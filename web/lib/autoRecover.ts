'use client';

import { useEffect } from 'react';

export type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
};

/** Auto-retries per error episode, so a lasting render error cannot spin forever. The button always works. */
export const AUTO_RECOVER_MAX_RETRIES = 5;
/** No auto-retry for this long (longer than the slowest backoff) means the next error is a new episode. */
const QUIET_MS = 60_000;
// Module-level: every retry resets the boundary, so a child that throws again mounts a fresh fallback.
let attempts = 0;
let lastAttemptAt = 0;

/**
 * Shared by the `error.tsx` files and `app/global-error.tsx`. Transient client/network errors (no server `digest`)
 * retry on their own as soon as the browser is visible and online, a few times with backoff; server errors wait
 * for the button.
 */
export function useAutoRecover({ error, retry, reset }: ErrorBoundaryProps) {
  const isServerError = Boolean(error?.digest);
  const recover = retry ?? reset;

  useEffect(() => {
    if (isServerError || !recover) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (document.visibilityState !== 'visible') return;
      if (navigator.onLine === false) return;
      if (Date.now() - lastAttemptAt > QUIET_MS) attempts = 0;
      if (attempts >= AUTO_RECOVER_MAX_RETRIES) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        attempts++;
        lastAttemptAt = Date.now();
        recover();
      }, 800 * 2 ** attempts);
    };
    attempt();
    document.addEventListener('visibilitychange', attempt);
    window.addEventListener('online', attempt);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', attempt);
      window.removeEventListener('online', attempt);
    };
  }, [isServerError, recover]);

  return { isServerError, recover };
}
