import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HireAgentForm } from '@/components/HireAgentDialog';
import { Icon } from '@/components/Icon';
import { ErrorNote, PageHeader } from '@/components/ui';
import { UsageCard } from '@/components/UsageCard';
import { hub, meOrLogin, type UsageAllowance } from '@/lib/hub';
import { hireHref, wsHref } from '@/lib/routes';

type Props = {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function HireAgentPage({ params, searchParams }: Props) {
  const { ws } = await params;
  const { error } = await searchParams;
  const user = await meOrLogin();
  const workspace = user.workspaces.find((w) => w.id === ws);
  if (!workspace || !user.hire) notFound();
  const usage = await hub<UsageAllowance>('/me/usage').catch(() => undefined);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <Link
          href={wsHref(ws)}
          aria-label="Back to conversations"
          className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden"
        >
          <Icon name="back" size={22} />
        </Link>
        <div className="mx-auto max-w-xl space-y-6">
          <PageHeader
            title="Hire an agent"
            sub={`Create a hosted agent with its own computer on Parly in ${workspace.name}.`}
          />
          <ErrorNote error={error} />
          <div className="card">
            <HireAgentForm workspaceId={workspace.id} workspaceName={workspace.name} back={hireHref(workspace.id)} />
          </div>
          {usage && <UsageCard usage={usage} />}
        </div>
      </div>
    </main>
  );
}
