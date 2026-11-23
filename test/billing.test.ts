import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { verifyPaddleSignature, limitsOf } from '../src/billing/billing.js';
import { httpCaller, testConfig, testDb, testPerson } from './helpers.js';

const SECRET = 'pdl_ntfset_test';
const PADDLE = { apiKey: 'pdl_sdbx_key', webhookSecret: SECRET, clientToken: 'test_tok', environment: 'sandbox' as const, prices: { pro: 'pri_pro', topups: { '10': 'pri_t10' } } };
const CLOUD = { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } };

const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => `ts=${ts};h1=${createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex')}`;

describe('Paddle signatures', () => {
  it('accepts a fresh, correct one and nothing else', () => {
    const body = '{"a":1}';
    expect(verifyPaddleSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
    expect(verifyPaddleSignature(Buffer.from('{"a":2}'), sign(body), SECRET)).toBe(false);
    expect(verifyPaddleSignature(Buffer.from(body), sign(body, Math.floor(Date.now() / 1000) - 600), SECRET)).toBe(false);
    expect(verifyPaddleSignature(Buffer.from(body), undefined, SECRET)).toBe(false);
  });

  it('accepts signatures during rotation when multiple h1 values are present', () => {
    const body = '{"rotation":true}';
    const ts = Math.floor(Date.now() / 1000);
    const oldSig = createHmac('sha256', 'old_secret').update(`${ts}:${body}`).digest('hex');
    const newSig = createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex');
    const header = `ts=${ts};h1=${oldSig};h1=${newSig}`;
    expect(verifyPaddleSignature(Buffer.from(body), header, SECRET)).toBe(true);
    expect(verifyPaddleSignature(Buffer.from(body), header, 'old_secret')).toBe(true);
    expect(verifyPaddleSignature(Buffer.from(body), header, 'wrong_secret')).toBe(false);
  });
});

describe('plans', () => {
  it('Paddle sets the plan, top-ups are spent after the month, and the plan sets workspace limits', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ paddle: PADDLE, cloudAgents: CLOUD, llmMonthlyAllowanceUsd: 2 }) });
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/billing/paddle`;
    const post = (event: object, signature?: string) => {
      const body = JSON.stringify(event);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': signature ?? sign(body) }, body });
    };
    try {
      const person = await testPerson(hub.registry, 'Payer');
      expect(await hub.llm.limits(person.id)).toMatchObject({ plan: 'free', monthlyMicros: 2_000_000, maxWorkspaces: 2, maxParticipants: 8 });

      // An admin's override changes one person's limits, and null clears it.
      await hub.billing.setPlan(person.id, { plan: 'free', maxWorkspaces: 4 });
      expect((await hub.llm.limits(person.id)).maxWorkspaces).toBe(4);
      await hub.billing.setPlan(person.id, { plan: 'free', maxWorkspaces: null });
      expect((await hub.llm.limits(person.id)).maxWorkspaces).toBe(2);

      // A forged event changes nothing.
      const sub = { event_id: 'evt_1', event_type: 'subscription.created', data: { id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { ownerId: person.id }, current_billing_period: { ends_at: '2026-11-19T00:00:00Z' } } };
      expect((await post(sub, 'ts=1;h1=00')).status).toBe(401);
      expect((await hub.llm.limits(person.id)).plan).toBe('free');

      // Subscribing makes them Pro, once even when Paddle retries.
      expect(await (await post(sub)).json()).toMatchObject({ outcome: 'done' });
      expect(await (await post(sub)).json()).toMatchObject({ outcome: 'seen' });
      expect(await hub.llm.limits(person.id)).toMatchObject({ plan: 'pro', monthlyMicros: 30_000_000, maxWorkspaces: 10, maxParticipants: 50 });
      await hub.createCloudAgent(person, { name: 'D' });

      // A $10 top-up (one pack, 1,000 credits): spent only once the month's 3,000 credits are. Model calls cost twice ours.
      await post({ event_id: 'evt_2', event_type: 'transaction.completed', data: { id: 'txn_1', customer_id: 'ctm_1', custom_data: { ownerId: person.id }, items: [{ price: { id: 'pri_t10' }, quantity: 1 }] } });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(10_000_000);
      // A company pool top-up (the workspace owner buys with billingAccountId) credits the workspace's record, not the buyer's.
      const pool = await hub.registry.createWorkspace(person, 'pool-co');
      await post({ event_id: 'evt_pool', event_type: 'transaction.completed', data: { id: 'txn_pool', customer_id: 'ctm_1', custom_data: { billingAccountId: pool.id, ownerId: person.id }, items: [{ price: { id: 'pri_t10' }, quantity: 1 }] } });
      expect(await hub.billing.get(pool.id)).toMatchObject({ extraMicros: 10_000_000 });
      expect((await hub.billing.get(pool.id))?.paddleCustomerId).toBeUndefined();
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(10_000_000);
      await hub.llm.add(person.id, 12_000_000); // 24 of the month
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(10_000_000);
      await hub.llm.add(person.id, 4_000_000); // 6 more of the month, then 2 of the top-up
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(8_000_000);
      await hub.llm.charge(person.id, 300); // an app action or event costs credits too: 3 more of the top-up
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(5_000_000);
      expect(await hub.llm.used(person.id)).toBeCloseTo(35 / 40);
      expect(await hub.llm.balance(person.id)).toEqual({ spentMicros: 35_000_000, capMicros: 40_000_000 }); // 500 credits left

      // Cancelled: back to Free, the top-up balance stays.
      await post({ event_id: 'evt_3', event_type: 'subscription.canceled', data: { id: 'sub_1', status: 'canceled', customer_id: 'ctm_1' } });
      expect(await hub.llm.limits(person.id)).toMatchObject({ plan: 'free', extraMicros: 5_000_000 });

      // An admin's Enterprise deal: their numbers, and Paddle doesn't undo it.
      await hub.billing.setPlan(person.id, { plan: 'enterprise', allowanceUsd: 500, maxParticipants: 50 });
      await post({ event_id: 'evt_4', event_type: 'subscription.updated', data: { id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { ownerId: person.id } } });
      expect(await hub.llm.limits(person.id)).toMatchObject({ plan: 'enterprise', monthlyMicros: 500_000_000, maxParticipants: 50 });

      // Malformed JSON with a valid signature returns 400 (not 500).
      const badJson = '{not-json';
      const badRes = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'paddle-signature': sign(badJson) },
        body: badJson,
      });
      expect(badRes.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('Paddle webhook edge cases', () => {
  it('a late cancel of an old subscription, an admin override, a lapsed period and a retried top-up are all handled', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ paddle: PADDLE, cloudAgents: CLOUD, llmMonthlyAllowanceUsd: 2 }) });
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/billing/paddle`;
    const post = (event: object) => {
      const body = JSON.stringify(event);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign(body) }, body });
    };
    try {
      const person = await testPerson(hub.registry, 'Resubscriber');
      const sub = (id: string, eventId: string, status: string) => ({ event_id: eventId, event_type: status === 'active' ? 'subscription.created' : 'subscription.canceled', data: { id, status, customer_id: 'ctm_9', custom_data: { ownerId: person.id } } });
      await post(sub('sub_old', 'e1', 'active'));
      await post(sub('sub_new', 'e2', 'active')); // subscribed again
      // The old subscription's cancel arrives late: they stay Pro on the new one.
      expect(await (await post(sub('sub_old', 'e3', 'canceled'))).json()).toMatchObject({ outcome: 'ignored' });
      expect((await hub.llm.limits(person.id)).plan).toBe('pro');

      // An admin's allowance bump while Pro doesn't survive Paddle moving them back to Free.
      await hub.billing.setPlan(person.id, { plan: 'pro', allowanceUsd: 100 });
      await post(sub('sub_new', 'e4', 'canceled'));
      expect(await hub.llm.limits(person.id)).toMatchObject({ plan: 'free', monthlyMicros: 2_000_000 });

      // The same top-up delivered three times at once is credited exactly once.
      const topup = { event_id: 'e5', event_type: 'transaction.completed', data: { id: 'txn_9', customer_id: 'ctm_9', custom_data: { ownerId: person.id }, items: [{ price: { id: 'pri_t10' }, quantity: 1 }] } };
      const outcomes = await Promise.all([post(topup), post(topup), post(topup)].map(async (r) => ((await (await r).json()) as { outcome: string }).outcome));
      expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(10_000_000);
    } finally {
      server.close();
    }
  });

  it('a stale subscription event delivered after a newer one is ignored', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ paddle: PADDLE, cloudAgents: CLOUD, llmMonthlyAllowanceUsd: 2 }) });
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/billing/paddle`;
    const post = (event: object) => {
      const body = JSON.stringify(event);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign(body) }, body });
    };
    try {
      const person = await testPerson(hub.registry, 'Reorderer');
      const data = (status: string) => ({ id: 'sub_r', status, customer_id: 'ctm_r', custom_data: { ownerId: person.id } });
      await post({ event_id: 'r2', event_type: 'subscription.updated', occurred_at: '2026-11-02T00:00:00.000000Z', data: data('active') });
      // The earlier cancel, retried by Paddle, arrives after the newer `active`: they stay Pro.
      expect(await (await post({ event_id: 'r1', event_type: 'subscription.updated', occurred_at: '2026-11-01T00:00:00.000000Z', data: data('canceled') })).json()).toMatchObject({ outcome: 'ignored' });
      expect((await hub.llm.limits(person.id)).plan).toBe('pro');
    } finally {
      server.close();
    }
  });

  it('a Pro plan cancelled at period end is Free once the period is over, even without the final webhook', () => {
    const rec = { ownerId: 'p', plan: 'pro' as const, cancelAtPeriodEnd: true, periodEnd: '2026-01-01T00:00:00Z', allowanceUsd: 100 };
    expect(limitsOf(rec, 2_000_000, Date.parse('2025-12-31T00:00:00Z'))).toMatchObject({ plan: 'pro', monthlyMicros: 100_000_000 });
    expect(limitsOf(rec, 2_000_000, Date.parse('2026-01-02T00:00:00Z'))).toMatchObject({ plan: 'free', monthlyMicros: 2_000_000 });
    expect(limitsOf({ ...rec, cancelAtPeriodEnd: false }, 2_000_000, Date.parse('2026-01-02T00:00:00Z')).plan).toBe('pro');
  });

  it('claws back top-up extraMicros on approved Paddle refund/chargeback adjustments and restores debitIfEnough charges via refund(key) once', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ paddle: PADDLE, cloudAgents: CLOUD, llmMonthlyAllowanceUsd: 1 }) });
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/billing/paddle`;
    const post = (event: object) => {
      const body = JSON.stringify(event);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign(body) }, body });
    };
    try {
      const person = await testPerson(hub.registry, 'Refunder');

      // Credit a $10 top-up (10_000_000 micros = 1,000 credits) on top of $1 monthly allowance (100 credits).
      await post({
        event_id: 'adj_topup_1',
        event_type: 'transaction.completed',
        data: { id: 'txn_adj_1', customer_id: 'ctm_adj', custom_data: { ownerId: person.id }, items: [{ price: { id: 'pri_t10' }, quantity: 1 }] },
      });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(10_000_000);

      // debitIfEnough spends monthly allowance first (100 credits), then top-ups (200 credits), idempotently per key.
      expect(await hub.llm.debitIfEnough(person.id, 300, 'debit_1')).toBe(true);
      expect(await hub.llm.debitIfEnough(person.id, 300, 'debit_1')).toBe(true); // repeat key is free
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(8_000_000);
      expect(await hub.llm.balance(person.id)).toEqual({ spentMicros: 3_000_000, capMicros: 11_000_000 });

      // Insufficient balance returns false without spending anything.
      expect(await hub.llm.debitIfEnough(person.id, 900, 'debit_too_much')).toBe(false);
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(8_000_000);

      // refund(key) restores both monthly usage and extraMicros once (idempotent on repeat).
      await hub.llm.refund('debit_1');
      await hub.llm.refund('debit_1');
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(10_000_000);
      expect(await hub.llm.balance(person.id)).toEqual({ spentMicros: 0, capMicros: 11_000_000 });

      // Spend 400 credits (100 monthly + 300 extra -> 7_000_000 extraMicros remaining) before a Paddle refund adjustment.
      expect(await hub.llm.debitIfEnough(person.id, 400, 'debit_2')).toBe(true);
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(7_000_000);

      // Pending adjustment is ignored; approved adjustment resolves owner via customer_id (when custom_data and subscription_id are absent) and claws back once per adjustment ID.
      const paddleAdjustmentItem = {
        id: 'adjitm_1',
        item_id: 'txnitm_1',
        type: 'full',
        amount: '1000',
        proration: null,
        totals: { subtotal: '1000', tax: '0', total: '1000' },
      };
      expect(
        await (
          await post({
            event_id: 'adj_pending',
            event_type: 'adjustment.created',
            data: {
              id: 'adj_1',
              transaction_id: 'txn_adj_1',
              customer_id: 'ctm_adj',
              status: 'pending_approval',
              action: 'refund',
              items: [paddleAdjustmentItem],
              totals: { subtotal: '1000', tax: '0', total: '1000', currency_code: 'USD' },
            },
          })
        ).json(),
      ).toMatchObject({ outcome: 'ignored' });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(7_000_000);

      // Add a second $10 top-up so balance is 17_000_000 before the $10 refund adjustment.
      await post({
        event_id: 'adj_topup_2',
        event_type: 'transaction.completed',
        data: { id: 'txn_adj_2', customer_id: 'ctm_adj', custom_data: { ownerId: person.id }, items: [{ price: { id: 'pri_t10' }, quantity: 1 }] },
      });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(17_000_000);

      expect(
        await (
          await post({
            event_id: 'adj_approved_1',
            event_type: 'adjustment.created',
            data: {
              id: 'adj_1',
              transaction_id: 'txn_adj_1',
              customer_id: 'ctm_adj',
              status: 'approved',
              action: 'refund',
              items: [paddleAdjustmentItem],
              totals: { subtotal: '1000', tax: '0', total: '1000', currency_code: 'USD' },
            },
          })
        ).json(),
      ).toMatchObject({ outcome: 'done' });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(7_000_000);

      // A subsequent adjustment.updated event for the same adjustment ID does not claw back a second time.
      expect(
        await (
          await post({
            event_id: 'adj_approved_2',
            event_type: 'adjustment.updated',
            data: {
              id: 'adj_1',
              transaction_id: 'txn_adj_1',
              customer_id: 'ctm_adj',
              status: 'approved',
              action: 'refund',
              items: [paddleAdjustmentItem],
              totals: { subtotal: '1000', tax: '0', total: '1000', currency_code: 'USD' },
            },
          })
        ).json(),
      ).toMatchObject({ outcome: 'ignored' });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(7_000_000);

      // An approved refund on a transaction that isn't a top-up (e.g. a Pro subscription invoice) is ignored and leaves extraMicros untouched.
      expect(
        await (
          await post({
            event_id: 'adj_sub_refund',
            event_type: 'adjustment.updated',
            data: {
              id: 'adj_sub_1',
              transaction_id: 'txn_sub_pro_1',
              customer_id: 'ctm_adj',
              status: 'approved',
              action: 'refund',
              items: [{ id: 'adjitm_sub', item_id: 'txnitm_sub', type: 'full', amount: '2000', proration: null, totals: { subtotal: '2000', tax: '0', total: '2000' } }],
              totals: { subtotal: '2000', tax: '0', total: '2000', currency_code: 'USD' },
            },
          })
        ).json(),
      ).toMatchObject({ outcome: 'ignored' });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(7_000_000);

      // A partial refund adjustment ($4.00 = 400 cents via items[].amount) claws back 4_000_000 micros.
      expect(
        await (
          await post({
            event_id: 'adj_approved_partial',
            event_type: 'adjustment.updated',
            data: {
              id: 'adj_partial',
              transaction_id: 'txn_adj_2',
              customer_id: 'ctm_adj',
              status: 'approved',
              action: 'refund',
              items: [{ id: 'adjitm_2', item_id: 'txnitm_2', type: 'partial', amount: '400', proration: null, totals: { subtotal: '400', tax: '0', total: '400' } }],
            },
          })
        ).json(),
      ).toMatchObject({ outcome: 'done' });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(3_000_000);

      // A subsequent distinct chargeback adjustment claws back remaining extraMicros (capped at currentExtra).
      expect(
        await (
          await post({
            event_id: 'adj_approved_3',
            event_type: 'adjustment.updated',
            data: {
              id: 'adj_2',
              transaction_id: 'txn_adj_2',
              customer_id: 'ctm_adj',
              status: 'approved',
              action: 'chargeback',
              items: [paddleAdjustmentItem],
              totals: { subtotal: '1000', tax: '0', total: '1000', currency_code: 'USD' },
            },
          })
        ).json(),
      ).toMatchObject({ outcome: 'done' });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(0);
    } finally {
      server.close();
    }
  });

  it('two partial refunds on one transaction claw back only the amount that transaction credited', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ paddle: PADDLE, cloudAgents: CLOUD, llmMonthlyAllowanceUsd: 1 }) });
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/billing/paddle`;
    const post = (event: object) => {
      const body = JSON.stringify(event);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign(body) }, body });
    };
    const refund = (adjId: string, txn: string, cents: string) =>
      post({
        event_id: `evt_${adjId}`,
        event_type: 'adjustment.created',
        data: {
          id: adjId,
          transaction_id: txn,
          customer_id: 'ctm_two',
          status: 'approved',
          action: 'refund',
          items: [{ id: `adjitm_${adjId}`, item_id: 'txnitm', type: 'partial', amount: cents, proration: null, totals: { subtotal: cents, tax: '0', total: cents } }],
        },
      });
    try {
      const person = await testPerson(hub.registry, 'TwoRefunds');
      // Two $10 top-ups on distinct transactions -> 20_000_000 extraMicros. The second keeps the
      // live balance well above the per-refund clawback, so currentExtra never becomes the cap —
      // the per-transaction recorded top-up is what must bound the clawback.
      for (const txn of ['txn_two_a', 'txn_two_b']) {
        await post({
          event_id: `evt_topup_${txn}`,
          event_type: 'transaction.completed',
          data: { id: txn, customer_id: 'ctm_two', custom_data: { ownerId: person.id }, items: [{ price: { id: 'pri_t10' }, quantity: 1 }] },
        });
      }
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(20_000_000);

      // Two distinct $6 refund adjustments both against txn_two_a (a $10 top-up). Together they must
      // claw back at most the $10 that transaction credited, not $6 twice against the full top-up.
      expect(await (await refund('adj_two_1', 'txn_two_a', '600')).json()).toMatchObject({ outcome: 'done' });
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(14_000_000);
      expect(await (await refund('adj_two_2', 'txn_two_a', '600')).json()).toMatchObject({ outcome: 'done' });
      // Fix: second refund claws only the remaining $4 of txn_two_a -> 10_000_000. Bug clawed $6 again -> 8_000_000.
      expect((await hub.llm.limits(person.id)).extraMicros).toBe(10_000_000);
    } finally {
      server.close();
    }
  });
});

describe('Team plan', () => {
  it('a Team subscription sets the pool to team with seats×15 (3-seat floor), refuses steering, and lifts members to Pro caps', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ paddle: { ...PADDLE, prices: { ...PADDLE.prices, team: 'pri_team' } }, cloudAgents: CLOUD }) });
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/billing/paddle`;
    const post = (event: object) => {
      const body = JSON.stringify(event);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': sign(body) }, body });
    };
    const teamSub = (id: string, ownerId: string, billingAccountId: string, quantity: number, status = 'active', type = 'subscription.created') => ({
      event_id: id,
      event_type: type,
      data: { id: `sub_${id}`, status, customer_id: `ctm_${id}`, custom_data: { ownerId, billingAccountId }, items: [{ price: { id: 'pri_team' }, quantity }], current_billing_period: { ends_at: '2099-01-01T00:00:00Z' } },
    });
    try {
      const owner = await testPerson(hub.registry, 'Owner');
      const mallory = await testPerson(hub.registry, 'Mallory');
      const ws = await hub.registry.createWorkspace(owner, 'co');

      // Steering: Mallory names someone else's workspace, or a person, as the pool: nothing becomes team.
      await post(teamSub('e1', mallory.id, ws.id, 5));
      await post(teamSub('e2', mallory.id, owner.id, 5));
      for (const id of [ws.id, owner.id, mallory.id]) expect((await hub.billing.get(id))?.plan ?? 'free').not.toBe('team');

      // Under 3 seats grants nothing (checkout enforces 3+; a tampered quantity is ignored).
      await post(teamSub('e2b', owner.id, ws.id, 2));
      expect((await hub.billing.get(ws.id))?.plan ?? 'free').not.toBe('team');
      // A Pro subscription naming the workspace as its owner never writes onto the workspace doc.
      await post({ event_id: 'p1', event_type: 'subscription.created', data: { id: 'sub_p1', status: 'active', customer_id: 'ctm_p1', custom_data: { ownerId: ws.id }, items: [{ price: { id: 'pri_pro' }, quantity: 1 }] } });
      expect(await hub.billing.get(ws.id)).toBeUndefined();

      // The owner buys 3 seats for their own workspace: team ($45), Pro-sized caps; their own doc stays as it was.
      await post(teamSub('e3', owner.id, ws.id, 3));
      expect(await hub.billing.get(ws.id)).toMatchObject({ plan: 'team', seats: 3 });
      expect(await hub.llm.limits(ws.id)).toMatchObject({ plan: 'team', monthlyMicros: 45_000_000, maxWorkspaces: 10, maxParticipants: 50 });
      expect((await hub.billing.get(owner.id))?.plan ?? 'free').toBe('free');
      await post({ ...teamSub('e4', owner.id, ws.id, 7, 'active', 'subscription.updated'), data: { ...teamSub('e3', owner.id, ws.id, 7).data } });
      expect((await hub.llm.limits(ws.id)).monthlyMicros).toBe(105_000_000);
      // The Free owner's Team workspace takes Pro's participant cap, not Free's 8.
      expect(await hub.registry.workspaceUsage(ws)).toMatchObject({ max: 50, plan: 'pro' });
      // A second Team subscription for the same pool (anyone who knows the owner's id) can't replace the first.
      await post(teamSub('e6', owner.id, ws.id, 3));
      expect(await hub.billing.get(ws.id)).toMatchObject({ paddleSubscriptionId: 'sub_e3', seats: 7 });
      await post({ ...teamSub('e7', owner.id, ws.id, 3, 'canceled', 'subscription.canceled'), data: teamSub('e6', owner.id, ws.id, 3, 'canceled').data });
      expect(await hub.billing.get(ws.id)).toMatchObject({ plan: 'team', paddleSubscriptionId: 'sub_e3', seats: 7 });
      // The pool's own subscription stays routed to it after a Team price rotation.
      await post({ event_id: 'e8', event_type: 'subscription.updated', data: { ...teamSub('e3', owner.id, ws.id, 4).data, custom_data: { ownerId: owner.id }, items: [{ price: { id: 'pri_team_v2' }, quantity: 4 }] } });
      expect(await hub.billing.get(ws.id)).toMatchObject({ plan: 'team', paddleSubscriptionId: 'sub_e3', seats: 4 });
      expect((await hub.billing.get(owner.id))?.plan ?? 'free').toBe('free');

      // A lapsed Team subscription (cancelled, period over) no longer blocks a new one.
      const ws2 = await hub.registry.createWorkspace(owner, 'co2');
      await post({ ...teamSub('l1', owner.id, ws2.id, 3), data: { ...teamSub('l1', owner.id, ws2.id, 3).data, scheduled_change: { action: 'cancel' }, current_billing_period: { ends_at: '2000-01-01T00:00:00Z' } } });
      expect((await hub.llm.limits(ws2.id)).plan).toBe('free');
      await post(teamSub('l2', owner.id, ws2.id, 5));
      expect(await hub.billing.get(ws2.id)).toMatchObject({ plan: 'team', paddleSubscriptionId: 'sub_l2', seats: 5 });

      // A member billed to the pool owns workspaces on Pro caps, not Free's 2.
      const member = await testPerson(hub.registry, 'Member');
      await hub.registry.agentStore.update(member.id, { billingAccountId: ws.id });
      for (const name of ['m1', 'm2', 'm3']) await hub.registry.createWorkspace(member, name);

      // Cancelling drops the pool back to free, and the member back to Free caps.
      await post({ ...teamSub('e5', owner.id, ws.id, 7, 'canceled', 'subscription.canceled'), data: { ...teamSub('e3', owner.id, ws.id, 7, 'canceled').data } });
      expect((await hub.llm.limits(ws.id)).plan).toBe('free');
      expect((await hub.registry.workspaceUsage(ws)).plan).toBe('free');
      await expect(hub.registry.createWorkspace(member, 'm4')).rejects.toThrow('Free plan');
    } finally {
      server.close();
    }
  });
});

