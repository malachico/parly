'use client';

import { useSyncExternalStore } from 'react';
import { dayLabel } from '@/lib/labels';

/**
 * Times in the reader's own time zone. Pages render on the server, which runs in UTC, so a time
 * formatted there is off for everyone else: these format in the browser, after it loads.
 */
const noSubscribe = () => () => {};
/** False while rendering on the server and hydrating, true after: one shared flag, no effect or state per instance. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

/** "14:05" (or "2:05 PM", by the reader's locale); with `date`, the date too. */
export function LocalTime({ iso, className, date }: { iso?: string; className?: string; date?: boolean }) {
  const mounted = useHydrated();
  if (!iso) return null;
  const d = new Date(iso);
  return (
    <time dateTime={iso} className={className}>
      {/* Before hydration, an invisible stand-in of about the same width, so the line doesn't shift when the time appears. */}
      {!mounted ? (
        <span className="invisible">{date ? '00/00/0000, 00:00:00' : '00:00'}</span>
      ) : date ? (
        d.toLocaleString()
      ) : (
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      )}
    </time>
  );
}

/**
 * A day divider's label in the reader's days ("Today", "Yesterday", a date). The divider itself is placed
 * on the server, so nothing is inserted after load (which made the page jump); only its words may change.
 */
export function DayLabel({ at, initial }: { at: string; initial: string }) {
  const mounted = useHydrated();
  return <>{mounted ? dayLabel(at) || initial : initial}</>;
}
