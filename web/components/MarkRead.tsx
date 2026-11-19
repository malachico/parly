'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { markConversationRead } from '@/lib/actions';
import { cancelRefresh, holdRefresh, scheduleRefresh } from '@/lib/refreshScheduler';

/** Fired (detail: the thread's post id) when an open thread is marked read, so its post's "N new" clears at once. */
export const THREAD_READ_EVENT = 'parly:thread-read';

/** Marks the open conversation read while it's on screen and has unread messages; `action` marks something else (a thread). */
export function MarkRead({ conversationKey, unread, action }: { conversationKey: string; unread: number; action?: () => Promise<void> }) {
  const act = useRef(action);
  act.current = action;
  const router = useRouter();
  useEffect(() => {
    if (unread === 0) return;
    let active = true;
    const releases = new Set<() => void>();
    const refresh = () => router.refresh();
    const after = () => {
      if (active) scheduleRefresh(refresh);
    };
    const mark = () => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      // Then re-render the server page so the canvas, sidebar and Needs you behind it drop the unread (other tabs
      // hear the hub's read event). Shared with LiveRefresh, held until the read lands: one live message, one re-render.
      const release = holdRefresh();
      releases.add(release);
      void (act.current ? act.current() : markConversationRead(conversationKey))
        // Refresh either way: on success the sidebar and ⌘K catch up; on failure an optimistic clear is undone.
        .then(after, after)
        .finally(() => {
          release();
          releases.delete(release);
        });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', mark);
      cancelRefresh(refresh);
      for (const release of releases) release();
    };
  }, [conversationKey, unread, router]);
  return null;
}
