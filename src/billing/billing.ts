import { CREDIT_MICROS, TEAM_MIN_SEATS, type BillingRecord, type Plan } from '../lib/plans.js';
export { BILLING, CREDIT_MICROS, limitsOf, type BillingRecord, type Plan, type Limits } from '../lib/plans.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import { BillingStore } from './store.js';

/**
 * Plans and payments. Paddle is the merchant of record: people pay it (checkout in the web app, Paddle.js), and its
 * webhook tells the hub who is on which plan and who bought a top-up. The hub keeps one billing record per person;
 * the LLM meter reads it for their monthly allowance and top-up balance, and the workspace and participant caps read it for their plan limits.
 */

export interface CreditVoucher {
  code: string;
  credits: number;
  maxUses: number;
  usedCount: number;
  redeemBefore: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  disabledBy?: string;
  disabledAt?: string;
}

function voucherCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{2,40}$/i.test(value.trim())) throw new HubError('invalid', 'Use 2–40 letters, numbers, underscores or hyphens for the voucher code');
  return value.trim().toLowerCase();
}

/** Paddle settings (config.paddle): its API, the webhook's secret, the checkout's public token and the price ids. */
export interface PaddleOptions {
  apiKey: string;
  webhookSecret: string;
  clientToken?: string;
  environment: 'sandbox' | 'production';
  /** Price ids: Pro monthly (and yearly), Team per seat, and one-time top-ups by their dollar value. */
  prices: { pro?: string; proYearly?: string; team?: string; topups?: Record<string, string> };
  fetchImpl?: typeof fetch;
}

