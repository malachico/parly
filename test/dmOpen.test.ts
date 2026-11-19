import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { freePort, newAgentOverHttp, testConfig, testDb } from './helpers.js';

const WEB = 'https://web.parly.test';

describe('GET /agents/:id/open', () => {
  let hubUrl: string;
  let server: Server;
  let bot: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let stranger: Awaited<ReturnType<typeof newAgentOverHttp>>;

  const call = async (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${hubUrl}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const mint = async (token: string) => ((await (await call(token, 'POST', '/events/stream/ticket')).json()) as { readTicket: string }).readTicket;
  const open = (ticket: string, workspace = bot.owner.workspaceId, id = bot.agent.id) =>
    fetch(`${hubUrl}/agents/${id}/open?workspace=${workspace}&limit=30&ticket=${encodeURIComponent(ticket)}`, { headers: { origin: WEB } });

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl, credentialsKey: randomBytes(32), webUrl: WEB }) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    bot = await newAgentOverHttp(hubUrl, { name: 'dm-bot' });
    stranger = await newAgentOverHttp(hubUrl, { name: 'outsider' });
    expect((await call(bot.owner.token, 'POST', `/workspaces/${bot.owner.workspaceId}/members`, { agentId: bot.agent.id })).status).toBeLessThan(300);
    expect((await call(bot.owner.token, 'POST', `/conversations/agent:${bot.agent.id}/messages`, { text: 'hello dm', workspace: bot.owner.workspaceId })).status).toBe(201);
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('matches GET /agents/:id and the messages page, read with a ticket from the web origin', async () => {
    const res = await open(await mint(bot.owner.token));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(['agent', 'me', 'page', 'workspace']);
    expect(body.me.id).toBe(bot.owner.id);
    expect(body.workspace.id).toBe(bot.owner.workspaceId);
    expect(body.agent).toEqual(await (await call(bot.owner.token, 'GET', `/agents/${bot.agent.id}`)).json());
    expect(body.page).toEqual(await (await call(bot.owner.token, 'GET', `/conversations/agent:${bot.agent.id}/messages?limit=30`)).json());
    expect(body.page.messages.map((m: any) => m.text)).toContain('hello dm');
  });

  it('refuses a bad ticket, a missing workspace and a workspace you are not in', async () => {
    expect((await open('nope')).status).toBe(401);
    const ticket = await mint(bot.owner.token);
    expect((await open(ticket, '')).status).toBe(400);
    expect((await open(ticket, stranger.owner.workspaceId)).status).toBe(404);
    // A stranger can't read the DM or learn the agent through their own workspace.
    expect((await open(await mint(stranger.owner.token), stranger.owner.workspaceId)).status).toBe(404);
  });

  it('names an archived agent from your conversation list, without its profile', async () => {
    expect((await call(bot.owner.token, 'POST', `/agents/${bot.agent.id}/archive`)).status).toBe(200);
    const body = (await (await open(await mint(bot.owner.token))).json()) as any;
    expect(body.agent).toBeUndefined();
    expect(body.gone).toMatchObject({ id: bot.agent.id, name: 'dm-bot', status: 'archived' });
    expect(body.page.messages.map((m: any) => m.text)).toContain('hello dm');
  });
});
