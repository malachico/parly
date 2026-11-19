import Link from 'next/link';
import { CreditsPaused } from '@/components/CreditsPaused';
import { Icon } from '@/components/Icon';
import { appsHref, skillsHref, triggersHref, wsHref } from '@/lib/routes';
import { AppSearch } from '@/components/AppSearch';
import { PendingButton } from '@/components/PendingButton';
import { ErrorNote, PageHeader } from '@/components/ui';
import { reconnectApp } from '@/lib/actions';
import { hub, meOrLogin, type MyAppView, type MyTools } from '@/lib/hub';
import { ago } from '@/lib/labels';
import { plural } from '@/lib/plural';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; q?: string }> };

/** Apps: every app you've connected or your agents may use, one row each; its page has who uses it and how. */
export default async function Apps({ params, searchParams }: Props) {
  const { ws } = await params;
  await meOrLogin();
  const { error, q } = await searchParams;
  const query = q?.trim();
  const [apps, tools] = await Promise.all([
    hub<MyAppView[]>('/me/apps').catch(() => [] as MyAppView[]),
    hub<MyTools>(`/me/tools${query ? `?q=${encodeURIComponent(query)}` : ''}`).catch(() => undefined),
  ]);
  // Apps to connect: the search's results, or the popular ones; not ones already on your list.
  const toAdd = ((query ? tools?.results : tools?.popular) ?? []).filter((t) => !apps.some((a) => a.toolkit === t.slug));

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <Link href={wsHref(ws)} scroll={false} aria-label="Close, back to the canvas" className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
          <Icon name="close" size={22} />
        </Link>
        <div className="mx-auto max-w-2xl space-y-8">
      <PageHeader title="Apps" sub="Your connected apps. Open one to see which agents use it, how, and to give another agent access." />
      <ErrorNote error={error} />
          <CreditsPaused what="App actions are" />

      {apps.length === 0 ? (
        <p className="card text-sm text-[var(--muted)]">No apps connected yet. Connect one below, then give your agents access.</p>
      ) : (
        <ul className="card divide-y divide-[var(--border)] p-0">
          {apps.map((app) => {
            const users = app.agents.filter((a) => a.enabled);
            const uses = app.agents.reduce((n, a) => n + (a.use?.uses ?? 0), 0);
            const last = app.agents.map((a) => a.use?.lastAt ?? '').sort().pop();
            const connected = app.account.status === 'ACTIVE';
            return (
              <li key={app.toolkit} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--subtle)]">
                <Link href={appsHref(ws, app.toolkit)} className="flex min-w-0 flex-1 items-center gap-3">
                  {app.logo ? (
                    <img src={app.logo} alt="" className="size-8 rounded-md" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--subtle)] text-xs font-bold uppercase">{app.name.slice(0, 1)}</span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{app.name}</span>
                    <span className="block text-xs text-[var(--muted)]">
                      {connected ? 'Connected' : 'Not connected'}
                      {` · ${plural(users.length, 'agent', 'agents')}`}
                      {uses > 0 && ` · used ${plural(uses, 'time', 'times')}, last ${ago(last)}`}
                    </span>
                  </span>
                </Link>
                {!connected ? (
                  // ponytail: installUrl is only set when ACTIVE (Manage on GitHub); Connect mints OAuth state
                  <form action={reconnectApp.bind(null, ws, app.toolkit)} className="shrink-0">
                    <PendingButton className="btn min-h-8 px-2.5 text-xs">Connect</PendingButton>
                  </form>
                ) : (
                  <Link href={appsHref(ws, app.toolkit)} aria-hidden className="text-[var(--muted)]">
                    ›
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {tools?.available && (
        <section id="connect" className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">Connect an app</h2>
            {tools.searchable && <span className="text-xs text-[var(--muted)]">1,000+ apps</span>}
          </div>
          {tools.searchable && (
            <AppSearch param="q" placeholder="Search apps: Slack, Notion, Linear…" />
          )}
          {query && toAdd.length === 0 && <p className="text-sm text-[var(--muted)]">No app matches &ldquo;{q}&rdquo;.</p>}
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {toAdd.slice(0, 12).map((t) => (
              <li key={t.slug} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[var(--border)] p-2.5">
                {t.logo ? <img src={t.logo} alt="" className="size-7 rounded-md" loading="lazy" referrerPolicy="no-referrer" /> : <span className="size-7 rounded-md bg-[var(--subtle)]" />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  {t.description && <span className="truncate text-xs text-[var(--muted)]">{t.description}</span>}
                </span>
                {t.connectable ? (
                  <form action={reconnectApp.bind(null, ws, t.slug)} className="shrink-0">
                    <PendingButton className="btn min-h-8 px-2.5 text-xs" title={t.keyed ? `Opens Composio's page, where you paste your ${t.name} key. It's kept there, never in Parly.` : undefined}>
                      {t.keyed ? 'Add key' : 'Connect'}
                    </PendingButton>
                  </form>
                ) : (
                  <span className="shrink-0 text-xs text-[var(--muted)]" title="It needs Parly's own app at that service (OAuth), which isn't set up yet">
                    needs setup
                  </span>
                )}
              </li>
            ))}
          </ul>
          {query && (
            <Link href={`${appsHref(ws)}#connect`} className="text-sm text-[var(--accent)] hover:underline">
              ← Popular apps
            </Link>
          )}
        </section>
      )}

      <p className="text-xs text-[var(--muted)]">
        Each agent&apos;s own apps are also on the canvas: 🔌 on its card. See also <Link href={triggersHref(ws)} className="underline">Triggers</Link> and <Link href={skillsHref(ws)} className="underline">Skills &amp; Processes</Link>.
      </p>
        </div>
      </div>
    </main>
  );
}
