import { randomUUID } from 'node:crypto';
import { canManageChannel, isOwner, isSuperAdmin } from '../lib/admin.js';
import { HubError } from '../lib/errors.js';
import {
  DEFAULT_WORKSPACE_SKILL_IDS,
  effectiveWorkspaceSkillIds,
  getBuiltinSkill,
  isBuiltinSkillId,
  withDefaultWorkspaceSkills,
} from './defaultSkills.js';
import { cleanSkillDescription, cleanSkillInstructions, cleanSkillName, cleanStepField, validDocId } from './fields.js';
import type { Registry } from './registry.js';
import type { AgentRecord, ChannelRecord, ProcessStep, SkillRecord, SkillScope, SkillType, WorkspaceRecord } from './types.js';

const MAX_PROCESS_STEPS = 50;
const MAX_STEP_ROLE = 100;
const MAX_STEP_ACTION = 1000;
const MAX_STEP_OUTPUT = 500;
const MAX_STEP_TRANSITION = 500;

export function isSkillOwner(skill: SkillRecord, caller: AgentRecord): boolean {
  return isOwner(skill, caller);
}

/** What `createSkill` takes. */
export interface CreateSkillInput {
  name: string;
  description: string;
  type?: SkillType;
  instructions?: string;
  steps?: Array<{ order?: number; role: string; action: string; output?: string; transition?: string; skillId?: string }>;
  scope?: SkillScope;
  id?: string;
}

/** What `updateSkill` may change. */
export interface UpdateSkillChanges {
  name?: string;
  description?: string;
  type?: SkillType;
  instructions?: string;
  steps?: Array<{ order?: number; role: string; action: string; output?: string; transition?: string; skillId?: string }>;
}

/**
 * Creates a reusable skill (`type: 'skill'`, default) or multi-agent workflow template (`type: 'process'`)
 * owned by `owner` (and their human owner if `owner` is a bot).
 * When `scope` (+ `id`) is given, verifies the caller owns that scope first and attaches the new record to it.
 */
