import Link from 'next/link';
import { AdminNav } from '@/components/Admin';
import { LocalTime } from '@/components/LocalTime';
import { Empty, PageHeader } from '@/components/ui';
import { adminAgentHref, adminGet, type ClientRequest } from '@/lib/admin';

export const metadata = { title: 'Admin · Client requests' };

/** Clients people asked for from the Connect page, with their email, newest first. */
export default async function AdminClientRequests() {
  const requests = await adminGet<ClientRequest[]>('/admin/client-requests?limit=200', '/admin/requests');
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader title="Admin" sub="Clients people asked for from the Connect page, newest first (the latest 200)." />
        <AdminNav current="/admin/requests" />
      </div>
      {requests.length === 0 ? (
        <Empty>No client requests yet.</Empty>
      ) : (
        <ul className="list">
          {requests.map((r) => (
            <li key={r.id} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Link href={adminAgentHref(r.agentId)} className="font-medium text-[var(--accent)] hover:underline">
                  {r.name}
                </Link>
                <a href={`mailto:${r.email}`} className="text-[var(--muted)] hover:underline">
                  {r.email}
                </a>
                <LocalTime iso={r.at} date className="ml-auto text-xs text-[var(--muted)] tabular-nums" />
              </div>
              <p className="break-words whitespace-pre-wrap">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
