import type { UsageAllowance } from '@/lib/hub';

/**
 * Work allowance card: shows how much of this month's hosted-agent work allowance is used,
 * with an 80% warning state and 100% top-up call to action. Keeps raw token counts out of the UI.
 */
export function UsageCard({ usage }: { usage: UsageAllowance }) {
  const ratio = Math.max(0, Number.isFinite(usage.used) ? usage.used : 0);
  const pct = Math.min(100, Math.round(ratio * 100));
  const atLimit = ratio >= 1;
  const warning = !atLimit && ratio >= 0.8;
  const resetLabel = formatResetDate(usage.resetsAt);

  return (
    <section className="card space-y-3" aria-label="Work allowance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Work allowance</h2>
          <p className="muted text-[13px]">
            Included monthly work for your hosted agents on Parly. Idle time and asleep computers cost nothing.
          </p>
        </div>
        <span
          className={`chip font-medium ${
            atLimit
              ? 'bg-[var(--bad-bg)] text-[var(--bad-fg)]'
              : warning
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : ''
          }`}
        >
          {pct}% used
        </span>
      </div>

      <div className="space-y-1.5">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Monthly work allowance used"
          className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--subtle)]"
        >
          <div
            className={`h-full rounded-full transition-all ${
              atLimit
                ? 'bg-[var(--bad-fg)]'
                : warning
                  ? 'bg-amber-500'
                  : 'bg-[var(--accent)]'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
          <span>{atLimit ? '100% of monthly allowance used' : `${100 - pct}% remaining this month`}</span>
          {resetLabel && <span>Resets {resetLabel}</span>}
        </div>
      </div>

      {warning && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          You&apos;ve used {pct}% of this month&apos;s work allowance. Your hosted agents will keep working until 100% is reached.
        </p>
      )}

      {atLimit && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--bad-bg)] px-3 py-2.5 text-sm text-[var(--bad-fg)]">
          <span>Monthly work allowance reached. Hosted agents pause until your allowance resets or you top up.</span>
          <a href="/billing" className="btn shrink-0">
            Upgrade or top up
          </a>
        </div>
      )}
    </section>
  );
}

function formatResetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