export async function createSkill(
  registry: Registry,
  owner: AgentRecord,
  input: CreateSkillInput,
): Promise<SkillRecord> {
  const name = cleanSkillName(input.name);
  const description = cleanSkillDescription(input.description);
  const type: SkillType = input.type ?? 'skill';
  if (type !== 'skill' && type !== 'process') {
    throw new HubError('invalid', 'type must be "skill" or "process"');
  }
  let instructions = '';
  let steps: ProcessStep[] | undefined;
  if (type === 'skill') {
    if (input.steps !== undefined) {
      throw new HubError('invalid', 'A skill cannot have process steps; set type to "process" or omit steps');
    }
    instructions = cleanSkillInstructions(input.instructions ?? '');
  } else {
    if (input.instructions !== undefined && input.instructions.trim() !== '') {
      throw new HubError('invalid', 'A process uses steps instead of instructions; omit instructions or set type to "skill"');
    }
    steps = await validateAndCleanSteps(registry, owner, input.steps);
  }

  let resolvedScope: { kind: SkillScope; id: string } | undefined;
  if (input.scope) {
    const targetId = input.id ?? (input.scope === 'agent' ? owner.id : '');
    if (!targetId) throw new HubError('invalid', `id is required when scope is "${input.scope}"`);
    if (input.scope === 'agent') {
      const target = await requireManageableAgent(registry, owner, targetId);
      resolvedScope = { kind: 'agent', id: target.id };
    } else if (input.scope === 'channel') {
      const ch = await requireOwnerChannel(registry, owner, targetId);
      resolvedScope = { kind: 'channel', id: ch.id };
    } else if (input.scope === 'workspace') {
      const ws = await requireOwnerWorkspace(registry, owner, targetId);
      resolvedScope = { kind: 'workspace', id: ws.id };
    } else {
      throw new HubError('invalid', `Unsupported skill scope "${String(input.scope)}"`);
    }
  }
  const now = new Date().toISOString();
  const skill: SkillRecord = {
    id: randomUUID(),
    name,
    description,
    type,
    instructions,
    ...(steps ? { steps } : {}),
    instructionsBy: owner.name,
    instructionsAt: now,
    ownerId: owner.id,
    ...(owner.ownerId ? { ownerIds: [owner.ownerId] } : {}),
    ...(resolvedScope ? { scope: resolvedScope } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await registry.skillStore.saveSkill(skill);
  if (resolvedScope) {
    await attachSkill(registry, owner, resolvedScope.kind, resolvedScope.id, skill.id);
  }
  return skill;
}

/**
 * Updates a skill or process's name, description, type, instructions, or steps atomically in a transaction.
 * Switching between `skill` and `process` clears the other type's content so a record never has contradictory body fields.
 */
export async function updateSkill(
  registry: Registry,
  caller: AgentRecord,
  skillId: string,
  changes: UpdateSkillChanges,
): Promise<SkillRecord> {
  if (isBuiltinSkillId(skillId)) {
    throw new HubError('forbidden', 'Built-in skills are read-only; create and attach a workspace skill to override it');
  }
  const initial = await requireSkill(registry, skillId);
  await requireSkillOwner(registry, caller, initial);
  if (changes.type !== undefined && changes.type !== 'skill' && changes.type !== 'process') {
    throw new HubError('invalid', 'type must be "skill" or "process"');
  }
  const cleanedName = changes.name !== undefined ? cleanSkillName(changes.name) : undefined;
  const cleanedDescription = changes.description !== undefined ? cleanSkillDescription(changes.description) : undefined;
  const prevalidatedSteps = changes.steps !== undefined ? await validateAndCleanSteps(registry, caller, changes.steps, initial.id) : undefined;

  const updated = await registry.skillStore.updateSkill(initial.id, (skill) => {
    const currentType: SkillType = skill.type ?? 'skill';
    const nextType: SkillType = changes.type ?? currentType;

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updatedAt: now };
    const deleteFields: string[] = [];
    const record: SkillRecord = { ...skill, updatedAt: now };

    if (cleanedName !== undefined) {
      patch.name = cleanedName;
      record.name = cleanedName;
    }
    if (cleanedDescription !== undefined) {
      patch.description = cleanedDescription;
      record.description = cleanedDescription;
    }

    if (nextType === 'skill') {
      if (prevalidatedSteps !== undefined) {
        throw new HubError('invalid', 'A skill cannot have process steps; set type to "process" or omit steps');
      }
      patch.type = 'skill';
      deleteFields.push('steps');
      record.type = 'skill';
      delete record.steps;
      if (currentType === 'process') {
        const instructions = cleanSkillInstructions(changes.instructions ?? '');
        patch.instructions = instructions;
        patch.instructionsBy = caller.name;
        patch.instructionsAt = now;
        record.instructions = instructions;
        record.instructionsBy = caller.name;
        record.instructionsAt = now;
      } else if (changes.instructions !== undefined) {
        const instructions = cleanSkillInstructions(changes.instructions);
        patch.instructions = instructions;
        patch.instructionsPrev = skill.instructions;
        patch.instructionsBy = caller.name;
        patch.instructionsAt = now;
        record.instructions = instructions;
        record.instructionsPrev = skill.instructions;
        record.instructionsBy = caller.name;
        record.instructionsAt = now;
      }
    } else {
      if (changes.instructions !== undefined && changes.instructions.trim() !== '') {
        throw new HubError('invalid', 'A process uses steps instead of instructions; omit instructions or set type to "skill"');
      }
      patch.type = 'process';
      patch.instructions = '';
      record.type = 'process';
      record.instructions = '';
      if (currentType === 'skill') {
        if (!prevalidatedSteps) {
          throw new HubError('invalid', 'Process steps are required (provide a non-empty list of steps)');
        }
        patch.steps = prevalidatedSteps;
        patch.instructionsPrev = skill.instructions;
        patch.instructionsBy = caller.name;
        patch.instructionsAt = now;
        record.steps = prevalidatedSteps;
        record.instructionsPrev = skill.instructions;
        record.instructionsBy = caller.name;
        record.instructionsAt = now;
      } else if (prevalidatedSteps !== undefined) {
        patch.steps = prevalidatedSteps;
        patch.instructionsBy = caller.name;
        patch.instructionsAt = now;
        record.steps = prevalidatedSteps;
        record.instructionsBy = caller.name;
        record.instructionsAt = now;
      }
    }

    return { record, patch, deleteFields };
  });
  if (!updated) throw new HubError('not_found', `No skill "${skillId}"`);
  return updated;
}

/** Deletes a skill (skill owner or scope owner only) and detaches it from any scopes where it was attached. */
export async function deleteSkill(registry: Registry, caller: AgentRecord, skillId: string): Promise<{ ok: true; deleted: string }> {
  if (isBuiltinSkillId(skillId)) {
    throw new HubError('forbidden', 'Built-in skills are read-only and cannot be deleted; use detach_skill to remove a built-in skill from a workspace');
  }
  const skill = await requireSkill(registry, skillId);
  await requireSkillOwner(registry, caller, skill);
  await registry.skillStore.deleteSkillAndDetach(skill.id);
  if (caller.attachedSkills?.includes(skill.id)) {
    caller.attachedSkills = caller.attachedSkills.filter((id) => id !== skill.id);
  }
  return { ok: true, deleted: skill.id };
}

/** A skill by id, or undefined if it does not exist. */
export async function getSkill(registry: Registry, id: string): Promise<SkillRecord | undefined> {
  if (!validDocId(id)) return undefined;
  const builtin = getBuiltinSkill(id);
  if (builtin) return builtin;
  return registry.skillStore.getSkill(id);
}

/** A skill by id, or throws not_found. */
export async function requireSkill(registry: Registry, id: string): Promise<SkillRecord> {
  const skill = await getSkill(registry, id);
  if (!skill) throw new HubError('not_found', `No skill "${id}"`);
  return skill;
}

/** A skill by id that `caller` is allowed to read (owns it or belongs to/owns a scope where it is attached), or throws. */
export async function requireAccessibleSkill(registry: Registry, caller: AgentRecord, id: string): Promise<SkillRecord> {
  const skill = await requireSkill(registry, id);
  if (!(await canAccessSkill(registry, caller, skill))) {
    throw new HubError('forbidden', 'Unauthorized: you do not have access to this skill');
  }
  return skill;
}

/** Whether `caller` may read `skill` (owns it, or belongs to / manages a scope where it is scoped or attached). */
export async function canAccessSkill(registry: Registry, caller: AgentRecord, skill: SkillRecord): Promise<boolean> {
  if (skill.builtin || isBuiltinSkillId(skill.id)) return true;
  if (isSkillOwner(skill, caller)) return true;
  const freshCaller = (await registry.get(caller.id)) ?? caller;
  if ((freshCaller.attachedSkills ?? []).includes(skill.id)) return true;
  if (skill.scope) {
    if (skill.scope.kind === 'agent' && (skill.scope.id === freshCaller.id || (await canManageSkillScope(registry, freshCaller, 'agent', skill.scope.id)))) {
      return true;
    }
    if (skill.scope.kind === 'channel' && ((freshCaller.channels ?? []).includes(skill.scope.id) || (await canManageSkillScope(registry, freshCaller, 'channel', skill.scope.id)))) {
      return true;
    }
    if (skill.scope.kind === 'workspace' && ((freshCaller.workspaces ?? []).includes(skill.scope.id) || (await canManageSkillScope(registry, freshCaller, 'workspace', skill.scope.id)))) {
      return true;
    }
  }
  const [workspaces, channels, bots] = await Promise.all([
    registry.workspacesOf(freshCaller),
    registry.channelsOf(freshCaller),
    freshCaller.kind === 'human' ? registry.botsOf(freshCaller) : Promise.resolve([] as AgentRecord[]),
  ]);
  if (workspaces.some((w) => (w.attachedSkills ?? []).includes(skill.id))) return true;
  if (channels.some((c) => (c.attachedSkills ?? []).includes(skill.id))) return true;
  if (bots.some((b) => (b.attachedSkills ?? []).includes(skill.id))) return true;
  const ownedWorkspaces = workspaces.filter((w) => !w.room && isOwner(w, freshCaller));
  if (ownedWorkspaces.length) {
    const channels = await registry.skillStore.listChannelsOfWorkspaces(ownedWorkspaces.map((w) => w.id));
    for (const c of channels) {
      if ((c.attachedSkills ?? []).includes(skill.id)) return true;
    }
  }
  return false;
}

/** Attaches an existing skill to an agent, channel, or workspace the caller is allowed to manage. */
export async function attachSkill(
  registry: Registry,
  caller: AgentRecord,
  scope: SkillScope,
  id: string,
  skillId: string,
): Promise<{ scope: SkillScope; id: string; attachedSkills: string[]; detachedSkills?: string[] }> {
  const skill = await requireAccessibleSkill(registry, caller, skillId);
  if (scope === 'agent') {
    const target = await requireManageableAgent(registry, caller, id);
    const wasDetached = (target.detachedSkills ?? []).includes(skill.id);
    const isInherited = await isInheritedOnAgent(registry, target, skill.id);
    const detachedSkills = (target.detachedSkills ?? []).filter((s) => s !== skill.id);
    const addDirect = !(wasDetached && isInherited);
    const attachedSkills = addDirect ? [...new Set([...(target.attachedSkills ?? []), skill.id])] : (target.attachedSkills ?? []);
    await registry.skillStore.attachSkillToAgent(target.id, skill.id, addDirect, wasDetached);
    target.attachedSkills = attachedSkills;
    target.detachedSkills = detachedSkills;
    if (target.id === caller.id) {
      caller.attachedSkills = attachedSkills;
      caller.detachedSkills = detachedSkills;
    }
    return { scope, id: target.id, attachedSkills, ...(detachedSkills.length ? { detachedSkills } : {}) };
  }
  if (scope === 'channel') {
    const channel = await requireOwnerChannel(registry, caller, id);
    const wasDetached = (channel.detachedSkills ?? []).includes(skill.id);
    const isInherited = await isInheritedOnChannel(registry, channel, skill.id);
    const detachedSkills = (channel.detachedSkills ?? []).filter((s) => s !== skill.id);
    const addDirect = !(wasDetached && isInherited);
    const attachedSkills = addDirect ? [...new Set([...(channel.attachedSkills ?? []), skill.id])] : (channel.attachedSkills ?? []);
    await registry.skillStore.attachSkillToChannel(channel.id, skill.id, addDirect, wasDetached);
    channel.attachedSkills = attachedSkills;
    channel.detachedSkills = detachedSkills;
    return { scope, id: channel.id, attachedSkills, ...(detachedSkills.length ? { detachedSkills } : {}) };
  }
  if (scope === 'workspace') {
    const workspace = await requireOwnerWorkspace(registry, caller, id);
    const isDefault = DEFAULT_WORKSPACE_SKILL_IDS.includes(skill.id);
    const detachedSkills = (workspace.detachedSkills ?? []).filter((s) => s !== skill.id);
    const attachedSkills = effectiveWorkspaceSkillIds({
      attachedSkills: [...new Set([...(workspace.attachedSkills ?? []), skill.id])],
      detachedSkills,
    });
    await registry.skillStore.attachSkillToWorkspace(workspace.id, skill.id, attachedSkills, isDefault);
    workspace.attachedSkills = attachedSkills;
    workspace.detachedSkills = detachedSkills;
    return { scope, id: workspace.id, attachedSkills, ...(detachedSkills.length ? { detachedSkills } : {}) };
  }
  throw new HubError('invalid', `Unsupported skill scope "${String(scope)}"`);
}

/** Detaches an existing skill from an agent, channel, or workspace the caller is allowed to manage. */
export async function detachSkill(
  registry: Registry,
  caller: AgentRecord,
  scope: SkillScope,
  id: string,
  skillId: string,
): Promise<{ scope: SkillScope; id: string; attachedSkills: string[]; detachedSkills?: string[] }> {
  const skill = await requireSkill(registry, skillId);
  if (scope === 'agent') {
    const target = await requireManageableAgent(registry, caller, id);
    const isInherited = await isInheritedOnAgent(registry, target, skill.id);
    const attachedSkills = (target.attachedSkills ?? []).filter((s) => s !== skill.id);
    const detachedSkills = isInherited ? [...new Set([...(target.detachedSkills ?? []), skill.id])] : (target.detachedSkills ?? []);
    await registry.skillStore.detachSkillFromAgent(target.id, skill.id, isInherited);
    target.attachedSkills = attachedSkills;
    if (detachedSkills.length) target.detachedSkills = detachedSkills;
    if (target.id === caller.id) {
      caller.attachedSkills = attachedSkills;
      if (detachedSkills.length) caller.detachedSkills = detachedSkills;
    }
    return { scope, id: target.id, attachedSkills, ...(detachedSkills.length ? { detachedSkills } : {}) };
  }
  if (scope === 'channel') {
    const channel = await requireOwnerChannel(registry, caller, id);
    const isInherited = await isInheritedOnChannel(registry, channel, skill.id);
    const attachedSkills = (channel.attachedSkills ?? []).filter((s) => s !== skill.id);
    const detachedSkills = isInherited ? [...new Set([...(channel.detachedSkills ?? []), skill.id])] : (channel.detachedSkills ?? []);
    await registry.skillStore.detachSkillFromChannel(channel.id, skill.id, isInherited);
    channel.attachedSkills = attachedSkills;
    if (detachedSkills.length) channel.detachedSkills = detachedSkills;
    return { scope, id: channel.id, attachedSkills, ...(detachedSkills.length ? { detachedSkills } : {}) };
  }
  if (scope === 'workspace') {
    const workspace = await requireOwnerWorkspace(registry, caller, id);
    const isDefault = DEFAULT_WORKSPACE_SKILL_IDS.includes(skill.id);
    const detachedSkills = isDefault
      ? [...new Set([...(workspace.detachedSkills ?? []), skill.id])]
      : workspace.detachedSkills;
    const attachedSkills = effectiveWorkspaceSkillIds({
      attachedSkills: (workspace.attachedSkills ?? []).filter((s) => s !== skill.id),
      detachedSkills,
    });
    await registry.skillStore.detachSkillFromWorkspace(workspace.id, skill.id, attachedSkills, isDefault);
    workspace.attachedSkills = attachedSkills;
    if (detachedSkills) workspace.detachedSkills = detachedSkills;
    return { scope, id: workspace.id, attachedSkills, ...(detachedSkills?.length ? { detachedSkills } : {}) };
  }
  throw new HubError('invalid', `Unsupported skill scope "${String(scope)}"`);
}

async function isInheritedOnChannel(registry: Registry, channel: ChannelRecord, skillId: string): Promise<boolean> {
  const ws = withDefaultWorkspaceSkills(await registry.workspaceDoc(channel.workspaceId));
  return (ws?.attachedSkills ?? []).includes(skillId);
}

async function isInheritedOnAgent(registry: Registry, agent: AgentRecord, skillId: string): Promise<boolean> {
  const [workspaces, channels] = await Promise.all([registry.workspacesOf(agent), registry.channelsOf(agent)]);
  if (workspaces.some((w) => (w.attachedSkills ?? []).includes(skillId))) return true;
  if (channels.some((c) => (c.attachedSkills ?? []).includes(skillId) && !(c.detachedSkills ?? []).includes(skillId))) return true;
  return false;
}

async function validateAndCleanSteps(
  registry: Registry,
  caller: AgentRecord,
  rawSteps: unknown,
  selfId?: string,
): Promise<ProcessStep[]> {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new HubError('invalid', 'Process steps are required (provide a non-empty list of steps)');
  }
  if (rawSteps.length > MAX_PROCESS_STEPS) {
    throw new HubError('invalid', `A process can have at most ${MAX_PROCESS_STEPS} steps`);
  }
  const cleaned: ProcessStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') {
      throw new HubError('invalid', `Step ${i + 1} must be an object`);
    }
    const order = raw.order === undefined ? i + 1 : Number(raw.order);
    if (!Number.isInteger(order) || order < 1) {
      throw new HubError('invalid', `Step ${i + 1} order must be a positive integer`);
    }
    const role = cleanStepField(raw.role, `Step ${i + 1} role`, MAX_STEP_ROLE);
    const action = cleanStepField(raw.action, `Step ${i + 1} action`, MAX_STEP_ACTION);
    const output = raw.output !== undefined && String(raw.output).trim() !== '' ? cleanStepField(raw.output, `Step ${i + 1} output`, MAX_STEP_OUTPUT) : undefined;
    const transition =
      raw.transition !== undefined && String(raw.transition).trim() !== '' ? cleanStepField(raw.transition, `Step ${i + 1} transition`, MAX_STEP_TRANSITION) : undefined;
    const skillId = raw.skillId !== undefined && String(raw.skillId).trim() !== '' ? String(raw.skillId).trim() : undefined;
    if (skillId) {
      if (selfId && skillId === selfId) {
        throw new HubError('invalid', 'A process step cannot reference the process itself');
      }
      const ref = await requireSkill(registry, skillId);
      if ((ref.type ?? 'skill') !== 'skill') {
        throw new HubError('invalid', `Step ${i + 1} skillId "${skillId}" must reference a skill, not a process`);
      }
      if (!(await canAccessSkill(registry, caller, ref))) {
        throw new HubError('forbidden', `Unauthorized: you do not have access to referenced skill "${skillId}"`);
      }
    }
    cleaned.push({
      order,
      role,
      action,
      ...(output ? { output } : {}),
      ...(transition ? { transition } : {}),
      ...(skillId ? { skillId } : {}),
    });
  }
  return cleaned.sort((a, b) => a.order - b.order);
}

