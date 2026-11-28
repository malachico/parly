import { notFound } from 'next/navigation';
import { BackToConversations } from '@/components/BackToConversations';
import { HireAgentForm } from '@/components/HireAgentDialog';
import { ErrorNote, PageHeader } from '@/components/ui';
import { UsageCard } from '@/components/UsageCard';
import { hub, meOrLogin, type UsageAllowance } from '@/lib/hub';
import { hireHref } from '@/lib/routes';

type Props = {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function HireAgentPage({ params, searchParams }: Props) {
  const { ws } = await params;
  const { error } = await searchParams;
  const [user, usage] = await Promise.all([meOrLogin(), hub<UsageAllowance>('/me/usage').catch(() => undefined)]);
  const workspace = user.workspaces.find((w) => w.id === ws);
  if (!workspace || !user.hire) notFound();

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <BackToConversations ws={ws} inset />
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
