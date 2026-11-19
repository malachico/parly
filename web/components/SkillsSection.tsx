import Link from 'next/link';
import { PendingButton } from '@/components/PendingButton';
import { ErrorNote } from '@/components/ui';
import { setScopeSkillOn } from '@/lib/actions';
import type { ScopedSkillView, SkillAttachmentSource, SkillSummaryView, SkillType } from '@/lib/hub';
import { skillsHref } from '@/lib/routes';

type UnifiedSkillRow = {
  id: string;
  name: string;
  description: string;
  type: SkillType;
  source?: SkillAttachmentSource;
  enabled: boolean;
  usedCount: number;
};

function sourceBadgeLabel(source: SkillAttachmentSource | undefined, enabled: boolean): string | null {
  if (!source) return null;
  if (source === 'direct') return enabled ? 'Direct' : null;
  if (source === 'builtin') return enabled ? 'Inherited · Built-in' : 'Opted out · Built-in';
  if (source === 'workspace') return enabled ? 'Inherited · Workspace' : 'Opted out · Workspace';
  if (source === 'channel') return enabled ? 'Inherited · Channel' : 'Opted out · Channel';
  return null;
}

/**
 * Plug-and-play Skills & Processes attachment section shared by Agent profiles (Skills-first)
 * and Channel panels (Processes-first).
 */
