import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CREDIT_MICROS } from '../src/billing/billing.js';
import { newAgentOverHttp, testConfig, testDb } from './helpers.js';

describe('credit vouchers', () => {
  const db = testDb();
  const { app, hub } = createApp({ db, config: testConfig({ llmMonthlyAllowanceUsd: 0.01 }) });
  let server: Server;
  let base: string;
  let admin: string;
  let person: { token: string; id: string };
  let botToken: string;
  const oldAdmins = process.env.SUPER_ADMIN_EMAILS;
  const call = async (token: string | undefined, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const signIn = async (email: string) => {
    const res = await call(undefined, 'POST', '/auth/google', { idToken: `dev:${email}` });
    expect(res.status).toBe(200);
    return { token: res.body.token as string, id: res.body.agent.id as string };
  };
  const create = (code: string, maxUses = 30, credits = 10) => call(admin, 'POST', '/admin/vouchers', { code, credits, maxUses, validUntil: '2099-12-31' });
  const redeem = (token: string | undefined, code: string, extra = {}) => call(token, 'POST', '/me/vouchers/redeem', { code, ...extra });

  beforeAll(async () => {
    process.env.SUPER_ADMIN_EMAILS = 'voucher-root@admin.test';
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = (await signIn('voucher-root@admin.test')).token;
    person = await signIn('voucher-user@people.test');
    botToken = (await newAgentOverHttp(base, { name: 'voucher-bot' })).token;
  });
  afterAll(async () => {
    if (oldAdmins === undefined) delete process.env.SUPER_ADMIN_EMAILS; else process.env.SUPER_ADMIN_EMAILS = oldAdmins;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('uses the existing admin gate and rejects bot redemption and client-chosen recipients/amounts', async () => {
    for (const token of [undefined, person.token, botToken]) {
      expect((await call(token, 'GET', '/admin/vouchers')).status).toBe(404);
      expect((await call(token, 'POST', '/admin/vouchers', { code: 'nope' })).status).toBe(404);
      expect((await call(token, 'PATCH', '/admin/vouchers/nope', { active: false })).status).toBe(404);
    }
    expect((await redeem(undefined, 'nope')).status).toBe(401);
    expect((await redeem(botToken, 'nope')).status).toBe(403);
    expect((await create('Self_Only')).status).toBe(200);
    const result = await redeem(person.token, ' SELF_ONLY ', { ownerId: 'victim', credits: 999999 });
    expect(result).toMatchObject({ status: 200, body: { creditsAdded: 10, extraCredits: 10 } });
    expect((await hub.billing.get(person.id))?.extraMicros).toBe(10 * CREDIT_MICROS);
    expect(await hub.billing.get('victim')).toBeUndefined();
    expect((await redeem(person.token, 'self_only')).status).toBe(409);
  });

  it('validates immutable settings, case-insensitive uniqueness and UTC expiry boundary', async () => {
    const created = await create('Yay2026');
    expect(created).toMatchObject({ status: 200, body: { code: 'yay2026', redeemBefore: '2100-01-01T00:00:00.000Z', maxUses: 30, credits: 10 } });
    expect((await create('yay2026')).status).toBe(409);
    for (const change of [{ credits: 0 }, { credits: 0.5 }, { credits: Number.MAX_SAFE_INTEGER }, { maxUses: -1 }, { maxUses: 1.5 }, { validUntil: '2099-02-31' }, { validUntil: '2000-01-01' }, { code: '../bad' }]) {
      const result = await call(admin, 'POST', '/admin/vouchers', { code: 'invalid', credits: 10, maxUses: 1, validUntil: '2099-12-31', ...change });
      expect(result.status).toBe(400);
    }
    expect((await call(admin, 'PATCH', '/admin/vouchers/yay2026', { credits: 999 })).status).toBe(400);
    expect((await call(admin, 'PATCH', '/admin/vouchers/yay2026', { active: true })).status).toBe(400);
  });

  it('rejects expired, disabled, missing and exhausted vouchers without granting credits', async () => {
    await create('expired');
    await db.collection('vouchers').doc('expired').update({ redeemBefore: new Date().toISOString() });
    expect((await redeem(person.token, 'expired'))).toMatchObject({ status: 400, body: { error: 'This voucher has expired' } });
    await create('disabled');
    expect((await call(admin, 'PATCH', '/admin/vouchers/disabled', { active: false })).status).toBe(200);
    expect((await call(admin, 'PATCH', '/admin/vouchers/disabled', { active: false })).status).toBe(200);
    expect((await redeem(person.token, 'disabled')).status).toBe(409);
    expect((await redeem(person.token, 'missing')).status).toBe(404);
    expect((await hub.billing.get(person.id))?.extraMicros).toBe(10 * CREDIT_MICROS);
    const list = await call(admin, 'GET', '/admin/vouchers');
    expect(list.body.vouchers.find((v: any) => v.code === 'disabled').active).toBe(false);
  });

  it('grants once under concurrent retries for the same user', async () => {
    for (let round = 0; round < 3; round++) {
      const code = `retry-${round}`;
      const user = await signIn(`voucher-retry-${round}@people.test`);
      await create(code, 5);
      const results = await Promise.all(Array.from({ length: 5 }, () => redeem(user.token, code)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 200);
      expect(losers).toHaveLength(4);
      for (const result of losers) expect(result).toMatchObject({ status: 409, body: { error: 'You have already used this voucher' } });
      expect((await hub.billing.get(user.id))?.extraMicros).toBe(10 * CREDIT_MICROS);
      const voucher = db.collection('vouchers').doc(code);
      expect((await voucher.get()).data()?.usedCount).toBe(1);
      expect((await voucher.collection('redemptions').get()).size).toBe(1);
    }
  });

  it('never exceeds the unique-user cap under concurrent last-use claims', async () => {
    await create('last-use', 2);
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => signIn(`voucher-race-${i}@people.test`)));
    const results = await Promise.all(users.map((u) => redeem(u.token, 'last-use')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const balances = await Promise.all(users.map((u) => hub.billing.get(u.id)));
    expect(balances.reduce((n, r) => n + (r?.extraMicros ?? 0), 0)).toBe(20 * CREDIT_MICROS);
    expect((await db.collection('vouchers').doc('last-use').get()).data()?.usedCount).toBe(2);
  });

  it('stacks with existing credits, preserves the plan and spends the monthly allowance first', async () => {
    const user = await signIn('voucher-plan@people.test');
    await hub.billing.setPlan(user.id, { plan: 'pro', allowanceUsd: 0.01, maxParticipants: 7 });
    await db.collection('billing').doc(user.id).set({ extraMicros: 2 * CREDIT_MICROS }, { merge: true });
    await create('stack');
    expect((await redeem(user.token, 'stack'))).toMatchObject({ status: 200, body: { creditsAdded: 10, extraCredits: 12 } });
    expect(await hub.billing.get(user.id)).toMatchObject({ plan: 'pro', allowanceUsd: 0.01, maxParticipants: 7, extraMicros: 12 * CREDIT_MICROS });
    await hub.llm.charge(user.id, 1);
    expect((await hub.billing.get(user.id))?.extraMicros).toBe(12 * CREDIT_MICROS);
    await hub.llm.charge(user.id, 1);
    expect((await hub.billing.get(user.id))?.extraMicros).toBe(11 * CREDIT_MICROS);
  });
  it('does not consume a use when the balance would overflow, and serializes disable against redemption', async () => {
    const user = await signIn('voucher-overflow@people.test');
    await db.collection('billing').doc(user.id).set({ ownerId: user.id, plan: 'free', extraMicros: Number.MAX_SAFE_INTEGER });
    await create('overflow');
    expect((await redeem(user.token, 'overflow')).status).toBe(400);
    expect((await db.collection('vouchers').doc('overflow').get()).data()?.usedCount).toBe(0);
    expect((await db.collection('vouchers').doc('overflow').collection('redemptions').get()).size).toBe(0);
    const racer = await signIn('voucher-disable-race@people.test');
    await create('disable-race', 1);
    const [claim, disabled] = await Promise.all([redeem(racer.token, 'disable-race'), call(admin, 'PATCH', '/admin/vouchers/disable-race', { active: false })]);
    expect(disabled.status).toBe(200);
    expect([200, 409]).toContain(claim.status);
    const doc = (await db.collection('vouchers').doc('disable-race').get()).data()!;
    expect(doc.active).toBe(false);
    expect(doc.usedCount).toBe(claim.status === 200 ? 1 : 0);
    expect((await hub.billing.get(racer.id))?.extraMicros ?? 0).toBe(claim.status === 200 ? 10 * CREDIT_MICROS : 0);
  });

});
