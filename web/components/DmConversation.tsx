'use client';

import Link from 'next/link';
import { Avatar, type People } from '@/components/Avatar';
import { Catchup } from '@/components/Catchup';
import { Composer } from '@/components/Composer';
import { Icon } from '@/components/Icon';
import { LiveTimeline } from '@/components/LiveTimeline';
import { MarkRead } from '@/components/MarkRead';
import { JumpToLatest, LoadOlder } from '@/components/ScrollToBottom';
import { ErrorNote } from '@/components/ui';
import { WarmComputer } from '@/components/WarmComputer';
import { POSTS } from '@/lib/channelView';
import type { Agent, Conversation, ConversationPage, Workspace } from '@/lib/hub';
import { shortTime } from '@/lib/labels';
import { conversationUnread } from '@/lib/receipts';
import { agentHref, botActivityHref, chatHref, wsHref } from '@/lib/routes';

/** The hub's GET /agents/:id/open: the other side (or, when they're gone, their row in my conversations), me, the messages. */
export type DmBundle = { me: Agent; workspace: Workspace; page: ConversationPage; agent?: Agent; gone?: NonNullable<Conversation['with']> };

/** One direct conversation: header, its messages, the composer. Who you're talking to lives on their Profile. */
export function DmConversation({ ws, conversationKey: key, bundle, postCount, pageMax, postsParam, at, error }: { ws: string; conversationKey: string; bundle: DmBundle; postCount: number; pageMax: number; postsParam?: string; at?: string; error?: string }) {
  const { me, workspace, page, gone } = bundle;
  // A showcase guest: the showcase's agents talk to them only at its tables (the hub refuses their DMs).
  const guest = Boolean((workspace.public || workspace.publicShowcase) && !workspace.owner);
  const messages = page.messages;

  let header: React.ReactNode;
  let composer: React.ComponentProps<typeof Composer> | undefined;
  let readOnly: string | undefined;
  // Avatars for whoever spoke: me and the other side.
  const people: People = { [me.id]: me };
  // An archived or deleted agent is hidden from me, but our conversation isn't: show it, read-only.
  if (gone) {
    const other = { id: gone.id, name: gone.name, kind: gone.kind, avatar: gone.avatar };
    people[other.id] = other;
    readOnly =
      gone.status === 'archived'
        ? `${gone.name} is archived. An owner of one of its workspaces can restore it from the workspace details.`
        : gone.status === 'deleted'
          ? `${gone.name} was removed. Its messages are kept here.`
          : `You can no longer message ${gone.name}. Your messages are kept here.`;
    header = (
      <Link href={agentHref(ws, gone.id)} className="flex min-w-0 flex-1 items-center gap-3" title="Profile">
        <Avatar who={other} className="size-9 shrink-0 opacity-50 grayscale sm:size-10" />
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-base font-semibold sm:text-lg">{gone.name}</h1>
          <span className="truncate text-[13px] text-[var(--muted)]">
            {gone.status === 'archived' ? 'Archived agent' : gone.status === 'deleted' ? 'Removed agent' : 'Unavailable'}
          </span>
        </div>
      </Link>
    );
  }
  const other = bundle.agent;
  if (other) {
    const person = other.kind === 'human';
    people[other.id] = other;
    header = (
      <>
        <Link href={agentHref(ws, other.id)} className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none" title="Profile">
          <Avatar who={other} className="size-9 shrink-0 sm:size-10" />
          <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-base font-semibold sm:text-lg">{other.name}</h1>
          <span className="truncate text-[13px] text-[var(--muted)]">
            {person ? 'Person' : other.cloud ? 'Cloud agent' : other.hosted ? 'Hosted agent' : 'Agent'} ·{' '}
            {other.cloud ? (
              <span className="font-medium text-[var(--ok-fg)]">● answers when messaged</span>
            ) : other.listening ? (
              <span className="font-medium text-[var(--ok-fg)]">● listening now</span>
            ) : other.wakes ? (
              <span className="font-medium text-[var(--ok-fg)]" title={other.hosted ? 'Wakes its Parly computer when you message it' : 'Not listening, but a message wakes it'}>● wakes on message</span>
            ) : (
              <>active {shortTime(other.lastSeen) === 'now' ? 'now' : `${shortTime(other.lastSeen)} ago`}</>
            )}{' '}
            {!person && other.owner && other.owner.id !== me.id && (
              <span className="hidden sm:inline"> · {other.owner.name}, its owner, can see its conversations</span>
            )}
          </span>
          </div>
        </Link>
        {!person && other.ownerId === me.id && other.hosted && <WarmComputer agentId={other.id} />}
        {!person && other.ownerId === me.id && (
          <Link href={botActivityHref(ws, other.id)} className="btn-ghost ml-auto hidden min-h-9 sm:inline-flex">
            All its conversations
          </Link>
        )}
        {/* On a phone: an icon (the name above can be long); from sm up, the word. */}
        <Link
          href={agentHref(ws, other.id)}
          aria-label={`${other.name}'s profile`}
          title="Profile"
          className={`btn-ghost min-h-9 shrink-0 px-2 sm:px-3 ${!person && other.ownerId === me.id ? 'sm:ml-0' : 'sm:ml-auto'}`}
        >
          <span className="sm:hidden">
            <Icon name="person" size={18} />
          </span>
          <span className="hidden sm:inline">Profile</span>
        </Link>
      </>
    );
    if (!person && other.ownerId !== me.id && (!other.public || (workspace.room?.mySide && workspace.room.sides.some((s) => s.id === other.ownerId)))) readOnly = guest ? `${other.name} talks to visitors in the public channels here, not in direct messages. Post at one of the tables.` : `Only ${other.name}'s owner can message it in private. Talk to it in a channel you share.`;
    else composer = { draftKey: key, workspaceId: ws, to: other.id, placeholder: `Message ${other.name}` };
  }

  const closeHref = chatHref(ws, key, { posts: postsParam });
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]" data-main>
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:px-7 sm:py-4">
        <Link href={wsHref(ws)} aria-label="Back to conversations" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
          <Icon name="back" size={22} />
        </Link>
        {header}
        <Catchup key={`${ws}:${key}`} ws={ws} conversationKey={key} initialSinceSeq={page.seen?.[me.id] ?? 0} />
      </header>
      <div id="thread-scroll" className="placing min-h-0 flex-1 overflow-y-auto px-3.5 py-6 sm:px-7">
        <div className="mx-auto max-w-4xl">
          <MarkRead conversationKey={key} unread={conversationUnread(page, me.id)} />
          {page.older && postCount >= pageMax && <p className="py-2 text-center text-xs text-[var(--muted)]">Older messages aren&apos;t shown here. Search (⌘K) finds them.</p>}
          {page.older && postCount < pageMax && <LoadOlder href={chatHref(ws, key, { posts: String(postCount + POSTS) })} target="thread-scroll" />}
          <LiveTimeline
            conversation={page.conversation}
            readKey={key}
            scroll={{ key: `${key}:${at ?? ''}`, focusId: at ? `msg-${at}` : undefined }}
            empty={<p className="py-10 [:has(>#outbox>*)>&]:hidden text-center text-sm text-[var(--muted)]">{readOnly ? 'No messages yet.' : 'No messages yet. Say hello below.'}</p>}
            quoteKey={readOnly ? undefined : key}
            messages={messages}
            meId={me.id}
            hrefBase={closeHref}
            ws={ws}
            people={people}
            seen={page.seen}
            threads={page.threads}
            activity={page.activity}
            channel={false}
          />
          <div id="outbox" />
        </div>
        <JumpToLatest target="thread-scroll" />
      </div>
      <div className="px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-7 sm:pb-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          <ErrorNote error={error} />
          {readOnly || !composer ? (
            <p className="rounded-lg bg-[var(--subtle)] px-4 py-3 text-center text-sm text-[var(--muted)]">{readOnly}</p>
          ) : (
            <Composer
              key={composer.draftKey}
              {...composer}
              me={{ id: me.id, avatar: me.avatar, kind: me.kind }}
              outbox="outbox"
              autoFocus={messages.length === 0}
              renderedMessages={messages.map((m) => ({ id: m.id, seq: m.seq, fromId: m.fromId, text: m.text, replyTo: m.replyTo }))}
              liveConversation={page.conversation}
            />
          )}
        </div>
      </div>
    </div>
  );
}
