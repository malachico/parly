import Link from 'next/link';
import type { Hour } from '@/lib/admin';

const TABS = [
  { href: '/admin', label: 'Health' },
  { href: '/admin/agents', label: 'Agents' },
  { href: '/admin/vouchers', label: 'Vouchers' },
  { href: '/admin/requests', label: 'Client requests' },
  { href: '/admin/leads', label: 'Enterprise leads' },
  { href: '/admin/clients', label: 'Connect page' },
  { href: '/admin/log', label: 'Audit log' },
] as const;

/** The admin section's tabs; `current` is the open one. */
export function AdminNav({ current }: { current: (typeof TABS)[number]['href'] }) {
  return (
    <nav aria-label="Admin" className="flex flex-wrap gap-1 border-b border-[var(--border)]">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === current ? 'page' : undefined}
          className={`-mb-px flex min-h-10 items-center border-b-2 px-3 text-sm font-medium ${
            t.href === current ? 'border-[var(--accent)] text-[var(--fg)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--fg)]'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** One number with its caption; `tone` marks a number that needs attention. */
export function Stat({ label, value, sub, tone, href }: { label: string; value: number | string; sub?: string; tone?: 'bad' | 'warn'; href?: string }) {
  const color = tone === 'bad' ? 'text-[var(--bad-fg)]' : tone === 'warn' ? 'text-[var(--warn-fg)]' : 'text-[var(--fg)]';
  const body = (
    <>
      <span className="label">{label}</span>
      <span className={`text-[28px] leading-tight font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-xs text-[var(--muted)]">{sub}</span>}
    </>
  );
  const cls = 'card flex min-w-0 flex-col gap-1';
  return href ? (
    <Link href={href} className={`${cls} hover:border-[var(--border-strong)]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Messages sent per hour. Hovering a column names its number. */
export function HourlyChart({ hours }: { hours: Hour[] }) {
  const max = Math.max(1, ...hours.map((h) => h.messages));
  const hourLabel = (iso: string) => `${iso.slice(11, 13)}:00 UTC`;
  return (
    <figure className="card space-y-3">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">Messages per hour</span>
        <span className="text-xs text-[var(--muted)]">peak {max}</span>
      </figcaption>
      <div className="flex h-40 items-end gap-[2px]" role="img" aria-label="Messages per hour">
        {hours.map((h) => (
          <div key={h.hour} title={`${hourLabel(h.hour)}: ${h.messages} messages`} className="flex h-full min-w-0 flex-1 flex-col-reverse rounded-t hover:bg-[var(--subtle)]">
            {h.messages > 0 && <div style={{ height: `${(h.messages / max) * 100}%`, background: 'var(--accent)', minHeight: 2 }} className="rounded-t-[4px]" />}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-[var(--muted)] tabular-nums">
        <span>{hours[0] && hourLabel(hours[0].hour)}</span>
        <span>now</span>
      </div>
    </figure>
  );
}
