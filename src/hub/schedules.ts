import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import { newId } from '../lib/wire.js';
import { TriggerStore } from './triggerStore.js';

/** How often a scheduled message repeats. `time` is "HH:MM" in `tz`; `once` also takes `date` ("YYYY-MM-DD"). */
type Repeat = 'once' | 'daily' | 'weekdays' | 'weekly' | 'interval';

interface ScheduleSpec {
  repeat: Repeat;
  /** "HH:MM", local to `tz` (all but interval). */
  time?: string;
  /** once: the local date, "YYYY-MM-DD". */
  date?: string;
  /** weekly: 0 (Sunday) to 6. */
  day?: number;
  /** interval: minutes between posts. */
  minutes?: number;
  /** An IANA time zone, e.g. "Asia/Bangkok". */
  tz: string;
}

/**
 * Collection `schedules`: a message posted when `nextAt` comes, either in a channel or as a
 * direct message to an agent (`to`), sent as its owner so the answer lands in their own conversation with it.
 */
export interface ScheduleRecord extends ScheduleSpec {
  id: string;
  /** A channel post (with `botId`), or else `to`. */
  channelId?: string;
  /** A direct message to this agent, from `ownerId`. */
  to?: string;
  /** Post in this post's thread instead of the channel. */
  thread?: string;
  text: string;
  /** The person it's for (who made it, or whose agent did); they, their agents or a channel owner change it. */
  ownerId: string;
  /** Channel triggers: the agent it belongs to; it posts as that agent (⏰) and wakes it. */
  agentId?: string;
  /** Legacy: the Scheduled bot that used to post it; now whoever scheduled it does. */
  botId?: string;
  /** When it next posts (ISO). Absent once it's paused or done, so the due query skips it. */
  nextAt?: string;
  active: boolean;
  createdAt: string;
  lastRunAt?: string;
  /** Posts that failed in a row; three pause it. */
  failures?: number;
  problem?: string;
}

const MIN_INTERVAL_MINUTES = 5;
const MAX_PER_CHANNEL = 20;
const MAX_FAILURES = 3;

/** Checks a spec from a request and returns it clean, or says what's wrong. */
export function parseSpec(input: Record<string, unknown>): ScheduleSpec {
  const repeat = input.repeat as Repeat;
  if (!['once', 'daily', 'weekdays', 'weekly', 'interval'].includes(repeat)) throw new HubError('invalid', 'repeat is once, daily, weekdays, weekly or interval');
  const tz = typeof input.tz === 'string' && input.tz ? input.tz : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new HubError('invalid', `"${tz}" is not a time zone (try one like Asia/Bangkok)`);
  }
  if (repeat === 'interval') {
    const minutes = Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES) throw new HubError('invalid', `An interval is a whole number of minutes, at least ${MIN_INTERVAL_MINUTES}`);
    return { repeat, minutes, tz };
  }
  const time = typeof input.time === 'string' ? input.time : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HubError('invalid', 'time is "HH:MM" (24-hour)');
  if (repeat === 'once') {
    const date = typeof input.date === 'string' ? input.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HubError('invalid', 'date is "YYYY-MM-DD"');
    // A day the month doesn't have (2026-02-31) would roll over into the next month.
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) throw new HubError('invalid', `${date} isn't a date`);
    return { repeat, time, date, tz };
  }
  if (repeat === 'weekly') {
    const day = Number(input.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new HubError('invalid', 'day is 0 (Sunday) to 6 (Saturday)');
    return { repeat, time, day, tz };
  }
  return { repeat, time, tz };
}

/** The first time after `after` the spec posts, or undefined (a `once` that has passed). */
export function nextRun(spec: ScheduleSpec, after: Date): Date | undefined {
  if (spec.repeat === 'interval') return new Date(after.getTime() + spec.minutes! * 60_000);
  const [hh, mm] = spec.time!.split(':').map(Number) as [number, number];
  if (spec.repeat === 'once') {
    const [y, m, d] = spec.date!.split('-').map(Number) as [number, number, number];
    const at = zoned(y, m, d, hh, mm, spec.tz);
    return at > after ? at : undefined;
  }
  // The local date in `tz` now, then forward a day at a time until one fits (a week covers weekly).
  const today = localParts(after, spec.tz);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const weekday = day.getUTCDay();
    if (spec.repeat === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (spec.repeat === 'weekly' && weekday !== spec.day) continue;
    const at = zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, spec.tz);
    if (at > after) return at;
  }
  return undefined;
}

/** In words, for the channel panel: "Weekdays at 09:00 (Asia/Bangkok)". */
export function describe(spec: ScheduleSpec): string {
  const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  if (spec.repeat === 'interval') return `Every ${spec.minutes} minutes`;
  const when = { once: `On ${spec.date}`, daily: 'Every day', weekdays: 'Weekdays', weekly: DAYS[spec.day ?? 0] }[spec.repeat];
  return `${when} at ${spec.time} (${spec.tz})`;
}

