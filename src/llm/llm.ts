import type { LlmUsage } from '../lib/llmCost.js';
export { costMicros, type LlmUsage, type LlmPrices } from '../lib/llmCost.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/types.js';
import { CREDIT_MICROS, limitsOf, type Limits } from '../billing/billing.js';
import { BillingStore } from '../billing/store.js';
import { payerOf } from '../billing/payer.js';
import type { AgentRecord } from '../registry/types.js';

/**
 * The LLM proxy for hosted agents: they run on Gemini in Vertex AI, which the hub calls as itself (its service
 * account), so no model credential ever reaches a computer. Each hosted agent gets its own Parly key that only
 * works here, every call is metered against its owner's monthly allowance, and past it calls are refused until
 * the month turns. Agents don't pick a model: every call goes to the one the hub is set up with.
 */

/** An agent's model use in a month: tokens in (prompt, cached included) and out (answer and thoughts), calls, cost. */
export interface AgentUsage {
  agentId: string;
  period: string;
  calls: number;
  input: number;
  output: number;
  micros: number;
}

/**
 * Credits: what people spend, 1 credit = 1¢ (CREDIT_MICROS of the ledger, which counts in millionths of a dollar).
 * A model call costs AI_MARKUP times what the model cost us; an app action or a delivered trigger event, 1 credit.
 */
export { CREDIT_MICROS } from '../billing/billing.js';
export { AI_MARKUP } from '../billing/store.js';
import { markedUpMicros } from '../billing/store.js';

/** The calendar month a call counts in (UTC). */
const periodOf = (at = new Date()) => at.toISOString().slice(0, 7);
/** The calendar day a public showcase turn counts in (UTC). */
const dayOf = (at = new Date()) => at.toISOString().slice(0, 10);

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

export class LlmMeter {
  readonly store: BillingStore;

  constructor(
    db: Database,
    /** Each person's monthly allowance, in millionths of a dollar. */
    private readonly allowanceMicros: number,
  ) {
    this.store = new BillingStore(db);
  }

  /** A new key for a hosted agent (shown once, to its computer). Its earlier keys keep working until revoked. */
  async mint(agent: { id: string; ownerId: string }): Promise<string> {
    const key = `plk_${randomBytes(32).toString('base64url')}`;
    await this.store.createKey(hash(key), { agentId: agent.id, ownerId: agent.ownerId, createdAt: new Date().toISOString() });
    return key;
  }

  async resolve(key: string | undefined): Promise<{ agentId: string; ownerId: string } | undefined> {
    if (!key?.startsWith('plk_')) return undefined;
    const doc = await this.store.getKey(hash(key));
    return doc && !doc.revoked ? { agentId: doc.agentId, ownerId: doc.ownerId } : undefined;
  }

  /** Every key of an agent stops working for good. Not for archiving: that can be undone, so `llmRouter` checks the agent on each call. */
  async revoke(agentId: string): Promise<void> {
    await this.store.revokeKeysForAgent(agentId);
  }

  /** Model spend billed to `ownerId` this month (a person's record, or a company pool's), per agent. */
  agentSpend(ownerId: string, period = periodOf()): Promise<{ agentId: string; micros: number }[]> {
    return this.store.agentUsageBilledTo(ownerId, period);
  }

  /** Who pays for this agent (billing/payer.ts): its company pool when its person is linked to one. */
  payerOf(agent: Pick<AgentRecord, 'id' | 'payerId' | 'ownerId'>): Promise<string> {
    return payerOf(agent, (id) => this.store.billingAccountOf(id));
  }

  /** A person's plan limits (billing/billing.ts): monthly allowance, top-up balance, workspace and participant caps. */
  async limits(ownerId: string): Promise<Limits> {
    return limitsOf(await this.store.getBilling(ownerId), this.allowanceMicros);
  }

