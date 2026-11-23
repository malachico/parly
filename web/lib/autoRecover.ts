'use client';

import { useEffect } from 'react';

export type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
  /** Which boundary this is: each gets its own retry budget, so one failing area can't use up another's. */
  scope?: string;
};

/** Auto-retries per error episode, so a lasting render error cannot spin forever. The button always works. */
export const AUTO_RECOVER_MAX_RETRIES = 5;
/** No auto-retry for this long (longer than the slowest backoff) means the next error is a new episode. */
const QUIET_MS = 60_000;
// Module-level per scope: every retry resets the boundary, so a child that throws again mounts a fresh fallback.
const budgets = new Map<string, { attempts: number; lastAttemptAt: number }>();
const budgetFor = (scope: string) => {
  let budget = budgets.get(scope);
  if (!budget) budgets.set(scope, (budget = { attempts: 0, lastAttemptAt: 0 }));
  if (Date.now() - budget.lastAttemptAt > QUIET_MS) budget.attempts = 0;
  return budget;
};

/**
 * Shared by the `error.tsx` files and `app/global-error.tsx`. Transient client/network errors (no server `digest`)
 * retry on their own as soon as the browser is visible and online, a few times with backoff; server errors wait
 * for the button.
 */
export function useAutoRecover({ error, retry, reset, scope = 'default' }: ErrorBoundaryProps) {
  const isServerError = Boolean(error?.digest);
  const auto = retry ?? reset;
  const gaveUp = !isServerError && budgetFor(scope).attempts >= AUTO_RECOVER_MAX_RETRIES;

  useEffect(() => {
    if (isServerError || !auto) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (document.visibilityState !== 'visible') return;
      if (navigator.onLine === false) return;
      const budget = budgetFor(scope);
      if (budget.attempts >= AUTO_RECOVER_MAX_RETRIES) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        budget.attempts++;
        budget.lastAttemptAt = Date.now();
        auto();
      }, 800 * 2 ** budget.attempts);
    };
    attempt();
    document.addEventListener('visibilitychange', attempt);
    window.addEventListener('online', attempt);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', attempt);
      window.removeEventListener('online', attempt);
    };
  }, [isServerError, auto, scope]);

  // Try again is never gated, and a person retrying starts a fresh budget.
  const recover = auto && (() => { budgets.delete(scope); auto(); });
  return { isServerError, recover, gaveUp };
}
