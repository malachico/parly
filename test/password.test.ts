import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/registry/password.js';
import type { Registry } from '../src/registry/registry.js';
import { testConfig, testDb, freePort, httpCaller } from './helpers.js';

describe('self-hosted password sign-in', () => {
  const SECRET = 'installer-generated-setup-secret-0123456789';
  let hubUrl: string;
  let server: Server;
  let registry: Registry;

  const call = httpCaller(() => hubUrl);

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const made = createApp({
      db: testDb(),
      config: testConfig({ port, publicUrl: hubUrl, googleAuthDev: true, passwordLogin: { setupSecret: SECRET } }),
    });
    registry = made.hub.registry;
    server = await new Promise<Server>((resolve) => {
      const s = made.app.listen(port, '127.0.0.1', () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('hashes with a salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    expect(a).not.toBe(await hashPassword('correct horse battery'));
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('anything at all', undefined)).toBe(false);
  });

  it('creates the first owner once, only with the setup secret, then signs them in', async () => {
    const owner = { email: 'Owner@Example.com', name: 'Owner', password: 'owner-password-1' };
    expect((await call(undefined, 'POST', '/auth/password/setup', { ...owner, setupSecret: 'wrong' })).status).toBe(403);
    expect((await call(undefined, 'POST', '/auth/password/setup', { ...owner, setupSecret: SECRET, password: 'short' })).status).toBe(400);

    // Two setups at once: exactly one owner.
    const [a, b] = await Promise.all([
      call(undefined, 'POST', '/auth/password/setup', { ...owner, setupSecret: SECRET }),
      call(undefined, 'POST', '/auth/password/setup', { ...owner, email: 'other@example.com', setupSecret: SECRET }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const made = a.status === 200 ? a : b;
    expect(made.json.token).toEqual(expect.any(String));
    expect(JSON.stringify(made.json)).not.toContain('scrypt');

    const email = a.status === 200 ? 'owner@example.com' : 'other@example.com';
    const ok = await call(undefined, 'POST', '/auth/password', { email, password: owner.password });
    expect(ok.status).toBe(200);
    // The session works, and a password person may connect agents (pairing codes need a signed-in person).
    expect((await call(ok.json.token, 'POST', '/pairings', {})).status).toBe(201);
    // No cloud agents and no payments: no plan or credits to show.
    expect((await call(ok.json.token, 'GET', '/me/billing')).status).not.toBe(200);
    // The hash never leaves the hub.
    for (const path of ['/me', '/agents', `/agents/${ok.json.agent.id}`]) {
      const res = await call(ok.json.token, 'GET', path);
      expect(JSON.stringify(res.json)).not.toMatch(/scrypt|passwordHash|sessionHashes/);
    }

    const wrong = await call(undefined, 'POST', '/auth/password', { email, password: 'not-the-password' });
    const nobody = await call(undefined, 'POST', '/auth/password', { email: 'nobody@example.com', password: owner.password });
    expect([wrong.status, nobody.status]).toEqual([401, 401]);
    expect(wrong.json).toEqual(nobody.json); // doesn't say which accounts exist
  });

  it('lets anyone sign up with no invite code, one account per email', async () => {
    const mate = { email: 'mate@example.com', name: 'Mate', password: 'mate-password-1' };
    const fresh = await call(undefined, 'POST', '/auth/password/signup', mate);
    expect(fresh.status).toBe(200);
    const me = await call(fresh.json.token, 'GET', '/me');
    expect(me.status).toBe(200);
    // No sign-up gate left to advertise.
    expect(me.json).not.toHaveProperty('signupOpen');
    expect((await call(undefined, 'GET', '/health')).json).not.toHaveProperty('signupOpen');
    expect((await call(undefined, 'POST', '/auth/password', { email: mate.email, password: mate.password })).status).toBe(200);
    expect((await call(undefined, 'POST', '/auth/password/signup', mate)).status).toBeGreaterThanOrEqual(400);
  });

  it('a password account is never a super admin, even with a listed email', async () => {
    const before = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = 'boss@admin.test';
    try {
      const boss = await call(undefined, 'POST', '/auth/password/signup', { email: 'boss@admin.test', name: 'Boss', password: 'boss-password-1' });
      expect(boss.status).toBe(200);
      expect((await call(boss.json.token, 'GET', '/me')).json).not.toHaveProperty('admin');
      expect((await call(boss.json.token, 'GET', '/admin/usage')).status).toBe(404);
    } finally {
      process.env.SUPER_ADMIN_EMAILS = before;
    }
  });

  it('password accounts do not consume workspace invites (the email is unproven)', async () => {
    const owner = await call(undefined, 'POST', '/auth/password', { email: 'owner@example.com', password: 'owner-password-1' });
    const token = owner.status === 200 ? owner.json.token : (await call(undefined, 'POST', '/auth/password', { email: 'other@example.com', password: 'owner-password-1' })).json.token;
    const ws = (await call(token, 'GET', '/workspaces')).json[0].id as string;
    const inWs = async (t: string) => ((await call(t, 'GET', '/workspaces')).json as { id: string }[]).some((w) => w.id === ws);

    expect((await call(token, 'POST', `/workspaces/${ws}/invites`, { email: 'cfo@acme.com' })).status).toBe(200);
    const cfo = await call(undefined, 'POST', '/auth/password/signup', { email: 'cfo@acme.com', name: 'CFO', password: 'cfo-password-1' });
    expect(cfo.status).toBe(200);
    expect(await inWs(cfo.json.token)).toBe(false);
    expect(JSON.stringify((await call(token, 'GET', `/workspaces/${ws}/invites`)).json)).toContain('cfo@acme.com');
  });

  it('setup owner signing in with Google is a takeover', async () => {
    const ownerRes = await call(undefined, 'POST', '/auth/password', { email: 'owner@example.com', password: 'owner-password-1' });
    const token = ownerRes.status === 200 ? ownerRes.json.token : (await call(undefined, 'POST', '/auth/password', { email: 'other@example.com', password: 'owner-password-1' })).json.token;
    const ownerEmail = ((await call(token, 'GET', '/me')).json as { email: string }).email;
    const owner = (await registry.signInWithPassword(ownerEmail, 'owner-password-1')).agent;
    const bot = await registry.createBot(owner, { name: 'Owner bot' });
    expect((await call(bot.token, 'GET', '/me')).status).toBe(200);

    const linked = await registry.signInWithGoogle(`dev:${ownerEmail}`);
    expect(linked.agent.id).toBe(owner.id);
    expect(linked.agent.googleSub).toBeTruthy();
    // Google clears the password, old sessions and bots (an unverified password could be a squatter);
    // the owner's own new Google session works.
    expect((await call(bot.token, 'GET', '/me')).status).toBe(401);
    expect((await call(token, 'GET', '/me')).status).toBe(401);
    expect((await call(undefined, 'POST', '/auth/password', { email: ownerEmail, password: 'owner-password-1' })).status).toBe(401);
    expect((await call(linked.token, 'GET', '/me')).status).toBe(200);
    expect((await registry.botsOf(linked.agent)).find((b) => b.id === bot.agent.id)?.archived).toBeTruthy();
  });

  it('Google sign-in takes over an unproven password account', async () => {
    const port = await freePort();
    const made = createApp({
      db: testDb(),
      config: testConfig({ port, publicUrl: `http://127.0.0.1:${port}`, googleAuthDev: true, passwordLogin: { setupSecret: SECRET } }),
    });
    const s = await new Promise<Server>((resolve) => {
      const x = made.app.listen(port, '127.0.0.1', () => resolve(x));
    });
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, body?: unknown, auth?: string) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const setup = await post('/auth/password/setup', { setupSecret: SECRET, email: 'open-owner@example.com', password: 'owner-password-1' });
    expect(setup.status).toBe(200);
    const squatter = await post('/auth/password/signup', { email: 'claim@acme.com', name: 'Claim', password: 'claim-password-1' });
    expect(squatter.status).toBe(200);
    const agent = (await made.hub.registry.signInWithPassword('claim@acme.com', 'claim-password-1')).agent;
    const bot = await made.hub.registry.createBot(agent, { name: 'Squatter bot' });
    expect((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${bot.token}` } })).status).toBe(200);

    const real = await made.hub.registry.signInWithGoogle('dev:claim@acme.com');
    expect(real.agent.id).toBe(agent.id);
    expect((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${squatter.json.token}` } })).status).toBe(401);
    expect((await post('/auth/password', { email: 'claim@acme.com', password: 'claim-password-1' })).status).toBe(401);
    expect((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${bot.token}` } })).status).toBe(401);
    await made.hub.registry.setArchived(real.agent, bot.agent.id, false);
    expect((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${bot.token}` } })).status).toBe(401);
    await new Promise((r) => s.close(r));
  });

  it('resets a password from the host and signs out old sessions', async () => {
    const before = await call(undefined, 'POST', '/auth/password', { email: 'mate@example.com', password: 'mate-password-1' });
    await registry.resetPassword('mate@example.com', 'brand-new-password');
    expect((await call(before.json.token, 'GET', '/me')).status).toBe(401);
    expect((await call(undefined, 'POST', '/auth/password', { email: 'mate@example.com', password: 'mate-password-1' })).status).toBe(401);
    expect((await call(undefined, 'POST', '/auth/password', { email: 'mate@example.com', password: 'brand-new-password' })).status).toBe(200);
  });

  it('lets setup be retried when creating the owner fails', async () => {
    const port = await freePort();
    const made = createApp({ db: testDb(), config: testConfig({ port, publicUrl: `http://127.0.0.1:${port}`, googleAuthDev: false, passwordLogin: { setupSecret: SECRET } }) });
    const s = await new Promise<Server>((resolve) => {
      const x = made.app.listen(port, '127.0.0.1', () => resolve(x));
    });
    const url = `http://127.0.0.1:${port}/auth/password/setup`;
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
    // An existing (Google) person already has this email: setup fails, and must not lock the hub.
    await made.hub.registry.personFor({ sub: 'g-taken', email: 'taken@example.com', name: 'Taken' });
    expect(await post({ setupSecret: SECRET, email: 'taken@example.com', password: 'owner-password-1' })).toBe(409);
    expect(await post({ setupSecret: SECRET, email: 'free@example.com', password: 'owner-password-1' })).toBe(200);
    expect(await post({ setupSecret: SECRET, email: 'again@example.com', password: 'owner-password-1' })).toBe(409);
    await new Promise((r) => s.close(r));
  });

  it('keeps setup closed once the owner exists, even if onboarding failed, and finishes it at sign-in', async () => {
    const port = await freePort();
    const made = createApp({ db: testDb(), config: testConfig({ port, publicUrl: `http://127.0.0.1:${port}`, googleAuthDev: false, passwordLogin: { setupSecret: SECRET } }) });
    const s = await new Promise<Server>((resolve) => {
      const x = made.app.listen(port, '127.0.0.1', () => resolve(x));
    });
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
    // A transient failure after the account is committed (making its home workspace).
    const spy = vi.spyOn(made.hub.registry as unknown as { ensureHomeWorkspace: () => Promise<void> }, 'ensureHomeWorkspace').mockRejectedValueOnce(new Error('transient'));
    expect((await post('/auth/password/setup', { setupSecret: SECRET, email: 'first@example.com', password: 'owner-password-1' })).status).toBe(500);
    spy.mockRestore();
    // Setup stays closed to anyone else, and the owner's sign-in completes what failed.
    expect((await post('/auth/password/setup', { setupSecret: SECRET, email: 'second@example.com', password: 'owner-password-1' })).status).toBe(409);
    const signedIn = await post('/auth/password', { email: 'first@example.com', password: 'owner-password-1' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.json.agent.workspaces.length).toBeGreaterThan(0);
    await new Promise((r) => s.close(r));
  });

  it('recovers an interrupted sign-up: reset-password finds the person, and a stale email claim is freed', async () => {
    const port = await freePort();
    const db = testDb();
    const made = createApp({ db, config: testConfig({ port, publicUrl: `http://127.0.0.1:${port}`, googleAuthDev: false, passwordLogin: { setupSecret: SECRET } }) });
    const s = await new Promise<Server>((resolve) => {
      const x = made.app.listen(port, '127.0.0.1', () => resolve(x));
    });
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
    const registry = made.hub.registry as unknown as { register: (...a: unknown[]) => Promise<unknown> };

    // Dies right after the person is written, before the password: the record and the email claim are left behind.
    const real = registry.register.bind(made.hub.registry);
    const spy = vi.spyOn(registry, 'register').mockImplementationOnce(async (...a: unknown[]) => {
      await real(...a);
      throw new Error('process died');
    });
    expect(await post('/auth/password/signup', { email: 'cut@example.com', name: 'Cut', password: 'cut-password-123' })).toBe(500);
    spy.mockRestore();
    await db.collection('password_claims').doc('email:cut@example.com').set({ at: new Date().toISOString() });
    expect(await post('/auth/password', { email: 'cut@example.com', password: 'cut-password-123' })).toBe(401);
    await made.hub.registry.resetPassword('cut@example.com', 'fresh-password-1');
    expect(await post('/auth/password', { email: 'cut@example.com', password: 'fresh-password-1' })).toBe(200);

    // A claim with no account behind it: fresh ones still block, old ones are taken over.
    await db.collection('password_claims').doc('email:ghost@example.com').set({ at: new Date().toISOString() });
    expect(await post('/auth/password/signup', { email: 'ghost@example.com', name: 'Ghost', password: 'ghost-password-1' })).toBe(409);
    await db.collection('password_claims').doc('email:ghost@example.com').set({ at: new Date(Date.now() - 11 * 60_000).toISOString() });
    // Two takeovers at once: exactly one account.
    const both = await Promise.all([1, 2].map(() => post('/auth/password/signup', { email: 'ghost@example.com', name: 'Ghost', password: 'ghost-password-1' })));
    expect(both.sort()).toEqual([200, 409]);
    await new Promise((r) => s.close(r));
  });

  it('is off unless PASSWORD_LOGIN is configured', async () => {
    const port = await freePort();
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: `http://127.0.0.1:${port}` }) });
    const s = await new Promise<Server>((resolve) => {
      const x = app.listen(port, '127.0.0.1', () => resolve(x));
    });
    const res = await fetch(`http://127.0.0.1:${port}/auth/password/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupSecret: SECRET, email: 'x@example.com', password: 'whatever-long-1' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
    await new Promise((r) => s.close(r));
  });
});
