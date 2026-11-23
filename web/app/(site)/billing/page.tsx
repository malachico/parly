import { ErrorNote, PageHeader } from '@/components/ui';
import { BillingCard, PoolCard } from '@/components/BillingCard';
import { RedeemVoucherForm } from '@/components/Vouchers';
import { redeemCreditVoucher } from '@/lib/actions/vouchers';
import { UsageCard } from '@/components/UsageCard';
import Link from 'next/link';
import { currentWorkspace, hub, hubOrLogin, myBilling, type Me, type PoolView, type UsageAllowance } from '@/lib/hub';
import { wsHref } from '@/lib/routes';

type Props = { searchParams: Promise<{ error?: string; asked?: string; paid?: string; had?: string; pool?: string }> };

/** Credits for bringing people in: invite them to your workspace; once their agent answers them, you both get 100. */
function InviteCard({ referrals, ws }: { referrals: number; ws?: string }) {
  return (
    <section id="invite" className="card scroll-mt-4 space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 font-semibold">Invite teammates, get credits</h2>
        <span className="text-xs text-[var(--muted)]">{Math.min(referrals, 10)} of 10</span>
      </div>
      <p className="text-sm text-[var(--fg-soft)]">
        Invite someone new to your workspace. Once one of their agents answers them, you both get 100 credits, kept until you use them.
      </p>
      {ws && referrals < 10 && (
        <Link href={wsHref(ws, { panel: 'workspace' })} className="btn-primary inline-flex">
          Invite someone
        </Link>
      )}
    </section>
  );
}

export default async function Billing({ searchParams }: Props) {
  const user = await hubOrLogin<Me>('/me', { next: '/billing' });
  const [{ error, asked, paid, had, pool: paidPool }, usage, billing] = await Promise.all([
    searchParams,
    hub<UsageAllowance>('/me/usage').catch(() => undefined),
    myBilling().catch(() => undefined),
  ]);
  const ws = await currentWorkspace(user);
  // A workspace owner manages its company credit pool here: every workspace of theirs.
  const pools = (
    await Promise.all(
      user.workspaces
        .filter((w) => w.owner && !w.archived)
        .map(async (w) => ({ w, pool: await hub<PoolView>(`/workspaces/${w.id}/billing`).catch(() => undefined) })),
    )
  ).filter((p) => p.pool);
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader
        title="Plan and billing"
        sub="Your monthly credits, cloud agent allowance, upgrades, and invoices."
      />
      <ErrorNote error={error} />
      {billing?.billedTo && (
        <p role="status" className="rounded-lg bg-[var(--subtle)] px-3 py-2 text-sm">
          Billed to {billing.billedTo.name}: your agents use your company&apos;s credits.
        </p>
      )}
      {billing &&
        pools.map(({ w, pool }) => (
          <PoolCard key={w.id} pool={pool!} name={w.name} billing={billing} me={{ id: user.id, email: user.email }} had={paid === 'pool' && paidPool === w.id ? had : undefined} team={paid === 'team' && paidPool === w.id} />
        ))}
      {billing?.paddle?.prices.team && !pools.length && !billing.billedTo && (
        <p className="muted text-sm">Team plan for your company: create a workspace for it, then buy Team here.</p>
      )}
      {billing ? (
        <BillingCard billing={billing} me={{ id: user.id, email: user.email }} asked={asked} paid={paid === 'pool' || paid === 'team' ? undefined : paid} had={had} />
      ) : (
        usage && <UsageCard usage={usage} />
      )}
      <RedeemVoucherForm action={redeemCreditVoucher} />
      {billing && <InviteCard referrals={billing.referrals ?? 0} ws={ws?.id} />}
    </div>
  );
}