async function requireSkillOwner(registry: Registry, caller: AgentRecord, skill: SkillRecord): Promise<void> {
  if (skill.builtin || isBuiltinSkillId(skill.id)) {
    throw new HubError('forbidden', 'Built-in skills are read-only');
  }
  if (isSkillOwner(skill, caller)) return;
  if (skill.scope && (await canManageSkillScope(registry, caller, skill.scope.kind, skill.scope.id))) return;
  const { channels, workspaces, agents } = await registry.skillStore.listScopesWithAttachedSkill(skill.id);
  for (const w of workspaces) {
    if (isOwner(w, caller)) return;
  }
  for (const ch of channels) {
    if (canManageChannel(ch, await registry.workspaceDoc(ch.workspaceId), caller)) return;
  }
  for (const a of agents) {
    if (a.id === caller.id || a.ownerId === caller.id) return;
  }
  throw new HubError('forbidden', 'Unauthorized: only the skill owner or scope owner can modify or delete this skill');
}

async function canManageSkillScope(registry: Registry, caller: AgentRecord, scope: SkillScope, id: string): Promise<boolean> {
  if (scope === 'agent') {
    if (id === caller.id || id === 'me') return true;
    const target = await registry.get(id);
    return !!target && (target.ownerId === caller.id || isSuperAdmin(caller));
  }
  if (scope === 'channel') {
    const ch = await registry.channelDoc(id);
    return !!ch && canManageChannel(ch, await registry.workspaceDoc(ch.workspaceId), caller);
  }
  if (scope === 'workspace') {
    const ws = await registry.workspaceDoc(id);
    return !!ws && isOwner(ws, caller);
  }
  return false;
}

