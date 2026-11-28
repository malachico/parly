'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { liveState } from '@/lib/live';

export const LIVE_REFRESH_EVENT = 'parly:live-refresh';

/**
 * Re-renders the server page when a hidden tab is shown again (after more than 30s hidden, or if the live stream
 * dropped or isn't open meanwhile), the one resync for what the live stream doesn't
 * carry (new channels, waiting items, who is working). Live events themselves never re-render it: messages are drawn
 * on the client from the event, and the canvas re-reads its unread counts from the hub. With `fallbackMs` it also re-renders on that cadence
 * while visible, for pages whose data isn't on the stream.
 */
export function LiveRefresh({ fallbackMs }: { fallbackMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && router.refresh();
    const every = fallbackMs ? setInterval(refresh, fallbackMs) : undefined;
    // When the tab was hidden and the stream's drop count then: a quick look away with the stream up missed nothing.
    let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : undefined;
    let dropsAt = liveState().drops;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        hiddenAt = Date.now();
        dropsAt = liveState().drops;
        return;
      }
      const live = liveState();
      const away = hiddenAt === undefined ? Infinity : Date.now() - hiddenAt;
      hiddenAt = undefined;
      if (away > 30_000 || !live.open || live.drops !== dropsAt) router.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, fallbackMs]);
  return null;
}
