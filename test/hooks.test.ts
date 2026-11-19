import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hookText } from '../src/rest/routes.js';
import { crewOverHttp, newAgentOverHttp, testConfig, testDb, freePort } from './helpers.js';

describe('incoming webhooks', () => {
  let hubUrl: string;
  let server: Server;
  let hook: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let dev: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let channelId: string;

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl }) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    hook = await newAgentOverHttp(hubUrl, { name: 'CI' });
    dev = await newAgentOverHttp(hubUrl, { name: 'Fixer' });
    ({ channelId } = await crewOverHttp(hubUrl, [hook, dev]));
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  const post = (path: string, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(`${hubUrl}${path}`, { method: 'POST', headers, body });

  it('posts a Slack-style body into the channel as the bot, mentioning who it names', async () => {
    const res = await post(`/hooks/${channelId}/${hook.token}`, JSON.stringify({ text: 'Build failed on main @Fixer' }));
    expect(res.status).toBe(201);
    const page = (await (await fetch(`${hubUrl}/conversations/channel:${channelId}/messages`, { headers: { authorization: `Bearer ${dev.token}` } })).json()) as {
      messages: { fromId: string; mentions?: string[] }[];
    };
    expect(page.messages.at(-1)).toMatchObject({ fromId: hook.agent.id, mentions: [dev.agent.id] });
  });

  it('takes GitHub form-encoded payloads', async () => {
    const payload = JSON.stringify({ action: 'completed', workflow_run: { name: 'CI', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/1' }, repository: { full_name: 'o/r' } });
    const res = await post(`/hooks/${channelId}/${hook.token}`, new URLSearchParams({ payload }).toString(), {
      'content-type': 'application/x-www-form-urlencoded',
      'x-github-event': 'workflow_run',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const reply = await post(`/hooks/${channelId}/${hook.token}?thread=${id}`, '{"text":"fixed"}');
    expect(reply.status).toBe(201);
  });

  it('refuses a wrong token and a channel the bot is not in', async () => {
    expect((await post(`/hooks/${channelId}/nope`, '{"text":"x"}')).status).toBe(401);
    expect((await post(`/hooks/${channelId}/${hook.owner.token}`, '{"text":"x"}')).status).toBe(401); // a person's token
    const outsider = await newAgentOverHttp(hubUrl, { name: 'outsider' });
    expect((await post(`/hooks/${channelId}/${outsider.token}`, '{"text":"x"}')).status).toBeGreaterThanOrEqual(400);
  });

  it('makes a webhook for a channel: not an agent, it posts as its maker with 🪝, only there, until deleted', async () => {
    const call = (method: string, path: string, token: string, body?: object) =>
      fetch(`${hubUrl}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await call('POST', `/channels/${channelId}/webhooks`, dev.owner.token, { name: 'GitHub' })).status).toBe(404); // not in the channel
    expect((await call('POST', `/channels/${channelId}/webhooks`, hook.token, { name: 'GitHub' })).status).toBe(403); // a bot can't make one that posts as its owner
    const made = await call('POST', `/channels/${channelId}/webhooks`, hook.owner.token, { name: 'GitHub' });
    expect(made.status).toBe(201);
    const { webhook, token } = (await made.json()) as { webhook: { id: string; name: string; ownerId: string; tokenHash?: string }; token: string };
    expect(webhook).toMatchObject({ name: 'GitHub', ownerId: hook.owner.id });
    expect(webhook.tokenHash).toBeUndefined();
    expect((await post(`/hooks/${channelId}/${token}`, JSON.stringify({ text: 'deployed @Fixer' }))).status).toBe(201);
    const page = (await (await call('GET', `/conversations/channel:${channelId}/messages`, dev.token)).json()) as {
      messages: { fromId: string; seq: number; text: string; mentions?: string[] }[];
      seen?: Record<string, number>;
    };
    // Agents are told it's an outside service, not its maker.
    const last = page.messages.at(-1)!;
    expect(last).toMatchObject({ fromId: hook.owner.id, text: '🪝 GitHub: deployed @Fixer', mentions: [dev.agent.id], webhook: 'GitHub' });
    // Posting as its maker isn't the maker reading the channel: it stays unread for them.
    expect(page.seen?.[hook.owner.id] ?? 0).toBeLessThan(last.seq);
    // Members see it in the channel's list; no agent was made.
    const list = (await (await call('GET', `/channels/${channelId}/webhooks`, dev.token)).json()) as { id: string }[];
    expect(list.map((w) => w.id)).toEqual([webhook.id]);
    const agents = (await (await call('GET', `/agents?channel=${channelId}`, dev.token)).json()) as { agents?: { name: string }[] } | { name: string }[];
    expect(JSON.stringify(agents)).not.toContain('"GitHub"');
    // Only into its own channel; its token is no bearer token.
    const { channelId: other } = await crewOverHttp(hubUrl, [hook], 'elsewhere');
    expect((await post(`/hooks/${other}/${token}`, JSON.stringify({ text: 'x' }))).status).toBe(403);
    expect((await call('GET', `/conversations/channel:${channelId}/messages`, token)).status).toBe(401);
    // Asked by name, the maker still owes an answer after the webhook posts in that thread.
    const me = (await (await call('GET', '/me', hook.owner.token)).json()) as { name: string };
    const ask = (await (await call('POST', `/conversations/channel:${channelId}/messages`, dev.token, { text: `@${me.name} can you look?` })).json()) as { id?: string; message?: { id: string } };
    const askId = ask.message?.id ?? ask.id!;
    expect((await post(`/hooks/${channelId}/${token}?thread=${askId}`, JSON.stringify({ text: 'build green' }))).status).toBe(201);
    const waiting = (await (await call('GET', '/waiting', hook.owner.token)).json()) as { messageId: string }[];
    expect(waiting.map((w) => w.messageId)).toContain(askId);
    // Someone else who isn't a channel owner can't delete it; its maker can, and the URL stops working.
    expect((await call('DELETE', `/webhooks/${webhook.id}`, dev.token)).status).toBe(403);
    expect((await call('DELETE', `/webhooks/${webhook.id}`, hook.owner.token)).status).toBe(200);
    expect((await post(`/hooks/${channelId}/${token}`, JSON.stringify({ text: 'x' }))).status).toBe(401);
  });

  it('turns bodies into text', () => {
    expect(hookText({ text: 'hi' })).toBe('hi');
    expect(hookText({ attachments: [{ fallback: 'a' }], blocks: [{ text: { text: 'b' } }] })).toBe('a\nb');
    expect(
      hookText({ action: 'completed', workflow_run: { name: 'CI', conclusion: 'failure', html_url: 'u' }, repository: { full_name: 'o/r' } }, 'workflow_run'),
    ).toBe('GitHub workflow_run completed failure on o/r\nCI\nu');
    expect(hookText({ ref: 'refs/heads/main', head_commit: { message: 'Fix\nmore' }, compare: 'c', repository: { full_name: 'o/r' } }, 'push')).toBe('GitHub push main on o/r\nFix\nc');
    expect(hookText({ level: 'error' })).toContain('"level": "error"');
    expect(hookText(undefined)).toBe('```json\n\n```');
  });
});
