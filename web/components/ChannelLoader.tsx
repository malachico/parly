'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { People } from '@/components/Avatar';
import { ChannelPanel } from '@/components/ChannelPanel';
import { ChannelShell } from '@/components/ChannelShell';
import { Composer } from '@/components/Composer';
import { type DmBundle, DmConversation } from '@/components/DmConversation';
import { LiveTimeline } from '@/components/LiveTimeline';
import { MarkRead } from '@/components/MarkRead';
import { PanelSkeleton } from '@/components/PanelSkeleton';
import { RoomBrief } from '@/components/RoomBrief';
import { RoomDocument, type RoomDocData } from '@/components/RoomDocument';
import { RoomStatus } from '@/components/RoomStatus';
import { RoomSummaryOpener, RoomTabs } from '@/components/RoomTabs';
import { LoadOlder } from '@/components/ScrollToBottom';
import { channelDescription, channelReadOnly, mentionableOf, POSTS, REPLIES, waitingNotes } from '@/lib/channelView';
import type { Agent, Channel, ConversationPage, MessageView, Schedule, ScopedSkillView, SkillSummaryView, Webhook, Workspace, WorkspaceSlackStatus, WorkspaceTelegramStatus } from '@/lib/hub';
import { hubGet } from '@/lib/hubDirect';
import { conversationUnread } from '@/lib/receipts';
import { roomPlaceholder } from '@/lib/roomStatus';
import { agentKey, channelKey, chatHref, wsHref } from '@/lib/routes';

/** The hub's GET /channels/:id/open: everything one channel page shows. */
type OpenBundle = {
  me: Agent;
  workspace: Workspace;
  channel: Channel;
  page: ConversationPage;
  members: Agent[];
  people: People;
  thread?: { post: MessageView; page: ConversationPage };
  room?: RoomDocData;
  brief?: string;
  panel?: {
    inWorkspace: Agent[];
    schedules: Schedule[];
    webhooks: Webhook[];
    skills: ScopedSkillView[];
    librarySkills: SkillSummaryView[];
    slack?: WorkspaceSlackStatus;
    telegram?: WorkspaceTelegramStatus;
  };
};
// Keyed by the conversation (channel:<id> or agent:<id>), so one never shows while another loads.
type State = { key: string; bundle: OpenBundle | DmBundle } | { key: string; failed: 'gone' | 'error' } | undefined;

// The hub's PAGE_MAX: at it, there's no loading more (older ones stay out of view).
const PAGE_MAX = 1000;
const countParam = (v: string | null, d: number) => Math.min(Math.max(Number(v) || d, d), PAGE_MAX);

/** Straight from the hub with a read ticket; through /api when that can't be done. Not a member: 'gone'. */
async function load(path: string, signal: AbortSignal): Promise<OpenBundle | DmBundle | 'gone' | 'error'> {
  const direct = await hubGet<OpenBundle | DmBundle>(path, signal).catch(() => null);
  if (direct) return direct;
  const res = await fetch(`/api${path}`, { signal, cache: 'no-store' }).catch(() => undefined);
  if (res?.ok) return (await res.json()) as OpenBundle | DmBundle;
  return res && [400, 403, 404].includes(res.status) ? 'gone' : 'error';
}

/**
 * A conversation page's contents, fetched from the browser: the page around it makes no hub call. `kind` picks a
 * channel (GET /channels/:id/open) or a DM with an agent (GET /agents/:id/open). `renderedAt` changes each time the
 * server page re-renders (a live refresh, an action's revalidate), and that re-reads it.
 */
