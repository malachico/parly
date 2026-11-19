'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';
import { subscribeLive } from '@/lib/live';
import { cancelRefresh, scheduleRefresh } from '@/lib/refreshScheduler';

export const LIVE_REFRESH_EVENT = 'parly:live-refresh';
/** A live burst's window: anchored on its first event, so a steady stream re-renders at most about once a second. */
const LIVE_SETTLE_MS = 1000;

/**
 * Keeps what's around the open conversation current (the sidebar's unread counts, last messages) from the live
 * stream (lib/live.ts): after a burst of events it re-renders the server page once. The open conversation itself
 * takes its messages straight from the events (LiveTimeline). `fallbackMs`: also re-render on that cadence, for a
 * page whose data the stream doesn't carry (an agent connecting). A hidden tab catches up once when shown.
 */
export function LiveRefresh({ fallbackMs }: { fallbackMs?: number }) {
  const router = useRouter();
  // One re-render in flight: a burst that settles while one is still loading waits for it, then runs once.
  const [busy, startTransition] = useTransition();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const followUp = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (busy || !followUp.current) return;
    const next = followUp.current;
    followUp.current = undefined;
    next();
  }, [busy]);
  useEffect(() => {
    let stale = false;
    const rerender = () => {
      if (document.visibilityState !== 'visible') return void (stale = true);
      if (busyRef.current) return void (followUp.current = rerender);
      startTransition(() => router.refresh());
    };
    // The open thread needs no fetch of its own: the re-render re-sends it (ChannelShell reseeds from initialThread).
    const refresh = () => {
      if (document.visibilityState !== 'visible') return void (stale = true);
      stale = false;
      // Shared with MarkRead: a live message and the read it causes re-render the page once, after the read lands.
      scheduleRefresh(rerender, undefined, LIVE_SETTLE_MS);
    };
    const onVisible = () => stale && refresh();
    // Who's working, per conversation: an agent's steps stream as activity, but only starting or stopping changes
    // what the server pages show (a channel's "is being woken up"); LiveTimeline draws the steps itself.
    const working = new Map<string, string>();
    const unsubscribe = subscribeLive((e) => {
      if (e.type === 'activity') {
        const who = [...new Set(e.activity.map((a) => a.agentId))].sort().join();
        if ((working.get(e.conversation) ?? '') === who) return;
        if (who) working.set(e.conversation, who);
        else working.delete(e.conversation);
      }
      refresh();
    });
    const every = fallbackMs ? setInterval(refresh, fallbackMs) : undefined;
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      cancelRefresh(rerender);
      followUp.current = undefined;
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, fallbackMs]);
  return null;
}
