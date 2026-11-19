import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testConfig, testDb } from './helpers.js';

async function setup() {
  const db = testDb();
  const { app, hub } = createApp({ db, config: testConfig() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
  };
  const owner = await hub.registry.signInWithGoogle('dev:owner@apps.test');
  const ws = await hub.registry.createWorkspace(owner.agent, 'Talent Inc');
  return { db, hub, call, owner, ws, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('apps and API keys', () => {
  it('an owner makes an app; its key reaches /v1 and nothing else, until revoked', async () => {
    const { call, owner, ws, close } = await setup();
    try {
      const made = await call(`/workspaces/${ws.id}/apps`, { method: 'POST', token: owner.token, body: { name: 'Talent', webhookUrl: 'https://talent.example/hooks' } });
      expect(made.status).toBe(201);
      const key: string = made.body.key;
      expect(key).toMatch(/^pk_live_[A-Za-z0-9_-]{43}$/);
      expect(made.body.app.webhookSecret).toMatch(/^whsec_/);

      const me = await call('/v1/me', { token: key });
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ id: made.body.app.id, workspaceId: ws.id, name: 'Talent', scopes: ['rooms:read', 'rooms:write'] });

      // A key is never an agent token, and an agent token never reaches /v1.
      expect((await call('/me', { token: key })).status).toBe(401);
      expect((await call('/v1/me', { token: owner.token })).status).toBe(401);
      expect((await call('/v1/me')).status).toBe(401);

      // Listing shows prefixes, never keys or the webhook secret.
      const list = await call(`/workspaces/${ws.id}/apps`, { token: owner.token });
      const listed = JSON.stringify(list.body);
      expect(listed).not.toContain(key);
      expect(listed).not.toContain(made.body.app.webhookSecret);
      const prefix: string = list.body[0].keys[0].prefix;
      expect(key.startsWith(prefix)).toBe(true);

      // Rotation: a second key works; revoking the first stops only it.
      const second = await call(`/workspaces/${ws.id}/apps/${made.body.app.id}/keys`, { method: 'POST', token: owner.token });
      expect((await call(`/workspaces/${ws.id}/apps/${made.body.app.id}/keys/${prefix}`, { method: 'DELETE', token: owner.token })).status).toBe(200);
      expect((await call('/v1/me', { token: key })).status).toBe(401);
      expect((await call('/v1/me', { token: second.body.key })).status).toBe(200);

      // Deleting the app revokes every key.
      await call(`/workspaces/${ws.id}/apps/${made.body.app.id}`, { method: 'DELETE', token: owner.token });
      expect((await call('/v1/me', { token: second.body.key })).status).toBe(401);
    } finally { await close(); }
  });

  it('only a workspace owner manages its apps', async () => {
    const { hub, call, ws, close } = await setup();
    try {
      const stranger = await hub.registry.signInWithGoogle('dev:stranger@apps.test');
      expect((await call(`/workspaces/${ws.id}/apps`, { method: 'POST', token: stranger.token, body: { name: 'Mine now' } })).status).toBe(404);
      expect((await call(`/workspaces/${ws.id}/apps`, { token: stranger.token })).status).toBe(404);
    } finally { await close(); }
  });

  it('lists the keys of every app, past the old 30-id cap', async () => {
    const { call, owner, ws, close } = await setup();
    try {
      for (let i = 0; i < 31; i++) expect((await call(`/workspaces/${ws.id}/apps`, { method: 'POST', token: owner.token, body: { name: `App ${i}` } })).status).toBe(201);
      const list = await call(`/workspaces/${ws.id}/apps`, { token: owner.token });
      expect(list.body).toHaveLength(31);
      for (const app of list.body) expect(app.keys).toHaveLength(1);
    } finally { await close(); }
  });

  it('rejects a non-https webhook and a missing name', async () => {
    const { call, owner, ws, close } = await setup();
    try {
      expect((await call(`/workspaces/${ws.id}/apps`, { method: 'POST', token: owner.token, body: { name: 'x', webhookUrl: 'http://plain.example' } })).status).toBe(400);
      expect((await call(`/workspaces/${ws.id}/apps`, { method: 'POST', token: owner.token, body: {} })).status).toBe(400);
    } finally { await close(); }
  });

  it("an app's keys stop when its maker no longer owns the workspace", async () => {
    const { db, call, owner, ws, close } = await setup();
    try {
      const made = await call(`/workspaces/${ws.id}/apps`, { method: 'POST', token: owner.token, body: { name: 'Talent' } });
      expect((await call('/v1/me', { token: made.body.key })).status).toBe(200);
      await db.collection('workspaces').doc(ws.id).update({ ownerId: 'someone-else', ownerIds: [] });
      expect((await call('/v1/me', { token: made.body.key })).status).toBe(401);
    } finally { await close(); }
  });
});
