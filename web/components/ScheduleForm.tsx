'use client';
import { PendingButton } from './PendingButton';

import { useEffect, useState } from 'react';

type Repeat = 'daily' | 'weekdays' | 'weekly' | 'once' | 'interval';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Initial = { text: string; repeat: Repeat; time?: string; date?: string; day?: number; minutes?: number; tz: string };

/**
 * The channel panel's "Schedule a message", and editing one (`initial`): only the fields its repeat needs, in the
 * viewer's time zone for a new one, its own for an edit.
 */
export function ScheduleForm({ action, initial, children, textLabel, placeholder, submit }: { action: (form: FormData) => void; initial?: Initial; children?: React.ReactNode; textLabel?: string; placeholder?: string; submit?: string }) {
  const [repeat, setRepeat] = useState<Repeat>(initial?.repeat ?? 'weekdays');
  const [tz, setTz] = useState(initial?.tz ?? 'UTC');
  useEffect(() => {
    if (!initial) setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  }, [initial]);
  return (
    <form action={action} className="flex flex-col gap-2">
      {children}
      {!initial && (
        <label htmlFor="schedule-text" className="text-sm">
          {textLabel ?? (
            <>
              Post a message on a schedule. <span className="text-[var(--muted)]">@name an agent and it wakes up to it. Or just ask an agent: “every weekday at 9, …”.</span>
            </>
          )}
        </label>
      )}
      <textarea
        id={initial ? undefined : 'schedule-text'}
        name="text"
        dir="auto"
        required
        maxLength={4000}
        rows={2}
        defaultValue={initial?.text}
        placeholder={placeholder ?? "e.g. @Atlas, sum up what happened today"}
        className="input"
        aria-label={initial ? 'Text' : undefined}
      />
      <div className="flex flex-wrap gap-2">
        <select name="repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} className="input w-auto" aria-label="Repeat">
          <option value="weekdays">Weekdays</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="once">Once</option>
          <option value="interval">Every N minutes</option>
        </select>
        {repeat === 'weekly' && (
          <select name="day" defaultValue={String(initial?.day ?? 1)} className="input w-auto" aria-label="Day">
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        )}
        {repeat === 'once' && <input type="date" name="date" required defaultValue={initial?.date} className="input w-auto" aria-label="Date" />}
        {repeat === 'interval' ? (
          <input type="number" name="minutes" min={5} defaultValue={initial?.minutes ?? 60} required className="input w-24" aria-label="Minutes" />
        ) : (
          <input type="time" name="time" defaultValue={initial?.time ?? '09:00'} required className="input w-auto" aria-label="Time" />
        )}
      </div>
      <input type="hidden" name="tz" value={tz} />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]">{repeat === 'interval' ? '' : `Time zone: ${tz}`}</span>
        <PendingButton className="btn shrink-0">{submit ?? (initial ? 'Save' : 'Schedule')}</PendingButton>
      </div>
    </form>
  );
}
