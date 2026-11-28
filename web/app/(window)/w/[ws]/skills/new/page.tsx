import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { PendingButton } from '@/components/PendingButton';
import { ProcessStepsEditor } from '@/components/ProcessStepsEditor';
import { ErrorNote, PageHeader } from '@/components/ui';
import { PanelPage } from '@/components/PanelPage';
import { createSkillAction } from '@/lib/actions';
import { hub, meOrLogin, type Agent, type SkillScope, type SkillSummaryView, type SkillType } from '@/lib/hub';
import { agentHref, channelHref, skillsHref } from '@/lib/routes';

type Props = {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ error?: string; type?: string; scope?: string; scopeId?: string }>;
};

const SKILL_STARTER_TEMPLATE = `## When to use
Explain the trigger or situation when the agent should use this skill.

## Prerequisites
- Required tools, context, or inputs before starting

## Steps
1. Inspect the relevant context first.
2. Execute the core change or action cleanly.
3. Verify the outcome with a concrete check.

## Quality checks
- Confirm nothing regressed and summarize what was verified.`;

export default async function NewSkillPage({ params, searchParams }: Props) {
  const { ws } = await params;
  const [{ error, type: rawType, scope: rawScope, scopeId }, user, allSkills, scopeAgent] = await Promise.all([
    searchParams,
    meOrLogin(),
    hub<SkillSummaryView[]>('/me/skills?type=skill').catch(() => [] as SkillSummaryView[]),
    // The agent a skill is for (?scope=agent), asked for alongside the rest.
    searchParams.then(({ scope, scopeId }) =>
      scope === 'agent' && scopeId?.trim() ? hub<Agent>(`/agents/${encodeURIComponent(scopeId.trim())}`).catch(() => undefined) : undefined,
    ),
  ]);

  const type: SkillType = rawType === 'process' ? 'process' : 'skill';
  const workspace = user.workspaces.find((w) => w.id === ws);
  const canManageWorkspace = Boolean(workspace?.owner);

  const validScope: SkillScope | undefined =
    rawScope === 'agent' || rawScope === 'channel' || rawScope === 'workspace' ? rawScope : undefined;
  const targetId = scopeId?.trim() || undefined;

  let targetLabel: string | undefined;
  let returnTo: string | undefined;
  if (validScope === 'agent' && targetId) {
    targetLabel = scopeAgent ? `agent ${scopeAgent.name}` : 'this agent';
    returnTo = `${agentHref(ws, targetId)}#skills`;
  } else if (validScope === 'channel' && targetId) {
    const ch = user.workspaces.flatMap((w) => w.channels ?? []).find((c) => c.id === targetId);
    targetLabel = ch ? `#${ch.name}` : 'this channel';
    returnTo = channelHref(ws, targetId, { panel: 'channel' });
  }

  const switchTypeHref = (nextType: SkillType) =>
    skillsHref(ws, 'new', {
      type: nextType,
      ...(validScope ? { scope: validScope } : {}),
      ...(targetId ? { scopeId: targetId } : {}),
    });

  return (
    <PanelPage ws={ws}>
        <div className="mx-auto max-w-2xl space-y-6">
          <Link href={returnTo ?? skillsHref(ws)} title="Back to Skills & Processes" aria-label="Back to Skills & Processes" className="-ml-2 inline-flex size-9 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
            <Icon name="back" size={18} />
          </Link>
          <PageHeader title={type === 'process' ? 'New process' : 'New skill'} sub="Create it once in your library, then attach it to any agent, channel, or workspace." />
          <ErrorNote error={error} />
          <section className="card space-y-3">
            <div className="space-y-1.5">
              <span className="text-xs font-semibold tracking-wider text-[var(--muted)] uppercase">1. Choose type</span>
              <div role="radiogroup" aria-label="Playbook type" className="grid grid-cols-2 gap-2.5">
                <Link href={switchTypeHref('skill')} role="radio" aria-checked={type === 'skill'} className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors ${type === 'skill' ? 'border-teal-500 bg-teal-500/10 text-teal-800 dark:text-teal-200' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--subtle)]'}`}>
                  <span className="text-sm font-semibold">📘 Skill</span>
                  <span className="text-xs text-[var(--muted)]">Instructions for one agent (Markdown)</span>
                </Link>
                <Link href={switchTypeHref('process')} role="radio" aria-checked={type === 'process'} className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors ${type === 'process' ? 'border-amber-500 bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--subtle)]'}`}>
                  <span className="text-sm font-semibold">🔀 Process</span>
                  <span className="text-xs text-[var(--muted)]">Step-by-step workflow for a channel/team (Roles, outputs &amp; gates)</span>
                </Link>
              </div>
            </div>
            <p className="rounded-lg bg-[var(--subtle)] px-3 py-2 text-xs text-[var(--muted)]">
              💡 <strong>Tip:</strong> ask any agent in chat to draft this with <code>{type === 'process' ? 'process-writer' : 'skill-writer'}</code>.
            </p>
          </section>
          <form action={createSkillAction.bind(null, ws)} className="card space-y-4">
            <input type="hidden" name="type" value={type} />
            {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
            <label className="block space-y-1">
              <span className="text-sm font-medium">Name</span>
              <input name="name" required maxLength={120} placeholder={type === 'process' ? 'e.g. feature-dev, release-checklist' : 'e.g. pr-reviewer, changelog-writer'} className="input w-full" />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Use this when… (one-line description)</span>
              <input
                name="description"
                required
                maxLength={300}
                placeholder={type === 'process' ? 'e.g. Use when shipping a feature in #dev — roles, handoffs, and deploy verification.' : 'e.g. Use when reviewing a pull request against the real diff and security checklist.'}
                className="input w-full"
              />
              <span className="block text-xs text-[var(--muted)]">
                Agents see this summary in every message so they know when to load the full {type}.
              </span>
            </label>
            {type === 'process' ? (
              <ProcessStepsEditor availableSkills={allSkills.map((s) => ({ id: s.id, name: s.name }))} />
            ) : (
              <label className="block space-y-1">
                <span className="text-sm font-medium">Instructions (Markdown)</span>
                <textarea name="instructions" required rows={12} defaultValue={SKILL_STARTER_TEMPLATE} className="input w-full font-mono text-[13px] leading-relaxed" />
              </label>
            )}
            <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
              {validScope && targetId && targetLabel && (
                <label className="flex items-center gap-2.5 text-sm">
                  <input type="checkbox" name="targetScope" value={validScope} defaultChecked className="size-4" />
                  <input type="hidden" name="targetId" value={targetId} />
                  <span>Attach immediately to <strong>{targetLabel}</strong></span>
                </label>
              )}
              {canManageWorkspace && validScope && validScope !== 'workspace' ? (
                <label className="flex items-center gap-2.5 text-sm">
                  <input type="checkbox" name="attachWorkspace" className="size-4" />
                  <span>Also apply to entire workspace (<strong>{workspace?.name ?? 'this workspace'}</strong>)</span>
                </label>
              ) : (
                !validScope && <p className="text-xs text-[var(--muted)]">Shared with everyone in <strong>{workspace?.name ?? 'this workspace'}</strong>; any member can edit it.</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <PendingButton className="btn-primary">Create {type === 'process' ? 'process' : 'skill'}</PendingButton>
              <Link href={returnTo ?? skillsHref(ws)} className="btn-ghost">Cancel</Link>
            </div>
          </form>
        </div>
    </PanelPage>
  );
}
