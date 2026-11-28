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
  // A mark still waiting out the debounce fires when the conversation changes or closes, so a quick visit still reads.
  const pending = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationKey is the flush trigger, not read here
  useEffect(() => () => pending.current?.(), [conversationKey]);
  useEffect(() => {
    pending.current = null;
    if (unread === 0) return;
    // Debounced ~1s: a burst of arriving messages (each bumping `unread`) marks read once.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      pending.current = null;
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      void (act.current ? act.current() : markConversationRead(conversationKey)).catch(() => {});
    };
    const mark = () => {
      clearTimeout(timer);
      pending.current = fire;
      timer = setTimeout(fire, 1000);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [conversationKey, unread]);
  return null;
}
