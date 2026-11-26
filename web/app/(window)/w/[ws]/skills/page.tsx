import Link from 'next/link';
import { AppSearch } from '@/components/AppSearch';
import { PendingButton } from '@/components/PendingButton';
import { ErrorNote, PageHeader } from '@/components/ui';
import { PanelPage } from '@/components/PanelPage';
import { deleteSkillAction, setScopeSkillOn } from '@/lib/actions';
import { hub, meOrLogin, type ScopedSkillView, type SkillSummaryView } from '@/lib/hub';
import { appsHref, skillsHref, triggersHref } from '@/lib/routes';
import { plural } from '@/lib/plural';

type Props = {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ error?: string; type?: string; q?: string }>;
};

function formatWhereUsed(s: SkillSummaryView, wsEnabled: boolean): string {
  const parts: string[] = [];
  if (wsEnabled) parts.push('entire workspace');
  else if (s.whereUsed.counts.workspaces > 0) parts.push(plural(s.whereUsed.counts.workspaces, 'workspace', 'workspaces'));
  if (s.whereUsed.counts.agents > 0) parts.push(plural(s.whereUsed.counts.agents, 'agent', 'agents'));
  if (s.whereUsed.counts.channels > 0) parts.push(plural(s.whereUsed.counts.channels, 'channel', 'channels'));
  if (parts.length > 0) return parts.join(' · ');
  if (s.builtin || s.id.startsWith('builtin:')) return 'Built-in · available everywhere by default';
  return 'Not attached yet';
}

