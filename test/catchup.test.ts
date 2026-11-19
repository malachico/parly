import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ALL_CAUGHT_UP_TLDR, MAX_CATCHUP_MESSAGES } from '../src/chat/catchup.js';
import { channelKey, threadKey } from '../src/chat/chat.js';
import type { HubService } from '../src/hub/hubService.js';
import { RateLimiter } from '../src/lib/rateLimit.js';
import { crew, crewOverHttp, newAgentOverHttp, testConfig, testDb } from './helpers.js';

const say = (text: string) => [{ text }];

describe('Catch me up (GET /conversations/:key/catchup)', () => {
  let hub: HubService;
  let server: Server;
  let baseUrl: string;
  let vertexCalls: { url: string; body: any }[] = [];
  let vertexShouldFail = false;

  beforeAll(async () => {
    const created = createApp({
      db: testDb(),
      config: testConfig({
        vertex: {
          model: 'gemini-test',
          project: 'test-proj',
          location: 'us-central1',
          prices: { input: 1, output: 2 },
        },
        channelRouter: false,
        channelRouterModel: 'router-model-must-not-control-catchup',
      }),
      cloudToken: async () => 'test-vertex-token',
      cloudFetch: async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        vertexCalls.push({ url: String(url), body });
        if (vertexShouldFail) {
          return new Response('upstream error', { status: 503 });
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        tldr: 'The team agreed on the v2 API contract and queued backend + frontend builds.',
                        decisions: ['Add ?sinceSeq=<number> to avoid MarkRead race', 'Run Vertex AI summarization on the Hub'],
                        actionItems: ['Build the Hub endpoint and Next.js proxy'],
                        openQuestions: ['Should we add a Mark as read button in the card?'],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    hub = created.hub;
    server = await new Promise<Server>((resolve) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns caughtUp: true without calling Vertex when there are no unread messages or only self-authored messages', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'cu-empty', ['cu-bot']);
    const [bot] = members;
    vertexCalls = [];

    const emptyRes = await hub.chat.summarizeCatchup(owner, channelKey(channel.id));
    expect(emptyRes).toEqual({
      caughtUp: true,
      messageCount: 0,
      tldr: ALL_CAUGHT_UP_TLDR,
      decisions: [],
      actionItems: [],
      openQuestions: [],
    });
    expect(vertexCalls).toHaveLength(0);

    await hub.send(bot!, { channel: channel.id }, say('Hello team'));
    await hub.chat.markRead(owner, channelKey(channel.id));
    const afterReadRes = await hub.chat.summarizeCatchup(owner, channelKey(channel.id));
    expect(afterReadRes.caughtUp).toBe(true);
    expect(afterReadRes.messageCount).toBe(0);
    expect(vertexCalls).toHaveLength(0);

    await hub.send(owner, { channel: channel.id }, say('My own message'));
    const ownMsgRes = await hub.chat.summarizeCatchup(owner, channelKey(channel.id));
    expect(ownMsgRes.caughtUp).toBe(true);
    expect(vertexCalls).toHaveLength(0);
  });

  it('summarizes unread messages via Vertex AI, supports ?sinceSeq override after MarkRead, and preserves read cursor', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'cu-vertex', ['cu-alice']);
    const [alice] = members;
    vertexCalls = [];
    vertexShouldFail = false;

    await hub.send(owner, { channel: channel.id }, say('Context message before unread'));
    await hub.chat.markRead(owner, channelKey(channel.id));
    const initialSeenSeq = (await hub.chat.page(owner, channelKey(channel.id), 10)).seen[owner.id] ?? 0;
    expect(initialSeenSeq).toBe(1);

    await hub.send(alice!, { channel: channel.id }, say('We decided to use Vertex AI in the Hub.'));
    await hub.send(alice!, { channel: channel.id }, say(`@${owner.name} can you review the API contract?`));

    const summary = await hub.chat.summarizeCatchup(owner, channelKey(channel.id));
    expect(summary).toEqual({
      caughtUp: false,
      messageCount: 2,
      tldr: 'The team agreed on the v2 API contract and queued backend + frontend builds.',
      decisions: ['Add ?sinceSeq=<number> to avoid MarkRead race', 'Run Vertex AI summarization on the Hub'],
      actionItems: ['Build the Hub endpoint and Next.js proxy'],
      openQuestions: ['Should we add a Mark as read button in the card?'],
    });
    expect(vertexCalls).toHaveLength(1);
    expect(vertexCalls[0]!.url).toBe('https://aiplatform.googleapis.com/v1/projects/test-proj/locations/global/publishers/google/models/gemini-3.5-flash-lite:generateContent');
    const promptSent = vertexCalls[0]!.body.contents[0].parts[0].text as string;
    expect(promptSent).toContain('Prior context before the unread messages');
    expect(promptSent).toContain('Context message before unread');
    expect(promptSent).toContain('We decided to use Vertex AI in the Hub.');

    const pageAfterCatchup = await hub.chat.page(owner, channelKey(channel.id), 10);
    expect(pageAfterCatchup.seen[owner.id]).toBe(1);

    await hub.chat.markRead(owner, channelKey(channel.id));
    const withoutSince = await hub.chat.summarizeCatchup(owner, channelKey(channel.id));
    expect(withoutSince.caughtUp).toBe(true);

    // Passing sinceSeq=initialSeenSeq (1) still summarizes the 2 messages that were unread when the user opened the channel!
    const withSince = await hub.chat.summarizeCatchup(owner, channelKey(channel.id), { sinceSeq: initialSeenSeq });
    expect(withSince.caughtUp).toBe(false);
    expect(withSince.messageCount).toBe(2);

    // Even when the channel top-level cursor is caught up, unread replies in an active thread are included in channel catchup!
    const rootPost = (await hub.send(owner, { channel: channel.id }, say('Release checklist thread'))).message;
    await hub.chat.markRead(owner, channelKey(channel.id));
    await hub.send(alice!, { channel: channel.id, thread: rootPost.id }, say('Staging e2e passed in thread.'));
    const channelWithUnreadThread = await hub.chat.summarizeCatchup(owner, channelKey(channel.id));
    expect(channelWithUnreadThread.caughtUp).toBe(false);
    expect(channelWithUnreadThread.messageCount).toBe(1);
  });

  it('falls back to deterministic heuristic extraction when Vertex AI fails, and caps backlogs at 80 messages', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'cu-cap', ['cu-writer']);
    const [writer] = members;
    vertexShouldFail = true;

    for (let i = 1; i <= 85; i++) {
      const text =
        i === 83
          ? 'Approved ✅ we decided to ship v2.'
          : i === 84
            ? `@${owner.name} please check staging.`
            : i === 85
              ? 'Should we enable rate limiting per user?'
              : `Update #${i}`;
      await hub.send(writer!, { channel: channel.id }, say(text));
    }

    const res = await hub.chat.summarizeCatchup(owner, channelKey(channel.id));
    vertexShouldFail = false;

    expect(res.caughtUp).toBe(false);
    expect(res.messageCount).toBe(MAX_CATCHUP_MESSAGES);
    expect(res.capped).toBe(true);
    expect(res.tldr).toContain('80 unread messages');
    expect(res.decisions.some((d) => d.includes('Approved ✅'))).toBe(true);
    expect(res.actionItems.some((a) => a.includes(`@${owner.name}`))).toBe(true);
    expect(res.openQuestions.some((q) => q.includes('Should we enable rate limiting per user?'))).toBe(true);
  });

  it('enforces authz over REST, supports threads, validates sinceSeq, and enforces per-user rate limit', async () => {
    const a = await newAgentOverHttp(baseUrl, { name: 'BotA' });
    const outsider = await newAgentOverHttp(baseUrl, { name: 'Outsider' });
    const { channelId } = await crewOverHttp(baseUrl, [a], 'private-catchup');
    const ch = { id: channelId };

    const unauth = await fetch(`${baseUrl}/conversations/${encodeURIComponent(`channel:${ch.id}`)}/catchup`);
    expect(unauth.status).toBe(401);

    const forbidden = await fetch(`${baseUrl}/conversations/${encodeURIComponent(`channel:${ch.id}`)}/catchup`, {
      headers: { authorization: `Bearer ${outsider.owner.token}` },
    });
    expect(forbidden.status).toBe(404);

    const badSince = await fetch(`${baseUrl}/conversations/${encodeURIComponent(`channel:${ch.id}`)}/catchup?sinceSeq=-5`, {
      headers: { authorization: `Bearer ${a.owner.token}` },
    });
    expect(badSince.status).toBe(400);

    const postRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(`channel:${ch.id}`)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ text: 'Root post for thread catchup' }),
    });
    const rootMsg = (await postRes.json()) as { id: string };

    await fetch(`${baseUrl}/conversations/${encodeURIComponent(threadKey(ch.id, rootMsg.id))}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ text: 'Reply inside the thread' }),
    });

    const threadCatchup = await fetch(
      `${baseUrl}/conversations/${encodeURIComponent(threadKey(ch.id, rootMsg.id))}/catchup?sinceSeq=0`,
      { headers: { authorization: `Bearer ${a.owner.token}` } },
    );
    expect(threadCatchup.status).toBe(200);
    const threadBody = (await threadCatchup.json()) as any;
    expect(threadBody.caughtUp).toBe(false);
    expect(threadBody.messageCount).toBe(1);

    hub.chat.catchupLimiter = new RateLimiter(1, 60_000, 'catch-up summaries');
    const firstHit = await fetch(`${baseUrl}/conversations/${encodeURIComponent(`channel:${ch.id}`)}/catchup?sinceSeq=0`, {
      headers: { authorization: `Bearer ${a.owner.token}` },
    });
    expect(firstHit.status).toBe(200);
    const secondHit = await fetch(`${baseUrl}/conversations/${encodeURIComponent(`channel:${ch.id}`)}/catchup?sinceSeq=0`, {
      headers: { authorization: `Bearer ${a.owner.token}` },
    });
    expect(secondHit.status).toBe(429);
    hub.chat.catchupLimiter = new RateLimiter(30, 60 * 60 * 1000, 'catch-up summaries');
  });
});
