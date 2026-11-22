import { KnowledgeExplorer } from '@/components/Knowledge';
import { PanelPage } from '@/components/PanelPage';
import { PageHeader } from '@/components/ui';
import { listGraphEntries } from '@/lib/actions/graph';
import { meOrLogin } from '@/lib/hub';
import { notFound } from 'next/navigation';

type Props = { params: Promise<{ ws: string }> };

/** Knowledge: what the workspace's conversations decided, and the people, topics and docs they were about. `?entry=` picks one. */
export default async function KnowledgePage({ params }: Props) {
  const { ws } = await params;
  const [me, initial] = await Promise.all([meOrLogin(), listGraphEntries(ws)]);
  if (!me.graph) notFound();
  return (
    <PanelPage ws={ws}>
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader title="Knowledge" sub="What your conversations decided, and the people, topics and docs they were about." />
        <KnowledgeExplorer ws={ws} initial={initial} />
      </div>
    </PanelPage>
  );
}