/** The wall-clock parts of `at` in `tz`. */
function localParts(at: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
}

/** The instant that is y-m-d hh:mm on the wall clocks of `tz` (DST-aware: the offset is checked at the result). */
function zoned(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (t: number) => {
    const p = localParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}

/** Scheduled messages: kept in the DB, posted by `post` when due (runDue, every minute from /tick or the sweep). */
export class Schedules {
  private readonly store: TriggerStore;

  constructor(db: Database) {
    this.store = new TriggerStore(db);
  }

  async create(input: Omit<ScheduleRecord, 'id' | 'nextAt' | 'active' | 'createdAt'>): Promise<ScheduleRecord> {
    const next = nextRun(input, new Date());
    if (!next) throw new HubError('invalid', 'That time has already passed');
    const record: ScheduleRecord = { ...input, id: newId(), nextAt: next.toISOString(), active: true, createdAt: new Date().toISOString() };
    if (!(await this.store.addSchedule(record, MAX_PER_CHANNEL))) {
      throw new HubError('conflict', `Up to ${MAX_PER_CHANNEL} scheduled messages per ${input.channelId ? 'channel' : 'agent'}`);
    }
    return record;
  }

  async get(id: string): Promise<ScheduleRecord | undefined> {
    return this.store.schedule(id);
  }

  /** What `ownerId` has scheduled to send agent `to`. */
  async toAgent(ownerId: string, to: string): Promise<ScheduleRecord[]> {
    return (await this.store.schedulesToAgent(ownerId, to)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Everything `ownerId` has scheduled: in channels and to agents. */
  async ofOwner(ownerId: string): Promise<ScheduleRecord[]> {
    return (await this.store.schedulesOfOwner(ownerId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async ofChannel(channelId: string): Promise<ScheduleRecord[]> {
    return (await this.store.schedulesOfChannel(channelId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** New text and/or timing; the next post is worked out again from now (a paused one stays paused). */
  async update(record: ScheduleRecord, patch: { text?: string; spec?: ScheduleSpec }): Promise<ScheduleRecord> {
    const updated: ScheduleRecord = { ...record, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.spec ?? {}) };
    if (patch.spec) {
      // Fields of the old repeat that the new one doesn't use go.
      for (const k of ['time', 'date', 'day', 'minutes'] as const) if (!(k in patch.spec)) delete updated[k];
    }
    let nextAt: string | undefined = updated.nextAt;
    if (patch.spec && updated.active) {
      const next = nextRun(updated, new Date());
      if (!next) throw new HubError('invalid', 'That time has already passed');
      nextAt = next.toISOString();
    }
    const final: ScheduleRecord = { ...updated, ...(nextAt ? { nextAt } : {}), failures: 0 };
    delete final.problem;
    await this.store.saveSchedule(final);
    return final;
  }

  /** Pause, or resume from now. */
  async setActive(record: ScheduleRecord, active: boolean): Promise<ScheduleRecord> {
    const next = active ? nextRun(record, new Date()) : undefined;
    if (active && !next) throw new HubError('invalid', 'That time has already passed');
    await this.store.setScheduleActive(record.id, active, next ? next.toISOString() : undefined);
    const { problem: _p, ...rest } = record;
    return { ...rest, active, failures: 0, ...(next ? { nextAt: next.toISOString() } : { nextAt: undefined }) };
  }

  async remove(id: string): Promise<void> {
    await this.store.removeSchedule(id);
  }

  /**
   * Posts every schedule whose time has come. Each is claimed in a transaction (its nextAt moved on) before it
   * posts, so two instances never post it twice; one that was missed while the hub slept posts once, now.
   */
  async runDue(post: (s: ScheduleRecord) => Promise<void>, now = new Date()): Promise<number> {
    let ran = 0;
    for (const id of await this.store.listDueSchedules(now)) {
      const claimed = await this.store.claimDueSchedule(id, now, nextRun);
      if (!claimed) continue;
      try {
        await post(claimed);
        if (claimed.failures) await this.store.clearScheduleFailures(id);
        ran++;
      } catch (err) {
        const failures = (claimed.failures ?? 0) + 1;
        const problem = (err as Error).message;
        // ponytail: three failures in a row pause it; the owner sees why in the channel panel
        await this.store.scheduleFailed(id, failures, problem, failures >= MAX_FAILURES
          ? { pause: true }
          : claimed.repeat === 'once' ? { retryAt: new Date(now.getTime() + 60_000).toISOString() } : undefined);
      }
    }
    return ran;
  }
}
