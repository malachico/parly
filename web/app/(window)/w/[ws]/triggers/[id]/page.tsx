import Link from 'next/link';
import { CreditsPaused } from '@/components/CreditsPaused';
import { Icon } from '@/components/Icon';
import { triggersHref } from '@/lib/routes';
import { AppSearch } from '@/components/AppSearch';
import { notFound } from 'next/navigation';
import { Avatar } from '@/components/Avatar';
import { PendingButton } from '@/components/PendingButton';
import { ErrorNote, PageHeader } from '@/components/ui';
import { ListenerFormFields } from '@/components/WherePicker';
import { PanelPage } from '@/components/PanelPage';
import { addTriggerListener, setListenerOn, setTriggerOn } from '@/lib/actions';
import { hub, meOrLogin, type Agent, type TriggerSourceView } from '@/lib/hub';
import { ago, triggerWhat } from '@/lib/labels';
import { plural } from '@/lib/plural';

type Props = { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ error?: string; q?: string }> };

/**
 * One trigger: who listens to it (an agent's DM, a channel, or both) and what became of each event, turning
 * listeners and the trigger on / off, and adding a listener. Agents are found by search, not listed.
 */
export default async function TriggerPage({ params, searchParams }: Props) {
  const { ws, id } = await params;
  const user = await meOrLogin();
  const [{ error, q }, bots, triggers] = await Promise.all([
    searchParams,
    hub<Agent[]>('/agents/bots').catch(() => [] as Agent[]),
    hub<TriggerSourceView[]>('/me/triggers').catch(() => [] as TriggerSourceView[]),
  ]);
  const t = triggers.find((x) => x.id === id);
  if (!t) notFound();

  const agents = bots.filter((b) => !b.archived && !b.webhookChannel);
  const agentNames = new Map(agents.map((g) => [g.id, g.name] as const));
  const channels = user.workspaces.flatMap((w) => (w.channels ?? []).filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, ws: w.name })));
  const channelName = (cid: string) => channels.find((c) => c.id === cid)?.name ?? 'a channel';
  const query = q?.trim().toLowerCase();
  // ponytail: matches by name in the page; a hub-side search when people have thousands of agents.
  const matches = query ? agents.filter((a) => a.name.toLowerCase().includes(query)).slice(0, 8) : [];
  // What became of every event, per listener (newest first).
  const histories = new Map(
    await Promise.all(
      t.listeners.map(
        async (l) =>
          [l.id, await hub<{ at: string; outcome: string; why?: string; to?: string }[]>(`/me/triggers/${encodeURIComponent(t.id)}/listeners/${encodeURIComponent(l.id)}/history`).catch(() => [])] as const,
      ),
    ),
  );

  return (
    <PanelPage ws={ws}>
        <div className="mx-auto max-w-2xl space-y-6">
      <Link href={triggersHref(ws)} title="All triggers" aria-label="All triggers" className="-ml-2 inline-flex size-9 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
            <Icon name="back" size={18} />
          </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span aria-hidden>{t.toolkit === 'gmail' ? '📧' : '⚡'}</span>
            {t.label}
          </span>
        }
        sub={`${triggerWhat(t)} · fired ${plural(t.fired ?? 0, 'time', 'times')}, last ${ago(t.lastFiredAt)}${t.archivedAt ? ' · turned off' : ''}`}
      >
        <form action={setTriggerOn.bind(null, ws, t.id, !!t.archivedAt)}>
          <PendingButton className={`min-h-8 px-2.5 text-xs ${t.archivedAt ? 'btn' : 'btn-ghost text-[var(--bad-fg)]'}`}>{t.archivedAt ? 'Restore' : 'Turn off'}</PendingButton>
        </form>
      </PageHeader>
      <ErrorNote error={error} />
          <CreditsPaused what="This trigger is" />

      <section className="card space-y-3">
        <h2 className="font-medium">Listening</h2>
        {t.listeners.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nobody listens to it. Add a listener below.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
            {t.listeners.map((l) => {
              const who = l.agentId ? agentNames.get(l.agentId) ?? 'An agent' : undefined;
              const where = l.channelId ? `#${channelName(l.channelId)}${who ? `, mentioning ${who}` : ''}` : `${who}'s DM with you`;
              return (
                <li key={l.id} className={`flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm ${l.enabled ? '' : 'opacity-60'}`}>
                  {l.agentId ? <Avatar who={agents.find((g) => g.id === l.agentId) ?? { id: l.agentId, name: who ?? '' }} className="size-7" /> : <span className="grid size-7 place-items-center rounded-full bg-[var(--subtle)] text-xs">#</span>}
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{l.agentId ? who : `#${channelName(l.channelId!)}`}</span>
                    <span className="block text-xs text-[var(--muted)]">
                      {where}
                      {l.filter.from && ` · from “${l.filter.from}”`}
                      {l.filter.subject && ` · subject has “${l.filter.subject}”`}
                      {l.filter.contains && ` · mentions “${l.filter.contains}”`}
                      {l.task && ` · → ${l.task}`}
                      {` · heard ${l.delivered ?? 0}, last ${ago(l.lastDeliveredAt)}`}
                      {!l.enabled && ' · off'}
                    </span>
                  </span>
                  {(histories.get(l.id) ?? []).length > 0 && (
                    <details className="order-last w-full text-xs">
                      <summary className="cursor-pointer text-[var(--accent)]">Recent activity</summary>
                      <ol className="mt-1.5 space-y-1 border-l border-[var(--border)] pl-3">
                        {(histories.get(l.id) ?? []).map((h, i) => (
                          <li key={i} className="flex gap-2">
                            <span className={h.outcome === 'delivered' ? 'text-[var(--ok-fg)]' : 'text-[var(--muted)]'}>
                              {h.outcome === 'delivered' ? '✓ delivered' : h.outcome === 'filtered' ? '– filtered out' : `✗ skipped${h.why ? `: ${h.why}` : ''}`}
                            </span>
                            <span className="text-[var(--muted)]">{ago(h.at)}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {!t.archivedAt && (
                    <form action={setListenerOn.bind(null, ws, t.id, l.id, !l.enabled)}>
                      <PendingButton className="btn-ghost min-h-8 px-2.5 text-xs">{l.enabled ? 'Turn off' : 'Turn on'}</PendingButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!t.archivedAt && (
        <section className="card space-y-4">
          <div>
            <h2 className="font-medium">Add a listener</h2>
            <p className="text-xs text-[var(--muted)]">Who hears about each event, and where. An agent gets it in its DM with you or in a channel; without an agent it&apos;s just posted in a channel.</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">1. Which agent?</p>
            <AppSearch param="q" placeholder="Search your agents by name" label="Search your agents" />
            {query && matches.length === 0 && <p className="text-sm text-[var(--muted)]">No agent matches &ldquo;{q}&rdquo;.</p>}
          </div>
          <form action={addTriggerListener.bind(null, ws, t.id)} className="space-y-4">
            <ListenerFormFields matches={matches} channels={channels} />
            <PendingButton className="btn-primary w-full">Add listener</PendingButton>
          </form>
        </section>
      )}
        </div>
    </PanelPage>
  );
}
