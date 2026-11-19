import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { seal } from '../src/lib/sealing.js';
import { crewOverHttp, freePort, newAgentOverHttp, testConfig, testDb } from './helpers.js';

const WEB = 'https://web.parly.test';

describe('GET /channels/:id/open', () => {
  let hubUrl: string;
  let server: Server;
  const credentialsKey = randomBytes(32);
  let bot: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let stranger: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let channelId: string;

  const mint = async (token: string) =>
    (await (await fetch(`${hubUrl}/events/stream/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json()) as { ticket: string; readTicket: string; hub: string; expiresAt: number };
  const open = (ticket: string, origin = WEB) => fetch(`${hubUrl}/channels/${channelId}/open?threads=open&limit=30&ticket=${encodeURIComponent(ticket)}`, { headers: { origin } });

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl, credentialsKey, webUrl: WEB }) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    bot = await newAgentOverHttp(hubUrl, { name: 'opener' });
    stranger = await newAgentOverHttp(hubUrl, { name: 'outsider' });
    ({ channelId } = await crewOverHttp(hubUrl, [bot], 'open-me'));
    const res = await fetch(`${hubUrl}/conversations/channel:${channelId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bot.token}` },
      body: JSON.stringify({ text: 'hello channel' }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('returns the page, members and people in one call, readable by the web origin only', async () => {
    const minted = await mint(bot.owner.token);
    expect(minted.hub).toBe(hubUrl);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
    const res = await open(minted.readTicket);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toMatch(/origin/i);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(['channel', 'me', 'members', 'page', 'people', 'workspace']);
    expect(body.me.id).toBe(bot.owner.id);
    expect(body.channel.id).toBe(channelId);
    expect(body.workspace.id).toBe(body.channel.workspaceId);
    expect(body.page.messages.map((m: any) => m.text)).toContain('hello channel');
    expect(body.page.conversation).toBe(`channel:${channelId}`);
    expect(body.members.map((m: any) => m.id)).toEqual(expect.arrayContaining([bot.owner.id, bot.agent.id]));
    expect(body.members.every((m: any) => !('token' in m))).toBe(true);
    expect(body.people).toEqual({});
  });

  it('adds the open thread and the details panel when asked', async () => {
    const { readTicket } = await mint(bot.owner.token);
    const post = ((await (await open(readTicket)).json()) as any).page.messages[0];
    const res = await fetch(`${hubUrl}/channels/${channelId}/open?thread=${post.id}&replies=20&panel=channel&ticket=${encodeURIComponent(readTicket)}`, { headers: { origin: WEB } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.thread.post.id).toBe(post.id);
    expect(body.thread.page.conversation).toBe(`thread:${channelId}:${post.id}`);
    expect(Object.keys(body.panel).sort()).toEqual(['inWorkspace', 'librarySkills', 'schedules', 'skills', 'slack', 'telegram', 'webhooks']);
  });

  it('sends no allow-origin header to an origin outside the allowlist', async () => {
    const res = await open((await mint(bot.owner.token)).readTicket, 'https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a changed, expired or stream ticket, and no ticket at all', async () => {
    const { ticket, readTicket } = await mint(bot.owner.token);
    const forged = readTicket.slice(0, -4) + (readTicket.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const readKey = createHmac('sha256', credentialsKey).update('channel-read-ticket').digest();
    const expired = seal(JSON.stringify({ agent: bot.owner.id, exp: Date.now() - 1000 }), readKey);
    for (const t of [forged, expired, ticket, '']) {
      const res = await open(t);
      expect(res.status).toBe(401);
      // The refusal is still readable by the web app, so it can mint a fresh ticket.
      expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    }
  });

  it("refuses another person's ticket for a channel they aren't in", async () => {
    const res = await open((await mint(stranger.owner.token)).readTicket);
    expect([403, 404]).toContain(res.status);
  });

  it('does not open the event stream with a read ticket', async () => {
    const res = await fetch(`${hubUrl}/events/stream?ticket=${encodeURIComponent((await mint(bot.owner.token)).readTicket)}`);
    expect(res.status).toBe(401);
  });
});
