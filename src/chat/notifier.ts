import { EventEmitter } from 'node:events';

/** Something changed in a conversation on this instance: a message stored, or someone's live activity there. */
export interface Change {
  conversationId: string;
  channelId?: string;
  participants?: string[];
  activity?: boolean;
}

// One listener per open wait (wait_for_message, a send waiting for its reply, /events, a web stream): no cap.
const bus = new EventEmitter().setMaxListeners(0);

export function changed(c: Change): void {
  bus.emit('change', c);
}

/** Calls `fn` on every change posted on this instance. */
export function onChange(fn: (c: Change) => void): void {
  bus.on('change', fn);
}

/**
 * Wakes a wait loop when a `relevant` change is posted here, instead of polling the store every second. Another
 * Cloud Run instance's posts don't reach this bus, so `next(ms)` still resolves after `ms`: the loop re-reads either
 * way. Subscribed from the start, so a change that lands while the loop is reading isn't missed. `close()` when done.
 */
export function watch(relevant: (c: Change) => boolean): { next(ms: number): Promise<void>; close(): void } {
  let pending = false;
  let wake: (() => void) | undefined;
  const on = (c: Change) => {
    if (!relevant(c)) return;
    pending = true;
    wake?.();
  };
  bus.on('change', on);
  return {
    next: (ms) =>
      new Promise<void>((resolve) => {
        if (pending) {
          pending = false;
          return resolve();
        }
        const timer = setTimeout(() => wake?.(), ms);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          pending = false;
          resolve();
        };
      }),
    close: () => {
      bus.off('change', on);
      wake?.();
    },
  };
}
