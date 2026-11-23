import { describe, expect, it, vi } from 'vitest';
import { Billing } from '../src/billing/billing.js';
import { payerName } from '../src/billing/payer.js';
import { LlmMeter } from '../src/llm/llm.js';
import { usedByPayer } from '../src/rest/account.js';
import type { Database } from '../src/db/types.js';
import type { AgentRecord } from '../src/registry/types.js';

const PADDLE = { apiKey: 'k', webhookSecret: 's', clientToken: 't', environment: 'sandbox' as const, prices: { pro: 'pri_pro', topups: { '10': 'pri_t10' } } };

function billing(workspaces: string[]) {
  const b = new Billing({} as Database, PADDLE);
  vi.spyOn(b.store, 'isWorkspace').mockImplementation(async (id) => workspaces.includes(id));
  const topup = vi.spyOn(b.store, 'handleTopupTransaction').mockResolvedValue('done');
  const sub = vi.spyOn(b.store, 'handleSubscriptionEvent').mockResolvedValue('done');
  vi.spyOn(b.store, 'ownerOfSubscription').mockResolvedValue('sub-owner');
  vi.spyOn(b.store, 'ownerOfCustomer').mockResolvedValue('cus-owner');
  return { b, topup, sub };
}
const topupEvent = (billingAccountId: string) => ({
  event_id: 'evt',
  event_type: 'transaction.completed',
  occurred_at: '2026-11-15T00:00:00Z',
  data: { id: 'txn', customer_id: 'ctm', custom_data: { billingAccountId, ownerId: 'buyer' }, items: [{ price: { id: 'pri_t10' }, quantity: 1 }] },
});

describe('pool top-up webhook', () => {
  it("ignores a billingAccountId that is a person's id: credits the buyer, never touches that person", async () => {
    const { b, topup } = billing(['ws']);
    await b.handle(topupEvent('victim') as never);
    expect(topup).toHaveBeenCalledWith('evt', 'transaction.completed', 'buyer', 'txn', 'ctm', 10_000_000, expect.any(String));
  });

  it('credits a real workspace pool without setting its paddleCustomerId', async () => {
    const { b, topup } = billing(['ws']);
    await b.handle(topupEvent('ws') as never);
    expect(topup).toHaveBeenCalledWith('evt', 'transaction.completed', 'ws', 'txn', undefined, 10_000_000, expect.any(String));
  });

  it('ignores billingAccountId on anything but a top-up', async () => {
    const { b, sub } = billing(['ws']);
    await b.handle({ event_id: 'evt', event_type: 'subscription.created', occurred_at: 'x', data: { id: 'sub', customer_id: 'ctm', custom_data: { billingAccountId: 'ws' } } } as never);
    expect(sub.mock.calls[0]?.[2]).toBe('sub-owner');
  });
});

describe('company pool spend', () => {
  it('rewards the referral to the person, not the pool that pays', async () => {
    const meter = new LlmMeter({} as Database, 1);
    const reward = vi.spyOn(meter, 'rewardReferral').mockResolvedValue();
    vi.spyOn(meter.store, 'recordAgentUsage').mockResolvedValue();
    await meter.add('ws', 0, { id: 'bot', usage: {} as never }, undefined, { personId: 'person' });
    expect(reward).toHaveBeenCalledWith('person');
  });

  it("reports a linked member's used ratio from the pool, not their own allowance", async () => {
    const me = { id: 'p', billingAccountId: 'ws' } as AgentRecord;
    const ratio: Record<string, number> = { p: 1, ws: 0.25 };
    const llm = { payerOf: async (a: Pick<AgentRecord, 'id'>) => (a.id === 'p' ? 'ws' : a.id), used: async (id: string) => ratio[id] ?? 0 };
    expect(await usedByPayer(llm, me)).toBe(0.25);
    Object.assign(ratio, { p: 0, ws: 1.5 });
    expect(await usedByPayer(llm, me)).toBe(1);
  });

  it('stops a pool at its monthly budget even with allowance left; unset behaves as before; raising it unblocks', async () => {
    const meter = new LlmMeter({} as Database, 1);
    const billing = { ownerId: 'ws', plan: 'team' as const, allowanceUsd: 10 } as { ownerId: string; plan: 'team'; allowanceUsd: number; budgetMicros?: number };
    vi.spyOn(meter.store, 'getUsageAndBilling').mockImplementation(async () => ({ usage: { micros: 2_000_000 } as never, billing }));
    expect(await meter.used('ws')).toBeCloseTo(0.2);
    expect(await meter.blockedBy('ws')).toBeUndefined();
    billing.budgetMicros = 2_000_000;
    expect(await meter.used('ws')).toBe(1);
    expect(await meter.hasCredits('ws')).toBe(false);
    expect(await meter.blockedBy('ws')).toBe('budget');
    billing.budgetMicros = 0;
    expect(await meter.blockedBy('ws')).toBe('budget');
    billing.budgetMicros = 4_000_000;
    expect(await meter.used('ws')).toBeCloseTo(0.5);
    expect(await meter.blockedBy('ws')).toBeUndefined();
    billing.allowanceUsd = 2;
    expect(await meter.blockedBy('ws')).toBe('credits');
    // Both used up: the budget is named when it binds first (at or under the credits).
    billing.budgetMicros = 2_000_000;
    expect(await meter.blockedBy('ws')).toBe('budget');
    billing.budgetMicros = 1_000_000;
    billing.allowanceUsd = 1.5;
    expect(await meter.blockedBy('ws')).toBe('budget');
  });

  it('words a budget stop for owners and members, and keeps the credits wording otherwise', async () => {
    const meter = new LlmMeter({} as Database, 1);
    const billing = { ownerId: 'ws', plan: 'team' as const, allowanceUsd: 10, budgetMicros: 1_000_000 };
    vi.spyOn(meter.store, 'getUsageAndBilling').mockImplementation(async () => ({ usage: { micros: 2_000_000 } as never, billing }));
    vi.spyOn(meter.store, 'workspace').mockImplementation(async () => ({ name: 'Acme', ownerId: 'o', ownerIds: ['co'] }));
    expect(await meter.stopText('ws', 'm', 'out')).toBe('Acme reached its monthly budget. Ask an owner to raise it.');
    expect(await meter.stopText('ws', 'co', 'out')).toBe('Acme reached its monthly budget. Raise it in Account → Billing.');
    billing.budgetMicros = 4_000_000;
    billing.allowanceUsd = 1;
    expect(await meter.stopText('ws', 'o', 'out')).toBe('out');
  });

  it("names the workspace when the payer is a pool", async () => {
    const lookups = { agent: async (id: string) => (id === 'dana' ? { name: 'Dana' } : undefined), workspace: async (id: string) => (id === 'ws' ? { name: 'Acme' } : undefined) };
    expect(await payerName('ws', lookups)).toBe('Acme');
    expect(await payerName('dana', lookups)).toBe('Dana');
  });
});