  /**
   * How much of what a person can spend this month they have used: 0 to 1 (and past 1 by the calls already under
   * way). What they can spend is the plan's monthly allowance plus their top-ups: those spent this month and those left.
   * When `opts.freeOnly` is true (public showcase turns), only the hub's free allowance is counted and paid plans/top-ups are ignored.
   */
  async used(ownerId: string, period = periodOf(), opts?: { freeOnly?: boolean }): Promise<number> {
    if (opts?.freeOnly) {
      const usage = await this.store.getMonthUsage(ownerId, period);
      const spentMicros = usage?.publicShowcaseMicros ?? 0;
      return this.allowanceMicros > 0 ? spentMicros / this.allowanceMicros : 1;
    }
    const { spentMicros, capMicros } = await this.balance(ownerId, period);
    return capMicros > 0 ? spentMicros / capMicros : 1;
  }

  /** Global daily public-showcase spend (micro-dollars, AI_MARKUP included) for `day` (`YYYY-MM-DD`). */
  async publicShowcaseSpent(day = dayOf()): Promise<number> {
    return this.store.getPublicShowcaseSpent(day);
  }

  /** Whether global daily public-showcase spend has reached or crossed `ceilingMicros`. */
  async publicShowcaseOverCeiling(ceilingMicros: number, day = dayOf()): Promise<boolean> {
    if (ceilingMicros <= 0) return true;
    return (await this.publicShowcaseSpent(day)) >= ceilingMicros;
  }

  /** Records `cost` (raw model micro-dollars) against the global daily public-showcase spend counter. */
  async addPublicShowcaseSpend(cost: number, day = dayOf()): Promise<void> {
    await this.store.addPublicShowcaseSpend(cost, day);
  }

  /** This month's spend and what could be spent: the allowance plus top-ups (spent this month and left). */
  async balance(ownerId: string, period = periodOf()): Promise<{ spentMicros: number; capMicros: number }> {
    const { usage, billing } = await this.store.getUsageAndBilling(ownerId, period);
    const limits = limitsOf(billing, this.allowanceMicros);
    const spentMicros = usage?.micros ?? 0;
    return { spentMicros, capMicros: limits.monthlyMicros + (usage?.extraSpentMicros ?? 0) + limits.extraMicros };
  }

  /** Whether a person has credits left this month (allowance or top-ups). */
  async hasCredits(ownerId: string): Promise<boolean> {
    return (await this.used(ownerId)) < 1;
  }

  /** Spends `credits` (an app action, a delivered trigger event) from a person's month, then their top-ups. */
  async charge(ownerId: string, credits: number, period = periodOf()): Promise<void> {
    if (credits > 0) await this.spend(ownerId, Math.round(credits * CREDIT_MICROS), period, new Date().toISOString());
  }

  /** `charge`, once per `key` (a delivered event Composio may send again): a repeat costs nothing. */
  async chargeOnce(ownerId: string, credits: number, key: string): Promise<void> {
    await this.store.chargeOnce(ownerId, credits, key, periodOf(), this.allowanceMicros);
  }

  /**
   * A model call on its owner's credits (AI_MARKUP times what it cost us) and, with `agent`, its tokens on that agent's
   * month too (`micros` charged, `costMicros` ours).
   */
  private readonly referralChecked = new Set<string>();

  /** A referred person's first agent answer: both get REFERRAL_CREDITS, the one who brought them for up to REFERRALS_MAX friends. Once. */
  async rewardReferral(ownerId: string): Promise<void> {
    if (this.referralChecked.has(ownerId)) return;
    await this.store.rewardReferral(ownerId);
    // Checked only once it went through: a failed attempt is tried again with the next answer (the flag keeps it once).
    this.referralChecked.add(ownerId);
  }

