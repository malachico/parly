'use client';

import { type ErrorBoundaryProps, useAutoRecover } from '@/lib/autoRecover';

/**
 * Segment-level error boundary below RootLayout. Transient client/network errors (no server `digest`, e.g.
 * `ERR_NETWORK_IO_SUSPENDED` / `TypeError: network error` when a device sleeps mid-navigation) automatically
 * retry as soon as the browser is visible and online.
 */
export default function AppError(props: ErrorBoundaryProps) {
  const { isServerError, recover } = useAutoRecover(props);

  return (
    <div className="flex min-h-dvh w-full flex-col items-center justify-center bg-[var(--bg)] p-6 text-center text-[var(--fg)]">
      <div className="max-w-sm space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
        <h1 className="text-base font-semibold">
          {isServerError ? 'Something went wrong' : 'Connection interrupted'}
        </h1>
        <p className="text-sm text-[var(--muted)]">
          {isServerError
            ? 'A server error occurred while loading this page.'
            : 'Reconnecting automatically when your network is ready, or try again now.'}
        </p>
        <div className="flex items-center justify-center gap-2 pt-2">
          <button type="button" onClick={() => recover?.()} className="btn-primary">
            Try again
          </button>
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? window.history.back() : (window.location.href = '/'))}
            className="btn"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
