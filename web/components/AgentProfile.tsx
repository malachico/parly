import Link from 'next/link';
import { Avatar } from '@/components/Avatar';
import { InlineMarkdown } from '@/components/InlineMarkdown';
import { Empty, KindBadge } from '@/components/ui';
import { hub, type Agent, type Conversation } from '@/lib/hub';
import { shortTime } from '@/lib/labels';
import { agentHref, botActivityHref, dmHref } from '@/lib/routes';
import { plural } from '@/lib/plural';

/** How many of its conversations the profile lists; the rest are on its conversations page. */
const RECENT = 8;

/** An agent's conversations as a read-only list; each row opens it in the agent's activity view (`id` is the id the links use). */
export function AgentConversationList({ ws, id, agent, conversations }: { ws: string; id: string; agent: Agent; conversations: Conversation[] }) {
  const title = (c: Conversation) => (c.kind === 'channel' ? `#${c.channel?.name ?? 'channel'}` : `with ${c.with?.name ?? 'someone'}`);
  return (
    <ul className="list">
      {conversations.map((c) => {
        return (
          <li key={c.key}>
            <Link href={botActivityHref(ws, id, c.key)} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--subtle)]">
              {c.kind === 'channel' || !c.with ? (
                <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center text-lg text-[var(--muted)]">
                  #
                </span>
              ) : (
                <Avatar who={c.with} className="size-9" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{title(c)}</span>
                  <time className="ml-auto shrink-0 text-xs text-[var(--muted)]">{shortTime(c.updatedAt)}</time>
                </span>
                <span dir="auto" className="truncate text-[13px] text-[var(--muted)]">
                  {c.last.fromId === agent.id ? `${agent.name}: ` : c.kind === 'channel' ? `${c.last.from}: ` : ''}
                  {c.last.text ? <InlineMarkdown text={c.last.text} /> : '(no text)'}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One of my agents at a glance, for a dialog: who it is, how it's doing, Message, and its latest
 * conversations (read-only, newest first). `children` adds actions (Revoke on Connect).
 */
export async function AgentProfile({ agent, ws, children }: { agent: Agent; ws: string; children?: React.ReactNode }) {
  const all = await hub<Conversation[]>(`/agents/${encodeURIComponent(agent.id)}/conversations`).catch(() => [] as Conversation[]);
  const recent = all.slice(0, RECENT);
  const seen = shortTime(agent.lastSeen);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Avatar who={agent} className="size-14 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-lg font-semibold">{agent.name}</span>
            <KindBadge kind={agent.kind} />
          </span>
          <span className="text-[13px] text-[var(--muted)]">
            {agent.listening ? <span className="font-medium text-[var(--ok-fg)]">● listening now</span> : agent.wakes ? <span className="font-medium text-[var(--ok-fg)]" title="Not listening, but a message starts its Claude Code Routine">● wakes on message</span> : seen ? `active ${seen === 'now' ? 'now' : `${seen} ago`}` : 'never seen'}
            {agent.workspaces.length ? ` · ${plural(agent.workspaces.length, 'workspace', 'workspaces')}` : ''}
          </span>
        </div>
      </div>
      {agent.authProblem && <p className="rounded-lg bg-[var(--bad-bg)] px-4 py-3 text-sm text-[var(--bad-fg)]">The hub can&apos;t sign in to it: {agent.authProblem}</p>}
      <p className="max-w-prose">{agent.description || <span className="muted">No description</span>}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={dmHref(ws, agent.id)} className="btn-primary">
          Message
        </Link>
        <Link href={agentHref(ws, agent.id)} className="btn">
          Full profile
        </Link>
        {children}
      </div>
      <section className="flex flex-col gap-3">
        <h3 className="label flex items-center gap-2">
          Conversations{all.length ? ` (${all.length})` : ''}
          {all.length > RECENT && (
            <Link href={botActivityHref(ws, agent.id)} className="ml-auto text-xs font-normal normal-case text-[var(--accent)] hover:underline">
              See all
            </Link>
          )}
        </h3>
        {recent.length === 0 ? (
          <Empty>No conversations yet: add {agent.name} to a channel or message it.</Empty>
        ) : (
          <AgentConversationList ws={ws} id={agent.id} agent={agent} conversations={recent} />
        )}
      </section>
    </div>
  );
}
