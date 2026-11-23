'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export const LIVE_REFRESH_EVENT = 'parly:live-refresh';

/**
 * Re-renders the server page when a hidden tab is shown again, the one resync for what the live stream doesn't
 * carry (new channels, waiting items, who is working). Live events themselves never re-render it: messages are drawn
 * on the client from the event, and the canvas re-reads its unread counts from the hub. With `fallbackMs` it also re-renders on that cadence
 * while visible, for pages whose data isn't on the stream.
 */
export function LiveRefresh({ fallbackMs }: { fallbackMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && router.refresh();
    const every = fallbackMs ? setInterval(refresh, fallbackMs) : undefined;
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(every);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [router, fallbackMs]);
  return null;
}
