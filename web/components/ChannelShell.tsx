'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { People } from '@/components/Avatar';
import { ChannelHeader } from '@/components/ChannelHeader';
import { Composer } from '@/components/Composer';
import { EscClose } from '@/components/EscClose';
import { Icon } from '@/components/Icon';
import { LIVE_REFRESH_EVENT } from '@/components/LiveRefresh';
import { MarkRead, THREAD_READ_EVENT } from '@/components/MarkRead';
import { PanelSkeleton } from '@/components/PanelSkeleton';
import { JumpToLatest, LoadOlder, ScrollToBottom } from '@/components/ScrollToBottom';
import { ThreadRelatedKnowledge } from '@/components/ChannelKnowledge';
import { ThreadView } from '@/components/Thread';
import { ThreadHeader } from '@/components/ThreadHeader';
import { ErrorNote } from '@/components/ui';
import { markThreadRead, setThreadDone, setThreadPublic } from '@/lib/actions';
import type { ActivityItem, Agent, Channel } from '@/lib/hub';
import { chatHref, timelineParamsChanged, wsHref } from '@/lib/routes';
import {
  createThreadNavController,
  DEFAULT_THREAD_REPLIES,
  MAX_THREAD_REPLIES,
  resolveChannelCloseHref,
  resolveSideDestination,
  type ThreadNavController,
  type ThreadPayload,
} from '@/lib/thread-nav';

type ChannelShellProps = {
  ws: string;
  conversationKey: string;
  channel: Pick<Channel, 'id' | 'public' | 'owner' | 'doneThreads' | 'publicThreads'>;
  channelName: string;
  description: string;
  peopleCount: number;
  botCount: number;
  hasDocument: boolean;
  me: { id: string; avatar?: string; kind: Agent['kind'] };
  basePeople: People;
  mentionable: { id: string; name: string }[];
  readOnly?: string;
  showDone: boolean;
  postsParam?: string;
  from?: string;
  error?: string;
  replyCount: number;
  initialSearch: string;
  initialThread?: { threadId: string; data: ThreadPayload };
  serverPanel?: 'channel' | 'doc';
  panelAside?: React.ReactNode;
  roomStatus?: React.ReactNode;
  roomTabs?: React.ReactNode;
  waiting: string[];
  pageActivity: ActivityItem[];
  doneThreads: string[];
  latestMainMessageId?: string;
  closeHref: string;
  mainTimeline: React.ReactNode;
  mainComposer: React.ReactNode;
};

async function fetchThreadFromApi({
  ws,
  conversationKey,
  threadId,
  replies,
  signal,
}: {
  ws: string;
  conversationKey: string;
  threadId: string;
  replies: number;
  signal: AbortSignal;
}): Promise<ThreadPayload> {
  const qs = new URLSearchParams({
    ws,
    post: threadId,
    replies: String(replies),
  });
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationKey)}/thread?${qs}`, {
    signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    let msg = `Unable to load thread (HTTP ${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody?.error) msg = errBody.error;
    } catch {}
    throw new Error(msg);
  }
  return (await res.json()) as ThreadPayload;
}