async function requireManageableAgent(registry: Registry, caller: AgentRecord, id: string): Promise<AgentRecord> {
  if (!id || id === 'me' || id === caller.id) return (await registry.get(caller.id)) ?? caller;
  const target = await registry.get(id);
  if (!target) throw new HubError('not_found', `No agent "${id}" is available to you.`);
  const owns = target.id === caller.id || target.ownerId === caller.id || isSuperAdmin(caller);
  if (!owns) {
    throw new HubError('forbidden', 'Unauthorized: only the agent or its owner can manage skills on this agent');
  }
  return target;
}

export async function requireOwnerChannel(registry: Registry, caller: AgentRecord, idOrName: string): Promise<ChannelRecord> {
  const byId = await registry.channelDoc(idOrName);
  const ch = byId ?? (await registry.resolveMemberChannel(caller, idOrName));
  const ws = await registry.workspaceDoc(ch.workspaceId);
  if (!canManageChannel(ch, ws, caller)) {
    throw new HubError('forbidden', 'Unauthorized: only a channel or workspace owner can manage skills on this channel');
  }
  return ch;
}

export async function requireOwnerWorkspace(registry: Registry, caller: AgentRecord, idOrName: string): Promise<WorkspaceRecord> {
  const byId = await registry.workspaceDoc(idOrName);
  const ws = byId ?? (await registry.resolveMemberWorkspace(caller, idOrName));
  if (!isOwner(ws, caller)) {
    throw new HubError('forbidden', 'Unauthorized: only a workspace owner can manage skills on this workspace');
  }
  return ws;
}
