'use client';

import { useEffect } from 'react';

export type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
};

/**
 * Shared by `app/error.tsx` and `app/global-error.tsx`. Transient client/network errors (no server `digest`)
 * retry on their own as soon as the browser is visible and online; server errors wait for the button.
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
      clearTimeout(timer);
      timer = setTimeout(() => recover(), 800);
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
