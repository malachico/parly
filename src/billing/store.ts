import { FieldValue, type Database, type DocumentReference, type Transaction } from '../db/types.js';
import { BILLING, CREDIT_MICROS, limitsOf, type BillingRecord, type Plan } from '../lib/plans.js';
import type { AgentUsage } from '../llm/llm.js';
import type { CreditVoucher } from './billing.js';

const VOUCHERS = 'vouchers';
const EVENTS = 'paddleEvents';
const USAGE = 'usage';
const AGENT_USAGE = 'agentUsage';
const CHARGES = 'creditCharges';
const KEYS = 'llmKeys';
const TURNS = 'llm_turns';
/** How long a turn's spend is kept: far past any turn. */
const TURN_TTL_MS = 7 * 86_400_000;
const REFERRAL_CREDITS = 100;
const REFERRALS_MAX = 10;
export const AI_MARKUP = 2;
/** What a model call that cost us `cost` micro-dollars costs its payer, in micro-dollars. */
export const markedUpMicros = (cost: number) => Math.ceil(Math.max(0, cost) * AI_MARKUP);

/**
 * Persistence for billing and LLM meter:
 * billing records (`billing`), vouchers and redemptions (`vouchers`),
 * Paddle idempotency events (`paddleEvents`), monthly/daily usage (`usage`),
 * per-agent usage (`agentUsage`), credit charge idempotency marks (`creditCharges`),
 * agent LLM keys (`llmKeys`), and showcase awards (`showcasePools`, `showcaseAwards`, `showcaseAwardLog`).
 */
export class BillingStore {
  constructor(private readonly db: Database) {}

  private col() {
    return this.db.collection(BILLING);
  }

  // ---- billing records --------------------------------------------------------------------------

  async getBilling(ownerId: string): Promise<BillingRecord | undefined> {
    return (await this.col().doc(ownerId).get()).data() as BillingRecord | undefined;
  }

  /** The company credit pool (a workspace id) this person's usage bills, if their company pays for them. */
  async billingAccountOf(personId: string): Promise<string | undefined> {
    return ((await this.db.collection('agents').doc(personId).get()).data() as { billingAccountId?: string } | undefined)?.billingAccountId;
  }

  async isWorkspace(id: string): Promise<boolean> {
    return (await this.db.collection('workspaces').doc(id).get()).exists;
  }

  async workspaceOwner(id: string): Promise<string | undefined> {
    return ((await this.db.collection('workspaces').doc(id).get()).data() as { ownerId?: string } | undefined)?.ownerId;
  }

  /** Model spend this period on a pool (agentUsage rows billed to it), by agent. */
  async agentUsageBilledTo(ownerId: string, period: string): Promise<{ agentId: string; micros: number }[]> {
    const snap = await this.db.collection(AGENT_USAGE).where('ownerId', '==', ownerId).where('period', '==', period).get();
    return snap.docs.map((d) => d.data() as { agentId: string; micros: number });
  }

  async setPlan(ownerId: string, change: { plan: Plan; allowanceUsd?: number | null; maxWorkspaces?: number | null; maxParticipants?: number | null }): Promise<BillingRecord> {
    const update: Record<string, unknown> = { ownerId, plan: change.plan, updatedAt: new Date().toISOString() };
    if (change.allowanceUsd !== undefined) update.allowanceUsd = change.allowanceUsd === null ? FieldValue.delete() : change.allowanceUsd;
    if (change.maxWorkspaces !== undefined) update.maxWorkspaces = change.maxWorkspaces === null ? FieldValue.delete() : change.maxWorkspaces;
    if (change.maxParticipants !== undefined) update.maxParticipants = change.maxParticipants === null ? FieldValue.delete() : change.maxParticipants;
    await this.col().doc(ownerId).set(update, { merge: true });
    return (await this.getBilling(ownerId))!;
  }

  /** A company pool's monthly budget in micros; null removes it. */
  async setBudget(ownerId: string, micros: number | null): Promise<void> {
    await this.col().doc(ownerId).set({ ownerId, budgetMicros: micros === null ? FieldValue.delete() : micros, updatedAt: new Date().toISOString() }, { merge: true });
  }

