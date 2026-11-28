/** The crew canvas while it loads: its dotted floor and the chrome in the same places, so nothing jumps when it arrives. */
export function CanvasSkeleton() {
  const bar = 'animate-pulse rounded-md bg-[var(--subtle)]';
  const pill = 'rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_4px_14px_rgba(23,22,28,0.06)]';
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="relative h-full min-w-0 flex-1 overflow-clip"
      style={{
        backgroundColor: 'var(--bg)',
        backgroundImage: 'radial-gradient(var(--dots) 1.3px, transparent 1.3px)',
        backgroundSize: '22px 22px',
      }}
    >
      <div className="absolute top-3.5 right-2.5 left-2.5 grid grid-cols-[minmax(0,1fr)_44px_auto] items-start gap-3 sm:right-4 sm:left-4 sm:grid-cols-[minmax(0,1fr)_100px_minmax(0,1fr)]">
        <div className={`${pill} flex items-center gap-2 justify-self-start`}>
          <div className={`${bar} size-9 rounded-full`} />
          <span aria-hidden="true" className="h-6 w-px bg-[var(--border)]" />
          <div className={`${bar} mr-2 h-4 w-28`} />
        </div>
        <div className="size-11 rounded-full border border-[var(--border)] bg-[var(--surface)] shadow-[0_4px_14px_rgba(23,22,28,0.06)] sm:w-full" />
        <div className={`${pill} flex items-center gap-1 justify-self-end`}>
          <div className={`${bar} size-9`} />
          <div className={`${bar} size-9`} />
        </div>
      </div>
      <div className={`${pill} absolute right-4 bottom-4 flex items-center gap-1`}>
        <div className={`${bar} h-8 w-36`} />
      </div>
    </div>
  );
}