export default async function SkillsLibraryPage({ params, searchParams }: Props) {
  const { ws } = await params;
  const [{ error, type: filterType, q }, user, allSkills, wsEffective] = await Promise.all([
    searchParams,
    meOrLogin(),
    hub<SkillSummaryView[]>('/me/skills').catch(() => [] as SkillSummaryView[]),
    hub<ScopedSkillView[]>(`/workspaces/${encodeURIComponent(ws)}/skills`).catch(() => [] as ScopedSkillView[]),
  ]);

  const workspace = user.workspaces.find((w) => w.id === ws);
  const canManageWorkspace = Boolean(workspace?.owner);
  const wsEnabledIds = new Set(wsEffective.filter((x) => x.enabled && (x.source === 'direct' || x.source === 'builtin')).map((x) => x.skill.id));

  const activeFilter: 'all' | 'skill' | 'process' =
    filterType === 'skill' ? 'skill' : filterType === 'process' ? 'process' : 'all';
  const query = q?.trim().toLowerCase();

  // Only this workspace's skills (attached here, directly or via one of its channels) plus built-ins.
  const wsSkillIds = new Set(wsEffective.map((x) => x.skill.id));
  const inWorkspace = allSkills.filter(
    (s) =>
      s.builtin ||
      wsSkillIds.has(s.id) ||
      s.whereUsed.workspaces.some((w) => w.id === ws) ||
      s.whereUsed.channels.some((c) => c.workspaceId === ws),
  );
  const searched = query
    ? inWorkspace.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(query))
    : inWorkspace;

  const skillsCount = searched.filter((s) => s.type === 'skill').length;
  const processesCount = searched.filter((s) => s.type === 'process').length;

  const filtered = searched.filter((s) => (activeFilter === 'all' ? true : s.type === activeFilter));
  const sorted = [
    ...filtered.filter((s) => !s.id.startsWith('builtin:')),
    ...filtered.filter((s) => s.id.startsWith('builtin:')),
  ];

  const filterHref = (t: 'all' | 'skill' | 'process') =>
    skillsHref(ws, undefined, {
      ...(t === 'all' ? {} : { type: t }),
      ...(q ? { q } : {}),
    });

  const pillClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      active
        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-ink)]'
        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]'
    }`;

  return (
    <PanelPage ws={ws}>
        <div className="mx-auto max-w-2xl space-y-6">
          <PageHeader title="Skills & Processes" sub="Create reusable playbooks once and attach them plug-and-play to any agent, channel, or your whole workspace.">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={skillsHref(ws, 'new', { type: 'skill' })} className="btn-primary min-h-9 px-3 text-sm">+ New skill</Link>
              <Link href={skillsHref(ws, 'new', { type: 'process' })} className="btn min-h-9 px-3 text-sm">+ New process</Link>
            </div>
          </PageHeader>
          <ErrorNote error={error} />
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-xl border border-teal-500/25 bg-teal-500/5 px-3.5 py-2.5 text-xs">
              <span className="font-semibold text-teal-700 dark:text-teal-300">📘 Skill</span>
              <span className="text-[var(--muted)]"> — Instructions for one agent (Markdown playbook).</span>
            </div>
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3.5 py-2.5 text-xs">
              <span className="font-semibold text-amber-700 dark:text-amber-300">🔀 Process</span>
              <span className="text-[var(--muted)]"> — Team workflow across roles in a channel (steps, outputs &amp; gates).</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Filter library" className="flex flex-wrap items-center gap-1.5">
              <Link href={filterHref('all')} className={pillClass(activeFilter === 'all')}>All ({searched.length})</Link>
              <Link href={filterHref('skill')} className={pillClass(activeFilter === 'skill')}>📘 Skills ({skillsCount})</Link>
              <Link href={filterHref('process')} className={pillClass(activeFilter === 'process')}>🔀 Processes ({processesCount})</Link>
            </nav>
            <div className="w-full sm:w-64">
              <AppSearch param="q" placeholder="Search skills & processes…" label="Search skills and processes" />
            </div>
          </div>
          {sorted.length === 0 ? (
            <div className="card space-y-3 text-center">
              <p className="text-sm text-[var(--muted)]">
                {query
                  ? `No skills or processes match “${q}”.`
                  : activeFilter === 'process'
                    ? 'No team processes yet. Create one once and attach it to any channel.'
                    : 'No skills found.'}
              </p>
              <div className="flex justify-center gap-2">
                <Link href={skillsHref(ws, 'new', { type: activeFilter === 'process' ? 'process' : 'skill' })} className="btn-primary min-h-9 px-3 text-sm">
                  + Create {activeFilter === 'process' ? 'a process' : 'a skill'}
                </Link>
              </div>
            </div>
          ) : (
            <ul className="space-y-3">
              {sorted.map((s) => {
                const isBuiltin = Boolean(s.builtin || s.id.startsWith('builtin:'));
                const isProcess = s.type === 'process';
                const wsEnabled = wsEnabledIds.has(s.id);
                const whereText = formatWhereUsed(s, wsEnabled);
                const currentHref = filterHref(activeFilter);
                const steps = s.steps ?? [];
                const previewSteps = steps.slice(0, 3);
                const moreSteps = steps.length > 3 ? steps.length - 3 : 0;

                return (
                  <li key={s.id} className="card space-y-2.5 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <Link href={skillsHref(ws, s.id)} className="flex min-w-0 flex-1 items-start gap-3">
                        <span aria-hidden className={`mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-base ${isProcess ? 'bg-amber-500/15' : 'bg-teal-500/15'}`}>
                          {isProcess ? '🔀' : '📘'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-semibold hover:underline">{s.name}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isProcess ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-teal-500/15 text-teal-700 dark:text-teal-300'}`}>
                              {isProcess ? 'Process' : 'Skill'}
                            </span>
                            {isBuiltin ? (
                              <span className="chip text-[11px]" title="Built-in starter skill (read-only)">🔒 Built-in</span>
                            ) : (
                              s.readOnly && <span className="chip text-[11px]" title="Read-only">🔒 Read-only</span>
                            )}
                          </span>
                          <span className="mt-1 line-clamp-2 block text-[13px] text-[var(--muted)]">{s.description}</span>
                        </span>
                      </Link>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {s.readOnly ? (
                          <Link href={skillsHref(ws, s.id)} className="btn-ghost min-h-8 px-2.5 text-xs">View</Link>
                        ) : (
                          <>
                            <Link href={skillsHref(ws, s.id, { edit: '1' })} className="btn-ghost min-h-8 px-2.5 text-xs">Edit</Link>
                            <form action={deleteSkillAction.bind(null, ws, s.id)}>
                              <PendingButton confirm="Yes, delete" className="btn-ghost min-h-8 px-2.5 text-xs text-[var(--bad-fg)]">Delete</PendingButton>
                            </form>
                          </>
                        )}
                      </div>
                    </div>
                    {isProcess && previewSteps.length > 0 && (
                      <ol className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[var(--bg)] px-3 py-2 text-xs">
                        {previewSteps.map((st, idx) => (
                          <li key={st.order} className="inline-flex items-center gap-1.5">
                            <span className="font-semibold text-amber-700 dark:text-amber-300">{st.order}. {st.role}:</span>
                            <span className="max-w-[200px] truncate text-[var(--muted)]">{st.action}</span>
                            {idx < previewSteps.length - 1 && <span aria-hidden className="text-[var(--muted)]">→</span>}
                          </li>
                        ))}
                        {moreSteps > 0 && (
                          <li className="rounded-full bg-[var(--subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">+{moreSteps} more</li>
                        )}
                      </ol>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-2 text-xs text-[var(--muted)]">
                      <span>{whereText}</span>
                      {canManageWorkspace && !isBuiltin && (
                        <form action={setScopeSkillOn.bind(null, ws, 'workspace', ws, s.id, !wsEnabled, currentHref)}>
                          <PendingButton className="text-xs font-medium text-[var(--accent)] hover:underline">
                            {wsEnabled ? '✓ Applied to workspace (turn off)' : '+ Apply to entire workspace'}
                          </PendingButton>
                        </form>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-[var(--muted)]">
            Attach skills and processes per agent (on its profile) or per channel (in its settings). See also <Link href={appsHref(ws)} className="underline">Apps</Link> and <Link href={triggersHref(ws)} className="underline">Triggers</Link>.
          </p>
        </div>
    </PanelPage>
  );
}
