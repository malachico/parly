import Link from 'next/link';
import { AdminNav } from '@/components/Admin';
import { LocalTime } from '@/components/LocalTime';
import { Empty, PageHeader } from '@/components/ui';
import { adminGet, type PlanLead } from '@/lib/admin';

export const metadata = { title: 'Admin · Pro waitlist' };

/** People who joined the Pro waitlist from Account → Billing, newest first. Each one is also emailed to the admins. */
const PLAN: Record<string, string> = { 'pro-monthly': 'Pro monthly', 'pro-yearly': 'Pro yearly' };

export default async function AdminLeads() {
  // Old hub path on purpose: the web can deploy before the hub. Rename to /admin/leads later.
  const leads = await adminGet<PlanLead[]>('/admin/enterprise-leads?limit=200', '/admin/leads');
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader title="Admin" sub="Pro waitlist from Account → Billing, newest first. Set a plan on the person's page." />
        <AdminNav current="/admin/leads" />
      </div>
      {leads.length === 0 ? (
        <Empty>No requests yet.</Empty>
      ) : (
        <ul className="list">
          {leads.map((l) => (
            <li key={l.id} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                {l.plan && <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs font-semibold text-white">{PLAN[l.plan] ?? l.plan}</span>}
                <LocalTime iso={l.at} date className="ml-auto text-xs text-[var(--muted)] tabular-nums" />
              </div>
              <div className="flex flex-wrap gap-x-2">
                <Link href={`/admin/agents/${encodeURIComponent(l.agentId)}`} className="text-[var(--accent)] hover:underline">
                  {l.name}
                </Link>
                <a href={`mailto:${l.email}?subject=${encodeURIComponent(`Parly ${PLAN[l.plan ?? ''] ?? 'Pro'}`)}`} className="text-[var(--muted)] hover:underline">
                  {l.email}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
