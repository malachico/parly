'use client';

import { useEffect, useRef } from 'react';
import { markConversationRead } from '@/lib/actions';

/** Fired (detail: the thread's post id) when an open thread is marked read, so its post's "N new" clears at once. */
export const THREAD_READ_EVENT = 'parly:thread-read';

/** Marks the open conversation read while it's on screen and has unread messages; `action` marks something else (a thread).
 *  The hub's read event then has the canvas re-read its counts, here and in other tabs; no page re-render. */
export function MarkRead({ conversationKey, unread, action }: { conversationKey: string; unread: number; action?: () => Promise<void> }) {
  const act = useRef(action);
  act.current = action;
  useEffect(() => {
    if (unread === 0) return;
    const mark = () => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      void (act.current ? act.current() : markConversationRead(conversationKey)).catch(() => {});
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [conversationKey, unread]);
  return null;
}
