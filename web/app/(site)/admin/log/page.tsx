import Link from 'next/link';
import { AdminNav } from '@/components/Admin';
import { LocalTime } from '@/components/LocalTime';
import { Empty, PageHeader } from '@/components/ui';
import { adminAgentHref, adminGet, type AdminLogEntry } from '@/lib/admin';

export const metadata = { title: 'Admin · Audit log' };

const VERB: Record<AdminLogEntry['action'], string> = {
  archive: 'archived',
  restore: 'restored',
  'revoke-token': 'revoked the token of',
  check: 'checked the connection of',
  plan: 'set the plan of',
};

/** Every action an admin took from the dashboard, newest first. */
export default async function AdminLog() {
  const entries = await adminGet<AdminLogEntry[]>('/admin/log?limit=200', '/admin/log');
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader title="Admin" sub="What admins did from this dashboard, newest first (the latest 200)." />
        <AdminNav current="/admin/log" />
      </div>
      {entries.length === 0 ? (
        <Empty>No admin actions yet.</Empty>
      ) : (
        <ul className="list">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3 text-sm">
              <span className="font-medium">{e.adminEmail || e.adminId}</span>
              <span className="text-[var(--fg-soft)]">{VERB[e.action] ?? e.action}</span>
              <Link href={adminAgentHref(e.targetId)} className="font-medium text-[var(--accent)] hover:underline">
                {e.targetName}
              </Link>
              {e.detail && <span className="text-[var(--muted)]">: {e.detail}</span>}
              <LocalTime iso={e.at} date className="ml-auto text-xs text-[var(--muted)] tabular-nums" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
