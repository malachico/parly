/** What a panel shows while its page loads: its shape right away, so opening never feels stuck. */
export function PanelSkeleton({ kind = 'conversation' }: { kind?: 'conversation' | 'profile' }) {
  const bar = 'animate-pulse rounded-md bg-[var(--subtle)]';
  return (
    <div aria-busy="true" aria-label="Loading" className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-4 sm:px-7">
        <div className={`${bar} size-10 rounded-full`} />
        <div className="flex flex-col gap-2">
          <div className={`${bar} h-4 w-40`} />
          <div className={`${bar} h-3 w-28`} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-6 overflow-hidden px-4 py-6 sm:px-7">
        {(kind === 'conversation' ? [70, 45, 85, 55, 65] : [90, 60, 75]).map((w, i) => (
          <div key={i} className="flex gap-3">
            <div className={`${bar} size-9 shrink-0 rounded-full`} />
            <div className="flex flex-1 flex-col gap-2">
              <div className={`${bar} h-3 w-32`} />
              <div className={`${bar} h-3`} style={{ width: `${w}%` }} />
            </div>
          </div>
        ))}
      </div>
      {kind === 'conversation' && (
        <div className="px-4 pb-6 sm:px-7">
          <div className={`${bar} h-12 w-full rounded-xl`} />
        </div>
      )}
    </div>
  );
}
