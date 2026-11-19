import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { newAgentOverHttp, testConfig, testDb, freePort, httpCaller } from './helpers.js';

describe('admin dashboard API', () => {
  let hubUrl: string;
  let server: Server;
  let adminToken: string;
  let sender: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let sleeper: Awaited<ReturnType<typeof newAgentOverHttp>>;
  const SECRET = 'the launch codes are 0000';

  const call = httpCaller(() => hubUrl);

  beforeAll(async () => {
    process.env.SUPER_ADMIN_EMAILS = 'root@admin.test';
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl }) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    adminToken = (await call(undefined, 'POST', '/auth/google', { idToken: 'dev:root@admin.test' })).json.token as string;
    sender = await newAgentOverHttp(hubUrl, { name: 'sender', public: true });
    sleeper = await newAgentOverHttp(hubUrl, { name: 'sleeper', public: true });
    expect((await call(sender.token, 'POST', `/conversations/agent:${sleeper.agent.id}/messages`, { text: SECRET })).status).toBe(201);
  });

  afterAll(async () => {
    delete process.env.SUPER_ADMIN_EMAILS;
    await new Promise((r) => server?.close(r));
  });

  it('takes client requests from people and shows them, with their email, to super admins only', async () => {
    const asked = await call(sender.owner.token, 'POST', '/client-requests', { text: '  Meta Muse please  ' });
    expect(asked.status).toBe(200);
    expect((await call(sender.token, 'POST', '/client-requests', { text: 'a bot asking' })).status).toBe(403); // people only
    expect((await call(undefined, 'POST', '/client-requests', { text: 'anyone' })).status).toBe(401);
    expect((await call(sender.owner.token, 'POST', '/client-requests', { text: ' ' })).status).toBe(400);
    expect((await call(sender.owner.token, 'POST', '/client-requests', { text: 'x'.repeat(501) })).status).toBe(400);

    expect((await call(sender.owner.token, 'GET', '/admin/client-requests')).status).toBe(404);
    const list = await call(adminToken, 'GET', '/admin/client-requests');
    expect(list.json).toEqual([{ id: asked.json.id, text: 'Meta Muse please', email: sender.owner.email, name: expect.any(String), agentId: sender.owner.id, at: asked.json.at }]);
  });

  it('lets super admins show and hide clients on the Connect page, which anyone can read', async () => {
    expect((await call(undefined, 'GET', '/connect-clients')).json).toEqual({ shown: {} });
    expect((await call(sender.owner.token, 'POST', '/admin/connect-clients', { client: 'grok', shown: true })).status).toBe(404);
    expect((await call(adminToken, 'POST', '/admin/connect-clients', { client: 'grok', shown: 'yes' })).status).toBe(400);
    expect((await call(adminToken, 'POST', '/admin/connect-clients', { client: 'Not a key!', shown: true })).status).toBe(400);
    await call(adminToken, 'POST', '/admin/connect-clients', { client: 'grok', shown: true });
    expect((await call(adminToken, 'POST', '/admin/connect-clients', { client: 'zed', shown: false })).json).toEqual({ shown: { grok: true, zed: false } });
    expect((await call(undefined, 'GET', '/connect-clients')).json).toEqual({ shown: { grok: true, zed: false } });
    expect((await call(sender.owner.token, 'GET', '/admin/connect-clients')).status).toBe(404);
    expect((await call(adminToken, 'GET', '/admin/connect-clients')).json).toEqual({ shown: { grok: true, zed: false } });
  });

  it('is invisible to everyone but super admins', async () => {
    for (const token of [undefined, sender.token, sender.owner.token]) {
      expect((await call(token, 'GET', '/admin/overview')).status).toBe(404);
      expect((await call(token, 'POST', `/admin/agents/${sleeper.agent.id}/actions`, { action: 'archive' })).status).toBe(404);
    }
    expect((await call(sender.owner.token, 'GET', '/me')).json.admin).toBeUndefined();
    expect((await call(adminToken, 'GET', '/me')).json.admin).toBe(true);
  });

  it('shows traffic without message text', async () => {
    const { status, json, text } = await call(adminToken, 'GET', '/admin/overview');
    expect(status).toBe(200);
    expect(json.messages.total).toBeGreaterThanOrEqual(1);
    expect(json.messages.hourly).toHaveLength(25);
    expect(json.messages.hourly.reduce((n: number, h: { messages: number }) => n + h.messages, 0)).toBe(json.messages.total);
    expect(json.agents.people).toBeGreaterThanOrEqual(3);
    expect(text).not.toContain(SECRET);
  });

  it('lists and filters agents, and shows one without its messages or token', async () => {
    const all = await call(adminToken, 'GET', '/admin/agents?q=sleeper');
    expect(all.json.agents.map((a: { id: string }) => a.id)).toEqual([sleeper.agent.id]);
    const one = await call(adminToken, 'GET', `/admin/agents/${sleeper.agent.id}`);
    expect(one.json.owner.id).toBe(sleeper.owner.id);
    expect(one.json.conversations).toMatchObject([{ kind: 'dm', messages: 1 }]);
    expect(one.text).not.toContain(SECRET);
    expect(one.text).not.toContain('tokenHash');

    const person = await call(adminToken, 'GET', `/admin/agents/${sleeper.owner.id}`);
    expect(person.json.bots.map((b: { id: string }) => b.id)).toEqual([sleeper.agent.id]);
  });

  it('archives, restores and revokes tokens, and logs who did it', async () => {
    const act = (id: string, action: string) => call(adminToken, 'POST', `/admin/agents/${id}/actions`, { action });
    expect((await act(sleeper.agent.id, 'archive')).json.agent.archived).toBe(true);
    expect((await call(adminToken, 'GET', '/admin/agents?q=sleeper')).json.agents).toEqual([]);
    expect((await call(adminToken, 'GET', '/admin/agents?filter=archived&q=sleeper')).json.agents).toHaveLength(1);
    expect((await act(sleeper.agent.id, 'restore')).json.agent.archived).toBeUndefined();

    expect((await call(sender.token, 'GET', '/me')).status).toBe(200);
    await act(sender.agent.id, 'revoke-token');
    expect((await call(sender.token, 'GET', '/me')).status).toBe(401);

    expect((await act(sender.agent.id, 'explode')).status).toBe(400);
    expect((await act(sender.agent.id, 'check')).status).toBe(400);

    const log = (await call(adminToken, 'GET', '/admin/log')).json as unknown as { action: string; targetId: string; adminEmail: string }[];
    expect(log.map((e) => e.action).sort()).toEqual(['archive', 'restore', 'revoke-token']);
    expect(log.every((e) => e.adminEmail === 'root@admin.test')).toBe(true);
    expect(log.find((e) => e.action === 'revoke-token')!.targetId).toBe(sender.agent.id);
  });
});
