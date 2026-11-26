import { canManageChannel, isOwner, isSuperAdmin } from '../lib/admin.js';
import { HubError } from '../lib/errors.js';
import {
  applySkillOverrides,
  BUILTIN_SKILLS,
  DEFAULT_WORKSPACE_SKILL_IDS,
  getBuiltinSkill,
  isBuiltinSkillId,
  withDefaultWorkspaceSkills,
} from './defaultSkills.js';
import { validDocId } from './fields.js';
import { isShowcaseGuest, type Registry } from './registry.js';
import { canAccessSkill, isSkillOwner, requireOwnerChannel, requireOwnerWorkspace } from './skills.js';
import {
  isPublicWorkspace,
  type AgentRecord,
  type ChannelRecord,
  type ProcessStep,
  type SkillAttachmentSource,
  type SkillRecord,
  type SkillScope,
  type SkillSummary,
  type SkillType,
  type SkillWhereUsed,
  type SurfacedProcessStep,
  type WorkspaceRecord,
} from './types.js';

const PROCESS_SURFACE_MAX = 1500;

/**
 * Resolves a process's steps for `viewer`: each `step.skillId` is resolved only to its `skillName`
 * (or `"unavailable"` if deleted or inaccessible to `viewer`), NEVER inlining the skill's `instructions`.
 * When `capChars` is given, bounds total inline step text to `capChars`.
 */
