import type { Agent } from '@/lib/hub';

/** "person" or "agent"; the technical kind (mailbox / endpoint) stays in the tooltip. */
export function KindBadge({ kind }: { kind: Agent['kind'] }) {
  return (
    <span className="chip shrink-0" title={kind}>
      {kind === 'human' ? 'person' : 'agent'}
    </span>
  );
}

export function ErrorNote({ error }: { error?: string | string[] }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
      {String(error)}
    </p>
  );
}

/** Page heading with an optional subtitle and actions that wrap under it on phones. */
export function PageHeader({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="page-title break-words">{title}</h1>
        {sub && <p className="muted mt-1">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted)]">{children}</p>;
}
