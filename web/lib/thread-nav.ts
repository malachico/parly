import type { People } from '../components/Avatar';
import type { ActivityItem, Agent, ConversationPage, Me, MessageView } from './hub';
import { conversationUnread } from './receipts';
import { channelKey } from './routes';

export const DEFAULT_THREAD_REPLIES = 10;
export const MAX_THREAD_REPLIES = 1000;

function clampReplyCount(value: number | string | undefined, fallback = DEFAULT_THREAD_REPLIES): number {
  return Math.min(Math.max(Number(value) || fallback, fallback), MAX_THREAD_REPLIES);
}

export type ThreadPayload = {
  post: MessageView;
  replies: MessageView[];
  seen: Record<string, number>;
  older: boolean;
  activity: ActivityItem[];
  unread: number;
  people: People;
  done: boolean;
  shared: boolean;
};

/**
 * Single side-pane destination derived strictly from the active URL query string:
 * - `{ kind: 'panel', panel: 'channel' | 'doc', section? }` when `?panel=channel` or `?panel=doc` is present.
 * - `{ kind: 'thread', threadId, replies? }` when `?thread=<postId>` is present.
 * - `{ kind: 'none' }` otherwise.
 */
type SideDestination =
  | { kind: 'thread'; threadId: string; replies?: number }
  | { kind: 'panel'; panel: 'channel' | 'doc'; section?: string }
  | { kind: 'none' };

function toSearchParams(search: string | URLSearchParams | Pick<URLSearchParams, 'get'>): Pick<URLSearchParams, 'get'> {
  if (typeof search === 'string') {
    const qIndex = search.indexOf('?');
    return new URLSearchParams(qIndex >= 0 ? search.slice(qIndex + 1) : search);
  }
  return search;
}

export function resolveSideDestination(
  search: string | URLSearchParams | Pick<URLSearchParams, 'get'>,
): SideDestination {
  const params = toSearchParams(search);
  const panel = params.get('panel');
  if (panel === 'channel' || panel === 'doc') {
    const section = params.get('section') || undefined;
    return { kind: 'panel', panel, ...(section ? { section } : {}) };
  }
  const threadId = params.get('thread')?.trim();
  if (threadId) {
    const rawReplies = Number(params.get('replies'));
    const replies = Number.isFinite(rawReplies) && rawReplies > 0 ? clampReplyCount(rawReplies) : undefined;
    return { kind: 'thread', threadId, ...(replies ? { replies } : {}) };
  }
  return { kind: 'none' };
}

/**
 * Computes the channel's side-pane close URL from the live query string, preserving only main-timeline
 * query params (`filter`, `posts`) and stripping `thread`, `panel`, `section`, and `replies`.
 */