  async ownerOfSubscription(subscriptionId: string): Promise<string | undefined> {
    const snap = await this.col().where('paddleSubscriptionId', '==', subscriptionId).limit(1).get();
    return snap.docs[0]?.id;
  }

  async ownerOfCustomer(customerId: string): Promise<string | undefined> {
    const snap = await this.col().where('paddleCustomerId', '==', customerId).limit(1).get();
    return snap.docs[0]?.id;
  }

  // ---- vouchers ---------------------------------------------------------------------------------

  async createVoucher(voucher: CreditVoucher): Promise<boolean> {
    const ref = this.db.collection(VOUCHERS).doc(voucher.code);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return false;
      tx.create(ref, voucher);
      return true;
    });
  }

  async listVouchers(limit = 100): Promise<CreditVoucher[]> {
    return (await this.db.collection(VOUCHERS).orderBy('createdAt', 'desc').limit(limit).get()).docs.map((d) => d.data() as CreditVoucher);
  }

  async disableVoucher(code: string, adminId: string): Promise<'not_found' | 'done'> {
    const ref = this.db.collection(VOUCHERS).doc(code);
    return this.db.runTransaction(async (tx) => {
      const voucher = (await tx.get(ref)).data() as CreditVoucher | undefined;
      if (!voucher) return 'not_found';
      if (voucher.active) tx.update(ref, { active: false, disabledBy: adminId, disabledAt: new Date().toISOString() });
      return 'done';
    });
  }

  async redeemVoucher(
    ownerId: string,
    code: string,
  ): Promise<
    | { outcome: 'ok'; creditsAdded: number; extraCredits: number }
    | { outcome: 'not_found' }
    | { outcome: 'already_used' }
    | { outcome: 'disabled' }
    | { outcome: 'expired' }
    | { outcome: 'usage_limit' }
    | { outcome: 'overflow' }
  > {
    const ref = this.db.collection(VOUCHERS).doc(code);
    const redemption = ref.collection('redemptions').doc(ownerId);
    const billingRef = this.col().doc(ownerId);
    return this.db.runTransaction(async (tx) => {
      const [voucherDoc, used, billingDoc] = await tx.getAll(ref, redemption, billingRef);
      const voucher = voucherDoc!.data() as CreditVoucher | undefined;
      if (!voucher) return { outcome: 'not_found' };
      if (used!.exists) return { outcome: 'already_used' };
      if (!voucher.active) return { outcome: 'disabled' };
      const now = new Date().toISOString();
      if (now >= voucher.redeemBefore) return { outcome: 'expired' };
      if (voucher.usedCount >= voucher.maxUses) return { outcome: 'usage_limit' };
      const billing = billingDoc!.data() as BillingRecord | undefined;
      const extraMicros = (billing?.extraMicros ?? 0) + voucher.credits * CREDIT_MICROS;
      if (!Number.isSafeInteger(extraMicros) || extraMicros < 0) return { outcome: 'overflow' };
      tx.create(redemption, { credits: voucher.credits, micros: voucher.credits * CREDIT_MICROS, redeemedAt: now });
      tx.update(ref, { usedCount: voucher.usedCount + 1 });
      tx.set(billingRef, { ownerId, plan: billing?.plan ?? 'free', extraMicros, updatedAt: now }, { merge: true });
      return { outcome: 'ok', creditsAdded: voucher.credits, extraCredits: extraMicros / CREDIT_MICROS };
    });
  }

  // ---- Paddle webhook transactions --------------------------------------------------------------

  async handleSubscriptionEvent(
    eventId: string,
    eventType: string,
    ownerId: string | undefined,
    data: {
      status?: string;
      customer_id?: string;
      id?: string;
      current_billing_period?: { ends_at?: string };
      scheduled_change?: { action?: string };
    },
    occurredAt: string | undefined,
    now: string,
    team?: { seats: number },
  ): Promise<'done' | 'seen' | 'ignored'> {
    const seen = this.db.collection(EVENTS).doc(eventId);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(seen)).exists) return 'seen' as const;
      const done = (outcome: 'done' | 'ignored') => {
        tx.create(seen, { type: eventType, at: now });
        return outcome;
      };
      if (!ownerId) return done('ignored');
      const ref = this.col().doc(ownerId);
      const current = (await tx.get(ref)).data() as BillingRecord | undefined;
      if (current?.plan === 'enterprise') return done('ignored');
      const paying = ['active', 'trialing', 'past_due'].includes(data.status ?? '');
      if (!paying && current?.paddleSubscriptionId && current.paddleSubscriptionId !== data.id) return done('ignored');
      // ponytail: first Team subscription wins a pool; another one (e.g. a $75 checkout by someone who knows the owner's id) is ignored until the first ends or lapses. A legit replacement needs the first cancelled.
      if (team && limitsOf(current, 0).plan === 'team' && current?.paddleSubscriptionId && current.paddleSubscriptionId !== data.id) return done('ignored');
      if (occurredAt && current?.subscriptionEventAt && Date.parse(occurredAt) < Date.parse(current.subscriptionEventAt)) return done('ignored');
      tx.set(
        ref,
        {
          ownerId,
          plan: paying ? (team ? 'team' : 'pro') : 'free',
          ...(team ? { seats: team.seats } : {}),
          // ponytail: a Team pool keeps the buyer's paddleCustomerId (its portal needs it), so ownerOfCustomer's limit(1) may pick
          // the pool or the buyer's own doc for a customer-only event; only adjustments without custom_data hit that fallback.
          paddleCustomerId: data.customer_id,
          paddleSubscriptionId: data.id,
          ...(data.current_billing_period?.ends_at ? { periodEnd: data.current_billing_period.ends_at } : {}),
          cancelAtPeriodEnd: data.scheduled_change?.action === 'cancel',
          ...(paying ? {} : { allowanceUsd: FieldValue.delete() }),
          ...(occurredAt ? { subscriptionEventAt: occurredAt } : {}),
          updatedAt: now,
        },
        { merge: true },
      );
      return done('done');
    });
  }

  async handleTopupTransaction(
    eventId: string,
    eventType: string,
    ownerId: string | undefined,
    transactionId: string | undefined,
    customerId: string | undefined,
    micros: number,
    now: string,
  ): Promise<'done' | 'seen' | 'ignored'> {
    const seen = this.db.collection(EVENTS).doc(eventId);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(seen)).exists) return 'seen' as const;
      const done = (outcome: 'done' | 'ignored') => {
        tx.create(seen, { type: eventType, at: now });
        return outcome;
      };
      if (!ownerId || !micros) return done('ignored');
      const ref = this.col().doc(ownerId);
      const current = (await tx.get(ref)).data() as BillingRecord | undefined;
      if (transactionId) tx.set(this.db.collection(EVENTS).doc(`topup_${transactionId}`), { ownerId, micros });
      tx.set(
        ref,
        {
          ownerId,
          extraMicros: FieldValue.increment(micros),
          ...(current?.plan ? {} : { plan: 'free' }),
          ...(customerId ? { paddleCustomerId: customerId } : {}),
          updatedAt: now,
        },
        { merge: true },
      );
      return done('done');
    });
  }

  async handleAdjustmentEvent(
    eventId: string,
    eventType: string,
    ownerId: string | undefined,
    adjId: string | undefined,
    transactionId: string | undefined,
    status: string,
    action: string | undefined,
    refundMicros: number,
    now: string,
  ): Promise<'done' | 'seen' | 'ignored'> {
    const seen = this.db.collection(EVENTS).doc(eventId);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(seen)).exists) return 'seen' as const;
      const done = (outcome: 'done' | 'ignored') => {
        tx.create(seen, { type: eventType, at: now });
        return outcome;
      };
      const adjRef = adjId ? this.db.collection(EVENTS).doc(`adj_${adjId}`) : undefined;
      if (adjRef && (await tx.get(adjRef)).exists) return done('ignored');
      if (status === 'approved' && (action === 'refund' || action === 'chargeback' || !action)) {
        const topupDoc = transactionId ? this.db.collection(EVENTS).doc(`topup_${transactionId}`) : undefined;
        const topupSnap = topupDoc ? await tx.get(topupDoc) : undefined;
        const topup = topupSnap?.data() as { micros?: number; ownerId?: string } | undefined;
        const recordedMicros = topup?.micros;
        // The record the top-up credited (a person's, or a company pool's): one Paddle customer can buy for both.
        const payer = topup?.ownerId ?? ownerId;
        if (!recordedMicros || !payer) return done('ignored');
        if (refundMicros > 0) {
          const ref = this.col().doc(payer);
          const current = (await tx.get(ref)).data() as BillingRecord | undefined;
          const currentExtra = current?.extraMicros ?? 0;
          const reversed = Math.min(refundMicros, recordedMicros);
          const clawback = Math.min(reversed, currentExtra);
          if (adjRef) tx.create(adjRef, { type: eventType, at: now, clawback });
          if (topupDoc) tx.set(topupDoc, { micros: FieldValue.increment(-reversed) }, { merge: true });
          tx.set(
            ref,
            {
              ownerId: payer,
              extraMicros: FieldValue.increment(-clawback),
              updatedAt: now,
            },
            { merge: true },
          );
          return done('done');
        }
      }
      return done('ignored');
    });
  }

  async markEventSeen(eventId: string, eventType: string, now: string): Promise<'done' | 'seen' | 'ignored'> {
    const seen = this.db.collection(EVENTS).doc(eventId);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(seen)).exists) return 'seen' as const;
      tx.create(seen, { type: eventType, at: now });
      return 'ignored';
    });
  }

  // ---- LLM keys (`llmKeys/{hash}`) -------------------------------------------------------------

  async createKey(keyHash: string, data: { agentId: string; ownerId: string; createdAt: string }): Promise<void> {
    await this.db.collection(KEYS).doc(keyHash).set(data);
  }

  async getKey(keyHash: string): Promise<{ agentId: string; ownerId: string; revoked?: boolean } | undefined> {
    const doc = (await this.db.collection(KEYS).doc(keyHash).get()).data();
    return doc ? { agentId: doc.agentId, ownerId: doc.ownerId, revoked: doc.revoked } : undefined;
  }

  async revokeKeysForAgent(agentId: string): Promise<void> {
    const snap = await this.db.collection(KEYS).where('agentId', '==', agentId).get();
    await Promise.all(snap.docs.map((d) => d.ref.update({ revoked: true })));
  }

  // ---- usage & limits ---------------------------------------------------------------------------

  async getMonthUsage(ownerId: string, period: string): Promise<{ micros?: number; extraSpentMicros?: number; publicShowcaseMicros?: number } | undefined> {
    return (await this.db.collection(USAGE).doc(`${ownerId}_${period}`).get()).data() as { micros?: number; extraSpentMicros?: number; publicShowcaseMicros?: number } | undefined;
  }

  async getUsageAndBilling(ownerId: string, period: string): Promise<{ usage?: { micros?: number; extraSpentMicros?: number }; billing?: BillingRecord }> {
    const [usageDoc, billingDoc] = await Promise.all([this.db.collection(USAGE).doc(`${ownerId}_${period}`).get(), this.col().doc(ownerId).get()]);
    return {
      usage: usageDoc.data() as { micros?: number; extraSpentMicros?: number } | undefined,
      billing: billingDoc.data() as BillingRecord | undefined,
    };
  }

  async getPublicShowcaseSpent(day: string): Promise<number> {
    const snap = await this.db.collection(USAGE).doc(`_public_showcase_${day}`).get();
    return (snap.data()?.micros as number | undefined) ?? 0;
  }

  /** Context-graph extraction spend for one workspace and day, in raw model micro-dollars (Parly's cost, no markup). */
  async getGraphSpent(workspaceId: string, day: string): Promise<number> {
    const snap = await this.db.collection(USAGE).doc(`_graph_${workspaceId}_${day}`).get();
    return (snap.data()?.costMicros as number | undefined) ?? 0;
  }

  /**
   * Parly pays for graph extraction: this only counts toward the graph cap and never touches anyone's credits.
   * ponytail: one doc per workspace per day that never expires; add a TTL index or a cleanup sweep if they pile up.
   */
  async addGraphSpend(workspaceId: string, cost: number, day: string): Promise<void> {
    if (cost <= 0) return;
    await this.db
      .collection(USAGE)
      .doc(`_graph_${workspaceId}_${day}`)
      .set({ workspaceId, day, costMicros: FieldValue.increment(cost), updatedAt: new Date().toISOString() }, { merge: true });
  }

  async addPublicShowcaseSpend(cost: number, day: string): Promise<void> {
    const micros = markedUpMicros(cost);
    if (micros <= 0) return;
    await this.db
      .collection(USAGE)
      .doc(`_public_showcase_${day}`)
      .set(
        {
          day,
          micros: FieldValue.increment(micros),
          costMicros: FieldValue.increment(Math.max(0, cost)),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
  }

  async recordAgentUsage(
    agentId: string,
    ownerId: string,
    period: string,
    micros: number,
    cost: number,
    u: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number },
    updatedAt: string,
  ): Promise<void> {
    await this.db
      .collection(AGENT_USAGE)
      .doc(`${agentId}_${period}`)
      .set(
        {
          agentId,
          ownerId,
          period,
          calls: FieldValue.increment(1),
          input: FieldValue.increment(u.promptTokenCount ?? 0),
          // Of `input`, how many Vertex served from its cache (measures prompt-caching savings).
          cached: FieldValue.increment(u.cachedContentTokenCount ?? 0),
          output: FieldValue.increment((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)),
          micros: FieldValue.increment(micros),
          costMicros: FieldValue.increment(Math.max(0, cost)),
          updatedAt,
        },
        { merge: true },
      );
  }

  /** What a hosted agent's turn (`turn`, its runner's id for one run) has spent so far, raw model micro-dollars. */
  async getTurnSpend(agentId: string, turn: string): Promise<number> {
    return ((await this.db.collection(TURNS).doc(`${agentId}_${turn}`).get()).data()?.micros as number | undefined) ?? 0;
  }

  async addTurnSpend(agentId: string, turn: string, micros: number): Promise<void> {
    await this.db
      .collection(TURNS)
      .doc(`${agentId}_${turn}`)
      .set({ agentId, turn, micros: FieldValue.increment(Math.max(0, micros)), expiresAt: new Date(Date.now() + TURN_TTL_MS) }, { merge: true });
  }

  async getAgentUsage(agentId: string, period: string): Promise<AgentUsage> {
    const d = (await this.db.collection(AGENT_USAGE).doc(`${agentId}_${period}`).get()).data();
    return { agentId, period, calls: d?.calls ?? 0, input: d?.input ?? 0, output: d?.output ?? 0, micros: d?.micros ?? 0 };
  }

  async topAgents(period: string): Promise<(AgentUsage & { ownerId: string })[]> {
    const snap = await this.db.collection(AGENT_USAGE).where('period', '==', period).orderBy('micros', 'desc').limit(200).get();
    return snap.docs
      .map((d) => d.data() as AgentUsage & { ownerId: string })
      .sort((a, b) => b.input + b.output - (a.input + a.output));
  }

  // ---- spend & charges --------------------------------------------------------------------------

  /** Adds `micros` to the period's usage; the part past the monthly allowance comes out of top-up credits. Returns that part. */
  private writeSpend(
    tx: Transaction,
    usageRef: DocumentReference,
    billingRef: DocumentReference,
    ownerId: string,
    period: string,
    micros: number,
    before: number,
    limits: { monthlyMicros: number; extraMicros: number },
    updatedAt: string,
  ): number {
    const over = Math.max(0, before + micros - limits.monthlyMicros) - Math.max(0, before - limits.monthlyMicros);
    const fromExtra = Math.min(over, limits.extraMicros);
    tx.set(usageRef, { ownerId, period, micros: FieldValue.increment(micros), ...(fromExtra ? { extraSpentMicros: FieldValue.increment(fromExtra) } : {}), updatedAt }, { merge: true });
    if (fromExtra) tx.set(billingRef, { extraMicros: FieldValue.increment(-fromExtra) }, { merge: true });
    return fromExtra;
  }

  async spend(ownerId: string, micros: number, period: string, updatedAt: string, allowanceMicros: number, freeOnly = false): Promise<void> {
    const usageRef = this.db.collection(USAGE).doc(`${ownerId}_${period}`);
    if (freeOnly) {
      await usageRef.set({ ownerId, period, publicShowcaseMicros: FieldValue.increment(micros), updatedAt }, { merge: true });
      return;
    }
    await this.db.runTransaction(async (tx) => {
      const billingRef = this.col().doc(ownerId);
      const [usage, billing] = await Promise.all([tx.get(usageRef), tx.get(billingRef)]);
      const limits = limitsOf(billing.data() as BillingRecord | undefined, allowanceMicros);
      const before = (usage.data()?.micros as number | undefined) ?? 0;
      this.writeSpend(tx, usageRef, billingRef, ownerId, period, micros, before, limits, updatedAt);
    });
  }

  async chargeOnce(ownerId: string, credits: number, key: string, period: string, allowanceMicros: number): Promise<void> {
    const markRef = this.db.collection(CHARGES).doc(key);
    const micros = Math.round(credits * CREDIT_MICROS);
    await this.db.runTransaction(async (tx) => {
      if ((await tx.get(markRef)).exists) return;
      const at = new Date().toISOString();
      if (micros > 0) {
        const usageRef = this.db.collection(USAGE).doc(`${ownerId}_${period}`);
        const billingRef = this.col().doc(ownerId);
        const [usage, billing] = await Promise.all([tx.get(usageRef), tx.get(billingRef)]);
        const limits = limitsOf(billing.data() as BillingRecord | undefined, allowanceMicros);
        const before = (usage.data()?.micros as number | undefined) ?? 0;
        this.writeSpend(tx, usageRef, billingRef, ownerId, period, micros, before, limits, at);
      }
      tx.create(markRef, { ownerId, credits, at });
    });
  }

  async debitIfEnough(ownerId: string, credits: number, key: string, period: string, allowanceMicros: number): Promise<boolean> {
    const micros = Math.round(credits * CREDIT_MICROS);
    const usageRef = this.db.collection(USAGE).doc(`${ownerId}_${period}`);
    const billingRef = this.col().doc(ownerId);
    const markRef = this.db.collection(CHARGES).doc(key);
    return this.db.runTransaction(async (tx) => {
      const [usage, billing, mark] = await Promise.all([tx.get(usageRef), tx.get(billingRef), tx.get(markRef)]);
      if (mark.exists) return true;
      const limits = limitsOf(billing.data() as BillingRecord | undefined, allowanceMicros);
      const before = (usage.data()?.micros as number | undefined) ?? 0;
      const cap = limits.monthlyMicros + ((usage.data()?.extraSpentMicros as number | undefined) ?? 0) + limits.extraMicros;
      if (cap - before < micros) return false;
      const updatedAt = new Date().toISOString();
      const fromExtra = this.writeSpend(tx, usageRef, billingRef, ownerId, period, micros, before, limits, updatedAt);
      tx.create(markRef, { ownerId, credits, micros, fromExtra, period, at: updatedAt });
      return true;
    });
  }

  async refund(key: string): Promise<void> {
    const markRef = this.db.collection(CHARGES).doc(key);
    await this.db.runTransaction(async (tx) => {
      const mark = (await tx.get(markRef)).data() as { ownerId: string; micros: number; fromExtra: number; period: string; refunded?: boolean } | undefined;
      if (!mark || mark.refunded) return;
      tx.set(this.db.collection(USAGE).doc(`${mark.ownerId}_${mark.period}`), { micros: FieldValue.increment(-mark.micros), ...(mark.fromExtra ? { extraSpentMicros: FieldValue.increment(-mark.fromExtra) } : {}) }, { merge: true });
      if (mark.fromExtra) tx.set(this.col().doc(mark.ownerId), { extraMicros: FieldValue.increment(mark.fromExtra) }, { merge: true });
      tx.update(markRef, { refunded: true, refundedAt: new Date().toISOString() });
    });
  }

  // ---- referral & showcase awards transactions --------------------------------------------------

  async rewardReferral(ownerId: string): Promise<void> {
    const personRef = this.db.collection('agents').doc(ownerId);
    const credits = REFERRAL_CREDITS * CREDIT_MICROS;
    await this.db.runTransaction(async (tx) => {
      const person = (await tx.get(personRef)).data() as { referredBy?: string; referralRewarded?: boolean } | undefined;
      if (!person?.referredBy || person.referralRewarded) return;
      const referrerRef = this.col().doc(person.referredBy);
      const referrer = (await tx.get(referrerRef)).data() as BillingRecord | undefined;
      const now = new Date().toISOString();
      tx.update(personRef, { referralRewarded: true });
      tx.set(this.col().doc(ownerId), { ownerId, extraMicros: FieldValue.increment(credits), updatedAt: now }, { merge: true });
      if ((referrer?.referrals ?? 0) < REFERRALS_MAX)
        tx.set(referrerRef, { ownerId: person.referredBy, referrals: FieldValue.increment(1), extraMicros: FieldValue.increment(credits), updatedAt: now }, { merge: true });
    });
  }

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
    const poolRef = this.db.collection('showcasePools').doc(args.poolId);
    const userRef = this.db.collection('showcaseAwards').doc(`${args.poolId}_${args.recipientId}`);
    const logRef = this.db.collection('showcaseAwardLog').doc(`${args.poolId}_${args.key}`);
    const recipientRef = this.db.collection('agents').doc(args.recipientId);
    try {
      return await this.db.runTransaction(async (tx) => {
        const [poolSnap, userSnap, logSnap, recSnap] = await Promise.all([tx.get(poolRef), tx.get(userRef), tx.get(logRef), tx.get(recipientRef)]);
        const recipient = recSnap.data() as { kind?: string; archived?: boolean } | undefined;
        if (!recipient) return { ok: false as const, error: 'that recipient does not exist' };
        if (recipient.kind !== 'human' || recipient.archived) return { ok: false as const, error: 'credits can only be awarded to a person' };
        if (logSnap.exists) {
          const prev = logSnap.data() as { amount?: number };
          return { ok: true as const, awarded: prev?.amount ?? 0, recipientTotal: (userSnap.data()?.granted as number) ?? 0, poolRemaining: (poolSnap.data()?.remaining as number) ?? 0 };
        }
        const remaining = poolSnap.exists ? ((poolSnap.data()?.remaining as number) ?? 0) : args.poolCredits;
        if (args.amount > remaining) return { ok: false as const, error: `the shared prize pool has only ${remaining} credit(s) left` };
        const granted = (userSnap.data()?.granted as number) ?? 0;
        if (granted + args.amount > args.ceiling) return { ok: false as const, error: `that would pass the ${args.ceiling}-credit cap per person (already ${granted})` };
        const now = new Date().toISOString();
        tx.set(poolRef, { poolId: args.poolId, remaining: remaining - args.amount, updatedAt: now }, { merge: true });
        tx.set(userRef, { poolId: args.poolId, recipientId: args.recipientId, granted: granted + args.amount, updatedAt: now }, { merge: true });
        tx.set(logRef, { poolId: args.poolId, key: args.key, recipientId: args.recipientId, amount: args.amount, judgeId: args.judgeId, at: now });
        tx.set(this.col().doc(args.recipientId), { ownerId: args.recipientId, extraMicros: FieldValue.increment(args.amount * CREDIT_MICROS), updatedAt: now }, { merge: true });
        return { ok: true as const, awarded: args.amount, recipientTotal: granted + args.amount, poolRemaining: remaining - args.amount };
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
