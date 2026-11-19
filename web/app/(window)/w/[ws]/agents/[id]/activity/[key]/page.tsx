import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Avatar, type People } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Timeline, ThreadView } from '@/components/Thread';
import { ScrollToBottom } from '@/components/ScrollToBottom';
import { hub, HubError, me, type Agent, type ConversationPage } from '@/lib/hub';
import { botActivityHref, dmHref } from '@/lib/routes';

type Props = { params: Promise<{ ws: string; id: string; key: string }>; searchParams: Promise<{ thread?: string }> };

/** One of a bot's conversations, for its owner: the same timeline as the chat, read-only (no composer, no actions). */
export default async function BotConversationPage({ params, searchParams }: Props) {
  const { ws, id, key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const { thread } = await searchParams;
  const [user, agent] = await Promise.all([
    me(),
    hub<Agent>(`/agents/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof HubError && err.status === 404) notFound();
      throw err;
    }),
  ]);
  if (!user || agent.ownerId !== user.id) notFound();
  // A thread:<channelId>:<postId> key opens the channel transcript with that thread open.
  if (key.startsWith('thread:')) {
    const [, chId, postId] = key.split(':');
    if (chId && postId) redirect(`${botActivityHref(ws, id, `channel:${chId}`)}?thread=${encodeURIComponent(postId)}`);
  }
  const dmOtherId = key.startsWith('dm:')
    ? key.slice(3).split('_').find((p) => p !== id)
    : key.startsWith('agent:')
      ? key.slice('agent:'.length)
      : undefined;
  // The bot's conversation with me is my own chat with it: open that, where I can write.
  if (dmOtherId === user.id) redirect(dmHref(ws, agent.id));
  const pageOf = (k: string) =>
    hub<ConversationPage>(`/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(k)}?limit=200`).catch((err) => {
      if (err instanceof HubError && [400, 404].includes(err.status)) notFound();
      throw err;
    });
  const isChannel = key.startsWith('channel:');
  const pageKey = dmOtherId ? `agent:${dmOtherId}` : key;
  const page = await pageOf(pageKey);
  const replies = isChannel && thread ? await pageOf(`thread:${key.slice('channel:'.length)}:${thread}`) : undefined;
  const post = replies ? page.messages.find((m) => m.id === thread) : undefined;

  // Names and avatars for everyone who spoke; the bot is marked as mine.
  const people: People = { [agent.id]: { ...agent, name: `${agent.name} (your agent)` } };
  for (const m of [...page.messages, ...(replies?.messages ?? [])]) people[m.fromId] ??= { id: m.fromId, name: m.from };
  const channelId = isChannel ? key.slice('channel:'.length) : undefined;
  const channelName = channelId ? user.workspaces.flatMap((w) => w.channels ?? []).find((c) => c.id === channelId)?.name : undefined;
  const other = isChannel
    ? (channelName ? `#${channelName}` : 'the channel')
    : (page.messages.find((m) => m.fromId !== agent.id)?.from ?? 'someone');
  const base = botActivityHref(ws, id, pageKey);
  const open = post && replies ? { post, replies } : undefined;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:gap-3 sm:px-7 sm:py-3">
        <Link href={open ? base : botActivityHref(ws, id)} aria-label="Back" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)]">
          <Icon name="back" size={20} />
        </Link>
        <Avatar who={agent} className="size-8 shrink-0 sm:size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 dir="auto" className="truncate text-base font-semibold sm:text-lg">
            {agent.name} {isChannel ? 'in' : 'with'} {other}
          </h1>
          <span className="truncate text-[13px] text-[var(--muted)]">{open ? 'Thread' : 'Read-only'}</span>
        </div>
        <Link href={dmHref(ws, agent.id)} className="btn ml-auto min-h-9 shrink-0 px-3" title={`Message ${agent.name}`}>
          <span className="sm:hidden">Message</span>
          <span className="hidden sm:inline">Message {agent.name}</span>
        </Link>
      </header>
      <p className="hidden border-b border-[var(--border)] bg-[var(--subtle)] px-4 py-2 text-center text-[13px] text-[var(--muted)] sm:block">
        You&apos;re viewing {agent.name}&apos;s conversation{isChannel ? ` in ${other}` : ` with ${other}`} · read-only
      </p>
      <ScrollToBottom key={open ? `${pageKey}:${open.post.id}` : pageKey} count={open ? open.replies.messages.length : page.messages.length} target="activity-thread-scroll" />
      <div id="activity-thread-scroll" className="placing min-h-0 flex-1 overflow-y-auto px-3.5 py-6 sm:px-7">
        <div className="mx-auto max-w-4xl">
          {page.messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-[var(--muted)]">No messages.</p>
          ) : open ? (
            <ThreadView post={open.post} replies={open.replies.messages} meId={user.id} ws={ws} people={people} seen={open.replies.seen} />
          ) : (
            // meId is the owner, who is neither side: read-only.
            <Timeline messages={page.messages} meId={user.id} hrefBase={base} ws={ws} people={people} seen={page.seen} threads={page.threads} channel={isChannel} />
          )}
        </div>
      </div>
    </main>
  );
}
