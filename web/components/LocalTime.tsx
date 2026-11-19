'use client';

import { useEffect, useState } from 'react';
import { dayLabel } from '@/lib/labels';

/**
 * Times in the reader's own time zone. Pages render on the server, which runs in UTC, so a time
 * formatted there is off for everyone else: these format in the browser, after it loads.
 */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** "14:05" (or "2:05 PM", by the reader's locale); with `date`, the date too. */
export function LocalTime({ iso, className, date }: { iso?: string; className?: string; date?: boolean }) {
  const mounted = useMounted();
  if (!iso) return null;
  const d = new Date(iso);
  const text = !mounted ? '' : date ? d.toLocaleString() : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <time dateTime={iso} className={className}>
      {text}
    </time>
  );
}

/**
 * A day divider's label in the reader's days ("Today", "Yesterday", a date). The divider itself is placed
 * on the server, so nothing is inserted after load (which made the page jump); only its words may change.
 */
export function DayLabel({ at, initial }: { at: string; initial: string }) {
  const mounted = useMounted();
  return <>{mounted ? dayLabel(at) || initial : initial}</>;
}