  /**
   * Grants public-showcase prize credits to a visitor's balance, atomically and within hard caps. One shared pool
   * (`showcasePools/{poolId}`, self-seeded to `poolCredits` on first award), a per-recipient lifetime ceiling
   * (`showcaseAwards/{poolId}_{recipientId}.granted`), and at most once per idempotency `key`
   * (`showcaseAwardLog/{poolId}_{key}` — so a retried judge turn never double-pays). The recipient must be a person
   * (not a bot) and not the judge or its owner. 1 credit = CREDIT_MICROS of `extraMicros` (the same bucket as referral/top-up).
   */
  async awardShowcaseCredits(args: {
    poolId: string;
    poolCredits: number;
    recipientId: string;
    amount: number;
    ceiling: number;
    key: string;
    judgeId: string;
    judgeOwnerId: string;
  }): Promise<{ ok: true; awarded: number; recipientTotal: number; poolRemaining: number } | { ok: false; error: string }> {
    const amount = Number(args.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > 10) return { ok: false, error: 'amount must be a whole number of credits from 1 to 10' };
    const rid = String(args.recipientId ?? '').trim();
    if (!rid) return { ok: false, error: 'no visitor to award in this turn' };
    if (rid === args.judgeId || rid === args.judgeOwnerId) return { ok: false, error: 'a judge cannot award credits to itself or its owner' };
    const key = String(args.key ?? '').trim();
    if (!key) return { ok: false, error: 'cannot record an award without an idempotency key' };
    if (!Number.isFinite(args.ceiling) || args.ceiling <= 0 || !Number.isFinite(args.poolCredits) || args.poolCredits <= 0)
      return { ok: false, error: 'the showcase prize pool is not configured' };
    return this.store.awardShowcaseCredits({
      poolId: args.poolId,
      poolCredits: args.poolCredits,
      recipientId: rid,
      amount,
      ceiling: args.ceiling,
      key,
      judgeId: args.judgeId,
      judgeOwnerId: args.judgeOwnerId,
    });
  }

  async add(
    ownerId: string,
    cost: number,
    agent?: { id: string; usage: LlmUsage },
    period = periodOf(),
    /** personId: the human behind the call, when the payer is someone else (a company pool) — referrals reward them. */
    opts?: { freeOnly?: boolean; publicShowcase?: boolean; personId?: string },
  ): Promise<void> {
    const micros = markedUpMicros(cost);
    const updatedAt = new Date().toISOString();
    const writes: Promise<unknown>[] = [];
    // An agent answering its owner is when a referral counts (a real person, using Parly).
    if (agent && !opts?.publicShowcase) {
      const person = opts?.personId ?? ownerId;
      writes.push(this.rewardReferral(person).catch((err) => console.error(`referral of ${person}`, err)));
    }
    if (micros > 0) writes.push(this.spend(ownerId, micros, period, updatedAt, opts?.freeOnly));
    // Only free turns count toward the hub-wide daily ceiling; a visitor on their own credits doesn't.
    if (opts?.publicShowcase && opts.freeOnly && cost > 0) writes.push(this.addPublicShowcaseSpend(cost));
    if (agent) {
      writes.push(this.store.recordAgentUsage(agent.id, ownerId, period, micros, cost, agent.usage, updatedAt));
    }
    await Promise.all(writes);
  }

  /**
   * Spends `credits` only if the person has that much left this month, atomically with `key`: one transaction checks
   * the balance, records the key and spends. A repeat of the key is already paid (true, nothing spent again); not
   * enough left is false, with nothing spent. refund(key) gives it back.
   */
  async debitIfEnough(ownerId: string, credits: number, key: string, period = periodOf()): Promise<boolean> {
    return this.store.debitIfEnough(ownerId, credits, key, period, this.allowanceMicros);
  }

  /** Gives back what debitIfEnough(`key`) spent (the operation it paid for failed), once. */
  async refund(key: string): Promise<void> {
    await this.store.refund(key);
  }

  /** Adds a call's cost to the month; whatever goes past the monthly allowance comes out of the top-up balance (unless `freeOnly` is set, which never deducts paid top-ups). */
  private async spend(ownerId: string, micros: number, period: string, updatedAt: string, freeOnly = false): Promise<void> {
    await this.store.spend(ownerId, micros, period, updatedAt, this.allowanceMicros, freeOnly);
  }

  /** An agent's model use this month (or `period`). */
  async agentUsage(agentId: string, period = periodOf()): Promise<AgentUsage> {
    return this.store.getAgentUsage(agentId, period);
  }

  /** The agents that cost the most this month (or `period`), shown most tokens first. */
  // ponytail: the 200 costliest agents of the month (index period, micros desc); page it if the admin needs the long tail
  async topAgents(period = periodOf()): Promise<(AgentUsage & { ownerId: string })[]> {
    return this.store.topAgents(period);
  }
}
