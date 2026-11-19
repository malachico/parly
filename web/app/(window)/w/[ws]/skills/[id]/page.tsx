import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { PendingButton } from '@/components/PendingButton';
import { ProcessStepsEditor } from '@/components/ProcessStepsEditor';
import { Markdown } from '@/components/Thread';
import { ErrorNote, PageHeader } from '@/components/ui';
import { attachSkillFromLibrary, deleteSkillAction, setScopeSkillOn, updateSkillAction } from '@/lib/actions';
import { hub, HubError, meOrLogin, type Agent, type ScopedSkillView, type SkillDetailView, type SkillSummaryView } from '@/lib/hub';
import { agentHref, channelHref, skillsHref, wsHref } from '@/lib/routes';

type Props = {
  params: Promise<{ ws: string; id: string }>;
  searchParams: Promise<{ error?: string; edit?: string }>;
};

export default async function SkillDetailPage({ params, searchParams }: Props) {
  const { ws, id } = await params;
  const user = await meOrLogin();
  const [{ error, edit }, skill, allSkills, wsEffective, bots] = await Promise.all([
    searchParams,
    hub<SkillDetailView>(`/me/skills/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof HubError && (err.status === 404 || err.status === 403)) return undefined;
      throw err;
    }),
    hub<SkillSummaryView[]>('/me/skills?type=skill').catch(() => [] as SkillSummaryView[]),
    hub<ScopedSkillView[]>(`/workspaces/${encodeURIComponent(ws)}/skills`).catch(() => [] as ScopedSkillView[]),
    hub<Agent[]>('/agents/bots').catch(() => [] as Agent[]),
  ]);

  if (!skill) notFound();

  const workspace = user.workspaces.find((w) => w.id === ws);
  const canManageWorkspace = Boolean(workspace?.owner);
  const isBuiltin = Boolean(skill.builtin || skill.id.startsWith('builtin:'));
  const wsEntry = wsEffective.find((x) => x.skill.id === skill.id);
  const wsEnabled = Boolean(wsEntry?.enabled && (wsEntry.source === 'direct' || wsEntry.source === 'builtin'));

  const attachedAgentIds = new Set(skill.whereUsed.agents.map((a) => a.id));
  const attachedChannelIds = new Set(skill.whereUsed.channels.map((c) => c.id));

  const myAttachableAgents = bots.filter((b) => !b.archived && !b.webhookChannel && b.ownerId === user.id && !attachedAgentIds.has(b.id));
  const myAttachableChannels = (workspace?.channels ?? []).filter((c) => !c.archived && c.owner && !attachedChannelIds.has(c.id));

  const selfHref = skillsHref(ws, skill.id);

  const isProcess = skill.type === 'process';

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <Link
          href={wsHref(ws)}
          scroll={false}
          aria-label="Close, back to the canvas"
          className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden"
        >
          <Icon name="close" size={22} />
        </Link>
        <div className="mx-auto max-w-2xl space-y-6">
          <Link
            href={skillsHref(ws)}
            title="All skills & processes"
            aria-label="All skills & processes"
            className="-ml-2 inline-flex size-9 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]"
          >
            <Icon name="back" size={18} />
          </Link>

          <PageHeader
            title={
              <span className="flex flex-wrap items-center gap-2.5">
                <span aria-hidden>{isProcess ? '🔀' : '📘'}</span>
                <span>{skill.name}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    isProcess
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                      : 'bg-teal-500/15 text-teal-700 dark:text-teal-300'
                  }`}
                >
                  {isProcess ? 'Process' : 'Skill'}
                </span>
                {isBuiltin ? (
                  <span className="chip text-xs font-normal">🔒 Built-in · read-only</span>
                ) : (
                  skill.readOnly && <span className="chip text-xs font-normal">🔒 Read-only</span>
                )}
              </span>
            }
            sub={skill.description}
          />

          <ErrorNote error={error} />

          <section className="card space-y-3">
            <h2 className="font-medium">{isProcess ? 'Workflow steps' : 'Instructions'}</h2>
            {isProcess ? (
              (skill.steps ?? []).length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No steps defined.</p>
              ) : (
                <ol className="space-y-2.5">
                  {(skill.steps ?? []).map((st) => (
                    <li key={st.order} className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">
                          {st.order}. <span className="text-amber-700 dark:text-amber-300">{st.role}</span>
                        </span>
                        {st.skillId && (
                          <Link
                            href={skillsHref(ws, st.skillId)}
                            className="inline-flex items-center gap-1 rounded-full bg-teal-500/15 px-2.5 py-0.5 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
                          >
                            📘 {st.skillName ?? st.skillId}
                          </Link>
                        )}
                      </div>
                      <p className="mt-1 text-[13px]">{st.action}</p>
                      <div className="mt-2 grid gap-1.5 border-t border-[var(--border)] pt-2 text-xs text-[var(--muted)] sm:grid-cols-2">
                        <div>
                          <span className="font-medium text-[var(--fg)]">Output:</span> {st.output}
                        </div>
                        <div>
                          <span className="font-medium text-[var(--fg)]">Gate:</span> {st.transition}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )
            ) : (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-sm">
                <Markdown text={skill.instructions ?? ''} />
              </div>
            )}
          </section>

          <section id="where-used" className="card space-y-4">
            <div>
              <h2 className="font-medium">Where is this used?</h2>
              <p className="text-xs text-[var(--muted)]">
                Attach once to an entire workspace, specific channels, or individual agents. Changes to this {skill.type} update everywhere it&apos;s attached.
              </p>
            </div>
            {workspace && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    Entire workspace: <span className="font-semibold">{workspace.name}</span>
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    {wsEnabled ? `Enabled across ${workspace.name} (${wsEntry?.source === 'builtin' ? 'built-in default' : 'workspace-wide'}).` : 'Off at the workspace level — only attached channels and agents below receive it.'}
                  </p>
                </div>
                {canManageWorkspace && (
                  <form action={setScopeSkillOn.bind(null, ws, 'workspace', ws, skill.id, !wsEnabled, selfHref)}>
                    <PendingButton className={wsEnabled ? 'btn-ghost min-h-8 px-3 text-xs' : 'btn min-h-8 px-3 text-xs'}>
                      {wsEnabled ? 'Turn off for workspace' : 'Apply to entire workspace'}
                    </PendingButton>
                  </form>
                )}
              </div>
            )}
            <div className="space-y-2">
              <h3 className="label">Channels ({skill.whereUsed.channels.length})</h3>
              {skill.whereUsed.channels.length === 0 ? (
                <p className="text-xs text-[var(--muted)]">Not directly attached to any channels yet.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                  {skill.whereUsed.channels.map((ch) => (
                    <li key={ch.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <Link href={channelHref(ch.workspaceId || ws, ch.id, { panel: 'channel' })} className="font-medium hover:underline">#{ch.name}</Link>
                      <form action={setScopeSkillOn.bind(null, ws, 'channel', ch.id, skill.id, false, selfHref)}>
                        <PendingButton className="btn-ghost min-h-7 px-2 text-xs text-[var(--muted)]">Detach</PendingButton>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              {myAttachableChannels.length > 0 && (
                <form action={attachSkillFromLibrary.bind(null, ws, skill.id, 'channel')} className="flex gap-2">
                  <select name="targetId" required defaultValue="" className="input min-w-0 flex-1 py-1.5 text-sm">
                    <option value="" disabled>+ Attach to a channel in {workspace?.name ?? 'workspace'}…</option>
                    {myAttachableChannels.map((c) => (
                      <option key={c.id} value={c.id}>#{c.name}</option>
                    ))}
                  </select>
                  <PendingButton className="btn shrink-0 text-xs">Attach</PendingButton>
                </form>
              )}
            </div>
            <div className="space-y-2">
              <h3 className="label">Agents ({skill.whereUsed.agents.length})</h3>
              {skill.whereUsed.agents.length === 0 ? (
                <p className="text-xs text-[var(--muted)]">Not directly attached to any agents yet.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                  {skill.whereUsed.agents.map((ag) => (
                    <li key={ag.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <Link href={agentHref(ws, ag.id)} className="font-medium hover:underline">{ag.name}</Link>
                      <form action={setScopeSkillOn.bind(null, ws, 'agent', ag.id, skill.id, false, selfHref)}>
                        <PendingButton className="btn-ghost min-h-7 px-2 text-xs text-[var(--muted)]">Detach</PendingButton>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              {myAttachableAgents.length > 0 && (
                <form action={attachSkillFromLibrary.bind(null, ws, skill.id, 'agent')} className="flex gap-2">
                  <select name="targetId" required defaultValue="" className="input min-w-0 flex-1 py-1.5 text-sm">
                    <option value="" disabled>+ Attach to one of your agents…</option>
                    {myAttachableAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  <PendingButton className="btn shrink-0 text-xs">Attach</PendingButton>
                </form>
              )}
            </div>
          </section>
          {!skill.readOnly && (
            <details className="card group" open={Boolean(error || edit)}>
              <summary className="cursor-pointer font-medium">
                Edit {isProcess ? 'process' : 'skill'}
              </summary>
              <form action={updateSkillAction.bind(null, ws, skill.id, skill.type)} className="mt-4 space-y-4">
                <div className="flex items-center justify-between rounded-lg bg-[var(--subtle)] px-3 py-2 text-xs text-[var(--muted)]">
                  <span>
                    Type: <strong className="text-[var(--fg)]">{isProcess ? '🔀 Process' : '📘 Skill'}</strong> (locked after creation)
                  </span>
                </div>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Name</span>
                  <input name="name" required maxLength={120} defaultValue={skill.name} className="input w-full" />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Use this when… (one-line description)</span>
                  <input name="description" required maxLength={300} defaultValue={skill.description} className="input w-full" />
                </label>
                {isProcess ? (
                  <ProcessStepsEditor
                    initialSteps={skill.steps}
                    availableSkills={allSkills.filter((s) => s.id !== skill.id).map((s) => ({ id: s.id, name: s.name }))}
                  />
                ) : (
                  <label className="block space-y-1">
                    <span className="text-sm font-medium">Instructions (Markdown)</span>
                    <textarea name="instructions" required rows={12} defaultValue={skill.instructions ?? ''} className="input w-full font-mono text-[13px] leading-relaxed" />
                  </label>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <PendingButton className="btn-primary">Save changes</PendingButton>
                </div>
              </form>
              <div className="mt-6 flex items-center justify-between border-t border-[var(--border)] pt-4">
                <span className="text-xs text-[var(--muted)]">
                  Deleting removes this {skill.type} from the library and detaches it from all agents, channels, and workspaces.
                </span>
                <form action={deleteSkillAction.bind(null, ws, skill.id)}>
                  <PendingButton confirm="Yes, delete" className="btn-ghost text-xs text-[var(--bad-fg)]">Delete {skill.type}</PendingButton>
                </form>
              </div>
            </details>
          )}
        </div>
      </div>
    </main>
  );
}
