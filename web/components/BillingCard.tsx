'use client';

import { useRouter } from 'next/navigation';
import { credits, meterColor } from '@/lib/labels';
import { useEffect, useState } from 'react';
import { createCompany, openBillingPortal, joinProWaitlist, openPoolPortal, setPoolBudget } from '@/lib/actions';
import type { BillingView, CompanyOwnerView } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type PaddleJs = {
  Environment: { set: (env: string) => void };
  Initialize: (opts: { token: string }) => void;
  Checkout: { open: (opts: Record<string, unknown>) => void };
};

declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

const PLAN_NAMES = { free: 'Free', pro: 'Pro', team: 'Team' } as const;

/** Paddle.js, once per page, set up for this hub's environment. */
function usePaddle(paddle: BillingView['paddle']): PaddleJs | undefined {
  const [ready, setReady] = useState<PaddleJs>();
  useEffect(() => {
    if (!paddle) return;
    const init = () => {
      if (!window.Paddle) return;
      if (paddle.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
      window.Paddle.Initialize({ token: paddle.clientToken });
      setReady(window.Paddle);
    };
    if (window.Paddle) return init();
    const script = document.createElement('script');
    script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    script.onload = init;
    document.head.appendChild(script);
  }, [paddle]);
  return ready;
}

/**
 * Your plan: what it gives you, and how to change it. Upgrading and top-ups open Paddle's checkout over the page
 * (Paddle is the merchant of record; no card reaches Parly); the hub hears of the payment from Paddle's webhook.
 */
export function BillingCard({
  billing: view,
  me,
  asked,
  paid,
  had,
}: {
  billing: BillingView;
  me: { id: string; email?: string };
  asked?: string | boolean;
  /** Back from Paddle's checkout: `pro` or `topup` (with `had`, the top-ups before it). */
  paid?: string;
  had?: string;
}) {
  // Absent when a company pays (its amounts are hidden there anyway) or from a hub before leftUsd.
  const billing = { ...view, monthlyUsd: view.monthlyUsd ?? 0, extraUsd: view.extraUsd ?? 0, leftUsd: view.leftUsd ?? 0 };
  const paddle = usePaddle(billing.paddle);
  // Paddle's webhook usually lands a moment after its checkout sends you back: until it does, the page refreshes.
  const landed = paid === 'pro' ? billing.plan !== 'free' : paid === 'topup' ? billing.extraUsd > Number(had ?? 0) : true;
  const slow = useRefreshUntil(landed);
  const prices = billing.paddle?.prices ?? {};
  const askedPro = asked === 'pro-monthly' || asked === 'pro-yearly' || asked === 'pro' || asked === '1' || asked === true;
  const checkout = (priceId: string, kind: 'pro' | 'topup') =>
    paddle?.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customData: { ownerId: me.id },
      ...(me.email ? { customer: { email: me.email } } : {}),
      settings: { successUrl: `${window.location.origin}/billing?paid=${kind}&had=${billing.extraUsd}` },
    });
  const pct = Math.min(100, Math.round(billing.used * 100));
  // On Team the company pool pays: your own credits don't matter, so the pool card shows the balance.
  const pooled = Boolean(billing.company);
  const ends = billing.periodEnd ? new Date(billing.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : undefined;

  return (
    <section id="billing" className="card scroll-mt-6 space-y-4" aria-label="Plan and billing">
      {paid && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm font-medium ${landed ? 'bg-[var(--ok-bg)] text-[var(--ok-fg)]' : 'bg-[var(--subtle)]'}`}>
          {!landed
            ? slow
              ? 'Payment received. Your plan is taking longer than usual to update: reload this page in a minute.'
              : 'Payment received. Updating your plan…'
            : paid === 'pro'
              ? `You're on ${PLAN_NAMES[billing.plan]} now: ${credits(billing.monthlyUsd)} credits a month.`
              : `Top-up added. You have ${credits(billing.leftUsd)} credits left.`}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="label">Your plan</p>
          <h2 className="text-xl font-semibold">{PLAN_NAMES[billing.plan]}</h2>
          <p className="muted text-[13px]">
            {pooled ? 'Your company pool pays for your agents' : `${credits(billing.monthlyUsd)} credits a month${billing.extraUsd > 0 ? ` + ${credits(billing.extraUsd)} from top-ups` : ''}`}
            {billing.workspaces?.max != null
              ? ` · ${billing.workspaces.count} of ${billing.workspaces.max} workspaces`
              : ''}
            {billing.cancelAtPeriodEnd && ends ? ` · ends ${ends}` : ends && billing.plan === 'pro' ? ` · renews ${ends}` : ''}
          </p>
        </div>
        {!pooled && (
          <div className="shrink-0 sm:text-right">
            <p className="label">Balance</p>
            <p className="text-xl font-semibold">{credits(billing.leftUsd)}</p>
            <p className="muted text-[13px]">credits left · {pct}% used</p>
          </div>
        )}
      </div>
      {billing.company && billing.ownPlan === 'pro' && ends && <p className="muted text-[13px]">Pro ends on {ends}, Team covers you now.</p>}
      {!pooled && (
        <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Credits used this month" className="h-2 w-full overflow-hidden rounded-full bg-[var(--subtle)]">
          <div className={`h-full rounded-full ${meterColor(pct)}`} style={{ width: `${pct}%` }} />
        </div>
      )}

      {billing.plan === 'free' && prices.pro && (
        <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5">
          <p className="font-semibold">Pro: $20/month</p>
          <p className="muted text-[13px]">1,500 credits a month (about 150 cloud-agent answers), 10 workspaces, 50 participants each, and top-ups when you need more.</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" disabled={!paddle} onClick={() => checkout(prices.pro!, 'pro')} className="btn-primary">
              Upgrade to Pro
            </button>
            {prices.proYearly && (
              <button type="button" disabled={!paddle} onClick={() => checkout(prices.proYearly!, 'pro')} className="btn">
                $200/year
              </button>
            )}
          </div>
        </div>
      )}

      {/* ponytail: until this hub takes payments (PADDLE_* unset), wanting Pro becomes a lead for the admins. */}
      {billing.plan === 'free' && !prices.pro && (
        <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">Pro: $20/month</p>
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-semibold text-white">Waitlist</span>
          </div>
          <p className="muted text-[13px]">1,500 credits a month (about 150 cloud-agent answers), 10 workspaces, 50 participants each, and top-ups when you need more.</p>
          {askedPro ? (
            <p role="status" className="mt-2.5 rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-sm font-medium text-[var(--ok-fg)]">
              You&apos;re on the Pro waitlist! We&apos;ll email you{me.email ? ` at ${me.email}` : ''} as soon as Pro checkout opens.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[13px]">Pro checkout opens very soon. Join the waitlist and we&apos;ll email you{me.email ? ` at ${me.email}` : ''} the moment it&apos;s ready.</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <form action={joinProWaitlist}>
                  <input type="hidden" name="plan" value="pro-monthly" />
                  <PendingButton className="btn-primary">Join Pro waitlist · $20/mo</PendingButton>
                </form>
                <form action={joinProWaitlist}>
                  <input type="hidden" name="plan" value="pro-yearly" />
                  <PendingButton className="btn">Join yearly waitlist · $200/yr</PendingButton>
                </form>
              </div>
            </>
          )}
        </div>
      )}

      {billing.plan !== 'free' && !billing.company && prices.topups && Object.keys(prices.topups).length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Top up credits</p>
          <p className="muted text-[13px]">Used after the month&apos;s credits; whatever&apos;s left carries over.</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(prices.topups)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([usd, priceId]) => (
                <button key={priceId} type="button" disabled={!paddle} onClick={() => checkout(priceId, 'topup')} className="btn">
                  {credits(Number(usd))} credits · ${usd}
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-[13px]">
        {billing.canManage ? (
          <form action={openBillingPortal}>
            <PendingButton className="btn-ghost min-h-8 px-2.5">Manage subscription and invoices</PendingButton>
          </form>
        ) : (
          <span className="muted">No payment details on file.</span>
        )}
      </div>

    </section>
  );
}

/** Team checkout for a company: Paddle bills the company (`billingAccountId`), not the buyer. */
function useTeamCheckout(billing: BillingView, me: { id: string; email?: string }) {
  const paddle = usePaddle(billing.paddle);
  const [seatsInput, setSeatsInput] = useState('3');
  const seats = Math.max(3, Math.floor(Number(seatsInput)) || 3);
  const buy = (companyId: string, priceId: string, quantity = 1, kind = 'pool', had = 0) =>
    paddle?.Checkout.open({
      items: [{ priceId, quantity }],
      customData: { billingAccountId: companyId, ownerId: me.id },
      ...(me.email ? { customer: { email: me.email } } : {}),
      settings: { successUrl: `${window.location.origin}/billing?paid=${kind}&pool=${companyId}&had=${had}` },
    });
  const seatsField = (
    <label className="text-sm">
      Seats{' '}
      <input type="number" min={3} value={seatsInput} onChange={(e) => setSeatsInput(e.target.value)} onBlur={() => setSeatsInput(String(seats))} className="input w-20" />
    </label>
  );
  return { paddle, seats, buy, seatsField };
}

/** Free or Pro with no company: name it, pick seats, pay. The company is created first so the checkout bills it. */
export function StartTeam({ billing, me }: { billing: BillingView; me: { id: string; email?: string; name: string } }) {
  const { paddle, seats, buy, seatsField } = useTeamCheckout(billing, me);
  const [name, setName] = useState(`${me.name}'s team`);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const teamPrice = billing.paddle?.prices.team;
  if (!teamPrice) return null;
  const start = async () => {
    setError(undefined);
    setPending(true);
    const r = await createCompany(name.trim()).finally(() => setPending(false));
    if ('error' in r) return setError(r.error);
    buy(r.id, teamPrice, seats, 'team');
  };
  return (
    <details className="card">
      <summary className="cursor-pointer text-sm font-medium">Start a Team</summary>
      <div className="mt-3 space-y-2">
        <p className="muted text-[13px]">$25/seat/month, at least 3 seats: {credits(15 * seats)} pooled credits a month, and Pro limits for everyone you add.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">
            Company{' '}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="input w-48" />
          </label>
          {seatsField}
          <button type="button" disabled={!paddle || !name.trim() || pending} onClick={start} className="btn-primary">
            Buy Team · ${25 * seats}/month
          </button>
        </div>
        {error && <p role="alert" className="text-[13px] text-[var(--bad-fg)]">{error}</p>}
      </div>
    </details>
  );
}

/**
 * A company you own: its credit pool, budget, Team subscription and top-ups. Its people spend the pool while it is on Team; members and invites are on CompanyCard.
 */
export function CompanyPool({
  company,
  billing,
  me,
  had,
  team,
}: { company: CompanyOwnerView; billing: BillingView; me: { id: string; email?: string }; had?: string; team?: boolean }) {
  const { paddle, seats, buy, seatsField } = useTeamCheckout(billing, me);
  // Back from a pool top-up (`had`: the pool's top-ups before it) or a Team checkout: refresh until the webhook lands.
  const landed = team ? company.plan === 'team' : had === undefined || company.extraUsd > Number(had);
  const slow = useRefreshUntil(landed);
  const topups = billing.paddle?.prices.topups ?? {};
  const teamPrice = billing.paddle?.prices.team;
  return (
    <section className="card scroll-mt-6 space-y-3" aria-label="Company credit pool">
      {(had !== undefined || team) && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm font-medium ${landed ? 'bg-[var(--ok-bg)] text-[var(--ok-fg)]' : 'bg-[var(--subtle)]'}`}>
          {landed && team ? `You're on Team: ${company.seats.max ?? 3} seats, ${credits(company.monthlyUsd)} pooled credits a month.` : landed ? `Top-up added. The pool has ${credits(company.leftUsd)} credits left.` : slow ? 'Payment received. The pool is taking longer than usual to update: reload this page in a minute.' : 'Payment received. Updating the pool…'}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="label">Company pool · {PLAN_NAMES[company.plan]}</p>
          <h2 className="text-xl font-semibold">{company.name}</h2>
          <p className="muted text-[13px]">While you're on Team, your company's people use these credits, for all of their agents.</p>
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="label">Balance</p>
          <p className="text-xl font-semibold">{credits(company.leftUsd)}</p>
          <p className="muted text-[13px]">credits left{company.monthlyUsd ? ` · ${credits(company.monthlyUsd)} a month` : ''}{company.extraUsd > 0 ? ` · ${credits(company.extraUsd)} from top-ups` : ''}</p>
        </div>
      </div>
      {/* Remounts when the saved budget changes, closing the form. */}
      <PoolBudget key={String(company.budgetCredits)} company={company} />
      {company.plan === 'team'
        ? company.managed && (
            <form action={openPoolPortal}>
              <input type="hidden" name="companyId" value={company.id} />
              <PendingButton className="btn">Manage Team</PendingButton>
            </form>
          )
        : teamPrice && (
            <div className="flex flex-wrap items-center gap-2">
              {seatsField}
              <button type="button" disabled={!paddle} onClick={() => buy(company.id, teamPrice, seats, 'team')} className="btn-primary">
                Buy Team · ${25 * seats}/month
              </button>
              <span className="muted text-[13px]">{credits(15 * seats)} pooled credits a month; your team gets Pro limits.</span>
            </div>
          )}
      {Object.keys(topups).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(topups)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([usd, priceId]) => (
              <button key={priceId} type="button" disabled={!paddle} onClick={() => buy(company.id, priceId, 1, 'pool', company.extraUsd)} className="btn">
                Add {credits(Number(usd))} credits · ${usd}
              </button>
            ))}
        </div>
      )}
    </section>
  );
}

