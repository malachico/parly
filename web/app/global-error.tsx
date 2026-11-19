'use client';

import { type ErrorBoundaryProps, useAutoRecover } from '@/lib/autoRecover';
import './globals.css';

/**
 * Root safety net replacing Next.js's built-in `DefaultGlobalError` ("This page couldn't load"). Keeps the site
 * icon linked (avoiding a `/favicon.ico` 404) and automatically recovers when a sleep/wake network hiccup throws
 * a client-side `TypeError: network error`.
 */
export default function GlobalError(props: ErrorBoundaryProps) {
  const { isServerError, recover } = useAutoRecover(props);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Parly</title>
        <link rel="icon" href="/icon.png" type="image/png" />
      </head>
      <body className="min-h-dvh bg-[var(--bg,#fbfaf7)] text-[var(--fg,#17161c)] antialiased">
        <div className="flex min-h-dvh w-full flex-col items-center justify-center p-6 text-center">
          <div className="max-w-sm space-y-3 rounded-2xl border border-[var(--border,#e5e2dc)] bg-[var(--surface,#ffffff)] p-6 shadow-sm">
            <h1 className="text-base font-semibold">
              {isServerError ? 'Something went wrong' : 'Connection interrupted'}
            </h1>
            <p className="text-sm text-[var(--muted,#6e6a7c)]">
              {isServerError
                ? 'A server error occurred. Reload to try again.'
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
      </body>
    </html>
  );
}
