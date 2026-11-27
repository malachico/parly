import { LocalTime } from '@/components/LocalTime';
import { ScheduleForm } from '@/components/ScheduleForm';
import { deleteSchedule, setScheduleActive, updateSchedule } from '@/lib/actions';
import type { Schedule } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

/**
 * Scheduled messages (a channel's, or mine to an agent): what each posts, when, by whom, and Edit / Pause / Delete
 * for those `canChange` allows. `back` is the page to return to after a change.
 */
export function ScheduleList({ schedules, back, canChange, byName }: { schedules: Schedule[]; back: string; canChange: (s: Schedule) => boolean; byName?: (s: Schedule) => string }) {
  if (schedules.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {schedules.map((s) => (
        <li key={s.id} id={`schedule-${s.id}`} className="scroll-mt-4 rounded-lg border border-[var(--border)] px-3 py-2">
          <p dir="auto" className="line-clamp-2 text-sm">
            {s.text}
          </p>
          <p className="text-[13px] text-[var(--muted)]">
            {s.when}
            {s.active && s.nextAt ? (
              <>
                {' · next '}
                <LocalTime iso={s.nextAt} date />
              </>
            ) : (
              ' · paused'
            )}
          </p>
          {byName && <p className="text-[13px] text-[var(--muted)]">{byName(s)}</p>}
          {s.problem && <p className="text-[13px] text-[var(--bad-fg)]">Last post failed: {s.problem}</p>}
          {canChange(s) && (
            <>
              <details className="pt-1">
                <summary className="cursor-pointer text-[13px] text-[var(--accent)]">Edit</summary>
                <div className="pt-2">
                  <ScheduleForm action={updateSchedule.bind(null, back, s.id)} initial={s} />
                </div>
              </details>
              <div className="flex gap-1.5 pt-1">
                <form action={setScheduleActive.bind(null, back, s.id, !s.active)}>
                  <PendingButton className="btn-ghost text-[13px]">{s.active ? 'Pause' : 'Resume'}</PendingButton>
                </form>
                <form action={deleteSchedule.bind(null, back, s.id)}>
                  <PendingButton confirm="Yes, delete" className="btn-ghost text-[13px] text-[var(--bad-fg)]">Delete</PendingButton>
                </form>
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
