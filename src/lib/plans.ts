export type Plan = 'free' | 'pro' | 'team' | 'enterprise';

/** `billing/{ownerId}`: a person's plan, their Paddle ids, and their top-up balance. */
export interface BillingRecord {
  ownerId: string;
  plan: Plan;
  paddleCustomerId?: string;
  paddleSubscriptionId?: string;
  /** When the paid period ends (and, with cancelAtPeriodEnd, when Pro stops). */
  periodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  /** Top-ups not spent yet, in millionths of a dollar: spent only once the month's allowance is. */
  extraMicros?: number;
  /** Set by an admin (Enterprise, or a one-off): overrides the plan's allowance and workspace/participant limits. */
  allowanceUsd?: number;
  maxWorkspaces?: number;
  maxParticipants?: number;
  /** A company pool's (workspace's) monthly spend limit in micros, set by its owners: past it, work stops until the month turns. Unset: no limit. */
  budgetMicros?: number;
  /** Team: seats bought (Paddle quantity); each adds TEAM_SEAT_USD to the pool's monthly allowance. */
  seats?: number;
  /** People this person brought in whose referral was rewarded (up to REFERRALS_MAX pay them). */
  referrals?: number;
  /** `occurred_at` of the last subscription event applied: an older one arriving late is ignored. */
  subscriptionEventAt?: string;
  updatedAt?: string;
}

/** One credit is one cent of internal usage allowance. */
export const CREDIT_MICROS = 10_000;
export const BILLING = 'billing';

/** Each plan's monthly credits (in USD, 1 credit = 1¢: Pro's 30 = 3,000), workspaces it may own, and participants per owned workspace.
 * Free's allowance is the hub's default (LLM_MONTHLY_ALLOWANCE_USD). The workspace owner's plan sets the participant cap. Free's maxWorkspaces counts workspaces you're in (owned or joined); paid plans count only those you own.
 * Going over never removes anyone: nobody new can be added until the owner upgrades. An admin can change one person's
 * limits (maxWorkspaces, maxParticipants). Super admins have none, nor does a self-hosted hub (registry/workspaces.ts). */
const PLAN_LIMITS: Record<Plan, { allowanceUsd?: number; maxWorkspaces: number; maxParticipants: number }> = {
  free: { maxWorkspaces: 2, maxParticipants: 8 },
  pro: { allowanceUsd: 30, maxWorkspaces: 10, maxParticipants: 50 },
  team: { maxWorkspaces: 10, maxParticipants: 50 },
  enterprise: { allowanceUsd: 100, maxWorkspaces: 100, maxParticipants: 500 },
};

/** Team: $25/seat/month buys 1,500 credits ($15) per seat into the company pool; at least 3 seats. */
const TEAM_SEAT_USD = 15;
export const TEAM_MIN_SEATS = 3;

/** What a person's plan gives them right now: monthly allowance and top-up balance (micro-dollars), and agents. */
export interface Limits {
  plan: Plan;
  monthlyMicros: number;
  extraMicros: number;
  maxWorkspaces: number;
  maxParticipants: number;
}

export function limitsOf(rec: BillingRecord | undefined, freeAllowanceMicros: number, now = Date.now()): Limits {
  // Cancelled at period end and the period is over: Free, even if Paddle's final webhook never arrives.
  const lapsed = (rec?.plan === 'pro' || rec?.plan === 'team') && rec.cancelAtPeriodEnd === true && !!rec.periodEnd && Date.parse(rec.periodEnd) <= now;
  const plan = lapsed ? 'free' : (rec?.plan ?? 'free');
  const base = PLAN_LIMITS[plan];
  const allowanceUsd = lapsed ? base.allowanceUsd : (rec?.allowanceUsd ?? (plan === 'team' ? Math.max(TEAM_MIN_SEATS, rec?.seats ?? 0) * TEAM_SEAT_USD : base.allowanceUsd));
  return {
    plan,
    monthlyMicros: allowanceUsd === undefined ? freeAllowanceMicros : Math.round(allowanceUsd * 1_000_000),
    extraMicros: Math.max(0, rec?.extraMicros ?? 0),
    maxWorkspaces: rec?.maxWorkspaces ?? base.maxWorkspaces,
    maxParticipants: rec?.maxParticipants ?? base.maxParticipants,
  };
}

