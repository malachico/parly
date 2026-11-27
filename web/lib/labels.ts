import { channelKey } from './routes';
import type { MessageView, Schedule } from './hub-types';

/** "3m", "2h", "Mon", "Oct 3": short enough for a list row. */
export function shortTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return new Date(t).toLocaleDateString([], { weekday: 'short' });
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** AI use in credits, as people see it: 100 credits = $1 (the hub meters dollars). "1,500". */
export function credits(usd: number): string {
  return Math.max(0, Math.floor(usd * 100)).toLocaleString('en-US');
}

/** A usage bar's fill: red at 100%, amber from 80%. */
export function meterColor(pct: number): string {
  return pct >= 100 ? 'bg-[var(--bad-fg)]' : pct >= 80 ? 'bg-amber-500' : 'bg-[var(--accent)]';
}

export const BUDGET_INVALID = 'Budget must be a number of credits, 0 or more, or null to remove it';

/** The budget form's value for the hub: null removes it (only an empty field), undefined is invalid. Same check as the hub's setBudget. */
export function budgetCredits(raw: string): number | null | undefined {
  if (raw === '') return null;
  const c = Number(raw);
  return Number.isFinite(c) && c >= 0 && Number.isSafeInteger(Math.round(c * 10_000)) ? c : undefined;
}

/** "just now", "3m ago", "2d ago", or "never": when something last happened. */
export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** What a trigger watches, in a few words: its settings ("owner: acme · repo: web"), or its app. */
export function triggerWhat(t: { toolkit: string; config?: Record<string, unknown> }): string {
  return (
    Object.entries(t.config ?? {})
      .filter(([k]) => k !== 'interval')
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · ') || t.toolkit
  );
}

/** "Today", "Yesterday", or a date, for separators in a thread. */
export function dayLabel(iso: string | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: diff < 7 ? 'long' : undefined, month: 'short', day: 'numeric' });
}

/** "512 B", "34 KB", "2.5 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A token count, short: 950, 12.3k, 4.1M. */
export function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** A status older than this reads as idle, not current work (agents don't always clear their last status). */
const STATUS_FRESH_MS = 30 * 60_000;

/** True when a status is old enough that it should not be shown as the agent's current work. */
export function statusStale(status: { at: string; text?: string } | undefined, now = Date.now()): boolean {
  if (!status) return false;
  // Agents post "Done: …" when they finish (see the log drawer's isDone); a finished status is not current work.
  if (status.text && /^done\b/i.test(status.text.trim())) return true;
  const t = Date.parse(status.at);
  return !Number.isNaN(t) && now - t > STATUS_FRESH_MS;
}

/** True when the status is current work in this channel or one of its threads. A team frame counts only work in its own channel, not a DM or another team. */
export function workingIn(status: { at: string; text?: string; conversationId: string } | undefined, channelId: string, now = Date.now()): boolean {
  if (!status || statusStale(status, now)) return false;
  return status.conversationId === channelKey(channelId) || status.conversationId.startsWith(`thread:${channelId}:`);
}

const GROUP_MS = 5 * 60_000;

/** Whether `m` shows under `prev`'s author line: same sender, kind (webhook, automatic) and day, within GROUP_MS. */
export function continues(prev: Pick<MessageView, 'fromId' | 'webhook' | 'scheduled' | 'at'> | undefined, m: Pick<MessageView, 'fromId' | 'webhook' | 'scheduled' | 'at'>): boolean {
  if (!prev || prev.fromId !== m.fromId || prev.webhook !== m.webhook || !prev.scheduled !== !m.scheduled || dayLabel(prev.at) !== dayLabel(m.at)) return false;
  return Date.parse(m.at) - Date.parse(prev.at) < GROUP_MS;
}

/** A thread's soonest active schedule, and how many more target it; undefined when none do. */
export function nextInThread<S extends Pick<Schedule, 'thread' | 'active' | 'nextAt'>>(schedules: S[], postId: string): { next: S; more: number } | undefined {
  const due = schedules.filter((s) => s.thread === postId && s.active && s.nextAt).sort((a, b) => Date.parse(a.nextAt!) - Date.parse(b.nextAt!));
  return due[0] && { next: due[0], more: due.length - 1 };
}

/** How often a schedule repeats, in words without its time zone ("every weekday"); "" for once. */
export function cadence(s: Pick<Schedule, 'repeat' | 'minutes'>): string {
  if (s.repeat === 'daily') return 'every day';
  if (s.repeat === 'weekdays') return 'every weekday';
  if (s.repeat === 'weekly') return 'weekly';
  if (s.repeat === 'interval') return `every ${s.minutes ?? '?'} min`;
  return '';
}
