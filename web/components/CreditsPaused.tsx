import Link from 'next/link';
import { myBilling } from '@/lib/hub';

/** Out of credits this month: what's paused here (`what`), and the way to keep going. Nothing while there are credits. */
export async function CreditsPaused({ what }: { what: string }) {
  const billing = await myBilling().catch(() => undefined);
  if (!billing || billing.used < 1) return null;
  // The workspace's monthly budget stopped it: owners raise it in Billing; members ask one (no amounts, no top-up).
  if (billing.billedTo && billing.blockedBy === 'budget')
    return (
      <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-xl bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
        <span>⏸ {what} paused: {billing.billedTo.name} reached its monthly budget.</span>
        {billing.billedTo.owner ? (
          <Link href="/billing" className="font-semibold underline">Raise it in Billing</Link>
        ) : (
          <span>Ask an owner to raise it.</span>
        )}
      </p>
    );
  // A company pool pays (`used` is the pool's): only its owner can top it up, so just say whose credits ran out.
  if (billing.billedTo)
    return (
      <p role="status" className="rounded-xl bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
        ⏸ {what} paused: {billing.billedTo.name}&apos;s credit pool is out this month. Ask its owner to top it up.
      </p>
    );
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-xl bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
      <span>⏸ {what} paused: out of credits this month.</span>
      <Link href="/billing" className="font-semibold underline">
        {billing.plan === 'free' ? 'Upgrade to Pro' : 'Top up'}
      </Link>
      {(billing.referrals ?? 0) < 10 && (
        <Link href="/billing#invite" className="font-semibold underline">
          or invite a teammate (+100 credits)
        </Link>
      )}
    </p>
  );
}
