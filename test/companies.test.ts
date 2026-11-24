import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Server } from 'node:http';
import { httpCaller, testConfig, testDb, testPerson } from './helpers.js';

type Person = { token: string; agent: { id: string; email: string } };

describe('company invites and membership', () => {
  const db = testDb();
  const { app, hub } = createApp({ db, config: testConfig() });
  let server: Server;
  const call = httpCaller(() => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  let n = 0;
  const signIn = async (name: string) => (await call(undefined, 'POST', '/auth/google', { idToken: `dev:${name}-${Date.now()}-${n++}@people.test` })).json as Person;
  const company = async (owner: Person, seats = 3) => {
    const id = `co-${n++}`;
    await db.collection('billing').doc(id).set({ name: `Co ${id}`, owners: [owner.agent.id], plan: 'team', seats });
    return id;
  };
  const linked = async (p: Person) => ((await db.collection('agents').doc(p.agent.id).get()).data() as { billingAccountId?: string }).billingAccountId;

  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => server.close());

  it('invite then accept links the person; accepting twice is a no-op; the owner sees them', async () => {
    const [owner, alice] = [await signIn('own'), await signIn('alice')];
    const id = await company(owner);
    expect((await call(owner.token, 'POST', `/companies/${id}/invites`, { email: alice.agent.email.toUpperCase() })).status).toBe(201);
    expect((await call(alice.token, 'GET', '/me/company/invites')).json).toMatchObject([{ companyId: id, companyName: `Co ${id}` }]);
    expect((await call(alice.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
    expect(await linked(alice)).toBe(id);
    expect((await call(alice.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
    expect(await linked(alice)).toBe(id);
    expect((await call(alice.token, 'GET', '/me/company/invites')).json).toEqual([]);
    expect((await call(alice.token, 'GET', '/me/company')).json).toMatchObject({ member: { id, active: true }, owned: [] });
    const { member, owned: [view] } = (await call(owner.token, 'GET', '/me/company')).json;
    expect(member).toBeNull();
    expect(view).toMatchObject({ id, plan: 'team', seats: { used: 2, max: 3 }, invites: [] });
    expect(view.members.map((m: { id: string }) => m.id).sort()).toEqual([alice.agent.id, owner.agent.id].sort());
  });

  it("an invite only works for the email it was sent to, and pending invites hold seats", async () => {
    const [owner, a, b, c, eve] = [await signIn('own'), await signIn('a'), await signIn('b'), await signIn('c'), await signIn('eve')];
    const id = await company(owner);
    for (const p of [a, b]) expect((await call(owner.token, 'POST', `/companies/${id}/invites`, { email: p.agent.email })).status).toBe(201);
    expect((await call(owner.token, 'POST', `/companies/${id}/invites`, { email: c.agent.email })).status).toBe(402);
    expect((await call(eve.token, 'POST', `/companies/${id}/accept`)).status).toBe(404);
    expect(await linked(eve)).toBeUndefined();
    expect((await call(owner.token, 'POST', `/companies/${id}/invites`, { email: 'nope' })).status).toBe(400);
  });

  it('concurrent accepts for the last seat: only one wins', async () => {
    const [owner, a, b, x, y] = [await signIn('own'), await signIn('a'), await signIn('b'), await signIn('x'), await signIn('y')];
    const id = await company(owner, 4);
    for (const p of [a, b]) await call(owner.token, 'POST', `/companies/${id}/invites`, { email: p.agent.email });
    // Two seats get filled outside the invite flow, so with the owner's seat one is left for two invites.
    for (const p of [x, y]) await hub.registry.agentStore.update(p.agent.id, { billingAccountId: id });
    const res = await Promise.all([a, b].map((p) => call(p.token, 'POST', `/companies/${id}/accept`)));
    expect(res.map((r) => r.status).sort()).toEqual([200, 402]);
    expect([await linked(a), await linked(b)].filter((v) => v === id)).toHaveLength(1);
  });

  it('owners take a seat, counted once even when linked as a member: 3 seats, 1 owner, 2 members is full', async () => {
    const [owner, a, b, c] = [await signIn('own'), await signIn('a'), await signIn('b'), await signIn('c')];
    const id = await company(owner);
    for (const p of [owner, a, b]) await hub.registry.agentStore.update(p.agent.id, { billingAccountId: id });
    expect((await call(owner.token, 'GET', '/me/company')).json.owned[0].seats).toEqual({ used: 3, max: 3 });
    expect((await call(owner.token, 'POST', `/companies/${id}/invites`, { email: c.agent.email })).status).toBe(402);
  });

  it('an owner with no link is listed among the people with her spend', async () => {
    const owner = await signIn('own');
    const id = await company(owner);
    const period = new Date().toISOString().slice(0, 7);
    await hub.llm.store.recordAgentUsage(owner.agent.id, id, period, 2_000_000, 2, {}, new Date().toISOString());
    const [view] = (await call(owner.token, 'GET', '/me/company')).json.owned;
    expect(view.seats.used).toBe(1);
    expect(view.members).toEqual([expect.objectContaining({ id: owner.agent.id, owner: true, spentUsd: 2 })]);
  });

  it('accepting another company moves the person', async () => {
    const [o1, o2, alice] = [await signIn('o1'), await signIn('o2'), await signIn('alice')];
    const [c1, c2] = [await company(o1), await company(o2)];
    await call(o1.token, 'POST', `/companies/${c1}/invites`, { email: alice.agent.email });
    await call(alice.token, 'POST', `/companies/${c1}/accept`);
    await call(o2.token, 'POST', `/companies/${c2}/invites`, { email: alice.agent.email });
    expect((await call(alice.token, 'POST', `/companies/${c2}/accept`)).status).toBe(200);
    expect(await linked(alice)).toBe(c2);
    expect((await call(o1.token, 'GET', '/me/company')).json.owned[0].members.map((m: { id: string }) => m.id)).toEqual([o1.agent.id]);
  });

  it.each([['a co-owner', true], ['the only owner', false]])('%s of Acme accepts Beta: she stays an owner of Acme and becomes a member of Beta', async (_, coOwned) => {
    const [alice, bob, beta] = [await signIn('alice'), await signIn('bob'), await signIn('beta')];
    const acme = await company(alice);
    if (coOwned) await db.collection('billing').doc(acme).update({ owners: [alice.agent.id, bob.agent.id] });
    const betaId = await company(beta);
    expect((await call(beta.token, 'POST', `/companies/${betaId}/invites`, { email: alice.agent.email })).status).toBe(201);
    expect((await call(alice.token, 'POST', `/companies/${betaId}/accept`)).status).toBe(200);
    const view = (await call(alice.token, 'GET', '/me/company')).json;
    expect(view.member).toMatchObject({ id: betaId });
    expect(view.owned.map((o: { id: string }) => o.id)).toEqual([acme]);
    expect(((await db.collection('billing').doc(acme).get()).data() as { owners: string[] }).owners).toContain(alice.agent.id);
  });

  it('re-sending invites hits the invite rate limit, and then no more mail goes out', async () => {
    const limited = createApp({ db, config: testConfig({ inviteLimitPerHour: 2 }) });
    const sent: string[] = [];
    Object.assign(limited.hub.registry, { mailInvite: async ({ email }: { email: string }) => void sent.push(email) });
    const srv = limited.app.listen(0);
    try {
      const callL = httpCaller(() => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
      const [owner, a] = [await signIn('own'), await signIn('a')];
      const id = await company(owner);
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await callL(owner.token, 'POST', `/companies/${id}/invites`, { email: a.agent.email })).status);
      expect(statuses).toEqual([201, 201, 429, 429]);
      expect(sent).toEqual([a.agent.email, a.agent.email]);
    } finally {
      srv.close();
    }
  });

  it('removing or leaving clears the link; non-owners get 403; a sole owner cannot leave', async () => {
    const [owner, a, b, out] = [await signIn('own'), await signIn('a'), await signIn('b'), await signIn('out')];
    const id = await company(owner);
    for (const p of [a, b]) {
      await call(owner.token, 'POST', `/companies/${id}/invites`, { email: p.agent.email });
      await call(p.token, 'POST', `/companies/${id}/accept`);
    }
    await call(owner.token, 'POST', `/companies/${id}/invites`, { email: out.agent.email });
    // Non-owners can't invite, remove others or revoke someone else's invite.
    expect((await call(a.token, 'POST', `/companies/${id}/invites`, { email: 'z@people.test' })).status).toBe(403);
    expect((await call(a.token, 'DELETE', `/companies/${id}/members/${b.agent.id}`)).status).toBe(403);
    expect((await call(a.token, 'DELETE', `/companies/${id}/invites/${encodeURIComponent(out.agent.email)}`)).status).toBe(403);
    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${owner.agent.id}`)).status).toBe(409);

    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`)).status).toBe(200);
    expect(await linked(a)).toBeUndefined();
    expect((await call(b.token, 'DELETE', `/companies/${id}/members/${b.agent.id}`)).status).toBe(200);
    expect(await linked(b)).toBeUndefined();
    expect((await call(b.token, 'GET', '/me/company')).json).toEqual({ member: null, owned: [] });
    // The invitee declines.
    expect((await call(out.token, 'DELETE', `/companies/${id}/invites/${encodeURIComponent(out.agent.email)}`)).status).toBe(200);
    expect((await call(out.token, 'GET', '/me/company/invites')).json).toEqual([]);
  });

  it('an owner of one company who is a member of another sees both, and can leave the one she is a member of', async () => {
    const [o1, o2] = [await signIn('o1'), await signIn('o2')];
    const [c1, c2] = [await company(o1), await company(o2)];
    await hub.registry.agentStore.update(o1.agent.id, { billingAccountId: c2 });
    const view = (await call(o1.token, 'GET', '/me/company')).json;
    expect(view.member).toMatchObject({ id: c2, active: true });
    expect(view.owned.map((o: { id: string }) => o.id)).toEqual([c1]);
    expect((await call(o1.token, 'DELETE', `/companies/${c2}/members/${o1.agent.id}`)).status).toBe(200);
    expect(await linked(o1)).toBeUndefined();
    expect((await call(o1.token, 'GET', '/me/company')).json).toMatchObject({ member: null, owned: [{ id: c1 }] });
  });

  it('an owner with no link is paid by her oldest active company; an inactive one falls back to personal; an explicit link wins', async () => {
    const payer = (p: Person) => hub.llm.payerOf({ id: p.agent.id });
    const a = await signIn('buyer');
    const [old, young] = [`co-old-${n++}`, `co-young-${n++}`];
    await db.collection('workspaces').doc(old).set({ name: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    await db.collection('workspaces').doc(young).set({ name: 'young', createdAt: '2026-06-01T00:00:00.000Z' });
    for (const id of [young, old]) await db.collection('billing').doc(id).set({ name: id, owners: [a.agent.id], plan: 'team', seats: 3 });
    expect(await payer(a)).toBe(old);
    await db.collection('billing').doc(old).set({ plan: 'free' }, { merge: true });
    expect(await payer(a)).toBe(young);
    await db.collection('billing').doc(young).set({ plan: 'free' }, { merge: true });
    expect(await payer(a)).toBe(a.agent.id);
    // An explicit link wins over owned companies, even to an inactive company.
    await db.collection('billing').doc(young).set({ plan: 'team' }, { merge: true });
    const other = await company(await signIn('other'));
    await hub.registry.agentStore.update(a.agent.id, { billingAccountId: other });
    expect(await payer(a)).toBe(other);
    await db.collection('billing').doc(other).set({ plan: 'free' }, { merge: true });
    expect(await payer(a)).toBe(a.agent.id);
  });

  it("a legacy pool with no owners still gives its workspace's creator Pro caps", async () => {
    const owner = await testPerson(hub.registry, 'Legacy');
    const ws = await hub.registry.createWorkspace(owner, 'legacy');
    await db.collection('billing').doc(ws.id).set({ plan: 'team', seats: 5 });
    expect((await hub.registry.workspaceUsage(ws)).plan).toBe('pro');
  });
});