/** Checks Paddle's `Paddle-Signature: ts=…;h1=…` over the raw body, within five minutes of `now`. Supports multiple `h1` signatures (e.g. during secret rotation). */
export function verifyPaddleSignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(';').map((p) => p.trim());
  let ts: number | undefined;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 'ts') ts = Number(v);
    else if (k === 'h1' && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v);
  }
  if (!ts || signatures.length === 0 || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:`).update(raw).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

type PaddleEvent = { event_id: string; event_type: string; occurred_at?: string; data: Record<string, any> };

export class Billing {
  private readonly fetchImpl: typeof fetch;
  readonly store: BillingStore;

  constructor(
    db: Database,
    readonly paddle?: PaddleOptions,
  ) {
    this.store = new BillingStore(db);
    this.fetchImpl = paddle?.fetchImpl ?? fetch;
  }

  async get(ownerId: string): Promise<BillingRecord | undefined> {
    return this.store.getBilling(ownerId);
  }

  async createVoucher(adminId: string, input: { code?: unknown; credits?: unknown; maxUses?: unknown; validUntil?: unknown }): Promise<CreditVoucher> {
    const code = voucherCode(input.code);
    const { credits, maxUses, validUntil } = input;
    if (typeof credits !== 'number' || !Number.isSafeInteger(credits) || credits <= 0 || !Number.isSafeInteger(credits * CREDIT_MICROS)) throw new HubError('invalid', 'Credits must be a positive whole number');
    if (typeof maxUses !== 'number' || !Number.isSafeInteger(maxUses) || maxUses <= 0) throw new HubError('invalid', 'Maximum users must be a positive whole number');
    const day = typeof validUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? new Date(`${validUntil}T00:00:00.000Z`) : new Date(NaN);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== validUntil) throw new HubError('invalid', 'Choose a valid redeem-by date');
    const redeemBefore = new Date(day.getTime() + 86_400_000).toISOString();
    if (redeemBefore <= new Date().toISOString()) throw new HubError('invalid', 'Redeem-by date must not have passed');
    const voucher: CreditVoucher = { code, credits, maxUses, usedCount: 0, redeemBefore, active: true, createdBy: adminId, createdAt: new Date().toISOString() };
    const created = await this.store.createVoucher(voucher);
    if (!created) throw new HubError('conflict', 'This voucher code already exists');
    return voucher;
  }

  async listVouchers(): Promise<CreditVoucher[]> {
    // shortcut: latest 100 vouchers; add cursor pagination when admins need older campaigns.
    return this.store.listVouchers(100);
  }

  async disableVoucher(codeInput: unknown, adminId: string): Promise<void> {
    const res = await this.store.disableVoucher(voucherCode(codeInput), adminId);
    if (res === 'not_found') throw new HubError('not_found', 'Invalid voucher code');
  }

  async redeemVoucher(ownerId: string, codeInput: unknown): Promise<{ creditsAdded: number; extraCredits: number }> {
    const res = await this.store.redeemVoucher(ownerId, voucherCode(codeInput));
    switch (res.outcome) {
      case 'not_found':
        throw new HubError('not_found', 'Invalid voucher code');
      case 'already_used':
        throw new HubError('conflict', 'You have already used this voucher');
      case 'disabled':
        throw new HubError('conflict', 'This voucher has been disabled');
      case 'expired':
        throw new HubError('invalid', 'This voucher has expired');
      case 'usage_limit':
        throw new HubError('conflict', 'This voucher has reached its usage limit');
      case 'overflow':
        throw new HubError('invalid', 'Credit balance would exceed its supported limit');
      case 'ok':
        return { creditsAdded: res.creditsAdded, extraCredits: res.extraCredits };
    }
  }

  /** An admin sets someone's plan, and optionally their own allowance and workspace/participant limits (Enterprise deals). */
  async setPlan(ownerId: string, change: { plan: Plan; allowanceUsd?: number | null; maxWorkspaces?: number | null; maxParticipants?: number | null }): Promise<BillingRecord> {
    return this.store.setPlan(ownerId, change);
  }

  /** Paddle's customer portal for this person: cards, invoices, cancelling. */
  async portalUrl(ownerId: string): Promise<string> {
    const rec = await this.get(ownerId);
    if (!this.paddle || !rec?.paddleCustomerId) throw new HubError('not_found', 'No Paddle subscription to manage');
    const res = await this.fetchImpl(`${this.apiBase()}/customers/${encodeURIComponent(rec.paddleCustomerId)}/portal-sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.paddle.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(rec.paddleSubscriptionId ? { subscription_ids: [rec.paddleSubscriptionId] } : {}),
    });
    if (!res.ok) throw new HubError('unavailable', `Paddle answered HTTP ${res.status}`);
    return ((await res.json()) as { data: { urls: { general: { overview: string } } } }).data.urls.general.overview;
  }

  private apiBase(): string {
    return this.paddle?.environment === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
  }

  /**
   * One webhook event, at most once (Paddle retries): a subscription sets the person's plan; a completed
   * transaction for a top-up adds to their balance. Who it is comes from the checkout's `custom_data`:
   * `billingAccountId` (a workspace owner buying for the company pool, keyed by the workspace id) or `ownerId`.
   */
  async handle(event: PaddleEvent): Promise<'done' | 'seen' | 'ignored'> {
    const d = event.data;
    const isSub = event.event_type.startsWith('subscription.');
    const teamPrice = this.paddle?.prices.team;
    const teamItem = isSub && teamPrice ? (d.items ?? []).find((i: { price?: { id?: string } }) => i.price?.id === teamPrice) : undefined;
    // custom_data comes from the client, so a pool id (billingAccountId) counts only on a top-up that names a real workspace,
    // or on a Team-price subscription whose ownerId is that workspace's owner (as forgeable as Pro's ownerId, so it is no stronger
    // than the trust Pro already puts in it); a pool keeps its first Team subscription (store), and a Team subscription never lands on ownerId's own doc.
    // A subscription a pool already holds stays there whatever its price (the Team price id may rotate); no other subscription
    // touches a workspace-keyed doc, and a paying Team subscription under 3 seats grants nothing.
    const poolId: string | undefined = d.custom_data?.billingAccountId;
    const pool = !poolId
      ? undefined
      : event.event_type === 'transaction.completed'
        ? (await this.store.isWorkspace(poolId)) ? poolId : undefined
        : teamItem && d.custom_data?.ownerId && (await this.store.workspaceOwner(poolId)) === d.custom_data.ownerId
          ? poolId
          : undefined;
    const now = new Date().toISOString();

    if (isSub) {
      const known = d.id ? await this.store.ownerOfSubscription(d.id) : undefined;
      const knownPool = known && (await this.store.isWorkspace(known)) ? known : undefined;
      const toPool = knownPool ?? pool;
      const person = toPool || teamItem ? undefined : (d.custom_data?.ownerId ?? known);
      if (person && (await this.store.isWorkspace(person))) return this.store.markEventSeen(event.event_id, event.event_type, now);
      const seats = toPool ? Number((teamItem ?? d.items?.[0])?.quantity) || 0 : 0;
      if (toPool && seats < TEAM_MIN_SEATS && ['active', 'trialing', 'past_due'].includes(d.status ?? '')) {
        console.warn(`billing: ignoring ${event.event_type} ${d.id}: Team needs ${TEAM_MIN_SEATS}+ seats, got ${seats}`);
        return this.store.markEventSeen(event.event_id, event.event_type, now);
      }
      return this.store.handleSubscriptionEvent(event.event_id, event.event_type, toPool ?? person, d, event.occurred_at, now, toPool ? { seats } : undefined);
    }
    const ownerId: string | undefined =
      pool ??
      d.custom_data?.ownerId ??
      (d.subscription_id
        ? await this.store.ownerOfSubscription(d.subscription_id)
        : d.customer_id
          ? await this.store.ownerOfCustomer(d.customer_id)
          : undefined);
    if (event.event_type === 'transaction.completed') {
      const topups = this.paddle?.prices.topups ?? {};
      const usd = (d.items ?? []).reduce((sum: number, i: { price?: { id?: string }; quantity?: number }) => {
        const pack = Object.entries(topups).find(([, id]) => id === i.price?.id)?.[0];
        return sum + (pack ? Number(pack) * (i.quantity ?? 1) : 0);
      }, 0);
      if (!usd) return this.store.markEventSeen(event.event_id, event.event_type, now);
      const micros = Math.round(usd * 1_000_000);
      return this.store.handleTopupTransaction(event.event_id, event.event_type, ownerId, d.id, pool ? undefined : d.customer_id, micros, now);
    }
    if (event.event_type === 'adjustment.updated' || event.event_type === 'adjustment.created') {
      // ponytail: derive refund cents from Paddle's adjustment totals.subtotal or items[].amount (before tax)
      const subtotal = d.totals?.subtotal !== undefined ? Number(d.totals.subtotal) : NaN;
      const cents = Number.isFinite(subtotal)
        ? subtotal
        : (d.items ?? []).reduce((sum: number, i: { amount?: string | number; totals?: { subtotal?: string | number } }) => {
            const amt = Number(i.amount ?? i.totals?.subtotal ?? 0);
            return sum + (Number.isFinite(amt) ? amt : 0);
          }, 0);
      const refundMicros = Math.round(cents * CREDIT_MICROS);
      return this.store.handleAdjustmentEvent(event.event_id, event.event_type, ownerId, d.id, d.transaction_id, d.status, d.action, refundMicros, now);
    }
    return this.store.markEventSeen(event.event_id, event.event_type, now);
  }
}
