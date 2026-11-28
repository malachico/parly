'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ActivityItem, MessageView } from '@/lib/hub';
import { forgetTicket, ticket } from '@/lib/hubDirect';

/** What the hub's GET /events/stream sends: each event carries the data to draw it. */
type LiveEvent = { type: 'message'; message: MessageView & { forYou?: boolean } } | { type: 'activity'; conversation: string; activity: ActivityItem[] } | { type: 'read'; conversation: string };

const listeners = new Set<(e: LiveEvent) => void>();
let source: EventSource | undefined;
let lastId = '';
// Bumped on sign-out, so a ticket asked for before it isn't used after.
let epoch = 0;
// The epoch a ticket is being asked for in: one from before a sign-out doesn't hold up the next person's.
let opening = -1;
// Counts stream errors (dropped or refused), so LiveRefresh can tell whether it missed events while hidden.
let drops = 0;

/** Whether the tab's stream is open now, and how many times it has dropped: LiveRefresh resyncs only after a gap. */
export function liveState(): { open: boolean; drops: number } {
  return { open: source?.readyState === 1, drops };
}

/**
 * One EventSource per tab, opened on the first subscriber, straight to the hub with the tab's ticket (lib/hubDirect).
 * A ticket only opens a stream for a few minutes, so once the hub refuses a reconnect the tab gets a new one and
 * resumes from the last event.
 */
async function connect(fresh = false) {
  if (source || opening === epoch || typeof EventSource === 'undefined') return;
  const mine = (opening = epoch);
  const t = await ticket(fresh);
  if (mine !== epoch) return;
  opening = -1;
  // Signed out: no stream, and no retrying.
  if (t === 401) return;
  // Offline (asleep, changing networks) or the hub busy: ask for a ticket again.
  if (typeof t === 'number') return void setTimeout(connect, t ? 30_000 : 5000);
  const { url } = t;
  const s = new EventSource(`${url}${lastId ? `&cursor=${encodeURIComponent(lastId)}` : ''}`);
  source = s;
  let opened = false;
  s.addEventListener('open', () => (opened = true));
  const emit = (e: LiveEvent) => listeners.forEach((l) => l(e));
  const track = (e: MessageEvent) => {
    if (e.lastEventId) lastId = e.lastEventId;
  };
  s.addEventListener('message', (e) => {
    track(e as MessageEvent);
    emit({ type: 'message', message: JSON.parse((e as MessageEvent).data) });
  });
  s.addEventListener('activity', (e) => {
    track(e as MessageEvent);
    const d = JSON.parse((e as MessageEvent).data) as {
      conversation: string;
      activity: ActivityItem[];
    };
    emit({
      type: 'activity',
      conversation: d.conversation,
      activity: d.activity,
    });
  });
  // Read here or in another tab: the canvas re-reads its unread counts.
  s.addEventListener('read', (e) => {
    track(e as MessageEvent);
    emit({ type: 'read', conversation: (JSON.parse((e as MessageEvent).data) as { conversation: string }).conversation });
  });
  // A dropped connection retries by itself; a refused one (an old ticket) closes, so open again with a new ticket.
  s.addEventListener('error', () => {
    drops++;
    if (s.readyState !== EventSource.CLOSED) return;
    source = undefined;
    // Never opened: the hub is unreachable from here, so back off rather than retry every 2 s.
    setTimeout(() => connect(true), opened ? 2000 : 30_000);
  });
}

/** Signing out leaves this tab (and module) alive: the next person must not get this one's stream, messages or ticket. */
export function forgetLive() {
  epoch++;
  forgetTicket();
  source?.close();
  source = undefined;
  lastId = '';
  arrived.clear();
}

export function subscribeLive(fn: (e: LiveEvent) => void): () => void {
  listeners.add(fn);
  void connect();
  return () => listeners.delete(fn);
}

// Messages that arrived live, per conversation (dm:…, channel:…, thread:…), beyond what the server page rendered.
const arrived = new Map<string, MessageView[]>();
const storeListeners = new Set<() => void>();
const EMPTY: MessageView[] = [];
// Conversations a mounted useLiveMessages is showing: never trimmed, or its un-rendered messages would vanish.
const watched = new Map<string, number>();
// ponytail: fixed caps for conversations nobody is showing (every thread in every channel lands here); tune if a
// remounted view ever needs more than its last few live messages.
const UNWATCHED_TAIL = 50;
const UNWATCHED_CONVERSATIONS = 100;

export function trimArrived(arrived: Map<string, MessageView[]>, watched: Map<string, number>) {
  let unwatched = 0;
  // Newest-updated last (each set re-inserts), so walk from the end and drop the oldest beyond the cap.
  for (const key of [...arrived.keys()].reverse()) {
    if (watched.has(key)) continue;
    if (++unwatched > UNWATCHED_CONVERSATIONS) {
      arrived.delete(key);
      continue;
    }
    const list = arrived.get(key)!;
    if (list.length > UNWATCHED_TAIL) arrived.set(key, list.slice(-UNWATCHED_TAIL));
  }
}

subscribeLiveStore();
function subscribeLiveStore() {
  if (typeof window === 'undefined') return;
  listeners.add((e) => {
    if (e.type !== 'message') return;
    const m = e.message;
    const list = arrived.get(m.conversation) ?? [];
    const i = list.findIndex((x) => x.id === m.id);
    // A new message is appended; one sent again (edited, its files ready) replaces the copy.
    const next = i >= 0 ? list.map((x, j) => (j === i ? m : x)) : [...list, m].sort((a, b) => a.seq - b.seq);
    arrived.delete(m.conversation);
    arrived.set(m.conversation, next);
    trimArrived(arrived, watched);
    storeListeners.forEach((l) => l());
  });
}

/**
 * `rendered` (from the server page) plus what arrived live for `conversation` since, by id, oldest first. The live
 * copy wins for a message in both (it's newer). Opens the stream.
 */
export function useLiveMessages<T extends Pick<MessageView, 'id' | 'seq'>>(conversation: string | undefined, rendered: T[]): (T | MessageView)[] {
  useEffect(() => subscribeLive(() => {}), []);
  useEffect(() => {
    if (!conversation) return;
    watched.set(conversation, (watched.get(conversation) ?? 0) + 1);
    return () => {
      const n = (watched.get(conversation) ?? 1) - 1;
      if (n > 0) watched.set(conversation, n);
      else watched.delete(conversation);
    };
  }, [conversation]);
  const live = useSyncExternalStore(
    (cb) => {
      storeListeners.add(cb);
      return () => storeListeners.delete(cb);
    },
    () => (conversation ? (arrived.get(conversation) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  return useMemo(() => {
    if (!live.length) return rendered;
    const byId = new Map<string, T | MessageView>(rendered.map((m) => [m.id, m]));
    for (const m of live) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.seq - b.seq);
  }, [live, rendered]);
}
