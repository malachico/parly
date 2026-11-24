import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { retryBilling } from '../src/rest/companies.js';
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

  it.each([['a co-owner', true], ['the only owner', false]])('%s of Acme cannot accept Beta: one company per person', async (_, coOwned) => {
    const [alice, bob, beta] = [await signIn('alice'), await signIn('bob'), await signIn('beta')];
    const acme = await company(alice);
    if (coOwned) await db.collection('billing').doc(acme).update({ owners: [alice.agent.id, bob.agent.id] });
    const betaId = await company(beta);
    expect((await call(beta.token, 'POST', `/companies/${betaId}/invites`, { email: alice.agent.email })).status).toBe(201);
    expect((await call(alice.token, 'POST', `/companies/${betaId}/accept`)).status).toBe(409);
    expect(await linked(alice)).toBeUndefined();
  });

  it('POST /companies creates one company per person; GET, budget and portal are owner-scoped', async () => {
    const [owner, member, stranger] = [await signIn('own'), await signIn('mem'), await signIn('str')];
    expect((await call(owner.token, 'POST', '/companies', { name: ' ' })).status).toBe(400);
    const created = await call(owner.token, 'POST', '/companies', { name: 'Acme' });
    expect(created.status).toBe(201);
    const { id } = created.json;
    expect(await db.collection('billing').doc(id).get().then((d) => d.data())).toMatchObject({ kind: 'company', name: 'Acme', owners: [owner.agent.id], plan: 'free' });
    expect((await call(owner.token, 'POST', '/companies', { name: 'Other' })).json).toEqual({ id, name: 'Acme' });
    // A member of an active Team company can't start another.
    const active = await company(stranger);
    await hub.registry.agentStore.update(member.agent.id, { billingAccountId: active });
    expect((await call(member.token, 'POST', '/companies', { name: 'Mine' })).status).toBe(409);

    expect((await call(owner.token, 'PUT', `/companies/${id}/budget`, { credits: 5 })).json).toEqual({ companyId: id, budgetCredits: 5 });
    expect((await call(owner.token, 'GET', `/companies/${id}`)).json).toMatchObject({ id, budgetCredits: 5 });
    expect((await call(member.token, 'GET', `/companies/${active}`)).json).toMatchObject({ id: active, name: `Co ${active}`, plan: 'team' });
    expect((await call(member.token, 'GET', `/companies/${active}`)).json.budgetCredits).toBeUndefined();
    for (const [method, path] of [['GET', `/companies/${id}`], ['PUT', `/companies/${id}/budget`], ['POST', `/companies/${id}/billing/portal`]] as const) {
      expect((await call(stranger.token, method, path, method === 'GET' ? undefined : { credits: 1 })).status).toBe(403);
    }
    expect((await call(member.token, 'PUT', `/companies/${active}/budget`, { credits: 1 })).status).toBe(403);
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

describe('companies with Paddle (mocked)', () => {
  const db = testDb();
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  let paddleStatus = 200;
  let onCall: (() => Promise<void>) | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: JSON.parse(String(init.body ?? '{}')) });
    await onCall?.();
    return new Response('{}', { status: paddleStatus });
  }) as typeof fetch;
  const paddle = { apiKey: 'pdl_sdbx_key', webhookSecret: 'pdl_ntfset_test', clientToken: 'test_tok', environment: 'sandbox' as const, prices: { pro: 'pri_pro', team: 'pri_team', topups: { '10': 'pri_t10' } }, fetchImpl };
  const { app, hub } = createApp({ db, config: testConfig({ paddle, tickSecret: 'tick' }) });
  let server: Server;
  const call = httpCaller(() => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  let n = 0;
  const signIn = async (name: string) => (await call(undefined, 'POST', '/auth/google', { idToken: `dev:${name}-${Date.now()}-${n++}@paddle.test` })).json as Person;
  const company = async (owner: Person, extra: object = {}) => {
    const id = `pco-${n++}`;
    await db.collection('billing').doc(id).set({ name: `Co ${id}`, owners: [owner.agent.id], plan: 'team', seats: 3, ...extra });
    return id;
  };
  const linked = async (p: Person) => ((await db.collection('agents').doc(p.agent.id).get()).data() as { billingAccountId?: string }).billingAccountId;
  const people = async (id: string, ...names: string[]) => {
    const ps = await Promise.all(names.map(signIn));
    for (const p of ps) await hub.registry.agentStore.update(p.agent.id, { billingAccountId: id });
    return ps as [Person, Person, Person, ...Person[]];
  };
  const quantity = (c: (typeof calls)[number]) => (c.body.items as [{ quantity: number }])[0].quantity;
  const invite = async (owner: Person, id: string, p: Person) => expect((await call(owner.token, 'POST', `/companies/${id}/invites`, { email: p.agent.email })).status).toBe(201);

  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => server.close());

  it("accepting cancels the person's Pro at period end first; if Paddle fails, 502 and no join", async () => {
    const [owner, pro] = [await signIn('own'), await signIn('pro')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: 'sub_pro1' });
    await invite(owner, id, pro);
    calls.length = 0;
    paddleStatus = 500;
    expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).toBe(502);
    expect(await linked(pro)).toBeUndefined();
    paddleStatus = 200;
    expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
    expect(await linked(pro)).toBe(id);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: 'https://sandbox-api.paddle.com/subscriptions/sub_pro1/cancel', method: 'POST', body: { effective_from: 'next_billing_period' } });
  });

  it('an unpaid draft company is deleted when its owner accepts another invite, or leaves it; a paid one is kept', async () => {
    const [owner, a, b] = [await signIn('own'), await signIn('a'), await signIn('b')];
    const id = await company(owner);
    const draft = (await call(a.token, 'POST', '/companies', { name: 'Draft A' })).json.id;
    await invite(owner, id, a);
    expect((await call(a.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
    expect(await linked(a)).toBe(id);
    expect((await db.collection('billing').doc(draft).get()).exists).toBe(false);

    const draftB = (await call(b.token, 'POST', '/companies', { name: 'Draft B' })).json.id;
    expect((await call(b.token, 'DELETE', `/companies/${draftB}/members/${b.agent.id}`)).status).toBe(200);
    expect((await db.collection('billing').doc(draftB).get()).exists).toBe(false);

    // Once Paddle has a subscription on it (even lapsed), it's kept and blocks joining.
    const paid = await company(b, { plan: 'free', paddleSubscriptionId: 'sub_old' });
    await invite(owner, id, b);
    expect((await call(b.token, 'POST', `/companies/${id}/accept`)).status).toBe(409);
    expect((await call(b.token, 'DELETE', `/companies/${paid}/members/${b.agent.id}`)).status).toBe(409);
    expect((await db.collection('billing').doc(paid).get()).exists).toBe(true);
  });

  it('removing a member lowers the Team subscription to who is left (at least 3) from the next invoice; if Paddle fails, nothing changes', async () => {
    const owner = await signIn('own');
    const id = await company(owner, { seats: 5, paddleSubscriptionId: 'sub_team1' });
    const [a, b] = await people(id, 'a', 'b', 'c', 'd');
    calls.length = 0;
    paddleStatus = 500;
    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`)).status).toBe(502);
    expect(await linked(a)).toBe(id);
    paddleStatus = 200;
    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`)).status).toBe(200);
    expect(await linked(a)).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: 'https://sandbox-api.paddle.com/subscriptions/sub_team1', method: 'PATCH', body: { items: [{ price_id: 'pri_team', quantity: 4 }], proration_billing_mode: 'do_not_bill' } });
    // At the 3-seat minimum Paddle isn't called.
    await db.collection('billing').doc(id).set({ seats: 3 }, { merge: true });
    calls.length = 0;
    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${b.agent.id}`)).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('concurrent removals of different members each count who is left; a lost local write is corrected by the next', async () => {
    const owner = await signIn('own');
    const id = await company(owner, { seats: 6, paddleSubscriptionId: 'sub_team3' });
    const [a, b, c] = await people(id, 'a', 'b', 'c', 'd', 'e');
    calls.length = 0;
    const res = await Promise.all([a, b].map((p) => call(owner.token, 'DELETE', `/companies/${id}/members/${p.agent.id}`)));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(quantity(calls.at(-1)!)).toBe(4);
    expect((await db.collection('billing').doc(id).get()).data()).toMatchObject({ seats: 4 });
    // Paddle took a change whose local write was lost: the next removal still targets who is left.
    await db.collection('billing').doc(id).set({ seats: 6 }, { merge: true });
    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${c.agent.id}`)).status).toBe(200);
    expect(quantity(calls.at(-1)!)).toBe(3);
  });

  it('leaving, or moving to another company, lowers the seats too', async () => {
    const [owner, other] = [await signIn('own'), await signIn('other')];
    const id = await company(owner, { seats: 6, paddleSubscriptionId: 'sub_team4' });
    const [a, b] = await people(id, 'a', 'b', 'c', 'd', 'e');
    calls.length = 0;
    expect((await call(a.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`)).status).toBe(200);
    expect(quantity(calls.at(-1)!)).toBe(5);
    const y = await company(other, { seats: 5 });
    await invite(other, y, b);
    expect((await call(b.token, 'POST', `/companies/${y}/accept`)).status).toBe(200);
    expect(await linked(b)).toBe(y);
    expect(quantity(calls.at(-1)!)).toBe(4);
    expect((await db.collection('billing').doc(id).get()).data()).toMatchObject({ seats: 4 });
  });

  it('an invite being accepted cannot be revoked; the join completes', async () => {
    const [owner, pro] = [await signIn('own'), await signIn('pro')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: 'sub_pro2' });
    await invite(owner, id, pro);
    let revoke = 0;
    onCall = async () => {
      revoke = (await call(owner.token, 'DELETE', `/companies/${id}/invites/${encodeURIComponent(pro.agent.email)}`)).status;
    };
    try {
      expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
    } finally {
      onCall = undefined;
    }
    expect(revoke).toBe(409);
    expect(await linked(pro)).toBe(id);
  });

  it('removals racing on two hub instances still end at who is left, in Paddle and locally', async () => {
    const other = createApp({ db, config: testConfig({ paddle }) });
    const srv = other.app.listen(0);
    const call2 = httpCaller(() => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    const owner = await signIn('own');
    const id = await company(owner, { seats: 6, paddleSubscriptionId: 'sub_team5' });
    const [a, b] = await people(id, 'a', 'b', 'c', 'd', 'e');
    calls.length = 0;
    // Both first PATCHes wait for each other, so each instance counted before the other unlinked (each sends 5).
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    onCall = async () => {
      if (++arrived > 2) return;
      if (arrived === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 2000))]);
    };
    try {
      const res = await Promise.all([call(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`), call2(owner.token, 'DELETE', `/companies/${id}/members/${b.agent.id}`)]);
      expect(res.map((r) => r.status)).toEqual([200, 200]);
    } finally {
      onCall = undefined;
      srv.close();
    }
    expect(quantity(calls[0]!)).toBe(5);
    expect(quantity(calls[1]!)).toBe(5);
    expect(quantity(calls.at(-1)!)).toBe(4);
    expect((await db.collection('billing').doc(id).get()).data()).toMatchObject({ seats: 4 });
  });

  it('a resend while an invite is being accepted is a 409 and keeps the claim', async () => {
    const [owner, pro] = [await signIn('own'), await signIn('pro')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: 'sub_pro3' });
    await invite(owner, id, pro);
    const statuses: number[] = [];
    let claim: unknown;
    onCall = async () => {
      onCall = undefined;
      statuses.push((await call(owner.token, 'POST', `/companies/${id}/invites`, { email: pro.agent.email })).status);
      claim = (await db.collection('companyInvites').doc(`${id}:${pro.agent.email}`).get()).data()?.acceptingAt;
      statuses.push((await call(owner.token, 'DELETE', `/companies/${id}/invites/${encodeURIComponent(pro.agent.email)}`)).status);
    };
    try {
      expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
    } finally {
      onCall = undefined;
    }
    expect(statuses).toEqual([409, 409]);
    expect(claim).toEqual(expect.any(Number));
    expect(await linked(pro)).toBe(id);
  });

  it('a join that fails after Pro was cancelled undoes the cancel', async () => {
    const [owner, pro, x, y] = [await signIn('own'), await signIn('pro'), await signIn('x'), await signIn('y')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: 'sub_pro4' });
    await invite(owner, id, pro);
    calls.length = 0;
    // While Paddle cancels Pro, the company's last seats go, so the join itself fails.
    onCall = async () => {
      onCall = undefined;
      for (const p of [x, y]) await hub.registry.agentStore.update(p.agent.id, { billingAccountId: id });
    };
    try {
      expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).not.toBe(200);
    } finally {
      onCall = undefined;
    }
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://sandbox-api.paddle.com/subscriptions/sub_pro4/cancel', { effective_from: 'next_billing_period' }],
      ['PATCH', 'https://sandbox-api.paddle.com/subscriptions/sub_pro4', { scheduled_change: null }],
    ]);
    expect(await linked(pro)).toBeUndefined();
  });

  it('a corrective seat PATCH Paddle refuses is retried by the billing sweep until it ends at 4', async () => {
    const other = createApp({ db, config: testConfig({ paddle }) });
    const srv = other.app.listen(0);
    const call2 = httpCaller(() => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    const owner = await signIn('own');
    const id = await company(owner, { seats: 6, paddleSubscriptionId: 'sub_team6' });
    const [a, b] = await people(id, 'a', 'b', 'c', 'd', 'e');
    calls.length = 0;
    // As above both instances send 5; then Paddle refuses the corrective 4 while the removals run.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    onCall = async () => {
      paddleStatus = quantity(calls.at(-1)!) === 4 ? 500 : 200;
      if (++arrived > 2) return;
      if (arrived === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 2000))]);
    };
    try {
      const res = await Promise.all([call(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`), call2(owner.token, 'DELETE', `/companies/${id}/members/${b.agent.id}`)]);
      expect(res.map((r) => r.status)).toEqual([200, 200]);
    } finally {
      onCall = undefined;
      paddleStatus = 200;
      srv.close();
    }
    expect(calls.some((c) => quantity(c) === 4)).toBe(true);
    expect((await db.collection('billing').doc(id).get()).data()).toMatchObject({ seats: 5, seatsSyncPending: true });
    calls.length = 0;
    await retryBilling(hub);
    expect(calls.map(quantity)).toEqual([4]);
    const rec = (await db.collection('billing').doc(id).get()).data();
    expect(rec).toMatchObject({ seats: 4 });
    expect(rec?.seatsSyncPending).toBeUndefined();
  });

  it('a recount that matched does not clear the flag a later failed recount on another instance set', async () => {
    const [clearing, letClear, both] = [gate(), gate(), gate()];
    let arrived = 0;
    let recounting = false;
    // A's clear of the flag (decided by its recount, once both have sent 5) is held until B's corrective 4 has failed and set it.
    const hold = async () => {
      if (!recounting) return;
      clearing.open();
      await letClear.p;
    };
    const wrap = <T extends object>(o: T, over: Record<string, unknown>) =>
      new Proxy(o, { get: (t, k) => { const v: unknown = k in over ? over[k as string] : Reflect.get(t, k); return typeof v === 'function' && !(k in over) ? v.bind(t) : v; } });
    const dbA = wrap(db, {
      runTransaction: async (fn: Parameters<typeof db.runTransaction>[0]) => (await hold(), db.runTransaction(fn)),
      collection: (name: string) =>
        wrap(db.collection(name), {
          doc: (d: string) => {
            const ref = db.collection(name).doc(d);
            return wrap(ref, {
              update: async (change: Record<string, unknown>) => {
                if (name === 'billing' && 'seatsSyncPending' in change) await (change.seatsSyncPending === true ? (recounting = true) : hold());
                return ref.update(change);
              },
            });
          },
        }),
    });
    const sendFive = async () => {
      if (++arrived === 2) both.open();
      await both.p;
    };
    const fetchA = (async () => (await sendFive(), new Response('{}', { status: 200 }))) as typeof fetch;
    const other = createApp({ db: dbA, config: testConfig({ paddle: { ...paddle, fetchImpl: fetchA } }) });
    const srv = other.app.listen(0);
    const callA = httpCaller(() => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    const owner = await signIn('own');
    const id = await company(owner, { seats: 6, paddleSubscriptionId: 'sub_team7' });
    const [a, b] = await people(id, 'a', 'b', 'c', 'd', 'e');
    calls.length = 0;
    onCall = async () => {
      paddleStatus = quantity(calls.at(-1)!) === 4 ? 500 : 200;
      if (paddleStatus === 200) await Promise.all([sendFive(), clearing.p]);
    };
    try {
      const removingA = callA(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`);
      expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${b.agent.id}`)).status).toBe(200);
      expect(calls.map(quantity)).toEqual([5, 4]);
      letClear.open();
      expect((await removingA).status).toBe(200);
    } finally {
      [both, clearing, letClear].forEach((g) => g.open());
      onCall = undefined;
      paddleStatus = 200;
      srv.close();
    }
    expect((await db.collection('billing').doc(id).get()).data()).toMatchObject({ seats: 5, seatsSyncPending: true });
    calls.length = 0;
    await retryBilling(hub);
    expect(calls.map(quantity)).toEqual([4]);
    const rec = (await db.collection('billing').doc(id).get()).data();
    expect(rec).toMatchObject({ seats: 4 });
    expect(rec?.seatsSyncPending).toBeUndefined();
  });

  it('a Pro cancel undo Paddle refuses is retried by the billing sweep', async () => {
    const [owner, pro, x, y] = [await signIn('own'), await signIn('pro'), await signIn('x'), await signIn('y')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: 'sub_pro5' });
    await invite(owner, id, pro);
    calls.length = 0;
    // The join fails as above, and Paddle refuses the first undo.
    onCall = async () => {
      if (calls.length === 1) for (const p of [x, y]) await hub.registry.agentStore.update(p.agent.id, { billingAccountId: id });
      paddleStatus = calls.length === 2 ? 500 : 200;
    };
    try {
      expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).not.toBe(200);
    } finally {
      onCall = undefined;
      paddleStatus = 200;
    }
    expect(calls).toHaveLength(2);
    expect((await db.collection('billing').doc(pro.agent.id).get()).data()).toMatchObject({ proRestorePending: true });
    calls.length = 0;
    await retryBilling(hub);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([['PATCH', 'https://sandbox-api.paddle.com/subscriptions/sub_pro5', { scheduled_change: null }]]);
    expect((await db.collection('billing').doc(pro.agent.id).get()).data()?.proRestorePending).toBeUndefined();
    expect(await linked(pro)).toBeUndefined();
  });

  it('a stale Pro undo is not retried over the cancel of a new accept', async () => {
    const [owner, pro] = [await signIn('own'), await signIn('pro')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: 'sub_pro6', proRestorePending: true });
    await invite(owner, id, pro);
    calls.length = 0;
    // The sweep fires while the accept's cancel is in flight (claimed, not yet linked).
    onCall = async () => {
      if (calls.length === 1) await retryBilling(hub);
    };
    try {
      expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
    } finally {
      onCall = undefined;
    }
    await retryBilling(hub);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).not.toEqual({ scheduled_change: null });
    expect((await db.collection('billing').doc(pro.agent.id).get()).data()?.proRestorePending).toBeUndefined();
    expect(await linked(pro)).toBe(id);
  });

  // A sweep's Pro undo is in flight (its PATCH held) while the person accepts a new invite, whose cancel the PATCH then wipes.
  const undoRacesAccept = async (sub: string, sweep: () => Promise<unknown>, status: () => number = () => 200) => {
    const [owner, pro] = [await signIn('own'), await signIn('pro')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: sub, proRestorePending: true });
    await invite(owner, id, pro);
    calls.length = 0;
    let entered!: () => void;
    let release!: () => void;
    const [started, wait] = [new Promise<void>((r) => (entered = r)), new Promise<void>((r) => (release = r))];
    onCall = async () => {
      paddleStatus = status();
      if (calls.at(-1)?.method === 'PATCH') entered(), await wait;
    };
    try {
      const swept = sweep();
      await started;
      expect((await call(pro.token, 'POST', `/companies/${id}/accept`)).status).toBe(200);
      release();
      await swept;
    } finally {
      release();
      onCall = undefined;
      paddleStatus = 200;
    }
    const cancel = ['POST', `https://sandbox-api.paddle.com/subscriptions/${sub}/cancel`];
    expect(calls.map((c) => [c.method, c.url])).toEqual([['PATCH', `https://sandbox-api.paddle.com/subscriptions/${sub}`], cancel, cancel]);
    expect(await linked(pro)).toBe(id);
    return { pro, cancel, rec: async () => (await db.collection('billing').doc(pro.agent.id).get()).data() };
  };

  it('an undo in flight through /tick when a new accept cancels Pro makes the cancel again', async () => {
    const { rec } = await undoRacesAccept('sub_pro7', async () => expect((await call(undefined, 'POST', '/tick', undefined, { 'x-tick-secret': 'tick' })).status).toBe(200));
    expect(await rec()).not.toHaveProperty('proRestorePending');
    expect(await rec()).not.toHaveProperty('proCancelPending');
  });

  it('a re-made Pro cancel Paddle refuses is retried by the billing sweep', async () => {
    const { rec, cancel } = await undoRacesAccept('sub_pro8', () => retryBilling(hub), () => (calls.length === 3 ? 500 : 200));
    expect(await rec()).toMatchObject({ proCancelPending: true });
    calls.length = 0;
    await retryBilling(hub);
    expect(calls.map((c) => [c.method, c.url])).toEqual([cancel]);
    expect(await rec()).not.toHaveProperty('proCancelPending');
    expect(await rec()).not.toHaveProperty('proRestorePending');
  });

  // The sweep's undo (call 1) is held while a new accept fails; `at[i]` runs when Paddle call i comes in.
  const undoRacesFailedAccept = async (sub: string, at: Record<number, (ctx: { fill: () => Promise<void> }) => Promise<void>>) => {
    const [owner, pro, x, y] = [await signIn('own'), await signIn('pro'), await signIn('x'), await signIn('y')];
    const id = await company(owner);
    await db.collection('billing').doc(pro.agent.id).set({ plan: 'pro', paddleSubscriptionId: sub, proRestorePending: true });
    await invite(owner, id, pro);
    calls.length = 0;
    const fill = async () => {
      for (const p of [x, y]) await hub.registry.agentStore.update(p.agent.id, { billingAccountId: id });
    };
    onCall = () => at[calls.length]?.({ fill }) ?? Promise.resolve();
    const tick = call(undefined, 'POST', '/tick', undefined, { 'x-tick-secret': 'tick' });
    return { pro, tick, accept: () => call(pro.token, 'POST', `/companies/${id}/accept`), rec: async () => (await db.collection('billing').doc(pro.agent.id).get()).data() };
  };
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { open, p };
  };

  it("an undo in flight when a newer accept fails leaves Pro active, not cancelled again", async () => {
    const held = gate();
    const entered = gate();
    const { pro, tick, accept, rec } = await undoRacesFailedAccept('sub_pro9', {
      1: async () => (entered.open(), held.p),
      2: ({ fill }) => fill(),
    });
    try {
      await entered.p;
      expect((await accept()).status).toBe(402);
      held.open();
      expect((await tick).status).toBe(200);
    } finally {
      held.open();
      onCall = undefined;
    }
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST', 'PATCH']);
    expect(await linked(pro)).toBeUndefined();
    expect(await rec()).not.toHaveProperty('proRestorePending');
    expect(await rec()).not.toHaveProperty('proCancelPending');
  });

  it('an undo that re-cancels for a live claim whose accept then fails owes the undo again, and the sweep makes it', async () => {
    const [held, entered, recancel, recancelEntered] = [gate(), gate(), gate(), gate()];
    // 1: the sweep's undo, held until the accept's cancel (2) is in; it sees the live claim and cancels again (3), held
    // while the join fails and the accept undoes its cancel (4); the re-cancel lands last.
    const { pro, tick, accept, rec } = await undoRacesFailedAccept('sub_pro10', {
      1: async () => (entered.open(), held.p),
      2: async ({ fill }) => (held.open(), await recancelEntered.p, await fill()),
      3: async () => (recancelEntered.open(), recancel.p),
    });
    try {
      await entered.p;
      expect((await accept()).status).toBe(402);
      recancel.open();
      expect((await tick).status).toBe(200);
    } finally {
      [held, recancel, recancelEntered].forEach((g) => g.open());
      onCall = undefined;
    }
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST', 'POST', 'PATCH']);
    expect(await linked(pro)).toBeUndefined();
    expect(await rec()).toMatchObject({ proRestorePending: true });
    calls.length = 0;
    await retryBilling(hub);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['PATCH', 'https://sandbox-api.paddle.com/subscriptions/sub_pro10']]);
    expect(await rec()).not.toHaveProperty('proRestorePending');
    expect(await rec()).not.toHaveProperty('proCancelPending');
  });

  it('duplicate and concurrent removals of the same member lower the subscription once', async () => {
    const owner = await signIn('own');
    const id = await company(owner, { seats: 6, paddleSubscriptionId: 'sub_team2' });
    const [a, b] = await people(id, 'a', 'b', 'c', 'd', 'e');
    calls.length = 0;
    const res = await Promise.all([1, 2, 3].map(() => call(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.every((r) => [200, 404, 409].includes(r.status))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { items: [{ quantity: 5 }] } });
    // A repeat is a 404 with no Paddle call; the next member counts from the lowered quantity.
    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${a.agent.id}`)).status).toBe(404);
    expect(calls).toHaveLength(1);
    expect((await call(owner.token, 'DELETE', `/companies/${id}/members/${b.agent.id}`)).status).toBe(200);
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { items: [{ quantity: 4 }] } });
  });

  it('concurrent POST /companies make exactly one company', async () => {
    const owner = await signIn('racer');
    const res = await Promise.all(Array.from({ length: 5 }, () => call(owner.token, 'POST', '/companies', { name: 'Race' })));
    expect(res.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(res.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    const owned = (await db.collection('billing').where('owners', 'array-contains', owner.agent.id).get()).docs;
    expect(owned).toHaveLength(1);
  });

  it("/me/billing leaves out the person's own amounts when a company pays", async () => {
    const [owner, m] = [await signIn('own'), await signIn('m')];
    const id = await company(owner);
    expect((await call(m.token, 'GET', '/me/billing')).json).toHaveProperty('monthlyUsd');
    await hub.registry.agentStore.update(m.agent.id, { billingAccountId: id });
    const view = (await call(m.token, 'GET', '/me/billing')).json;
    expect(view.company).toMatchObject({ id });
    for (const k of ['monthlyUsd', 'extraUsd', 'leftUsd']) expect(view).not.toHaveProperty(k);
  });
});
