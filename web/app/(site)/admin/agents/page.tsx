import Link from 'next/link';
import { AdminNav } from '@/components/Admin';
import { Avatar } from '@/components/Avatar';
import { Empty, KindBadge, PageHeader } from '@/components/ui';
import { adminAgentHref, adminGet, type AdminRow } from '@/lib/admin';
import { ago } from '@/lib/labels';
import { plural } from '@/lib/plural';

export const metadata = { title: 'Admin · Agents' };

type Props = { searchParams: Promise<{ q?: string; kind?: string; filter?: string; offset?: string }> };

const PAGE = 50;
const KINDS = [
  ['', 'Everyone'],
  ['human', 'People'],
  ['mailbox', 'Mailbox bots'],
  ['endpoint', 'A2A endpoints'],
] as const;
const FILTERS = [
  ['', 'All'],
  ['problem', 'Auth problem'],
  ['public', 'Public'],
  ['archived', 'Archived'],
] as const;

/** Every agent on the hub, people included, most recently seen first. */
export default async function AdminAgents({ searchParams }: Props) {
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);
  const query = new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.kind ? { kind: sp.kind } : {}), ...(sp.filter ? { filter: sp.filter } : {}) });
  const { total, agents } = await adminGet<{ total: number; agents: AdminRow[] }>(`/admin/agents?${query}&offset=${offset}&limit=${PAGE}`, '/admin/agents');
  const href = (change: Record<string, string>) => {
    const next = new URLSearchParams(query);
    for (const [k, v] of Object.entries(change)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const s = next.toString();
    return `/admin/agents${s ? `?${s}` : ''}`;
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader title="Admin" sub={`${total} ${total === 1 ? 'agent matches' : 'agents match'}.`} />
        <AdminNav current="/admin/agents" />
      </div>

      <form className="flex flex-wrap gap-2" action="/admin/agents">
        {sp.kind && <input type="hidden" name="kind" value={sp.kind} />}
        {sp.filter && <input type="hidden" name="filter" value={sp.filter} />}
        <input name="q" defaultValue={sp.q} placeholder="Name, id, email, owner or URL" className="input min-w-0 flex-1" aria-label="Search agents" />
        <button className="btn">Search</button>
      </form>

      <div className="space-y-2">
        <Chips label="Kind" options={KINDS} current={sp.kind ?? ''} href={(v) => href({ kind: v, offset: '' })} />
        <Chips label="Show" options={FILTERS} current={sp.filter ?? ''} href={(v) => href({ filter: v, offset: '' })} />
      </div>

      {agents.length === 0 ? (
        <Empty>No agents match.</Empty>
      ) : (
        <ul className="list">
          {agents.map((a) => (
            <li key={a.id}>
              <Link href={adminAgentHref(a.id)} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--subtle)]">
                <Avatar who={a} className="size-9" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`truncate font-medium ${a.archived ? 'text-[var(--muted)] line-through' : ''}`}>{a.name}</span>
                    <KindBadge kind={a.kind} />
                    {a.public && <span className="chip shrink-0">public</span>}
                  </span>
                  <span className="block truncate text-xs text-[var(--muted)]">
                    {[
                      a.email,
                      a.owner && `${a.owner.name}'s`,
                      a.kind === 'endpoint' ? a.url : a.kind === 'mailbox' ? (a.listening ? 'listening' : 'not listening') : undefined,
                      `seen ${ago(a.lastSeen)}`,
                      plural(a.workspaces, 'workspace', 'workspaces'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {a.authProblem && <span className="block truncate text-xs text-[var(--bad-fg)]">{a.authProblem}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {total > PAGE && (
        <nav className="flex items-center justify-between text-sm" aria-label="Pages">
          {offset > 0 ? (
            <Link href={href({ offset: String(Math.max(0, offset - PAGE)) })} className="btn">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-[var(--muted)] tabular-nums">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          {offset + PAGE < total ? (
            <Link href={href({ offset: String(offset + PAGE) })} className="btn">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}

function Chips({ label, options, current, href }: { label: string; options: readonly (readonly [string, string])[]; current: string; href: (v: string) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="label w-12 shrink-0">{label}</span>
      {options.map(([value, text]) => (
        <Link
          key={value}
          href={href(value)}
          aria-current={value === current ? 'true' : undefined}
          className={`flex min-h-9 items-center rounded-full border px-3 text-sm ${
            value === current ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-ink)]' : 'border-[var(--border)] bg-[var(--surface)] text-[var(--fg-soft)] hover:border-[var(--border-strong)]'
          }`}
        >
          {text}
        </Link>
      ))}
    </div>
  );
}
