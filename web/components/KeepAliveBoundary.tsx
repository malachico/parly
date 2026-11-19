'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Component, startTransition, useEffect, type ReactNode } from 'react';

/** True when `err` is Next.js's internal signal for `redirect()` or `notFound()`. */
export function isNextRouterError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('digest' in err)) return false;
  const d = (err as { digest?: unknown }).digest;
  return typeof d === 'string' && (d.startsWith('NEXT_REDIRECT;') || d.startsWith('NEXT_HTTP_ERROR_FALLBACK;'));
}

/** Cap auto-retries so a lasting render error cannot spin forever (#35). */
export const KEEP_ALIVE_MAX_AUTO_RETRIES = 5;

/** Backoff for auto-retry attempt `n` (0-based), capped at 30s. */
export function keepAliveRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_500 * 2 ** Math.max(0, attempt));
}

function AutoRetry({ delayMs, onRetry }: { delayMs: number; onRetry: () => void }) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      clearTimeout(timer);
      timer = setTimeout(onRetry, delayMs);
    };
    attempt();
    const onWake = () => attempt();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [delayMs, onRetry]);
  return null;
}

type InnerProps = {
  routeKey: string;
  className?: string;
  onRetry: () => void;
  children: ReactNode;
};

type InnerState = {
  error: unknown;
  routeKey: string;
  /** Auto-retry attempts in this error episode (manual Try again resets it). */
  autoAttempts: number;
};

/**
 * Catches an interrupted in-flight RSC stream (e.g. `net::ERR_NETWORK_IO_SUSPENDED` when a laptop sleeps mid-refresh)
 * and shows a small inline "Reconnecting…" fallback that auto-retries, instead of letting the rejected Flight chunk
 * bubble to Next.js's full-screen `DefaultGlobalError` ("This page couldn't load"). When the connection returns the
 * retry re-mounts the children with fresh data (drafts are localStorage-backed, so an in-progress message survives).
 */
export class KeepAliveBoundaryInner extends Component<InnerProps, InnerState> {
  constructor(props: InnerProps) {
    super(props);
    this.state = { error: null, routeKey: props.routeKey, autoAttempts: 0 };
  }

  static getDerivedStateFromError(thrownValue: unknown): Partial<InnerState> {
    if (isNextRouterError(thrownValue)) throw thrownValue;
    return { error: thrownValue ?? new Error('Render error') };
  }

  static getDerivedStateFromProps(props: InnerProps, state: InnerState): Partial<InnerState> | null {
    if (props.routeKey !== state.routeKey && state.error !== null) {
      return { error: null, routeKey: props.routeKey, autoAttempts: 0 };
    }
    if (props.routeKey !== state.routeKey) {
      return { routeKey: props.routeKey, autoAttempts: 0 };
    }
    return null;
  }

  private retry = (fromAuto = false) => {
    startTransition(() => {
      this.props.onRetry();
      this.setState((s) => ({
        error: null,
        autoAttempts: fromAuto ? s.autoAttempts + 1 : 0,
      }));
    });
  };

  render() {
    if (this.state.error !== null) {
      const canAuto = this.state.autoAttempts < KEEP_ALIVE_MAX_AUTO_RETRIES;
      // A live fallback (not a frozen DOM snapshot): auto-retry while we can, and always keep a manual "Try again"
      // so the view can still recover after the auto-retry cap instead of sticking (#35).
      return (
        <div className={this.props.className}>
          {canAuto ? <AutoRetry delayMs={keepAliveRetryDelayMs(this.state.autoAttempts)} onRetry={() => this.retry(true)} /> : null}
          <div className="flex h-full min-h-[240px] w-full flex-1 flex-col items-center justify-center gap-3 bg-[var(--bg)] p-6 text-center">
            <p className="text-sm font-medium text-[var(--fg)]">{canAuto ? 'Reconnecting…' : 'Still offline'}</p>
            <p className="max-w-xs text-xs text-[var(--muted)]">The connection was interrupted while loading this view.</p>
            <button type="button" onClick={() => this.retry(false)} className="btn mt-1">
              Try again
            </button>
          </div>
        </div>
      );
    }
    return <div className={this.props.className}>{this.props.children}</div>;
  }
}

export function KeepAliveBoundary({ className = 'contents', children }: { className?: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <KeepAliveBoundaryInner routeKey={pathname} className={className} onRetry={() => router.refresh()}>
      {children}
    </KeepAliveBoundaryInner>
  );
}
