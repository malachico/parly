export type PanelSkeletonKind = 'conversation' | 'profile';

/** Which skeleton fits the page a link opens: conversations (and their threads) get the chat shape, the rest the card stack. */
export function panelSkeletonKind(to: URL): PanelSkeletonKind {
  return /\/(c|activity)\/[^/]+$/.test(decodeURIComponent(to.pathname)) ? 'conversation' : 'profile';
}

/** What a panel shows while its page loads: its shape right away, so opening never feels stuck. */
export function PanelSkeleton({ kind = 'conversation' }: { kind?: PanelSkeletonKind }) {
  const bar = 'animate-pulse rounded-md bg-[var(--subtle)]';
  if (kind === 'profile') {
    // The profile and settings pages: a centered stack of cards, no header bar.
    return (
      <div aria-busy="true" aria-label="Loading" className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-6 sm:px-7">
          <div className="mx-auto max-w-2xl space-y-6">
            <div className="card space-y-5 p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className={`${bar} size-16 shrink-0 rounded-full`} />
                <div className="flex flex-1 flex-col gap-2 pt-1">
                  <div className={`${bar} h-6 w-48`} />
                  <div className={`${bar} h-3 w-32`} />
                </div>
              </div>
              <div className={`${bar} h-3 w-4/5`} />
              <div className="space-y-2 border-t border-[var(--border)] pt-4">
                {[60, 45, 70].map((w, i) => (
                  <div key={i} className={`${bar} h-3`} style={{ width: `${w}%` }} />
                ))}
              </div>
            </div>
            {[3, 2].map((rows, i) => (
              <div key={i} className="card space-y-3 p-5 sm:p-6">
                <div className={`${bar} h-4 w-36`} />
                {Array.from({ length: rows }, (_, j) => (
                  <div key={j} className={`${bar} h-3`} style={{ width: `${85 - j * 20}%` }} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div aria-busy="true" aria-label="Loading" className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      {/* Same height as the real conversation header: a back button and the name, no avatar. */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-2 sm:px-5">
        <div className={`${bar} size-9 shrink-0 rounded-lg`} />
        <div className="flex flex-col gap-1.5">
          <div className={`${bar} h-4 w-40`} />
          <div className={`${bar} h-3 w-28`} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-6 overflow-hidden px-4 py-6 sm:px-7">
        {[70, 45, 85, 55, 65].map((w, i) => (
          <div key={i} className="flex gap-3">
            <div className={`${bar} size-9 shrink-0 rounded-full`} />
            <div className="flex flex-1 flex-col gap-2">
              <div className={`${bar} h-3 w-32`} />
              <div className={`${bar} h-3`} style={{ width: `${w}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 pb-6 sm:px-7">
        <div className={`${bar} h-12 w-full rounded-xl`} />
      </div>
    </div>
  );
}
