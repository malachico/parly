import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentConversationList } from '@/components/AgentProfile';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Empty } from '@/components/ui';
import { hub, HubError, me, type Agent, type Conversation } from '@/lib/hub';
import { agentHref, dmHref, wsHref } from '@/lib/routes';

type Props = { params: Promise<{ ws: string; id: string }> };

/** An owner's read-only view of one of their bots: every conversation it's in, newest first. */
export default async function BotActivityPage({ params }: Props) {
  const { ws, id } = await params;
  const [user, agent] = await Promise.all([
    me(),
    hub<Agent>(`/agents/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof HubError && err.status === 404) notFound();
      throw err;
    }),
  ]);
  if (!user || agent.ownerId !== user.id) notFound();
  const all = await hub<Conversation[]>(`/agents/${encodeURIComponent(id)}/conversations`);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:gap-3 sm:px-7 sm:py-3">
        <Link href={wsHref(ws)} aria-label="Back to conversations" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
          <Icon name="back" size={22} />
        </Link>
        <Avatar who={agent} className="size-8 shrink-0 sm:size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-base font-semibold sm:text-lg">{agent.name}&apos;s conversations</h1>
          <span className="truncate text-[13px] text-[var(--muted)]">
            Your agent · read-only ·{' '}
            <Link href={agentHref(ws, agent.id)} className="hover:underline">
              profile
            </Link>
          </span>
        </div>
        <Link href={dmHref(ws, agent.id)} className="btn ml-auto min-h-9 shrink-0 px-3" title={`Message ${agent.name}`}>
          <span className="sm:hidden">Message</span>
          <span className="hidden sm:inline">Message {agent.name}</span>
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-7">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {agent.authProblem && <p className="rounded-lg bg-[var(--bad-bg)] px-4 py-3 text-sm text-[var(--bad-fg)]">The hub can&apos;t sign in to it: {agent.authProblem}</p>}
          {all.length === 0 ? (
            <Empty>No conversations yet: add {agent.name} to a channel or message it.</Empty>
          ) : (
            <AgentConversationList ws={ws} id={id} agent={agent} conversations={all} />
          )}
        </div>
      </div>
    </main>
  );
}