describe('Enterprise leads', () => {
  it('are kept for Admin and emailed to the super admins', async () => {
    const { Admin } = await import('../src/admin/admin.js');
    const db = testDb();
    const { hub } = createApp({ db, config: testConfig() });
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const admin = new Admin(db, hub, async (to, subject, text) => void sent.push({ to, subject, text }));
    const before = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = 'boss@admin.test, ops@admin.test';
    try {
      const person = await testPerson(hub.registry, 'Buyer');
      await expect(admin.addEnterpriseLead(person, {})).rejects.toThrow(/company or what you need/);
      await admin.addEnterpriseLead(person, { company: 'Acme', size: '40 people', message: 'Agents for support' });
      expect((await admin.enterpriseLeads()).map((l) => [l.company, l.size, l.email])).toEqual([['Acme', '40 people', person.email]]);
      expect(sent).toEqual([{ to: ['boss@admin.test', 'ops@admin.test'], subject: 'Parly Enterprise: Acme', text: expect.stringContaining('Agents for support') }]);
      // While checkout is closed, wanting Pro is a lead too: who, and which plan, with nothing else to fill in.
      await admin.addEnterpriseLead(person, { plan: 'pro-yearly' });
      expect((await admin.enterpriseLeads())[0]).toMatchObject({ plan: 'pro-yearly', email: person.email });
      expect(sent[1]).toMatchObject({ subject: `Parly Pro yearly ($200/year) request: ${person.name}`, text: expect.stringContaining(person.email!) });
    } finally {
      process.env.SUPER_ADMIN_EMAILS = before;
    }
  });
});

