import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { appsHref, triggersHref, wsHref } from '@/lib/routes';
import { AppSearch } from '@/components/AppSearch';
import { Avatar } from '@/components/Avatar';
import { cleanTriggerLabel, TriggerFields } from '@/components/ToolsSection';
import { ErrorNote, PageHeader } from '@/components/ui';
import { WherePicker } from '@/components/WherePicker';
import { addScheduleTrigger, addTrigger } from '@/lib/actions';
import { ScheduleForm } from '@/components/ScheduleForm';
import { hub, meOrLogin, type Agent, type TriggerTypeGroup } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string; tq?: string; type?: string; q?: string }> };

/**
 * Add a trigger, in the Triggers panel: pick what to watch (events of your connected apps, searched as you type), its
 * settings, and the agent that hears about it (searched too) and where.
 */
export default async function NewTrigger({ params, searchParams }: Props) {
  const { ws } = await params;
  const { error, tq, type: slug, q } = await searchParams;
  const [user, groups, bots] = await Promise.all([
    meOrLogin(),
    hub<TriggerTypeGroup[]>('/me/trigger-types').catch(() => [] as TriggerTypeGroup[]),
    hub<Agent[]>('/agents/bots').catch(() => [] as Agent[]),
  ]);
  const all = groups.flatMap((g) => g.types.map((t) => ({ ...t, toolkit: g.toolkit, app: g.app })));
  const picked = slug ? all.find((t) => t.slug === slug) : undefined;
  // Not an app's event but a time: "On a schedule" (it needs no app).
  const timed = slug === 'schedule';
  const events = tq?.trim().toLowerCase();
  // ponytail: matches in the page; every connected app's events are already here
  const matches = events ? all.filter((t) => `${t.app} ${t.name} ${t.description}`.toLowerCase().includes(events)).slice(0, 12) : [];
  const agents = bots.filter((b) => !b.archived && !b.webhookChannel);
  const who = q?.trim().toLowerCase();
  const agentMatches = who ? agents.filter((a) => a.name.toLowerCase().includes(who)).slice(0, 8) : [];
  const channels = user.workspaces.flatMap((w) => (w.channels ?? []).filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, ws: w.name })));
  const pick = (s: string) => `${triggersHref(ws)}/new?type=${encodeURIComponent(s)}`;
  const chip = 'rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-xs font-medium hover:border-[var(--accent)]';

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <Link href={wsHref(ws)} scroll={false} aria-label="Close, back to the canvas" className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
          <Icon name="close" size={22} />
        </Link>
        <div className="mx-auto max-w-2xl space-y-6">
          <Link href={triggersHref(ws)} title="All triggers" aria-label="All triggers" className="-ml-2 inline-flex size-9 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
            <Icon name="back" size={18} />
          </Link>
          <PageHeader title="Add a trigger" sub="Something that happens in one of your apps, or a time, and the agent that hears about it." />
          <ErrorNote error={error} />

          {timed ? (
            <section className="card space-y-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[var(--muted)]">1. Watch · a time</p>
                  <p className="font-medium">⏰ On a schedule</p>
                  <p className="text-[13px] text-[var(--muted)]">Wakes an agent at set times (every weekday at 9, every hour…) with what to do.</p>
                </div>
                <Link href={`${triggersHref(ws)}/new`} className="text-sm text-[var(--accent)] hover:underline">
                  Change
                </Link>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">2. Which agent?</p>
                <AppSearch param="q" placeholder="Search your agents by name" label="Search your agents" />
                {who && agentMatches.length === 0 && <p className="text-sm text-[var(--muted)]">No agent matches &ldquo;{q}&rdquo;.</p>}
              </div>
              {agentMatches.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Find the agent above first.</p>
              ) : (
                <ScheduleForm action={addScheduleTrigger.bind(null, ws)} textLabel="4. What should it do each time?" placeholder="e.g. sum up what happened today" submit="Turn on">
                  <fieldset className="space-y-1 text-sm">
                    <legend className="sr-only">Agent</legend>
                    {agentMatches.map((a, i) => (
                      <label key={a.id} className="flex items-center gap-2">
                        <input type="radio" name="agentId" value={a.id} defaultChecked={i === 0} />
                        <Avatar who={a} className="size-6" />
                        {a.name}
                      </label>
                    ))}
                  </fieldset>
                  <WherePicker label="3. Where?" dmLabel="The agent's DM with you" channels={channels} />
                </ScheduleForm>
              )}
            </section>
          ) : groups.length === 0 ? (
            <section className="card space-y-3">
              <Link href={`${triggersHref(ws)}/new?type=schedule`} className={`${chip} inline-block`}>
                ⏰ On a schedule
              </Link>
              <p className="text-sm text-[var(--muted)]">
                Or connect an app (Gmail, GitHub, Calendar, Slack…) in <Link href={appsHref(ws)} className="underline">Apps</Link>, then pick what to watch in it.
              </p>
            </section>
          ) : !picked ? (
            <section className="card space-y-3">
              <h2 className="font-medium">1. What should it watch?</h2>
              <Link href={`${triggersHref(ws)}/new?type=schedule`} className={`${chip} inline-block`}>
                ⏰ On a schedule
              </Link>
              <AppSearch param="tq" placeholder="Search events: new email, pull request, meeting…" label="Search events" />
              {events && matches.length === 0 && <p className="text-sm text-[var(--muted)]">No event matches &ldquo;{tq}&rdquo;.</p>}
              {events ? (
                <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                  {matches.map((t) => (
                    <li key={t.slug}>
                      <Link href={pick(t.slug)} className="block px-3 py-2.5 text-sm hover:bg-[var(--subtle)]">
                        <span className="font-medium">{cleanTriggerLabel(t.name)}</span> <span className="text-xs text-[var(--muted)]">· {t.app}</span>
                        {t.description && <span className="block truncate text-xs text-[var(--muted)]">{t.description}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                groups.map((g) => (
                  <div key={g.toolkit} className="space-y-1.5">
                    <p className="text-xs font-medium text-[var(--muted)]">{g.app}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {g.types.slice(0, 6).map((t) => (
                        <Link key={t.slug} href={pick(t.slug)} className={chip}>
                          {cleanTriggerLabel(t.name)}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </section>
          ) : (
            <section className="card space-y-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[var(--muted)]">1. Watch · {picked.app}</p>
                  <p className="font-medium">{cleanTriggerLabel(picked.name)}</p>
                  {picked.description && <p className="text-[13px] text-[var(--muted)]">{picked.description}</p>}
                </div>
                <Link href={`${triggersHref(ws)}/new`} className="text-sm text-[var(--accent)] hover:underline">
                  Change
                </Link>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">2. Which agent hears about it?</p>
                <AppSearch param="q" placeholder="Search your agents by name" label="Search your agents" />
                {who && agentMatches.length === 0 && <p className="text-sm text-[var(--muted)]">No agent matches &ldquo;{q}&rdquo;.</p>}
              </div>
              <form action={addTrigger.bind(null, ws, picked.slug)} className="space-y-4">
                {agentMatches.length > 0 && (
                  <fieldset className="space-y-1 text-sm">
                    <legend className="sr-only">Agent</legend>
                    {agentMatches.map((a, i) => (
                      <label key={a.id} className="flex items-center gap-2">
                        <input type="radio" name="agentId" value={a.id} defaultChecked={i === 0} />
                        <Avatar who={a} className="size-6" />
                        {a.name}
                      </label>
                    ))}
                  </fieldset>
                )}
                <TriggerFields type={picked} />
                <WherePicker label="3. Where?" dmLabel="The agent's DM with you" channels={channels} />
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    4. Only some events? <span className="font-normal text-[var(--muted)]">(optional)</span>
                  </span>
                  <input name="contains" placeholder="e.g. billing: only events that mention it" className="input w-full" />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">
                    5. What should the agent do? <span className="font-normal text-[var(--muted)]">(optional)</span>
                  </span>
                  <input name="task" placeholder="e.g. summarize the PR and review it" className="input w-full" />
                </label>
                <PendingButton className="btn-primary w-full" disabled={agentMatches.length === 0}>
                  {agentMatches.length ? 'Turn on' : 'Find the agent above first'}
                </PendingButton>
              </form>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
