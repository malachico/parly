import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import { newAgentOverHttp, testConfig, testDb } from './helpers.js';

const SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'ChatGPT', version: '1' } };
const verifySig = (headers: Record<string, string>, body: string) => {
  const key = Buffer.from(SECRET.slice(6), 'base64');
  return headers['webhook-signature'] === `v1,${createHmac('sha256', key).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64')}`;
};

describe('MCP Events (2026-07-28, ChatGPT dots)', () => {
  it('flags native SDK support so the modern response shim can be retired', () => {
    expect(
      SUPPORTED_PROTOCOL_VERSIONS,
      'The SDK now supports 2026-07-28: review src/mcp/modern.ts and remove its legacy header/response patches after the HTTP tests pass natively.',
    ).not.toContain('2026-07-28');
  });

  it('discovers, subscribes with a verified callback, delivers a signed event when messages wait, and unsubscribes', async () => {
    const received: { url: string; headers: Record<string, string>; body: string }[] = [];
    let echo = true;
    const mcpEventsFetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = String(init.body);
      received.push({ url, headers, body });
      const msg = JSON.parse(body);
      if (msg.type === 'verification') return Response.json({ challenge: echo ? msg.challenge : 'nope' });
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const { app } = createApp({ db: testDb(), config: testConfig(), mcpEventsFetch });
    const server = app.listen(0);
    const hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dot = await newAgentOverHttp(hubUrl, { name: 'My Dot' });
      const rpc = async (method: string, params: Record<string, unknown> | null = {}) => {
        const res = await fetch(`${hubUrl}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${dot.token}`, 'mcp-protocol-version': '2026-07-28' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params === null ? null : { ...params, _meta: meta } }),
        });
        return (await res.json()) as { result?: any; error?: any };
      };

      const discover = await rpc('server/discover');
      expect(discover.result).toMatchObject({ resultType: 'complete', capabilities: { events: {} } });
      expect(discover.result.supportedVersions).toContain('2026-07-28');
      expect((await rpc('events/list')).result.events.map((e: { name: string }) => e.name)).toEqual(['message.received']);

      // Tools still work, the modern way.
      const who = await rpc('tools/call', { name: 'whoami', arguments: {} });
      expect(who.result).toMatchObject({ resultType: 'complete' });
      expect(JSON.stringify(who.result.content)).toContain('My Dot');

      const delivery = { mode: 'webhook', url: 'https://chatgpt.test/hooks/abc' };
      // Zod at the events edge: non-object params / non-string name are invalid.
      expect((await rpc('events/subscribe', null)).error).toBeTruthy();
      expect((await rpc('events/subscribe', { name: 1, delivery })).error).toBeTruthy();
      // Empty delivery object reaches HubError (not a Zod field miss).
      expect((await rpc('events/subscribe', { name: 'message.received', delivery: {} })).error?.message).toMatch(/webhook delivery/i);
      expect((await rpc('events/subscribe', { name: 'message.received', arguments: {}, delivery: { ...delivery, secret: 'short' } })).error).toBeTruthy();
      echo = false;
      expect((await rpc('events/subscribe', { name: 'message.received', arguments: {}, delivery: { ...delivery, secret: SECRET } })).error).toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
      echo = true;
      const sub = await rpc('events/subscribe', { name: 'message.received', arguments: {}, delivery: { ...delivery, secret: SECRET }, cursor: null });
      expect(sub.result).toMatchObject({ resultType: 'complete', cursor: null });
      expect(sub.result.id).toMatch(/^sub_/);
      const verification = received.at(-1)!;
      expect(verifySig(verification.headers, verification.body)).toBe(true);
      // The same subscription again (a refresh) keeps its id and isn't re-verified.
      const before = received.length;
      expect((await rpc('events/subscribe', { name: 'message.received', arguments: {}, delivery: { ...delivery, secret: SECRET }, cursor: null })).result.id).toBe(sub.result.id);
      expect(received.length).toBe(before);

      // Someone writes to the dot's agent: one signed event.
      await fetch(`${hubUrl}/conversations/agent:${dot.agent.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${dot.owner.token}` },
        body: JSON.stringify({ text: 'Can you summarize the launch plan?' }),
      });
      for (let i = 0; i < 50 && received.length === before; i++) await new Promise((r) => setTimeout(r, 20));
      const event = received.at(-1)!;
      expect(event.url).toBe(delivery.url);
      expect(verifySig(event.headers, event.body)).toBe(true);
      expect(event.headers['x-mcp-subscription-id']).toBe(sub.result.id);
      const parsed = JSON.parse(event.body);
      expect(parsed).toMatchObject({ name: 'message.received', data: { agentId: dot.agent.id, waiting: 1 }, cursor: null });
      expect(event.headers['webhook-id']).toBe(parsed.eventId);

      const say = (text: string) =>
        fetch(`${hubUrl}/conversations/agent:${dot.agent.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${dot.owner.token}` },
          body: JSON.stringify({ text }),
        });
      const settle = () => new Promise((r) => setTimeout(r, 300));
      const events = () => received.filter((r) => JSON.parse(r.body).name === 'message.received').length;

      // Another message before the dot has read: it's already been told.
      await say('Also, the budget?');
      await settle();
      expect(events()).toBe(1);
      // It reads its inbox; the next message wakes it again right away.
      await rpc('tools/call', { name: 'check_inbox', arguments: {} });
      await say('Thanks! One more thing.');
      for (let i = 0; i < 50 && events() < 2; i++) await settle();
      expect(events()).toBe(2);

      // Unsubscribed (by its id): nothing more.
      expect((await rpc('events/unsubscribe', { id: sub.result.id })).result).toMatchObject({ resultType: 'complete' });
      await rpc('tools/call', { name: 'check_inbox', arguments: {} });
      await say('Still there?');
      await settle();
      expect(events()).toBe(2);
    } finally {
      server.close();
    }
  });
});
