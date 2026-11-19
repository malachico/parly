'use client';

import { useRouter } from 'next/navigation';
import { credits } from '@/lib/labels';
import { useEffect, useState } from 'react';
import { askEnterprise, openBillingPortal, openPoolPortal } from '@/lib/actions';
import type { BillingView, PoolView } from '@/lib/hub';
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

const PLAN_NAMES = { free: 'Free', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' } as const;

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
  billing,
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
  const paddle = usePaddle(billing.paddle);
  billing = { ...billing, leftUsd: billing.leftUsd ?? 0 }; // ponytail: a hub from before leftUsd; drop once deployed
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label">Your plan</p>
          <h2 className="text-xl font-semibold">{PLAN_NAMES[billing.plan]}</h2>
          <p className="muted text-[13px]">
            {credits(billing.monthlyUsd)} credits a month{billing.extraUsd > 0 ? ` + ${credits(billing.extraUsd)} from top-ups` : ''}
            {billing.workspaces?.max != null
              ? ` · ${billing.workspaces.count} of ${billing.workspaces.max} workspaces`
              : ''}
            {billing.cancelAtPeriodEnd && ends ? ` · ends ${ends}` : ends && billing.plan === 'pro' ? ` · renews ${ends}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="label">Balance</p>
          <p className="text-xl font-semibold">{credits(billing.leftUsd)}</p>
          <p className="muted text-[13px]">credits left · {pct}% used</p>
        </div>
      </div>
      <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Credits used this month" className="h-2 w-full overflow-hidden rounded-full bg-[var(--subtle)]">
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-[var(--bad-fg)]' : pct >= 80 ? 'bg-amber-500' : 'bg-[var(--accent)]'}`} style={{ width: `${pct}%` }} />
      </div>

      {billing.plan === 'free' && prices.pro && (
        <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5">
          <p className="font-semibold">Pro: $20/month</p>
          <p className="muted text-[13px]">3,000 credits a month (about 300 cloud-agent answers), 10 workspaces, 50 participants each, and top-ups when you need more.</p>
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
          <p className="muted text-[13px]">3,000 credits a month (about 300 cloud-agent answers), 10 workspaces, 50 participants each, and top-ups when you need more.</p>
          {askedPro ? (
            <p role="status" className="mt-2.5 rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-sm font-medium text-[var(--ok-fg)]">
              You&apos;re on the Pro waitlist! We&apos;ll email you{me.email ? ` at ${me.email}` : ''} as soon as Pro checkout opens.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[13px]">Pro checkout opens very soon. Join the waitlist and we&apos;ll email you{me.email ? ` at ${me.email}` : ''} the moment it&apos;s ready.</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <form action={askEnterprise}>
                  <input type="hidden" name="plan" value="pro-monthly" />
                  <PendingButton className="btn-primary">Join Pro waitlist · $20/mo</PendingButton>
                </form>
                <form action={askEnterprise}>
                  <input type="hidden" name="plan" value="pro-yearly" />
                  <PendingButton className="btn">Join yearly waitlist · $200/yr</PendingButton>
                </form>
              </div>
            </>
          )}
        </div>
      )}

      {billing.plan !== 'free' && prices.topups && Object.keys(prices.topups).length > 0 && (
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

/**
 * The company credit pool, for the owner of a workspace with a verified email domain: everyone who joined by that
 * domain spends it. Shows what's left and each member's model spend this month; top-ups bought here credit the pool.
 */
export function PoolCard({
  pool,
  name,
  billing,
  me,
  had,
  team,
}: { pool: PoolView; name: string; billing: BillingView; me: { id: string; email?: string }; had?: string; team?: boolean }) {
  const paddle = usePaddle(billing.paddle);
  // Back from a pool top-up (`had`: the pool's top-ups before it) or a Team checkout: refresh until the webhook lands.
  const landed = team ? pool.plan === 'team' : had === undefined || pool.extraUsd > Number(had);
  const slow = useRefreshUntil(landed);
  const topups = billing.paddle?.prices.topups ?? {};
  const teamPrice = billing.paddle?.prices.team;
  const [seatsInput, setSeatsInput] = useState('3');
  const seats = Math.max(3, Math.floor(Number(seatsInput)) || 3);
  const buy = (priceId: string, quantity = 1, kind = 'pool') =>
    paddle?.Checkout.open({
      items: [{ priceId, quantity }],
      customData: { billingAccountId: pool.workspaceId, ownerId: me.id },
      ...(me.email ? { customer: { email: me.email } } : {}),
      settings: { successUrl: `${window.location.origin}/billing?paid=${kind}&pool=${pool.workspaceId}&had=${pool.extraUsd}` },
    });
  return (
    <section id="company" className="card scroll-mt-6 space-y-3" aria-label="Company credit pool">
      {(had !== undefined || team) && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm font-medium ${landed ? 'bg-[var(--ok-bg)] text-[var(--ok-fg)]' : 'bg-[var(--subtle)]'}`}>
          {landed && team ? `You're on Team: ${pool.seats ?? 3} seats, ${credits(pool.monthlyUsd ?? 0)} pooled credits a month.` : landed ? `Top-up added. The pool has ${credits(pool.leftUsd)} credits left.` : slow ? 'Payment received. The pool is taking longer than usual to update: reload this page in a minute.' : 'Payment received. Updating the pool…'}
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label">Company pool · {PLAN_NAMES[pool.plan]}{pool.plan === 'team' && pool.seats ? ` · ${pool.seats} seats` : ''}</p>
          <h2 className="text-xl font-semibold">{name}</h2>
          <p className="muted text-[13px]">Everyone who joined by your email domain uses these credits, for all of their agents.</p>
        </div>
        <div className="text-right">
          <p className="label">Balance</p>
          <p className="text-xl font-semibold">{credits(pool.leftUsd)}</p>
          <p className="muted text-[13px]">credits left{pool.monthlyUsd ? ` · ${credits(pool.monthlyUsd)} a month` : ''}{pool.extraUsd > 0 ? ` · ${credits(pool.extraUsd)} from top-ups` : ''}</p>
        </div>
      </div>
      {pool.members.length > 0 && (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {pool.members.map((m) => (
            <li key={m.id} className="flex justify-between py-1.5">
              <span>{m.name}</span>
              <span className="muted">{credits(m.spentUsd)} this month</span>
            </li>
          ))}
        </ul>
      )}
      {pool.plan === 'team' ? (
        pool.buyer &&
        pool.managed && (
        <form action={openPoolPortal}>
          <input type="hidden" name="workspaceId" value={pool.workspaceId} />
          <PendingButton className="btn">Manage Team</PendingButton>
        </form>
        )
      ) : pool.plan !== 'enterprise' && teamPrice ? (
        pool.buyer ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">
            Seats{' '}
            <input type="number" min={3} value={seatsInput} onChange={(e) => setSeatsInput(e.target.value)} onBlur={() => setSeatsInput(String(seats))} className="input w-20" />
          </label>
          <button type="button" disabled={!paddle} onClick={() => buy(teamPrice, seats, 'team')} className="btn-primary">
            Buy Team · ${25 * seats}/month
          </button>
          <span className="muted text-[13px]">{credits(15 * seats)} pooled credits a month; everyone on your domain gets Pro limits.</span>
        </div>
        ) : (
          <p className="muted text-[13px]">Only the person who created this workspace can buy Team for it.</p>
        )
      ) : (
        pool.plan !== 'enterprise' && (
          // ponytail: no Team price configured yet; the ask lands in Admin → Leads as an Enterprise lead.
          <form action={askEnterprise} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="company" value={name} />
            <input type="hidden" name="message" value="Team plan" />
            <span className="muted text-[13px]">Team ($25/seat/month, pooled credits): coming soon.</span>
            <PendingButton className="btn">Ask about Team</PendingButton>
          </form>
        )
      )}
      {Object.keys(topups).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(topups)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([usd, priceId]) => (
              <button key={priceId} type="button" disabled={!paddle} onClick={() => buy(priceId)} className="btn">
                Add {credits(Number(usd))} credits · ${usd}
              </button>
            ))}
        </div>
      )}
    </section>
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