export function SkillsSection({
  ws,
  scope,
  targetId,
  targetName,
  canManage,
  effectiveSkills,
  librarySkills,
  backHref,
  error,
}: {
  ws: string;
  scope: 'agent' | 'channel';
  targetId: string;
  targetName: string;
  canManage: boolean;
  effectiveSkills: ScopedSkillView[];
  librarySkills: SkillSummaryView[];
  backHref: string;
  error?: string;
}) {
  const byId = new Map<string, UnifiedSkillRow>();
  const libById = new Map(librarySkills.map((s) => [s.id, s]));

  for (const eff of effectiveSkills) {
    const lib = libById.get(eff.skill.id);
    byId.set(eff.skill.id, {
      id: eff.skill.id,
      name: eff.skill.name,
      description: eff.skill.description,
      type: eff.skill.type,
      source: eff.source,
      enabled: eff.enabled,
      usedCount: lib?.whereUsed.counts.total ?? 0,
    });
  }

  if (canManage) {
    for (const lib of librarySkills) {
      if (!byId.has(lib.id)) {
        byId.set(lib.id, {
          id: lib.id,
          name: lib.name,
          description: lib.description,
          type: lib.type,
          source: undefined,
          enabled: false,
          usedCount: lib.whereUsed.counts.total,
        });
      }
    }
  }

  const allRows = [...byId.values()];
  const primaryType: SkillType = scope === 'channel' ? 'process' : 'skill';
  allRows.sort((a, b) => {
    const aPrimary = a.type === primaryType ? 0 : 1;
    const bPrimary = b.type === primaryType ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const aBuiltin = a.id.startsWith('builtin:') ? 1 : 0;
    const bBuiltin = b.id.startsWith('builtin:') ? 1 : 0;
    if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin;
    return a.name.localeCompare(b.name);
  });

  const renderRow = (row: UnifiedSkillRow) => {
    const isProcess = row.type === 'process';
    const isInherited = row.source === 'workspace' || row.source === 'channel' || row.source === 'builtin';
    const badge = sourceBadgeLabel(row.source, row.enabled);

    return (
      <li key={row.id} className={`flex items-start justify-between gap-3 px-3.5 py-2.5 ${row.enabled ? '' : 'opacity-75'}`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span aria-hidden className="text-sm">{isProcess ? '🔀' : '📘'}</span>
            <Link href={skillsHref(ws, row.id)} className="truncate text-sm font-medium hover:underline">
              {row.name}
            </Link>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                isProcess
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  : 'bg-teal-500/15 text-teal-700 dark:text-teal-300'
              }`}
            >
              {isProcess ? 'Process' : 'Skill'}
            </span>
            {badge && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  row.source === 'direct'
                    ? 'bg-[var(--accent-soft)] text-[var(--accent-ink)]'
                    : 'bg-[var(--subtle)] text-[var(--muted)]'
                }`}
              >
                {badge}
              </span>
            )}
            {row.usedCount > 1 && (
              <span className="text-[11px] text-[var(--muted)]">· used in {row.usedCount} places</span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{row.description}</p>
          {isInherited && (
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">
              {row.enabled
                ? `Inherited · flipping off opts ${scope === 'agent' ? 'this agent' : 'this channel'} out`
                : `Opted out on ${scope === 'agent' ? 'this agent' : 'this channel'} · flipping on re-enables it`}
            </p>
          )}
        </div>

        {canManage ? (
          <form action={setScopeSkillOn.bind(null, ws, scope, targetId, row.id, !row.enabled, backHref)} className="shrink-0 pt-0.5">
            <PendingButton
              className={`min-h-8 rounded-full px-3 text-xs font-semibold transition-colors ${
                row.enabled
                  ? 'bg-[var(--accent)] text-white hover:opacity-90'
                  : 'border border-[var(--border)] bg-[var(--bg)] text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]'
              }`}
              title={
                row.enabled
                  ? isInherited
                    ? `Opt ${targetName} out of ${row.name}`
                    : `Detach ${row.name} from ${targetName}`
                  : `Attach ${row.name} to ${targetName}`
              }
            >
              {row.enabled ? 'On' : 'Off'}
            </PendingButton>
          </form>
        ) : (
          <span className="shrink-0 pt-1 text-xs font-medium text-[var(--muted)]">
            {row.enabled ? 'On' : 'Off'}
          </span>
        )}
      </li>
    );
  };

  const processRows = allRows.filter((r) => r.type === 'process');
  const skillRows = allRows.filter((r) => r.type === 'skill');
  const groups =
    scope === 'channel'
      ? [
          { type: 'process' as const, title: '🔀 Processes', empty: 'No processes yet.', rows: processRows },
          { type: 'skill' as const, title: '📘 Skills', empty: 'No skills yet.', rows: skillRows },
        ]
      : [
          { type: 'skill' as const, title: '📘 Skills', empty: 'No skills yet.', rows: skillRows },
          { type: 'process' as const, title: '🔀 Processes', empty: 'No processes yet.', rows: processRows },
        ];

  return (
    <section id="skills" className="card scroll-mt-6 space-y-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">Skills &amp; Processes</h2>
          <p className="muted text-[13px]">
            {scope === 'channel'
              ? `Reusable team workflows (🔀 Processes) and playbooks (📘 Skills) active in ${targetName}.`
              : `Reusable playbooks (📘 Skills) and team workflows (🔀 Processes) ${targetName} can load on demand.`}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={skillsHref(ws, 'new', { type: primaryType, scope, scopeId: targetId })}
              className="btn min-h-8 shrink-0 px-2.5 text-xs"
            >
              + New {primaryType}
            </Link>
            <Link
              href={skillsHref(ws, 'new', { type: primaryType === 'process' ? 'skill' : 'process', scope, scopeId: targetId })}
              className="btn-ghost min-h-8 shrink-0 px-2.5 text-xs"
            >
              + New {primaryType === 'process' ? 'skill' : 'process'}
            </Link>
          </div>
        )}
      </div>

      <ErrorNote error={error} />

      {allRows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-[13px] text-[var(--muted)]">
          No skills or processes in your library yet.
        </p>
      ) : (
        <div className="space-y-3">
          {groups
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <div key={g.type} className="space-y-1.5">
                <h3 className="px-1 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">{g.title}</h3>
                <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
                  {g.rows.map(renderRow)}
                </ul>
              </div>
            ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-[var(--muted)]">
          Create once in the library, reuse across agents and channels.
        </span>
        <Link href={skillsHref(ws)} className="font-medium text-[var(--accent)] hover:underline">
          Manage in Library →
        </Link>
      </div>
    </section>
  );
}
