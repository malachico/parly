'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { ActivityItem, MessageView } from '@/lib/hub';

/** What the hub's GET /events/stream sends: each event carries the data to draw it. */
type LiveEvent = { type: 'message'; message: MessageView & { forYou?: boolean } } | { type: 'activity'; conversation: string; activity: ActivityItem[] } | { type: 'read'; conversation: string };

const listeners = new Set<(e: LiveEvent) => void>();
let source: EventSource | undefined;
let opening = false;
let lastId = '';

/**
 * One EventSource per tab, opened on the first subscriber, straight to the hub with a ticket from /api/stream/ticket.
 * A ticket only opens a stream for a few minutes, so once the hub refuses a reconnect the tab gets a new one and
 * resumes from the last event.
 */
async function connect() {
  if (source || opening || typeof EventSource === 'undefined') return;
  opening = true;
  const res = await fetch('/api/stream/ticket', { method: 'POST' }).catch(() => null);
  opening = false;
  // Signed out: no stream, and no retrying.
  if (res?.status === 401) return;
  // Offline (asleep, changing networks) or the hub busy: ask for a ticket again.
  if (!res?.ok) return void setTimeout(connect, res ? 30_000 : 5000);
  const { url } = (await res.json()) as { url: string };
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
  // Read here or in another tab: LiveRefresh redraws the unread counts.
  s.addEventListener('read', (e) => {
    track(e as MessageEvent);
    emit({ type: 'read', conversation: (JSON.parse((e as MessageEvent).data) as { conversation: string }).conversation });
  });
  // A dropped connection retries by itself; a refused one (an old ticket) closes, so open again with a new ticket.
  s.addEventListener('error', () => {
    if (s.readyState !== EventSource.CLOSED) return;
    source = undefined;
    // Never opened: the hub is unreachable from here, so back off rather than retry every 2 s.
    setTimeout(connect, opened ? 2000 : 30_000);
  });
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
    arrived.set(m.conversation, next);
    storeListeners.forEach((l) => l());
  });
}

/**
 * `rendered` (from the server page) plus what arrived live for `conversation` since, by id, oldest first. The live
 * copy wins for a message in both (it's newer). Opens the stream.
 */
export function useLiveMessages<T extends Pick<MessageView, 'id' | 'seq'>>(conversation: string | undefined, rendered: T[]): (T | MessageView)[] {
  useEffect(() => subscribeLive(() => {}), []);
  const live = useSyncExternalStore(
    (cb) => {
      storeListeners.add(cb);
      return () => storeListeners.delete(cb);
    },
    () => (conversation ? (arrived.get(conversation) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  if (!live.length) return rendered;
  const byId = new Map<string, T | MessageView>(rendered.map((m) => [m.id, m]));
  for (const m of live) byId.set(m.id, m);
  // ponytail: re-merges on every render; fine for a page of messages
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