export async function resolveProcessSteps(
  registry: Registry,
  viewer: AgentRecord | undefined,
  steps: ProcessStep[] | undefined,
  capChars?: number,
): Promise<{ steps: SurfacedProcessStep[]; truncated: boolean }> {
  if (!steps?.length) return { steps: [], truncated: false };
  const refIds = [...new Set(steps.map((s) => s.skillId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const refRecords = refIds.length ? await skillsById(registry, refIds) : [];
  const accessibleNameById = new Map<string, string>();
  await Promise.all(
    refRecords.map(async (ref) => {
      if ((ref.type ?? 'skill') !== 'skill') return;
      if (viewer && (await canAccessSkill(registry, viewer, ref))) {
        accessibleNameById.set(ref.id, ref.name);
      }
    }),
  );

  const surfaced: SurfacedProcessStep[] = [];
  let usedChars = 0;
  let truncated = false;
  for (const step of steps) {
    const resolvedStep: SurfacedProcessStep = {
      order: step.order,
      role: step.role,
      action: step.action,
      ...(step.output ? { output: step.output } : {}),
      ...(step.transition ? { transition: step.transition } : {}),
      ...(step.skillId
        ? {
            skillId: step.skillId,
            skillName: accessibleNameById.get(step.skillId) ?? 'unavailable',
          }
        : {}),
    };
    const stepChars =
      resolvedStep.role.length +
      resolvedStep.action.length +
      (resolvedStep.output?.length ?? 0) +
      (resolvedStep.transition?.length ?? 0) +
      (resolvedStep.skillName?.length ?? 0);
    if (capChars !== undefined && usedChars + stepChars > capChars) {
      truncated = true;
      if (surfaced.length === 0) {
        let budget = Math.max(0, capChars - resolvedStep.role.length - (resolvedStep.skillName?.length ?? 0));
        const clipToBudget = (s: string | undefined): string | undefined => {
          if (!s || budget <= 0) return undefined;
          if (s.length <= budget) {
            budget -= s.length;
            return s;
          }
          const cut = budget > 1 ? `${s.slice(0, budget - 1)}…` : s.slice(0, budget);
          budget = 0;
          return cut;
        };
        const action = clipToBudget(resolvedStep.action) ?? '';
        const output = clipToBudget(resolvedStep.output);
        const transition = clipToBudget(resolvedStep.transition);
        surfaced.push({
          order: resolvedStep.order,
          role: resolvedStep.role,
          action,
          ...(output ? { output } : {}),
          ...(transition ? { transition } : {}),
          ...(resolvedStep.skillId ? { skillId: resolvedStep.skillId, skillName: resolvedStep.skillName } : {}),
        });
      }
      break;
    }
    usedChars += stepChars;
    surfaced.push(resolvedStep);
  }
  return { steps: surfaced, truncated };
}

/** Batch-loads skills in the order of `ids`, silently skipping missing or deleted skill ids. */
export async function skillsById(registry: Registry, ids: string[]): Promise<SkillRecord[]> {
  const unique = [...new Set(ids)].filter(validDocId);
  if (unique.length === 0) return [];
  const byId = new Map<string, SkillRecord>();
  const storedIds: string[] = [];
  for (const id of unique) {
    const builtin = getBuiltinSkill(id);
    if (builtin) {
      byId.set(id, builtin);
    } else {
      storedIds.push(id);
    }
  }
  if (storedIds.length > 0) {
    const snaps = await registry.skillStore.getSkills(storedIds);
    for (const s of snaps) {
      byId.set(s.id, s);
    }
  }
  return unique.map((id) => byId.get(id)).filter((s): s is SkillRecord => s !== undefined);
}

/** Lists skills/processes attached to a specific scope, or all skills/processes owned by or attached to the caller's scopes. */
export async function listSkills(registry: Registry, caller: AgentRecord, opts: { scope?: SkillScope; id?: string; type?: SkillType } = {}): Promise<SkillRecord[]> {
  const matchType = (s: SkillRecord) => !opts.type || (s.type ?? 'skill') === opts.type;
  if (opts.scope === 'agent') {
    const target = !opts.id || opts.id === 'me' || opts.id === caller.id ? ((await registry.get(caller.id)) ?? caller) : await registry.requireVisible(opts.id, caller);
    const records = applySkillOverrides(await skillsById(registry, target.attachedSkills ?? [])).filter(matchType);
    if (target.id === caller.id || target.ownerId === caller.id || isSuperAdmin(caller)) return records;
    const accessible = await Promise.all(records.map(async (r) => ((await canAccessSkill(registry, caller, r)) ? r : undefined)));
    return accessible.filter((r): r is SkillRecord => r !== undefined);
  }
  if (opts.scope === 'channel') {
    if (!opts.id) throw new HubError('invalid', 'id is required when scope is "channel"');
    const channel = await registry.resolveMemberChannel(caller, opts.id).catch(() => requireOwnerChannel(registry, caller, opts.id!));
    return applySkillOverrides(await skillsById(registry, channel.attachedSkills ?? [])).filter(matchType);
  }
  if (opts.scope === 'workspace') {
    if (!opts.id) throw new HubError('invalid', 'id is required when scope is "workspace"');
    const workspace = await registry.resolveMemberWorkspace(caller, opts.id).catch(() => requireOwnerWorkspace(registry, caller, opts.id!));
    return applySkillOverrides(await skillsById(registry, workspace.attachedSkills ?? [])).filter(matchType);
  }
  const [owned, coOwned, workspaces, channels, freshSelf] = await Promise.all([
    registry.skillStore.listSkillsOwnedBy(caller.id),
    registry.skillStore.listSkillsCoOwnedBy(caller.id),
    registry.workspacesOf(caller),
    registry.channelsOf(caller),
    registry.get(caller.id),
  ]);
  const attachedIds = [
    ...workspaces.flatMap((w) => w.attachedSkills ?? []),
    ...channels.flatMap((c) => c.attachedSkills ?? []),
    ...((freshSelf ?? caller).attachedSkills ?? []),
  ];
  const attached = await skillsById(registry, attachedIds);
  const byId = new Map<string, SkillRecord>();
  for (const s of owned) byId.set(s.id, s);
  for (const s of coOwned) byId.set(s.id, s);
  for (const s of attached) byId.set(s.id, s);
  return applySkillOverrides([...byId.values()]).filter(matchType).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves compact skill summaries and inline process roadmaps attached across `workspace -> channel -> agent`
 * in deterministic order, deduplicating by id and silently skipping missing/deleted records.
 */
export async function resolveAttachedSkills(registry: Registry, opts: {
  agent?: AgentRecord;
  agentId?: string;
  channel?: ChannelRecord | null;
  channelId?: string;
  workspace?: WorkspaceRecord | null;
  workspaceId?: string;
}): Promise<SkillSummary[]> {
  const aId = opts.agentId ?? opts.agent?.id;
  const [agent, channel] = await Promise.all([
    aId ? registry.get(aId).then((a) => a ?? opts.agent) : Promise.resolve(opts.agent),
    opts.channel !== undefined ? Promise.resolve(opts.channel ?? undefined) : opts.channelId ? registry.channelDoc(opts.channelId) : Promise.resolve(undefined),
  ]);
  const wsId = opts.workspace?.id ?? opts.workspaceId ?? channel?.workspaceId;
  const workspace = withDefaultWorkspaceSkills(opts.workspace !== undefined ? (opts.workspace ?? undefined) : wsId ? await registry.workspaceDoc(wsId) : undefined);
  const channelDetached = new Set(channel?.detachedSkills ?? []);
  const agentDetached = new Set(agent?.detachedSkills ?? []);
  const ids = [
    ...(workspace?.attachedSkills ?? []).filter((id) => !channelDetached.has(id) && !agentDetached.has(id)),
    ...(channel?.attachedSkills ?? []).filter((id) => !agentDetached.has(id)),
    ...(agent?.attachedSkills ?? []).filter((id) => !agentDetached.has(id)),
  ];
  if (ids.length === 0) return [];
  const records = applySkillOverrides(await skillsById(registry, ids));
  return Promise.all(
    records.map(async (s): Promise<SkillSummary> => {
      const type: SkillType = s.type ?? 'skill';
      if (type === 'process') {
        const { steps, truncated } = await resolveProcessSteps(registry, agent, s.steps, PROCESS_SURFACE_MAX);
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          type: 'process',
          steps,
          ...(truncated ? { stepsTruncated: true } : {}),
        };
      }
      return { id: s.id, name: s.name, description: s.description, type: 'skill' };
    }),
  );
}

/**
 * Resolves all visible workspaces, channels, and agents for `caller`, used to compute `whereUsed` and `readOnly`
 * without N+1 queries or cross-tenant leaks.
 */
async function callerSkillContext(registry: Registry, caller: AgentRecord) {
  const [workspaces, memberChannels, bots, freshSelf] = await Promise.all([
    registry.workspacesOf(caller),
    registry.channelsOf(caller),
    registry.botsOf(caller),
    registry.get(caller.id),
  ]);
  const self = freshSelf ?? caller;
  const ownedWsIds = new Set(workspaces.filter((w) => !w.room && isOwner(w, self)).map((w) => w.id));
  const fullVisWorkspaces = workspaces.filter((w) => !isPublicWorkspace(w) || isOwner(w, self));
  const [extraChannels, wsMembers, chMembers] = await Promise.all([
    registry.skillStore.listChannelsOfWorkspaces([...ownedWsIds]),
    registry.skillStore.listMembersOfWorkspaces(fullVisWorkspaces.map((w) => w.id)),
    registry.skillStore.listMembersOfChannels(memberChannels.map((c) => c.id)),
  ]);
  const channelMap = new Map<string, ChannelRecord>();
  for (const c of memberChannels) channelMap.set(c.id, c);
  for (const c of extraChannels) {
    if (!c.archived) channelMap.set(c.id, c);
  }
  const agentMap = new Map<string, AgentRecord>();
  agentMap.set(self.id, self);
  for (const b of bots) {
    if (!b.archived) agentMap.set(b.id, b);
  }
  for (const a of [...wsMembers, ...chMembers]) {
    if (!a.archived) agentMap.set(a.id, a);
  }
  return {
    self,
    workspaces,
    channels: [...channelMap.values()],
    agents: [...agentMap.values()],
  };
}

function computeWhereUsedAndReadOnly(
  skill: SkillRecord,
  ctx: Awaited<ReturnType<typeof callerSkillContext>>,
): { readOnly: boolean; whereUsed: SkillWhereUsed } {
  const builtin = Boolean(skill.builtin || isBuiltinSkillId(skill.id));
  const usedWorkspaces = ctx.workspaces
    .filter((w) => (w.attachedSkills ?? []).includes(skill.id))
    .map((w) => ({ id: w.id, name: w.name }));
  const usedChannels = ctx.channels
    .filter((c) => (c.attachedSkills ?? []).includes(skill.id))
    .map((c) => ({ id: c.id, name: c.name, workspaceId: c.workspaceId }));
  const usedAgents = ctx.agents
    .filter((a) => (a.attachedSkills ?? []).includes(skill.id))
    .map((a) => ({ id: a.id, name: a.name }));

  const wsById = new Map(ctx.workspaces.map((w) => [w.id, w]));
  let canEdit = !builtin && (isSkillOwner(skill, ctx.self) || isSuperAdmin(ctx.self));
  if (!builtin && !canEdit) {
    if (skill.scope) {
      if (skill.scope.kind === 'workspace') {
        const w = wsById.get(skill.scope.id);
        if (w && !isShowcaseGuest(w, ctx.self)) canEdit = true; // any member (not a showcase guest) can edit a workspace skill
      } else if (skill.scope.kind === 'channel') {
        const c = ctx.channels.find((ch) => ch.id === skill.scope!.id);
        if (c && canManageChannel(c, wsById.get(c.workspaceId), ctx.self)) canEdit = true;
      } else if (skill.scope.kind === 'agent') {
        const a = ctx.agents.find((ag) => ag.id === skill.scope!.id);
        if (a && (a.id === ctx.self.id || a.ownerId === ctx.self.id)) canEdit = true;
      }
    }
    if (!canEdit) {
      if (ctx.workspaces.some((w) => (w.attachedSkills ?? []).includes(skill.id) && isOwner(w, ctx.self))) canEdit = true;
      else if (ctx.channels.some((c) => (c.attachedSkills ?? []).includes(skill.id) && canManageChannel(c, wsById.get(c.workspaceId), ctx.self))) canEdit = true;
      else if (ctx.agents.some((a) => (a.attachedSkills ?? []).includes(skill.id) && (a.id === ctx.self.id || a.ownerId === ctx.self.id))) canEdit = true;
    }
  }

  return {
    readOnly: builtin || !canEdit,
    whereUsed: {
      agents: usedAgents,
      channels: usedChannels,
      workspaces: usedWorkspaces,
      counts: {
        agents: usedAgents.length,
        channels: usedChannels.length,
        workspaces: usedWorkspaces.length,
        total: usedAgents.length + usedChannels.length + usedWorkspaces.length,
      },
    },
  };
}

/**
 * Lists the caller's Library of skills and processes (`GET /me/skills`), including built-ins, with `readOnly`
 * and `whereUsed` (counts + targets across the caller's visible workspaces, channels, and agents).
 */
export async function mySkillsCatalog(registry: Registry, caller: AgentRecord, opts: { type?: SkillType } = {}) {
  if (opts.type !== undefined && opts.type !== 'skill' && opts.type !== 'process') {
    throw new HubError('invalid', 'type must be "skill" or "process"');
  }
  const [owned, coOwned, ctx] = await Promise.all([
    registry.skillStore.listSkillsOwnedBy(caller.id),
    registry.skillStore.listSkillsCoOwnedBy(caller.id),
    callerSkillContext(registry, caller),
  ]);
  const attachedIds = [
    ...ctx.workspaces.flatMap((w) => w.attachedSkills ?? []),
    ...ctx.channels.flatMap((c) => c.attachedSkills ?? []),
    ...ctx.agents.filter((a) => a.id === ctx.self.id || a.ownerId === ctx.self.id).flatMap((a) => a.attachedSkills ?? []),
  ];
  const attached = await skillsById(registry, attachedIds);
  const byId = new Map<string, SkillRecord>();
  for (const b of BUILTIN_SKILLS) byId.set(b.id, { ...b });
  for (const s of owned) byId.set(s.id, s);
  for (const s of coOwned) byId.set(s.id, s);
  for (const s of attached) byId.set(s.id, s);

  const matchType = (s: SkillRecord) => !opts.type || (s.type ?? 'skill') === opts.type;
  const records = [...byId.values()].filter(matchType).sort((a, b) => a.name.localeCompare(b.name));

  return Promise.all(
    records.map(async (s) => {
      const type: SkillType = s.type ?? 'skill';
      const resolvedSteps = type === 'process' ? (await resolveProcessSteps(registry, ctx.self, s.steps)).steps : undefined;
      const { readOnly, whereUsed } = computeWhereUsedAndReadOnly(s, ctx);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        type,
        ...(s.builtin || isBuiltinSkillId(s.id) ? { builtin: true } : {}),
        readOnly,
        whereUsed,
        ...(type === 'process' ? { steps: resolvedSteps ?? [] } : {}),
        ...(s.instructionsBy ? { instructionsBy: s.instructionsBy } : {}),
        ...(s.instructionsAt ? { instructionsAt: s.instructionsAt } : {}),
        ownerId: s.ownerId,
        ...(s.ownerIds?.length ? { ownerIds: s.ownerIds } : {}),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    }),
  );
}

/** Returns a full skill/process record enriched with resolved step skillNames, `readOnly`, and `whereUsed`. */
export async function enrichSkillRecord(registry: Registry, caller: AgentRecord, skill: SkillRecord) {
  const [ctx, resolved] = await Promise.all([
    callerSkillContext(registry, caller),
    (skill.type ?? 'skill') === 'process' ? resolveProcessSteps(registry, caller, skill.steps) : Promise.resolve(undefined),
  ]);
  const { readOnly, whereUsed } = computeWhereUsedAndReadOnly(skill, ctx);
  return {
    ...skill,
    type: skill.type ?? 'skill',
    ...(resolved ? { steps: resolved.steps } : {}),
    ...(skill.builtin || isBuiltinSkillId(skill.id) ? { builtin: true } : {}),
    readOnly,
    whereUsed,
  };
}

/**
 * Lists the effective skills/processes for a scope (`agent`, `channel`, or `workspace`) as
 * `{ skill, source: 'direct' | 'channel' | 'workspace' | 'builtin', enabled }`.
 */
export async function scopeEffectiveSkills(
  registry: Registry,
  caller: AgentRecord,
  scope: SkillScope,
  id: string,
  opts: { workspaceId?: string; channelId?: string; type?: SkillType } = {},
) {
  if (opts.type !== undefined && opts.type !== 'skill' && opts.type !== 'process') {
    throw new HubError('invalid', 'type must be "skill" or "process"');
  }
  const matchType = (s: SkillRecord) => !opts.type || (s.type ?? 'skill') === opts.type;
  const ctx = await callerSkillContext(registry, caller);

  const buildEntries = async (
    candidateIds: string[],
    detached: Set<string>,
    sourceOf: (s: SkillRecord) => SkillAttachmentSource,
    filterAccess?: boolean,
  ) => {
    let records = await skillsById(registry, candidateIds);
    if (filterAccess) {
      const checked = await Promise.all(records.map(async (r) => ((await canAccessSkill(registry, caller, r)) ? r : undefined)));
      records = checked.filter((r): r is SkillRecord => r !== undefined);
    }
    const enabledCustomNames = new Set(
      records
        .filter((r) => !(r.builtin || isBuiltinSkillId(r.id)) && !detached.has(r.id))
        .map((r) => r.name.toLowerCase()),
    );
    const visible = records
      .filter((r) => !((r.builtin || isBuiltinSkillId(r.id)) && enabledCustomNames.has(r.name.toLowerCase())))
      .filter(matchType);

    return Promise.all(
      visible.map(async (s) => {
        const type: SkillType = s.type ?? 'skill';
        const resolvedSteps = type === 'process' ? (await resolveProcessSteps(registry, ctx.self, s.steps)).steps : undefined;
        const { readOnly } = computeWhereUsedAndReadOnly(s, ctx);
        return {
          skill: {
            id: s.id,
            name: s.name,
            description: s.description,
            type,
            ...(s.builtin || isBuiltinSkillId(s.id) ? { builtin: true } : {}),
            readOnly,
            ...(type === 'process' ? { steps: resolvedSteps ?? [] } : {}),
          },
          source: sourceOf(s),
          enabled: !detached.has(s.id),
        };
      }),
    );
  };

  if (scope === 'workspace') {
    const ws = await registry.resolveMemberWorkspace(caller, id).catch(() => requireOwnerWorkspace(registry, caller, id));
    const rawWs = (await registry.workspaceDoc(ws.id)) ?? ws;
    const detached = new Set(rawWs.detachedSkills ?? []);
    const rawAttached = rawWs.attachedSkills ?? [];
    const candidateIds = [...new Set([...DEFAULT_WORKSPACE_SKILL_IDS, ...rawAttached])];
    return buildEntries(
      candidateIds,
      detached,
      (s) => (s.builtin || isBuiltinSkillId(s.id) ? 'builtin' : 'direct'),
    );
  }

  if (scope === 'channel') {
    const channel = await registry.resolveMemberChannel(caller, id).catch(() => requireOwnerChannel(registry, caller, id));
    const ws = withDefaultWorkspaceSkills(await registry.workspaceDoc(channel.workspaceId));
    const wsIds = ws?.attachedSkills ?? [];
    const directIds = channel.attachedSkills ?? [];
    const wsSet = new Set(wsIds);
    const directSet = new Set(directIds);
    const detached = new Set(channel.detachedSkills ?? []);
    const candidateIds = [...new Set([...wsIds, ...directIds])];
    return buildEntries(
      candidateIds,
      detached,
      (s) => {
        if (directSet.has(s.id) && !wsSet.has(s.id)) return 'direct';
        if (s.builtin || isBuiltinSkillId(s.id)) return 'builtin';
        if (wsSet.has(s.id)) return 'workspace';
        return 'direct';
      },
    );
  }

  if (scope === 'agent') {
    const target = !id || id === 'me' || id === caller.id ? ((await registry.get(caller.id)) ?? caller) : await registry.requireVisible(id, caller);
    const workspaces = opts.workspaceId
      ? [await registry.resolveMemberWorkspace(caller, opts.workspaceId).catch(() => requireOwnerWorkspace(registry, caller, opts.workspaceId!))]
      : await registry.workspacesOf(target);
    const channels = opts.channelId
      ? [await registry.resolveMemberChannel(caller, opts.channelId).catch(() => requireOwnerChannel(registry, caller, opts.channelId!))]
      : await registry.channelsOf(target);
    const wsIds = workspaces.flatMap((w) => w.attachedSkills ?? []);
    const chIds = channels.flatMap((c) => (c.attachedSkills ?? []).filter((sid) => !(c.detachedSkills ?? []).includes(sid)));
    const directIds = target.attachedSkills ?? [];
    const wsSet = new Set(wsIds);
    const chSet = new Set(chIds);
    const directSet = new Set(directIds);
    const detached = new Set(target.detachedSkills ?? []);
    const candidateIds = [...new Set([...wsIds, ...chIds, ...directIds])];
    const filterAccess = target.id !== caller.id && target.ownerId !== caller.id && !isSuperAdmin(caller);
    return buildEntries(
      candidateIds,
      detached,
      (s) => {
        if (directSet.has(s.id) && !wsSet.has(s.id) && !chSet.has(s.id)) return 'direct';
        if (s.builtin || isBuiltinSkillId(s.id)) return 'builtin';
        if (wsSet.has(s.id)) return 'workspace';
        if (chSet.has(s.id)) return 'channel';
        return 'direct';
      },
      filterAccess,
    );
  }

  throw new HubError('invalid', `Unsupported skill scope "${String(scope)}"`);
}
