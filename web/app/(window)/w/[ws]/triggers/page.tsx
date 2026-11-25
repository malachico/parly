import Link from 'next/link';
import { CreditsPaused } from '@/components/CreditsPaused';
import { appsHref, skillsHref, triggersHref } from '@/lib/routes';
import { ErrorNote, PageHeader } from '@/components/ui';
import { hub, meOrLogin, type Agent, type Schedule, type TriggerSourceView } from '@/lib/hub';
import { ScheduleList } from '@/components/ScheduleList';
import { PanelPage } from '@/components/PanelPage';
import { ago, triggerWhat } from '@/lib/labels';
import { plural } from '@/lib/plural';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> };

/** Triggers: every trigger of yours, one row each; its page has who listens to it, what they heard, and adding a listener. */
export default async function Triggers({ params, searchParams }: Props) {
  const { ws } = await params;
  const user = await meOrLogin();
  const [{ error }, triggers, schedules, bots] = await Promise.all([
    searchParams,
    hub<TriggerSourceView[]>('/me/triggers').catch(() => [] as TriggerSourceView[]),
    hub<Schedule[]>('/me/schedules').catch(() => [] as Schedule[]),
    hub<Agent[]>('/agents/bots').catch(() => [] as Agent[]),
  ]);
  const channelName = new Map(user.workspaces.flatMap((w) => (w.channels ?? []).map((c) => [c.id, c.name] as const)));
  const where = (s: Schedule) => (s.channelId ? `${s.agentId ? `${bots.find((b) => b.id === s.agentId)?.name ?? 'An agent'} ` : ''}in #${channelName.get(s.channelId) ?? 'a channel'}` : `to ${bots.find((b) => b.id === s.to)?.name ?? 'an agent'}, in your DM`);
  const sorted = [...triggers.filter((t) => !t.archivedAt), ...triggers.filter((t) => t.archivedAt)];

  return (
    <PanelPage ws={ws}>
        <div className="mx-auto max-w-2xl space-y-8">
      <PageHeader title="Triggers" sub="What wakes your agents: things that happen in your apps, and set times. Open one to see who listens to it and what they heard.">
            <Link href={`${triggersHref(ws)}/new`} className="btn-primary min-h-9 px-3 text-sm">
              + Add a trigger
            </Link>
          </PageHeader>
      <ErrorNote error={error} />
          <CreditsPaused what="Triggers are" />

      {schedules.length > 0 && (
        <section className="card space-y-2">
          <h2 className="font-medium">⏰ On a schedule</h2>
          <ScheduleList schedules={schedules} back={triggersHref(ws)} canChange={() => true} byName={where} />
        </section>
      )}
      {triggers.length === 0 && schedules.length > 0 ? null : triggers.length === 0 ? (
        <p className="card text-sm text-[var(--muted)]">No triggers yet. Add one here, from an agent&apos;s ⚡ view, or ask the agent in your DM (&ldquo;tell me about new PRs in acme/web&rdquo;).</p>
      ) : (
        <ul className="card divide-y divide-[var(--border)] p-0">
          {sorted.map((t) => {
            const on = t.listeners.filter((l) => l.enabled).length;
            return (
              <li key={t.id} className={t.archivedAt ? 'opacity-60' : ''}>
                <Link href={triggersHref(ws, t.id)} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--subtle)]">
                  <span aria-hidden className="text-lg">{t.toolkit === 'gmail' ? '📧' : '⚡'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t.label}</span>
                    <span className="block text-xs text-[var(--muted)]">
                      {triggerWhat(t)}
                      {` · ${plural(on, 'listener', 'listeners')} · fired ${plural(t.fired ?? 0, 'time', 'times')}, last ${ago(t.lastFiredAt)}`}
                      {t.archivedAt && ' · turned off'}
                    </span>
                  </span>
                  <span aria-hidden className="text-[var(--muted)]">›</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-[var(--muted)]">
        Each agent&apos;s own triggers are also on the canvas: ⚡ on its card. See also <Link href={appsHref(ws)} className="underline">Apps</Link> and <Link href={skillsHref(ws)} className="underline">Skills &amp; Processes</Link>.
      </p>
        </div>
    </PanelPage>
  );
}
