import { AdminNav } from '@/components/Admin';
import { CreateVoucherForm, DisableVoucherButton } from '@/components/Vouchers';
import { PageHeader } from '@/components/ui';
import { adminGet } from '@/lib/admin';
import { createCreditVoucher, disableCreditVoucher } from '@/lib/actions/vouchers';
import type { CreditVoucher } from '@/lib/vouchers';

export default async function Vouchers() {
  const { vouchers } = await adminGet<{ vouchers: CreditVoucher[] }>('/admin/vouchers', '/admin/vouchers');
  return <div className="space-y-6">
    <PageHeader title="Credit vouchers" sub="Grant usage credits with a code, a redeem-by date and a unique-user limit." />
    <AdminNav current="/admin/vouchers" />
    <CreateVoucherForm action={createCreditVoucher} />
    <section className="space-y-3"><h2 className="font-semibold">Latest 100 vouchers</h2>
      {!vouchers.length && <p className="text-sm text-[var(--muted)]">No vouchers yet.</p>}
      <ul className="space-y-3">{vouchers.map((v) => {
        const expired = v.redeemBefore <= new Date().toISOString();
        const status = !v.active ? 'Disabled' : expired ? 'Expired' : v.usedCount >= v.maxUses ? 'Full' : 'Active';
        return <li key={v.code} className="card flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1"><h3 className="break-all font-mono font-semibold">{v.code}</h3><p className="text-sm">+{v.credits.toLocaleString()} credits · {v.usedCount} / {v.maxUses} used · {Math.max(0, v.maxUses - v.usedCount)} remaining</p><p className="text-xs text-[var(--muted)]">Redeem by {new Date(Date.parse(v.redeemBefore) - 1).toISOString().slice(0, 10)} (end of day UTC) · {status}</p></div>
          {v.active && <DisableVoucherButton action={disableCreditVoucher.bind(null, v.code)} />}
        </li>;
      })}</ul>
    </section>
  </div>;
}