export function ChannelShell({
  ws,
  conversationKey,
  channel,
  channelName,
  description,
  peopleCount,
  botCount,
  hasDocument,
  me,
  basePeople,
  mentionable,
  readOnly,
  showDone,
  postsParam,
  from,
  error,
  replyCount,
  initialSearch,
  initialThread,
  serverPanel,
  panelAside,
  roomStatus,
  roomTabs,
  waiting,
  pageActivity,
  doneThreads,
  latestMainMessageId,
  closeHref,
  mainTimeline,
  mainComposer,
}: ChannelShellProps) {
  const path = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, setTick] = useState(0);

  const controllerRef = useRef<{
    key: string;
    instance: ThreadNavController;
  } | null>(null);
  const markReadKeyRef = useRef<string | undefined>(undefined);

  const scopeKey = `${ws}:${conversationKey}`;
  if (!controllerRef.current || controllerRef.current.key !== scopeKey) {
    controllerRef.current?.instance.dispose();
    controllerRef.current = {
      key: scopeKey,
      instance: createThreadNavController({
        ws,
        conversationKey,
        meId: me.id,
        initialSearch,
        initialThread: initialThread
          ? { threadId: initialThread.threadId, data: initialThread.data, replyLimit: replyCount }
          : undefined,
        defaultReplyLimit: replyCount || DEFAULT_THREAD_REPLIES,
        fetchThread: fetchThreadFromApi,
        pushHistory: (url) => {
          if (typeof window !== 'undefined' && window.location.pathname + window.location.search !== url) {
            window.history.pushState(null, '', url);
          }
        },
        replaceHistory: (url) => {
          if (typeof window !== 'undefined' && window.location.pathname + window.location.search !== url) {
            window.history.replaceState(null, '', url);
          }
        },
        onChange: () => setTick((t) => t + 1),
      }),
    };
  }
  const controller = controllerRef.current.instance;

  useEffect(() => {
    return () => {
      controllerRef.current?.instance.dispose();
      controllerRef.current = null;
    };
  }, []);

  const isPanelReady = useCallback(
    // Ignores `section`: every tab is in the server-rendered panel and PanelTabs reads `section` from the URL itself,
    // so a tab switch must not refetch the page.
    (panel: 'channel' | 'doc') => serverPanel === panel && Boolean(panelAside),
    [serverPanel, panelAside],
  );

  // When SSR or router.refresh() provides a fresh snapshot for the active thread (or an uncached thread),
  // update that thread's cache entry without re-seeding the initial mount object or overwriting optimistic state.
  const lastSeededRef = useRef(initialThread);
  useEffect(() => {
    if (!initialThread || initialThread === lastSeededRef.current) return;
    lastSeededRef.current = initialThread;
    const curDest = controller.getDestination();
    if (
      (curDest.kind === 'thread' && curDest.threadId === initialThread.threadId) ||
      !controller.getCachedThread(initialThread.threadId)
    ) {
      controller.seedThread(initialThread.threadId, initialThread.data, replyCount);
    }
  }, [controller, initialThread, replyCount]);

  // Listen to browser Back/Forward (`popstate`) and `LiveRefresh` (the live stream from the hub).
  useEffect(() => {
    const onPopState = () => {
      const next = controller.onPopState(window.location.search);
      if (next.kind === 'panel' && !isPanelReady(next.panel)) {
        router.replace(window.location.pathname + window.location.search, { scroll: false });
      }
    };
    const onLiveRefresh = () => {
      void controller.refreshActiveThread();
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener(LIVE_REFRESH_EVENT, onLiveRefresh);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener(LIVE_REFRESH_EVENT, onLiveRefresh);
    };
  }, [controller, router, isPanelReady]);

  // Sync external Next.js router navigations (e.g. ⌘K search hits) that change `useSearchParams()` on the same channel.
  const prevSearchRef = useRef(searchParams.toString());
  useEffect(() => {
    const cur = searchParams.toString();
    if (cur === prevSearchRef.current) return;
    prevSearchRef.current = cur;
    if (typeof window !== 'undefined') {
      const next = controller.syncExternalSearch(window.location.search);
      if (next.kind === 'panel' && !isPanelReady(next.panel)) {
        router.replace(window.location.pathname + window.location.search, { scroll: false });
      }
    }
  }, [controller, router, searchParams, isPanelReady]);

  const dest = controller.getDestination();
  const viewState = controller.getViewState();
  const hasAside = viewState.kind !== 'none';
  const openThreadId = dest.kind === 'thread' ? dest.threadId : undefined;
  const activePanel = dest.kind === 'panel' ? dest.panel : undefined;
  const liveSearch = typeof window !== 'undefined' ? window.location.search : searchParams.toString();
  const liveCloseHref = resolveChannelCloseHref(
    path,
    liveSearch,
    showDone ? 'done' : undefined,
    postsParam,
  );
  const doneSet = new Set(doneThreads);
  const mainActivity = pageActivity.filter(
    (a) => a.agentId !== me.id && (!a.thread || (a.thread !== openThreadId && !doneSet.has(a.thread))),
  );

  let asideNode: React.ReactNode = null;
  if (viewState.kind === 'panel') {
    if (isPanelReady(viewState.panel)) {
      asideNode = panelAside;
    } else {
      asideNode = (
        <aside
          key={`panel-loading:${viewState.panel}`}
          aria-label={viewState.panel === 'doc' ? 'Summary for agreement' : 'Channel details'}
          aria-busy="true"
          className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg)] lg:w-[420px] lg:shrink-0"
        >
          <PanelSkeleton />
        </aside>
      );
    }
  } else if (viewState.kind === 'thread-loading') {
    asideNode = (
      <aside
        key={`loading:${viewState.threadId}`}
        aria-label="Thread"
        aria-busy="true"
        className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg)] md:w-[45%] md:shrink-0 lg:w-[420px]"
      >
        <PanelSkeleton />
      </aside>
    );
  } else if (viewState.kind === 'thread-error') {
    asideNode = (
      <aside
        key={`error:${viewState.threadId}`}
        aria-label="Thread"
        className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg)] md:w-[45%] md:shrink-0 lg:w-[420px]"
      >
        <ThreadHeader
          channelName={channelName}
          backHref={liveCloseHref}
          done={false}
          publicHref={`/p/${channel.id}?thread=${encodeURIComponent(viewState.threadId)}`}
          shared={false}
          channelPublic={Boolean(channel.public)}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p role="alert" className="text-sm text-[var(--bad-fg)]">
            {viewState.error}
          </p>
          <button
            type="button"
            className="btn min-h-9 px-3 text-sm"
            onClick={() => void controller.retryThread(viewState.threadId)}
          >
            Retry
          </button>
        </div>
      </aside>
    );
  }
  if (viewState.kind === 'thread') {
    const postId = viewState.threadId;
    const open = viewState.data;
    const lastSeq = open.replies.at(-1)?.seq ?? 0;
    // Latched: the optimistic clear below makes this false at once, and unmounting MarkRead then would drop the refresh
    // that brings the sidebar and ⌘K up to date. It stays mounted until a newer reply (a new key) needs marking.
    if (open.unread > 0 || open.seen[me.id] === undefined) markReadKeyRef.current = `${conversationKey}:${postId}:${lastSeq}`;
    const isThreadDone = Boolean(open.done || doneSet.has(postId));
    const canToggleThreadDone = Boolean(channel.owner || open.post.fromId === me.id);
    const isThreadShared = Boolean(open.shared || channel.publicThreads?.includes(postId));
    const show = viewState.replyLimit;
    const hidden = open.older && show < MAX_THREAD_REPLIES;
    const mergedPeople: People = { ...basePeople, ...open.people };
    const threadActivity = [
      ...(open.activity ?? []),
      ...(postId === latestMainMessageId ? pageActivity.filter((a) => !a.thread) : []),
    ];

    asideNode = (
      <aside key={postId} aria-label="Thread" className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg)] md:w-[45%] md:shrink-0 lg:w-[420px]">
        <ThreadHeader
          channelName={channelName}
          backHref={liveCloseHref}
          related={<ThreadRelatedKnowledge key={postId} ws={ws} channelId={channel.id} thread={postId} />}
          done={isThreadDone}
          doneAction={
            canToggleThreadDone
              ? async () => {
                  const nextDone = !isThreadDone;
                  controller.updateThreadMeta(postId, { done: nextDone });
                  await setThreadDone(ws, channel.id, postId, nextDone, showDone ? 'done' : undefined);
                }
              : undefined
          }
          publicHref={`/p/${channel.id}?thread=${encodeURIComponent(postId)}`}
          shared={isThreadShared}
          channelPublic={Boolean(channel.public)}
          shareAction={
            channel.owner && !channel.public
              ? async (pub: boolean) => {
                  const res = await setThreadPublic(ws, channel.id, postId, pub);
                  if (res.ok) controller.updateThreadMeta(postId, { shared: pub });
                  return res;
                }
              : undefined
          }
        />
        <ScrollToBottom key={postId} count={open.replies.length} latest={open.replies.at(-1)?.seq} target="thread-pane-scroll" />
        {markReadKeyRef.current === `${conversationKey}:${postId}:${lastSeq}` && (
          <MarkRead
            conversationKey={markReadKeyRef.current}
            unread={1}
            action={async () => {
              // Clear right away (the pane, the post's "N new"), then persist; MarkRead refreshes the sidebar and ⌘K after.
              controller.markThreadSeen(postId, lastSeq);
              window.dispatchEvent(new CustomEvent(THREAD_READ_EVENT, { detail: postId }));
              await markThreadRead(channel.id, postId);
            }}
          />
        )}
        <div id="thread-pane-scroll" className="placing min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ThreadView
            quoteKey={readOnly ? undefined : `${conversationKey}:${postId}`}
            post={open.post}
            replies={open.replies}
            meId={me.id}
            ws={ws}
            people={mergedPeople}
            seen={open.seen}
            activity={threadActivity}
            older={
              !hidden && open.older ? (
                <p className="py-2 text-center text-xs text-[var(--muted)]">Older replies aren&apos;t shown here. Search (⌘K) finds them.</p>
              ) : (
                hidden && (
                  <LoadOlder
                    href={chatHref(ws, conversationKey, { thread: postId, posts: postsParam, replies: String(show + DEFAULT_THREAD_REPLIES) })}
                    target="thread-pane-scroll"
                    label="Loading older replies…"
                    onLoadOlder={() => controller.loadOlderReplies(postId, DEFAULT_THREAD_REPLIES)}
                  />
                )
              )
            }
          />
          <div id="outbox-thread" />
          <JumpToLatest target="thread-pane-scroll" />
        </div>
        <div className="px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-4 sm:pb-4">
          <div className="flex flex-col gap-1.5">
            {readOnly ? (
              <p className="rounded-lg bg-[var(--subtle)] px-4 py-3 text-center text-sm text-[var(--muted)]">{readOnly}</p>
            ) : (
              <Composer
                key={`${conversationKey}:${postId}`}
                draftKey={`${conversationKey}:${postId}`}
                workspaceId={ws}
                channelId={channel.id}
                thread={postId}
                placeholder="Reply in thread"
                members={mentionable}
                me={{ id: me.id, avatar: me.avatar, kind: me.kind, role: mergedPeople[me.id]?.role }}
                outbox="outbox-thread"
                renderedMessages={open.replies.map((m) => ({ id: m.id, seq: m.seq, fromId: m.fromId, text: m.text, replyTo: m.replyTo }))}
                onSent={(msg) => controller.recordSentReply(postId, msg)}
              />
            )}
          </div>
        </div>
      </aside>
    );
  }

  const escHref = from === 'canvas' && viewState.kind === 'panel' && viewState.panel === 'channel' ? wsHref(ws) : liveCloseHref;

  return (
    <div
      className="contents"
      onClickCapture={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
        const a = (e.target as HTMLElement).closest('a');
        if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
        let to: URL;
        try {
          to = new URL(a.href, window.location.origin);
        } catch {
          return;
        }
        if (to.origin !== window.location.origin) return;
        if (decodeURIComponent(to.pathname) !== decodeURIComponent(path)) return;

        const next = to.searchParams;
        if (timelineParamsChanged(new URLSearchParams(window.location.search), next)) {
          controller.syncExternalSearch(to.search);
          return;
        }

        const nextDest = resolveSideDestination(next);
        if (nextDest.kind === 'thread' || nextDest.kind === 'none') {
          e.preventDefault();
          controller.navigate(to.pathname + to.search);
          return;
        }
        if (nextDest.kind === 'panel') {
          e.preventDefault();
          if (isPanelReady(nextDest.panel)) {
            controller.navigate(to.pathname + to.search);
          } else {
            controller.syncExternalSearch(to.search);
            router.push(to.pathname + to.search, { scroll: false });
          }
        }
      }}
    >
      <div className={`${hasAside ? (openThreadId ? 'hidden md:flex' : 'hidden lg:flex') : 'flex'} h-full min-w-0 flex-1 flex-col bg-[var(--bg)]`} data-main>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-2 sm:gap-2 sm:px-5">
          {/* ponytail: hasDocument means a Shared Room, where there's no canvas to go back to. */}
          {!hasDocument && (
            <Link href={wsHref(ws)} aria-label="Back to conversations" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
              <Icon name="back" size={22} />
            </Link>
          )}
          <ChannelHeader
            ws={ws}
            conversationKey={conversationKey}
            name={channelName}
            description={description}
            channel={channel}
            peopleCount={peopleCount}
            botCount={botCount}
            thread={openThreadId}
            panel={activePanel}
            document={hasDocument}
            tabs={roomTabs}
          />
        </header>
        <div id="thread-scroll" className="placing min-h-0 flex-1 overflow-y-auto px-3.5 py-6 sm:px-7">
          <div className="mx-auto max-w-4xl">
            {!openThreadId && roomStatus}
            {mainTimeline}
          </div>
          <JumpToLatest target="thread-scroll" />
        </div>
        <div className="px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-7 sm:pb-6">
          <div className="mx-auto flex max-w-4xl flex-col gap-2">
            {waiting.length > 0 && mainActivity.length === 0 && (
              <div className="flex min-h-6 flex-col justify-end">
                <p role="status" className="truncate px-1 text-xs text-[var(--muted)]">{waiting.join(' · ')}</p>
              </div>
            )}
            {activePanel !== 'channel' && <ErrorNote error={error} />}
            {mainComposer}
          </div>
        </div>
      </div>
      {asideNode}
      {hasAside && (
        <EscClose
          href={escHref}
          onClose={() => {
            if (from === 'canvas' && viewState.kind === 'panel' && viewState.panel === 'channel') {
              router.push(wsHref(ws), { scroll: false });
            } else {
              controller.navigate(closeHref);
            }
          }}
        />
      )}
    </div>
  );
}


