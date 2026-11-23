'use client';

import { type ErrorBoundaryProps, useAutoRecover } from '@/lib/autoRecover';

/**
 * Shown in place of the open panel (or a Shared Room's chat) when it fails to render, e.g. an RSC stream cut off
 * when a laptop sleeps mid-refresh. The canvas and the rest of the window stay up.
 */
export default function PanelError(props: ErrorBoundaryProps) {
  const { isServerError, recover } = useAutoRecover(props);
  return (
    <div className="flex h-full min-h-[240px] w-full flex-1 flex-col items-center justify-center gap-3 bg-[var(--bg)] p-6 text-center">
      <p className="text-sm font-medium text-[var(--fg)]">{isServerError ? 'Something went wrong' : 'Reconnecting…'}</p>
      <p className="max-w-xs text-xs text-[var(--muted)]">
        {isServerError ? 'A server error occurred while loading this view.' : 'The connection was interrupted while loading this view.'}
      </p>
      <button type="button" onClick={() => recover?.()} className="btn mt-1">
        Try again
      </button>
    </div>
  );
}