/** The owner's monthly budget for the company: spent against it this month, and set, edit or remove it. */
function PoolBudget({ company: pool }: { company: CompanyOwnerView }) {
  const budget = pool.budgetCredits ?? null;
  const spent = pool.spentCredits ?? 0;
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(budget === null ? '' : String(budget));
  const pct = budget === null ? 0 : budget === 0 ? 100 : Math.min(100, Math.round((spent / budget) * 100));
  const n = (c: number) => credits(c / 100);
  const below = input !== '' && Number(input) < spent;
  return (
    <div className="space-y-2 rounded-xl bg-[var(--subtle)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="label">Monthly budget</p>
        <p className="text-sm">
          {budget === null ? <span className="muted">None: work stops only when credits run out · {n(spent)} spent this month</span> : `${n(spent)} of ${n(budget)} credits spent this month`}
        </p>
      </div>
      {budget !== null && (
        <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used this month" className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg)]">
          <div className={`h-full rounded-full ${meterColor(pct)}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {pool.blockedBy === 'budget' && <p className="text-[13px] font-medium text-[var(--bad-fg)]">The budget is reached: agents on this pool stop until next month or until you raise it.</p>}
      {editing ? (
        <form action={setPoolBudget} className="space-y-2">
          <input type="hidden" name="companyId" value={pool.id} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm">
              Credits a month{' '}
              <input name="credits" type="number" min={0} step={1} required value={input} onChange={(e) => setInput(e.target.value)} className="input w-28" />
            </label>
            <PendingButton className="btn-primary">Save</PendingButton>
            <button type="button" onClick={() => { setEditing(false); setInput(budget === null ? '' : String(budget)); }} className="btn">Cancel</button>
          </div>
          {below && <p role="status" className="rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-[13px] text-[var(--warn-fg)]">That's below the {n(spent)} credits already spent this month: work stops as soon as you save.</p>}
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setEditing(true)} className="btn">{budget === null ? 'Set budget' : 'Edit budget'}</button>
          {budget !== null && (
            <form action={setPoolBudget}>
              <input type="hidden" name="companyId" value={pool.id} />
              <input type="hidden" name="credits" value="" />
              <PendingButton className="btn">Remove budget</PendingButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** Paddle's webhook usually lands a moment after its checkout sends you back: refresh the page until `landed`; true once it gives up after a minute. */
function useRefreshUntil(landed: boolean): boolean {
  const router = useRouter();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (landed) return;
    const tick = setInterval(() => router.refresh(), 2000);
    const giveUp = setTimeout(() => (clearInterval(tick), setSlow(true)), 60_000);
    return () => (clearInterval(tick), clearTimeout(giveUp));
  }, [landed, router]);
  return slow;
}
