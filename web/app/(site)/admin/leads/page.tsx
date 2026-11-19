import Link from 'next/link';
import { AdminNav } from '@/components/Admin';
import { LocalTime } from '@/components/LocalTime';
import { Empty, PageHeader } from '@/components/ui';
import { adminGet, type EnterpriseLead } from '@/lib/admin';

export const metadata = { title: 'Admin · Enterprise leads' };

/** People who asked about Enterprise from Account → Billing, newest first. Each one is also emailed to the super admins. */
/** What each request asked for. */
const PLAN: Record<string, string> = { enterprise: 'Enterprise', 'pro-monthly': 'Pro monthly', 'pro-yearly': 'Pro yearly' };

export default async function AdminLeads() {
  const leads = await adminGet<EnterpriseLead[]>('/admin/enterprise-leads?limit=200', '/admin/leads');
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader title="Admin" sub="Plan requests from Account → Billing (Enterprise, and Pro while checkout is closed), newest first. Set a plan on the person's page." />
        <AdminNav current="/admin/leads" />
      </div>
      {leads.length === 0 ? (
        <Empty>No requests yet.</Empty>
      ) : (
        <ul className="list">
          {leads.map((l) => (
            <li key={l.id} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${l.plan && l.plan !== 'enterprise' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--subtle)]'}`}>
                  {PLAN[l.plan ?? 'enterprise'] ?? l.plan}
                </span>
                {(l.company || l.plan === 'enterprise' || !l.plan) && <span className="font-semibold">{l.company || 'No company given'}</span>}
                {l.size && <span className="text-[var(--muted)]">· {l.size}</span>}
                <LocalTime iso={l.at} date className="ml-auto text-xs text-[var(--muted)] tabular-nums" />
              </div>
              <div className="flex flex-wrap gap-x-2">
                <Link href={`/admin/agents/${encodeURIComponent(l.agentId)}`} className="text-[var(--accent)] hover:underline">
                  {l.name}
                </Link>
                <a href={`mailto:${l.email}?subject=${encodeURIComponent(`Parly ${PLAN[l.plan ?? 'enterprise'] ?? ''}`)}`} className="text-[var(--muted)] hover:underline">
                  {l.email}
                </a>
              </div>
              {l.message && <p className="break-words whitespace-pre-wrap">{l.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