export function resolveChannelCloseHref(
  basePath: string,
  search: string | URLSearchParams | Pick<URLSearchParams, 'get'>,
  fallbackFilter?: string,
  fallbackPosts?: string,
): string {
  const params = toSearchParams(search);
  const out = new URLSearchParams();
  const posts = params.get('posts') ?? fallbackPosts;
  const filter = params.get('filter') ?? fallbackFilter;
  if (posts) out.set('posts', posts);
  if (filter) out.set('filter', filter);
  const qs = out.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Builds the composite cache key (`workspace + channel + thread`) so thread caches never collide across channels
 * or workspaces.
 */
export function threadCacheKey(ws: string, conversationKey: string, threadId: string): string {
  const normalizedChannel = conversationKey.startsWith('channel:') ? conversationKey : channelKey(conversationKey);
  return `${ws}:${normalizedChannel}:${threadId}`;
}

/**
 * Appends or updates a newly sent reply inside its own thread's cached payload without mutating previous state.
 * Deduplicates by message `id` or `(seq, fromId)` and keeps replies ordered by `seq`.
 */
function appendReplyToThreadPayload(
  current: ThreadPayload,
  reply: MessageView,
  meId?: string,
): ThreadPayload {
  const existingIdx = current.replies.findIndex(
    (m) => m.id === reply.id || (m.seq === reply.seq && m.fromId === reply.fromId),
  );
  let nextReplies: MessageView[];
  if (existingIdx >= 0) {
    nextReplies = current.replies.map((m, i) => (i === existingIdx ? reply : m));
  } else {
    nextReplies = [...current.replies, reply].sort((a, b) => a.seq - b.seq);
  }
  const nextSeen =
    meId && reply.fromId === meId
      ? { ...current.seen, [meId]: Math.max(current.seen[meId] ?? 0, reply.seq) }
      : current.seen;
  return {
    ...current,
    replies: nextReplies,
    seen: nextSeen,
  };
}

/**
 * Merges an incoming server/refetched `ThreadPayload` with an existing cached payload for the same thread,
 * preserving any already-recorded replies with a higher `seq` than the incoming snapshot so an older SSR/fetch
 * snapshot never drops a just-sent reply.
 */
function mergeThreadPayload(existing: ThreadPayload | undefined, incoming: ThreadPayload): ThreadPayload {
  if (!existing) return incoming;
  const existingMaxSeq = existing.replies.at(-1)?.seq ?? 0;
  const incomingMaxSeq = incoming.replies.at(-1)?.seq ?? 0;
  const incomingMinSeq = incoming.replies[0]?.seq ?? Infinity;
  const olderReplies = incoming.older
    ? existing.replies.filter((r) => r.seq < incomingMinSeq && !incoming.replies.some((ir) => ir.id === r.id))
    : [];
  const newerReplies = existing.replies.filter(
    (r) => r.seq > incomingMaxSeq && !incoming.replies.some((ir) => ir.id === r.id),
  );
  const mergedPeople: People = { ...existing.people, ...incoming.people };
  const mergedSeen: Record<string, number> = { ...existing.seen, ...incoming.seen };
  for (const [uid, seq] of Object.entries(existing.seen)) {
    mergedSeen[uid] = Math.max(seq, incoming.seen[uid] ?? 0);
  }
  const mergedReplies =
    olderReplies.length === 0 && newerReplies.length === 0
      ? incoming.replies
      : [...olderReplies, ...incoming.replies, ...newerReplies].sort((a, b) => a.seq - b.seq);
  const mergedMaxSeq = mergedReplies.at(-1)?.seq ?? 0;
  const mergedUnread = existing.unread === 0 && mergedMaxSeq <= existingMaxSeq ? 0 : incoming.unread;
  const mergedOlder = olderReplies.length > 0 ? existing.older : incoming.older;
  return {
    ...incoming,
    replies: mergedReplies,
    older: mergedOlder,
    people: mergedPeople,
    seen: mergedSeen,
    unread: mergedUnread,
  };
}


type SideViewState =
  | { kind: 'none' }
  | { kind: 'panel'; panel: 'channel' | 'doc'; section?: string }
  | { kind: 'thread'; threadId: string; data: ThreadPayload; refreshing: boolean; replyLimit: number }
  | { kind: 'thread-loading'; threadId: string; replyLimit: number }
  | { kind: 'thread-error'; threadId: string; error: string; replyLimit: number };

type ThreadNavControllerOptions = {
  ws: string;
  conversationKey: string;
  meId?: string;
  initialSearch?: string;
  initialThread?: { threadId: string; data: ThreadPayload; replyLimit?: number };
  defaultReplyLimit?: number;
  fetchThread: (params: {
    ws: string;
    conversationKey: string;
    threadId: string;
    replies: number;
    signal: AbortSignal;
  }) => Promise<ThreadPayload>;
  pushHistory?: (url: string) => void;
  replaceHistory?: (url: string) => void;
  onChange?: () => void;
};

export type ThreadNavController = {
  getDestination: () => SideDestination;
  getViewState: () => SideViewState;
  getCachedThread: (threadId: string) => ThreadPayload | undefined;
  seedThread: (threadId: string, data: ThreadPayload, replyLimit?: number) => void;
  navigate: (url: string, opts?: { replace?: boolean; fromPopState?: boolean }) => SideDestination;
  onPopState: (currentLocationSearch: string) => SideDestination;
  syncExternalSearch: (currentLocationSearch: string) => SideDestination;
  recordSentReply: (threadId: string, message: MessageView) => void;
  refreshActiveThread: () => Promise<void>;
  loadOlderReplies: (threadId: string, step?: number) => Promise<void>;
  retryThread: (threadId?: string) => Promise<void>;
  updateThreadMeta: (threadId: string, patch: Partial<Pick<ThreadPayload, 'done' | 'shared' | 'unread'>>) => void;
  markThreadSeen: (threadId: string, seq?: number) => void;
  dispose: () => void;
};

/**
 * Client-side controller for channel thread/panel navigation and per-thread caching.
 */
export function createThreadNavController(options: ThreadNavControllerOptions): ThreadNavController {
  const {
    ws,
    conversationKey,
    meId,
    initialSearch = '',
    initialThread,
    defaultReplyLimit = DEFAULT_THREAD_REPLIES,
    fetchThread,
    pushHistory,
    replaceHistory,
    onChange,
  } = options;

  const cache = new Map<string, ThreadPayload>();
  const metaOverrides = new Map<string, Partial<Pick<ThreadPayload, 'done' | 'shared'>>>();
  const replyLimits = new Map<string, number>();
  const loadingKeys = new Set<string>();
  const errors = new Map<string, string>();
  const requestSeq = new Map<string, number>();
  const aborts = new Map<string, AbortController>();
  let disposed = false;

  const keyFor = (threadId: string) => threadCacheKey(ws, conversationKey, threadId);

  if (initialThread) {
    const k = keyFor(initialThread.threadId);
    cache.set(k, initialThread.data);
    replyLimits.set(k, clampReplyCount(initialThread.replyLimit, defaultReplyLimit));
  }

  let destination: SideDestination = resolveSideDestination(initialSearch);
  if (destination.kind === 'thread' && destination.replies) {
    replyLimits.set(keyFor(destination.threadId), destination.replies);
  }

  const notify = () => {
    if (!disposed) onChange?.();
  };

  const fetchIntoCache = async (threadId: string, requestedLimit?: number): Promise<void> => {
    if (disposed) return;
    const k = keyFor(threadId);
    const limit = clampReplyCount(requestedLimit ?? replyLimits.get(k) ?? defaultReplyLimit, defaultReplyLimit);
    replyLimits.set(k, limit);

    const seq = (requestSeq.get(k) ?? 0) + 1;
    requestSeq.set(k, seq);

    aborts.get(k)?.abort();
    const abort = new AbortController();
    aborts.set(k, abort);

    loadingKeys.add(k);
    errors.delete(k);
    notify();

    try {
      const data = await fetchThread({
        ws,
        conversationKey,
        threadId,
        replies: limit,
        signal: abort.signal,
      });
      if (disposed || abort.signal.aborted || requestSeq.get(k) !== seq) return;
      cache.set(k, mergeThreadPayload(cache.get(k), data));
      metaOverrides.delete(k);
      errors.delete(k);
    } catch (err) {
      if (disposed || abort.signal.aborted || requestSeq.get(k) !== seq) return;
      if (!cache.has(k)) {
        errors.set(k, err instanceof Error ? err.message : 'Unable to load thread');
      }
    } finally {
      if (!disposed && requestSeq.get(k) === seq) {
        loadingKeys.delete(k);
        aborts.delete(k);
        notify();
      }
    }
  };

  const applySearch = (urlOrSearch: string): SideDestination => {
    const next = resolveSideDestination(urlOrSearch);
    destination = next;
    if (next.kind === 'thread') {
      const k = keyFor(next.threadId);
      const limit = next.replies ?? replyLimits.get(k) ?? defaultReplyLimit;
      void fetchIntoCache(next.threadId, limit);
    } else {
      notify();
    }
    return next;
  };

  if (destination.kind === 'thread' && !cache.has(keyFor(destination.threadId))) {
    void fetchIntoCache(destination.threadId, destination.replies);
  }

  return {
    getDestination: () => destination,

    getViewState: (): SideViewState => {
      if (destination.kind === 'none') return { kind: 'none' };
      if (destination.kind === 'panel') {
        return {
          kind: 'panel',
          panel: destination.panel,
          ...(destination.section ? { section: destination.section } : {}),
        };
      }
      const { threadId } = destination;
      const k = keyFor(threadId);
      const replyLimit = replyLimits.get(k) ?? destination.replies ?? defaultReplyLimit;
      const cached = cache.get(k);
      if (cached) {
        return {
          kind: 'thread',
          threadId,
          data: cached,
          refreshing: loadingKeys.has(k),
          replyLimit,
        };
      }
      const err = errors.get(k);
      if (err && !loadingKeys.has(k)) {
        return { kind: 'thread-error', threadId, error: err, replyLimit };
      }
      return { kind: 'thread-loading', threadId, replyLimit };
    },

    getCachedThread: (threadId: string) => cache.get(keyFor(threadId)),

    seedThread: (threadId: string, data: ThreadPayload, replyLimit?: number) => {
      const k = keyFor(threadId);
      const merged = mergeThreadPayload(cache.get(k), data);
      const overrides = metaOverrides.get(k);
      cache.set(k, overrides ? { ...merged, ...overrides } : merged);
      if (replyLimit) {
        replyLimits.set(k, Math.max(replyLimits.get(k) ?? defaultReplyLimit, clampReplyCount(replyLimit, defaultReplyLimit)));
      }
      errors.delete(k);
      notify();
    },

    navigate: (url: string, opts?: { replace?: boolean; fromPopState?: boolean }) => {
      if (!opts?.fromPopState) {
        if (opts?.replace) replaceHistory?.(url);
        else pushHistory?.(url);
      }
      return applySearch(url);
    },

    onPopState: (currentLocationSearch: string) => applySearch(currentLocationSearch),

    syncExternalSearch: (currentLocationSearch: string) => {
      const next = resolveSideDestination(currentLocationSearch);
      const same =
        next.kind === destination.kind &&
        (next.kind !== 'thread' || (destination.kind === 'thread' && next.threadId === destination.threadId && next.replies === destination.replies)) &&
        (next.kind !== 'panel' || (destination.kind === 'panel' && next.panel === destination.panel && next.section === destination.section));
      if (same) return destination;
      return applySearch(currentLocationSearch);
    },

    recordSentReply: (threadId: string, message: MessageView) => {
      const k = keyFor(threadId);
      const existing = cache.get(k);
      if (!existing) return;
      cache.set(k, appendReplyToThreadPayload(existing, message, meId));
      notify();
    },

    refreshActiveThread: async () => {
      if (destination.kind !== 'thread') return;
      await fetchIntoCache(destination.threadId, replyLimits.get(keyFor(destination.threadId)));
    },

    loadOlderReplies: async (threadId: string, step = DEFAULT_THREAD_REPLIES) => {
      const k = keyFor(threadId);
      const currentLimit = replyLimits.get(k) ?? defaultReplyLimit;
      const nextLimit = clampReplyCount(currentLimit + step, defaultReplyLimit);
      await fetchIntoCache(threadId, nextLimit);
    },

    retryThread: async (threadId?: string) => {
      const target = threadId ?? (destination.kind === 'thread' ? destination.threadId : undefined);
      if (!target) return;
      await fetchIntoCache(target, replyLimits.get(keyFor(target)));
    },

    updateThreadMeta: (threadId: string, patch: Partial<Pick<ThreadPayload, 'done' | 'shared' | 'unread'>>) => {
      const k = keyFor(threadId);
      const existing = cache.get(k);
      if (!existing) return;
      if (patch.done !== undefined || patch.shared !== undefined) {
        const prev = metaOverrides.get(k) ?? {};
        metaOverrides.set(k, {
          ...prev,
          ...(patch.done !== undefined ? { done: patch.done } : {}),
          ...(patch.shared !== undefined ? { shared: patch.shared } : {}),
        });
      }
      cache.set(k, { ...existing, ...patch });
      notify();
    },

    markThreadSeen: (threadId: string, seq?: number) => {
      const k = keyFor(threadId);
      const existing = cache.get(k);
      if (!existing) return;
      const maxSeq = seq ?? existing.replies.at(-1)?.seq ?? 0;
      const nextSeen = meId
        ? { ...existing.seen, [meId]: Math.max(existing.seen[meId] ?? 0, maxSeq) }
        : existing.seen;
      if (existing.unread === 0 && (!meId || existing.seen[meId] === nextSeen[meId])) return;
      cache.set(k, { ...existing, unread: 0, seen: nextSeen });
      notify();
    },

    dispose: () => {
      disposed = true;
      for (const ctrl of aborts.values()) ctrl.abort();
      aborts.clear();
    },
  };
}

/** What the session-gated conversation readers (`readChannelThread`, `readConversationCatchup`) need from the request. */
export type SessionReadDeps = {
  getToken: () => Promise<string | undefined>;
  getMe: () => Promise<Me | undefined>;
  fetchHub: <T>(path: string) => Promise<T>;
  isHubStatus?: (err: unknown) => number | undefined;
};

/** The signed-in user and their workspace `ws`, or the 401/403 answer when there is no session or no membership. */
export async function sessionWorkspace(
  ws: string,
  deps: Pick<SessionReadDeps, 'getToken' | 'getMe'>,
): Promise<{ user: Me; workspace: Me['workspaces'][number] } | { status: 401 | 403; body: { error: string } }> {
  if (!(await deps.getToken())) {
    return { status: 401, body: { error: 'Not signed in' } };
  }
  const user = await deps.getMe();
  if (!user) {
    return { status: 401, body: { error: 'Not signed in' } };
  }
  const workspace = user.workspaces.find((w) => w.id === ws);
  if (!workspace) {
    return { status: 403, body: { error: 'Not a member of this workspace' } };
  }
  return { user, workspace };
}

type ReadChannelThreadResult =
  | { status: 200; body: ThreadPayload }
  | { status: 400 | 401 | 403 | 404 | 500; body: { error: string } };

/**
 * Server-side reader for a single channel thread (`GET /api/conversations/[key]/thread`).
 * Validates the user's session, workspace membership, channel membership, and that the root post
 * belongs to this channel before returning `{ post, replies, seen, older, activity, unread, people, done, shared }`.
 */
export async function readChannelThread(
  input: { ws: string; key: string; postId: string; replies?: number },
  deps: SessionReadDeps,
): Promise<ReadChannelThreadResult> {
  const ws = input.ws.trim();
  const key = input.key.trim();
  const postId = input.postId.trim();
  if (!ws || !postId || !key.startsWith('channel:') || key.length <= 8) {
    return { status: 400, body: { error: 'Invalid channel thread request' } };
  }
  const channelId = key.slice(8);

  const session = await sessionWorkspace(ws, deps);
  if ('status' in session) return session;
  const { user, workspace } = session;
  const channel = workspace.channels?.find((c) => c.id === channelId);
  if (!channel) {
    return { status: 403, body: { error: 'Not a member of this channel' } };
  }

  const replyCount = clampReplyCount(input.replies, DEFAULT_THREAD_REPLIES);
  const threadKey = `thread:${channelId}:${postId}`;

  try {
    const [threadPost, threadPage, members] = await Promise.all([
      deps.fetchHub<{ message: MessageView }>(`/messages/${encodeURIComponent(postId)}`),
      deps.fetchHub<ConversationPage>(
        `/conversations/${encodeURIComponent(threadKey)}/messages?${new URLSearchParams({ limit: String(replyCount) })}`,
      ),
      deps.fetchHub<Agent[]>(`/agents?channel=${encodeURIComponent(channelId)}`).catch(() => [] as Agent[]),
    ]);

    if (threadPost.message.conversation !== key) {
      return { status: 404, body: { error: 'Thread does not belong to this channel' } };
    }

    const people: People = { [user.id]: user };
    for (const m of members) {
      people[m.id] = { ...m, role: channel.roles?.[m.id] };
    }
    const gone = [
      ...new Set([
        threadPost.message.fromId,
        ...threadPage.messages.map((m) => m.fromId),
        ...Object.keys(threadPage.seen ?? {}),
        ...(threadPage.activity ?? []).map((a) => a.agentId),
      ]),
    ]
      .filter((id) => !people[id])
      .slice(0, 12);

    for (const a of await Promise.all(
      gone.map((id) => deps.fetchHub<Agent>(`/agents/${encodeURIComponent(id)}`).catch(() => undefined)),
    )) {
      if (a) people[a.id] = a;
    }

    return {
      status: 200,
      body: {
        post: threadPost.message,
        replies: threadPage.messages,
        seen: threadPage.seen ?? {},
        older: Boolean(threadPage.older),
        activity: threadPage.activity ?? [],
        unread: conversationUnread(threadPage, user.id),
        people,
        done: Boolean(channel.doneThreads?.includes(postId)),
        shared: Boolean(channel.publicThreads?.includes(postId)),
      },
    };
  } catch (err) {
    const status = deps.isHubStatus?.(err);
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      return { status, body: { error: err instanceof Error ? err.message : 'Unable to load thread' } };
    }
    throw err;
  }
}