describe('workspace budget', () => {
  it('owners and co-owners set it, members and outsiders cannot, bad values are refused, and it shows in billing', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }) });
    const server = app.listen(0);
    const call = httpCaller(() => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const signIn = async (name: string) => (await call(undefined, 'POST', '/auth/google', { idToken: `dev:${name}-${Date.now()}@people.test` })).json as { token: string; agent: { id: string; email: string } };
    try {
      const [owner, co, member, outsider] = [await signIn('own'), await signIn('co'), await signIn('mem'), await signIn('out')];
      const ownerRec = (await hub.registry.get(owner.agent.id))!;
      const ws = await hub.registry.createWorkspace(ownerRec, 'Acme', { unchecked: true });
      for (const p of [co, member]) expect((await call(owner.token, 'POST', `/workspaces/${ws.id}/invites`, { email: p.agent.email })).status).toBe(200);
      await hub.registry.addWorkspaceOwner(ownerRec, ws.id, co.agent.id);
      const put = (token: string, body: unknown) => call(token, 'PUT', `/workspaces/${ws.id}/budget`, body);

      expect((await put(owner.token, { credits: 5 })).json).toEqual({ workspaceId: ws.id, budgetCredits: 5 });
      expect((await call(owner.token, 'GET', `/workspaces/${ws.id}/billing`)).json).toMatchObject({ budgetCredits: 5, spentCredits: 0 });
      expect((await put(co.token, { credits: 7.5 })).json).toMatchObject({ budgetCredits: 7.5 });
      expect((await put(member.token, { credits: 100 })).status).toBe(403);
      expect((await call(member.token, 'GET', `/workspaces/${ws.id}/billing`)).status).toBe(403);
      expect((await put(outsider.token, { credits: 100 })).status).toBe(404);
      for (const credits of [-1, '5', Number.MAX_VALUE, undefined]) expect((await put(owner.token, { credits })).status).toBe(400);
      expect((await call(co.token, 'GET', `/workspaces/${ws.id}/billing`)).json.budgetCredits).toBe(7.5);

      await put(owner.token, { credits: 0 });
      expect((await call(owner.token, 'GET', `/workspaces/${ws.id}/billing`)).json.blockedBy).toBe('budget');
      expect((await put(owner.token, { credits: null })).json.budgetCredits).toBeNull();
      expect((await call(owner.token, 'GET', `/workspaces/${ws.id}/billing`)).json).toMatchObject({ budgetCredits: null });
    } finally {
      server.close();
    }
  });
});
