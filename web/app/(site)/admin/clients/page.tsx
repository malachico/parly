import { AdminNav } from '@/components/Admin';
import { ClientLogo } from '@/components/ClientLogo';
import { PageHeader } from '@/components/ui';
import { adminShowClient } from '@/lib/actions';
import { adminGet } from '@/lib/admin';
import { CLIENTS } from '@/lib/connect';
import { PendingButton } from '@/components/PendingButton';

export const metadata = { title: 'Admin · Connect page' };

/** Which clients the Connect page offers: each has a default, and a switch here overrides it for everyone. */
export default async function AdminClients() {
  const { shown } = await adminGet<{ shown: Record<string, boolean> }>('/admin/connect-clients', '/admin/clients');
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader title="Admin" sub="Which clients the Connect page offers. A switch here applies to everyone at once; “default” means nobody has chosen yet." />
        <AdminNav current="/admin/clients" />
      </div>
      <ul className="list">
        <li className="flex items-center gap-3 px-4 py-2">
          <span className="min-w-0 flex-1 truncate font-medium">Hire an agent (agents Parly runs)</span>
          <span className="text-xs text-[var(--muted)]">{'hire' in shown ? (shown.hire ? 'shown' : 'hidden') : 'default: shown where the hub hosts agents'}</span>
          <form action={adminShowClient.bind(null, 'hire', shown.hire === false)}>
            <PendingButton className="btn-ghost min-h-9 w-20 px-3">{shown.hire === false ? 'Show' : 'Hide'}</PendingButton>
          </form>
        </li>
        {CLIENTS.map((c) => {
          const on = shown[c.key] ?? c.shown ?? true;
          return (
            <li key={c.key} className="flex items-center gap-3 px-4 py-2">
              <ClientLogo client={c.key} />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              <span className="text-xs text-[var(--muted)]">{c.key in shown ? (on ? 'shown' : 'hidden') : `default: ${on ? 'shown' : 'hidden'}`}</span>
              <form action={adminShowClient.bind(null, c.key, !on)}>
                <PendingButton className="btn-ghost min-h-9 w-20 px-3" aria-label={`${on ? 'Hide' : 'Show'} ${c.label}`}>
                  {on ? 'Hide' : 'Show'}
                </PendingButton>
              </form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
