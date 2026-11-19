import Link from 'next/link';
import { readFlash } from '@/lib/actions/helpers';
import { notFound } from 'next/navigation';
import { CopyButton } from '@/components/CopyButton';
import { Icon } from '@/components/Icon';
import { PendingButton } from '@/components/PendingButton';
import { ErrorNote, PageHeader } from '@/components/ui';
import { addDevAppKey, createDevApp, deleteDevApp, revokeDevAppKey } from '@/lib/actions';
import { hub, meOrLogin, type Me } from '@/lib/hub';
import { ago } from '@/lib/labels';
import { wsHref } from '@/lib/routes';

type DevApp = { id: string; name: string; webhookUrl?: string; createdAt: string; keys: { prefix: string; createdAt: string; revokedAt?: string }[] };
type Props = { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; made?: string }> };

/** A secret shown once, masked, with a copy button. */
function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-start gap-2">
        <pre className="code min-w-0 flex-1 overflow-x-auto whitespace-pre">{`${value.slice(0, value.indexOf('_') + 1)}••••••••${value.slice(-4)}`}</pre>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/** The rooms an app opened, newest first (/me lists oldest first), to open and look into. */
function AppRooms({ rooms }: { rooms: Me['workspaces'] }) {
  if (!rooms.length) return <p className="text-xs text-[var(--muted)]">No rooms yet.</p>;
  return (
    <details open className="text-sm">
      <summary className="cursor-pointer text-xs font-medium">Rooms ({rooms.length})</summary>
      <ul className="mt-1 divide-y divide-[var(--border)]">
        {rooms.map((w) => (
          <li key={w.id}>
            <Link href={wsHref(w.id)} className="flex min-h-11 flex-col justify-center py-1.5 hover:underline">
              <span className="truncate">{w.name}</span>
              <span className="truncate text-xs text-[var(--muted)]">{w.room!.sides.map((s) => s.name).join(' · ')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Developer apps: API keys that let a workspace's own servers use Parly (/v1). Owners only. */
export default async function DeveloperApps({ params, searchParams }: Props) {
  const { ws } = await params;
  const [me, { error, made }] = await Promise.all([meOrLogin(), searchParams]);
  if (!me.workspaces.find((w) => w.id === ws)?.owner) notFound();
  const apps = await hub<DevApp[]>(`/workspaces/${encodeURIComponent(ws)}/apps`);
  let shown: { appId: string; key: string; webhookSecret?: string } | undefined;
  if (made) shown = await readFlash('flash_dev_app');

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <Link href={wsHref(ws)} scroll={false} aria-label="Close, back to the canvas" className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
          <Icon name="close" size={22} />
        </Link>
        <div className="mx-auto max-w-2xl space-y-8">
          <PageHeader title="Developer apps" sub={<>Let your own servers use Parly: open rooms, follow them and get webhooks, with an API key. See <Link href="/docs/apps-api" className="underline">Apps API</Link>.</>} />
          <ErrorNote error={error} />

          {shown && (
            <section role="status" className="card space-y-3 border-[var(--accent)]">
              <p className="font-medium">Store these now: they&apos;re shown only once.</p>
              <Secret label="API key" value={shown.key} />
              {shown.webhookSecret && <Secret label="Webhook secret" value={shown.webhookSecret} />}
            </section>
          )}

          <form action={createDevApp.bind(null, ws)} className="card space-y-3">
            <h2 className="font-medium">New app</h2>
            <label className="block space-y-1 text-sm">
              <span>Name</span>
              <input name="name" required maxLength={80} className="input w-full" placeholder="Talent" />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Webhook URL <span className="text-[var(--muted)]">(optional, https)</span></span>
              <input name="webhookUrl" type="url" pattern="https://.*" className="input w-full" placeholder="https://example.com/api/parly/webhook" />
            </label>
            <PendingButton className="btn-primary">Create app</PendingButton>
          </form>

          {apps.length === 0 ? (
            <p className="card text-sm text-[var(--muted)]">No apps yet.</p>
          ) : (
            <ul className="space-y-4">
              {apps.map((app) => (
                <li key={app.id} id={`app-${app.id}`} className="card scroll-mt-4 space-y-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{app.name}</p>
                      <p className="truncate text-xs text-[var(--muted)]">{app.webhookUrl ?? 'No webhook'} · made {ago(app.createdAt)}</p>
                    </div>
                    <form action={addDevAppKey.bind(null, ws, app.id)}>
                      <PendingButton className="btn min-h-9 px-3 text-sm">New key</PendingButton>
                    </form>
                  </div>
                  <ul className="divide-y divide-[var(--border)] text-sm">
                    {app.keys.map((k) => (
                      <li key={k.prefix} className={`flex items-center gap-2 py-2 ${k.revokedAt ? 'opacity-60' : ''}`}>
                        <code className="min-w-0 flex-1 truncate">{k.prefix}…</code>
                        <span className="text-xs text-[var(--muted)]">{k.revokedAt ? `revoked ${ago(k.revokedAt)}` : `made ${ago(k.createdAt)}`}</span>
                        {!k.revokedAt && (
                          <form action={revokeDevAppKey.bind(null, ws, app.id, k.prefix)}>
                            <PendingButton confirm="Yes, revoke" className="btn-ghost text-xs text-[var(--bad-fg)]">Revoke</PendingButton>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                  <AppRooms rooms={me.workspaces.filter((w) => w.room?.appId === app.id && !w.archived).reverse()} />
                  <details className="text-sm">
                    <summary className="cursor-pointer text-xs text-[var(--bad-fg)]">Delete app</summary>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-[var(--muted)]">This revokes all its keys at once.</span>
                      <form action={deleteDevApp.bind(null, ws, app.id)}>
                        <PendingButton className="btn-ghost text-xs text-[var(--bad-fg)]">Yes, delete {app.name}</PendingButton>
                      </form>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