export function ChannelLoader({ ws, kind, id: channelId, renderedAt, webhookUrl }: { ws: string; kind: 'channel' | 'agent'; id: string; renderedAt: number; webhookUrl?: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const dm = kind === 'agent';
  const key = dm ? agentKey(channelId) : channelKey(channelId);
  const get = (k: string) => sp.get(k) ?? undefined;
  const thread = get('thread');
  const panel = get('panel');
  const at = get('at');
  const error = get('error');
  const postsParam = get('posts');
  const repliesParam = get('replies');
  const from = get('from');
  const filter = get('filter');
  const section = get('section');
  const postCount = countParam(sp.get('posts'), POSTS);
  const replyCount = countParam(sp.get('replies'), REPLIES);
  const showDone = !dm && filter === 'done';
  const wantPanel = !dm && panel === 'channel';
  const [state, setState] = useState<State>();
  const [retry, setRetry] = useState(0);

  // Re-read on what the server page used to render from; a thread opened in place is fetched by ChannelShell
  // itself, so the current one rides along (read from the address, not a dependency) without causing a fetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderedAt and retry are the re-run triggers, not read here — a server re-render or "Try again" re-reads the channel
  useEffect(() => {
    const ctrl = new AbortController();
    const id = encodeURIComponent(channelId);
    let path: string;
    if (dm) path = `/agents/${id}/open?${new URLSearchParams({ limit: String(postCount), workspace: ws })}`;
    else {
      const now = new URLSearchParams(window.location.search);
      const q = new URLSearchParams({ limit: String(postCount), threads: showDone ? 'done' : 'open' });
      if (now.get('thread')) q.set('thread', now.get('thread')!), q.set('replies', String(countParam(now.get('replies'), REPLIES)));
      if (wantPanel) q.set('panel', 'channel');
      path = `/channels/${id}/open?${q}`;
    }
    void load(path, ctrl.signal).then((r) => {
      if (ctrl.signal.aborted) return;
      setState(typeof r === 'string' ? { key, failed: r } : { key, bundle: r });
    });
    return () => ctrl.abort();
  }, [dm, ws, key, channelId, postCount, showDone, wantPanel, renderedAt, retry]);

  const loaded = state?.key === key && 'bundle' in state ? state.bundle : undefined;
  const bundle = loaded && 'channel' in loaded ? loaded : undefined;
  // A channel from another workspace opens there (a DM is read in the workspace it was asked for).
  const elsewhere = bundle && bundle.channel.workspaceId !== ws ? bundle.channel.workspaceId : undefined;
  useEffect(() => {
    if (elsewhere) router.replace(chatHref(elsewhere, key, { thread, panel, at }));
  }, [elsewhere, router, key, thread, panel, at]);

  if (state?.key === key && 'failed' in state) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--bg)] p-8 text-center text-sm text-[var(--muted)]" data-main>
        {state.failed === 'gone' ? (
          <>
            <p>{dm ? "This conversation isn't available." : "This channel isn't available. It may have been removed, or you are no longer in it."}</p>
            <Link href={wsHref(ws)} className="btn-ghost">Back to the workspace</Link>
          </>
        ) : (
          <>
            <p>{dm ? "The conversation couldn't be loaded." : "The channel couldn't be loaded."}</p>
            <button type="button" className="btn-ghost" onClick={() => setRetry((n) => n + 1)}>Try again</button>
          </>
        )}
      </div>
    );
  }
  if (dm) return loaded && !('channel' in loaded) ? <DmConversation ws={ws} conversationKey={key} bundle={loaded} postCount={postCount} pageMax={PAGE_MAX} postsParam={postsParam} at={at} error={error} /> : <PanelSkeleton />;
  if (!bundle || elsewhere) return <PanelSkeleton />;

  const { me, workspace, channel, page, members } = bundle;
  const messages = page.messages;
  const href = chatHref(ws, key);
  const closeHref = chatHref(ws, key, { posts: postsParam, filter: showDone ? 'done' : undefined });
  // A showcase guest: the showcase's agents talk to them only at its tables.
  const guest = Boolean((workspace.public || workspace.publicShowcase) && !workspace.owner);
  const readOnly = channelReadOnly(channel, workspace);
  // Avatars for whoever spoke: me, the channel's members, and those who have since left.
  const people: People = { [me.id]: me };
  for (const m of members) people[m.id] = { ...m, role: channel.roles?.[m.id] };
  for (const [id, p] of Object.entries(bundle.people ?? {})) people[id] ??= p;
  const waiting = waitingNotes(page, members, me.id);
  // Like Slack: a post goes to the whole channel; replying in a post's thread answers it.
  const mentionable = mentionableOf(members, me.id);
  const composer = { draftKey: key, workspaceId: ws, channelId, placeholder: roomPlaceholder(workspace.room, channelId) ?? `Message #${channel.name} · agents answer when @mentioned`, members: mentionable, starters: channel.starters };

  // The room's own channel opens on where it stands; its summary is one click away.
  let roomTabs: React.ReactNode = null;
  let roomStatus: React.ReactNode = null;
  let aside: React.ReactNode = null;
  const roomData = bundle.room;
  const mySide = workspace.room?.mySide;
  if (workspace.room && roomData) {
    const inShared = workspace.room.shared === channelId;
    const docHref = chatHref(ws, key, { panel: 'doc' });
    if (mySide && (inShared || mySide.corner === channelId)) roomTabs = <RoomTabs sharedHref={chatHref(ws, channelKey(workspace.room.shared))} cornerHref={chatHref(ws, channelKey(mySide.corner))} inCorner={!inShared} />;
    roomStatus = (
      <>
        {inShared && <RoomStatus ws={ws} room={workspace.room} data={roomData} docHref={docHref} cornerHref={mySide && chatHref(ws, channelKey(mySide.corner))} composerId={`composer-${key}`} noAgents={!members.some((m) => m.kind !== 'human' && (m.ownerId || m.cloud))} back={href} />}
        {inShared && roomData.doc && !thread && (!panel || panel === 'doc') && <RoomSummaryOpener ws={ws} href={docHref} open={panel === 'doc'} />}
        {mySide?.corner === channelId && <RoomBrief ws={ws} brief={bundle.brief} back={href} />}
      </>
    );
    if (panel === 'doc') aside = <RoomDocument ws={ws} room={workspace.room} data={roomData} back={docHref} closeHref={closeHref} error={error} />;
  }
  if (panel === 'channel' && bundle.panel) {
    const p = bundle.panel;
    const inChannel = new Set(members.map((m) => m.id));
    // ponytail: everyone in the workspace, in one <select>; a search box when workspaces get long
    const candidates = p.inWorkspace.filter((a) => !inChannel.has(a.id) && !a.archived && !a.webhookChannel);
    aside = <ChannelPanel guest={guest} initialTab={section === 'settings' ? 'settings' : undefined} workspaceId={ws} channel={channel} room={workspace.room} slack={p.slack} telegram={p.telegram} meId={me.id} members={members} candidates={candidates} error={error} closeHref={from === 'canvas' ? wsHref(ws) : closeHref} webhookUrl={webhookUrl} schedules={p.schedules} webhooks={p.webhooks} skills={p.skills} librarySkills={p.librarySkills} />;
  }

  const open = bundle.thread;
  const postId = open?.post.id;
  const initialThread =
    open && postId
      ? {
          threadId: postId,
          data: {
            post: open.post,
            replies: open.page.messages,
            seen: open.page.seen ?? {},
            older: Boolean(open.page.older),
            activity: open.page.activity ?? [],
            unread: conversationUnread(open.page, me.id),
            people,
            done: Boolean(channel.doneThreads?.includes(postId) || page.threads?.[postId]?.done),
            shared: Boolean(channel.publicThreads?.includes(postId)),
          },
        }
      : undefined;

  const doneIds = new Set(channel.doneThreads ?? []);
  const visibleMessages = messages.filter((m) => (showDone ? doneIds.has(m.id) : !doneIds.has(m.id)));
  const mainTimeline = (
    <>
      <MarkRead conversationKey={key} unread={conversationUnread(page, me.id)} />
      {page.older && postCount >= PAGE_MAX && <p className="py-2 text-center text-xs text-[var(--muted)]">Older messages aren&apos;t shown here. Search (⌘K) finds them.</p>}
      {page.older && postCount < PAGE_MAX && <LoadOlder href={chatHref(ws, key, { filter: showDone ? 'done' : undefined, thread, replies: repliesParam, posts: String(postCount + POSTS) })} target="thread-scroll" />}
      <LiveTimeline
        conversation={page.conversation}
        readKey={key}
        scroll={{ key: `${key}:${at ?? ''}`, focusId: at ? `msg-${at}` : undefined }}
        empty={
          <p className="py-10 [:has(>#outbox>*)>&]:hidden text-center text-sm text-[var(--muted)]">
            {showDone ? 'No done threads in this channel.' : messages.length > 0 ? 'All threads here are marked as done.' : readOnly ? 'No messages yet.' : 'No messages yet. Say hello below.'}
          </p>
        }
        quoteKey={readOnly ? undefined : key}
        messages={visibleMessages}
        meId={me.id}
        hrefBase={closeHref}
        ws={ws}
        people={people}
        seen={page.seen}
        threads={page.threads}
        activity={page.activity}
        channel
        filter={showDone ? 'done' : undefined}
        doneThreads={channel.doneThreads}
        channelOwner={channel.owner}
        done={{ ws, channelId, filter: showDone ? 'done' : undefined }}
      />
      <div id="outbox" />
    </>
  );
  const mainComposer = readOnly ? (
    <p className="rounded-lg bg-[var(--subtle)] px-4 py-3 text-center text-sm text-[var(--muted)]">{readOnly}</p>
  ) : (
    <Composer
      key={composer.draftKey}
      {...composer}
      me={{ id: me.id, avatar: me.avatar, kind: me.kind, role: people[me.id]?.role }}
      outbox="outbox"
      autoFocus={messages.length === 0}
      renderedMessages={messages.map((m) => ({ id: m.id, seq: m.seq, fromId: m.fromId, text: m.text, replyTo: m.replyTo }))}
      liveConversation={page.conversation}
    />
  );
  const initialSearch = new URLSearchParams({
    ...(thread ? { thread } : {}),
    ...(panel ? { panel } : {}),
    ...(section ? { section } : {}),
    ...(repliesParam ? { replies: repliesParam } : {}),
    ...(filter ? { filter } : {}),
    ...(postsParam ? { posts: postsParam } : {}),
  }).toString();

  return (
    <ChannelShell
      ws={ws}
      conversationKey={key}
      channel={channel}
      channelName={channel.name}
      description={channelDescription(channel, members)}
      peopleCount={members.filter((m) => m.kind === 'human').length}
      botCount={members.filter((m) => m.kind !== 'human').length}
      hasDocument={Boolean(workspace.room)}
      me={{ id: me.id, avatar: me.avatar, kind: me.kind }}
      basePeople={people}
      mentionable={mentionable}
      readOnly={readOnly}
      showDone={showDone}
      postsParam={postsParam}
      from={from}
      error={error}
      replyCount={replyCount}
      initialSearch={initialSearch}
      initialThread={initialThread}
      serverPanel={aside && (panel === 'channel' || panel === 'doc') ? panel : undefined}
      panelAside={aside}
      roomTabs={roomTabs}
      roomStatus={roomStatus}
      waiting={waiting}
      pageActivity={page.activity ?? []}
      doneThreads={channel.doneThreads ?? []}
      latestMainMessageId={messages.at(-1)?.id}
      closeHref={closeHref}
      mainTimeline={mainTimeline}
      mainComposer={mainComposer}
    />
  );
}
