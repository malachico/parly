import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { appsHref } from '@/lib/routes';
import { AppSearch } from '@/components/AppSearch';
import { notFound } from 'next/navigation';
import { Avatar } from '@/components/Avatar';
import { PendingButton } from '@/components/PendingButton';
import { ErrorNote, PageHeader } from '@/components/ui';
import { PanelPage } from '@/components/PanelPage';
import { disconnectApp, reconnectApp, setAgentAct, setAgentApp } from '@/lib/actions';
import { hub, meOrLogin, type MyAppView } from '@/lib/hub';
import { ago } from '@/lib/labels';
import { plural } from '@/lib/plural';

type Props = { params: Promise<{ ws: string; toolkit: string }>; searchParams: Promise<{ error?: string; q?: string }> };

/**
 * One app: its connection, the agents that may use it (or have) with their activity, and a search to give another
 * agent access. Agents without access aren't listed (you may have hundreds); search finds them.
 */
export default async function AppPage({ params, searchParams }: Props) {
  const { ws, toolkit } = await params;
  await meOrLogin();
  const [{ error, q }, apps] = await Promise.all([searchParams, hub<MyAppView[]>('/me/apps').catch(() => [] as MyAppView[])]);
  const app = apps.find((a) => a.toolkit === toolkit);
  if (!app) notFound();

  const users = app.agents.filter((a) => a.enabled || a.use).sort((x, y) => Number(y.enabled) - Number(x.enabled) || (y.use?.uses ?? 0) - (x.use?.uses ?? 0));
  const query = q?.trim().toLowerCase();
  // ponytail: matches by name in the page; a hub-side search when people have thousands of agents.
  const matches = query ? app.agents.filter((a) => !a.enabled && a.name.toLowerCase().includes(query)).slice(0, 8) : [];
  // Each agent's runs of this app (newest first): which tool, when, and whether it worked.
  const histories = new Map(
    await Promise.all(
      users
        .filter((a) => a.use)
        .map(
          async (a) =>
            [a.id, await hub<{ at: string; tool: string; ok: boolean }[]>(`/me/apps/${encodeURIComponent(toolkit)}/usage?agent=${encodeURIComponent(a.id)}`).catch(() => [])] as const,
        ),
    ),
  );

  return (
    <PanelPage ws={ws}>
        <div className="mx-auto max-w-2xl space-y-6">
      <Link href={appsHref(ws)} title="All apps" aria-label="All apps" className="-ml-2 inline-flex size-9 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
            <Icon name="back" size={18} />
          </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {app.logo ? <img src={app.logo} alt="" className="size-9 rounded-md" loading="lazy" referrerPolicy="no-referrer" /> : <span className="size-9 rounded-md bg-[var(--subtle)]" />}
            {app.name}
          </span>
        }
        sub={app.account.status === 'ACTIVE' ? 'Connected' : 'Not connected'}
      >
        {app.native || app.toolkit === 'github' ? (
          app.account.status === 'ACTIVE' && app.installUrl ? (
            <a href={app.installUrl} className="btn-ghost min-h-8 px-2.5 text-xs">
              Manage on GitHub ↗
            </a>
          ) : app.account.status !== 'ACTIVE' ? (
            // ponytail: installUrl only when ACTIVE; bare GitHub URL skips CSRF-bound Connect
            <form action={reconnectApp.bind(null, ws, app.toolkit)}>
              <PendingButton className="btn min-h-8 px-2.5 text-xs">Connect</PendingButton>
            </form>
          ) : null
        ) : (
          <form action={disconnectApp.bind(null, ws, app.account.id)}>
            <PendingButton confirm="Yes, disconnect" className="btn-ghost min-h-8 px-2.5 text-xs text-[var(--bad-fg)]" title={`Disconnect ${app.name} from all your agents`}>
              Disconnect
            </PendingButton>
          </form>
        )}
      </PageHeader>
      <ErrorNote error={error} />

      <section className="card space-y-3">
        <h2 className="font-medium">Agents using it</h2>
        {users.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None of your agents may use {app.name} yet. Find one below.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
            {users.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                <Avatar who={a} className="size-7" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.name}</span>
                  <span className="block text-xs text-[var(--muted)]">
                    {a.use ? `Used ${plural(a.use.uses, 'time', 'times')}${a.use.failures ? ` (${a.use.failures} failed)` : ''} · last ${ago(a.use.lastAt)}: ${a.use.lastTool}` : 'Not used yet'}
                    {a.enabled ? ` · ${a.act ? 'may act (all its apps)' : 'read only'}` : ' · no access now'}
                  </span>
                </span>
                {(histories.get(a.id) ?? []).length > 0 && (
                  <details className="order-last w-full text-xs">
                    <summary className="cursor-pointer text-[var(--accent)]">Recent activity</summary>
                    <ol className="mt-1.5 space-y-1 border-l border-[var(--border)] pl-3">
                      {(histories.get(a.id) ?? []).map((h, i) => (
                        <li key={i} className="flex gap-2">
                          <span className={h.ok ? 'text-[var(--ok-fg)]' : 'text-[var(--bad-fg)]'}>{h.ok ? '✓' : '✗'}</span>
                          <span className="font-mono">{h.tool}</span>
                          <span className="text-[var(--muted)]">{ago(h.at)}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {a.enabled && (
                  <form action={setAgentAct.bind(null, ws, a.id, app.toolkit, !a.act)}>
                    <PendingButton className="btn-ghost min-h-8 px-2.5 text-xs" title={a.act ? 'Only read with its apps' : 'Also send, create and change with its apps (all of them)'}>
                      {a.act ? 'Make read only' : 'Let it act'}
                    </PendingButton>
                  </form>
                )}
                <form action={setAgentApp.bind(null, ws, a.id, app.toolkit, !a.enabled)}>
                  <PendingButton className={`min-h-8 px-2.5 text-xs ${a.enabled ? 'btn-ghost' : 'btn'}`}>{a.enabled ? 'Remove access' : 'Give access'}</PendingButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium">Give another agent access</h2>
        <AppSearch param="q" placeholder="Search your agents by name" label="Search your agents" />
        {query &&
          (matches.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No agent without access matches &ldquo;{q}&rdquo;.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
              {matches.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <Avatar who={a} className="size-7" />
                  <span className="min-w-0 flex-1 font-medium">{a.name}</span>
                  <form action={setAgentApp.bind(null, ws, a.id, app.toolkit, true)}>
                    <PendingButton className="btn min-h-8 px-2.5 text-xs">Give access</PendingButton>
                  </form>
                </li>
              ))}
            </ul>
          ))}
      </section>
        </div>
    </PanelPage>
  );
}
