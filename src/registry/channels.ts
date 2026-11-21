import { randomUUID } from 'node:crypto';
import { HubError } from '../lib/errors.js';
import { canManageChannel, isOwner, isSuperAdmin } from '../lib/admin.js';
import { cleanGroupName, cleanName, validDocId } from './fields.js';
import {
  isOpenChannel,
  isPublicWorkspace,
  type AgentRecord,
  type AgentStatus,
  type CanvasBox,
  type ChannelRecord,
} from './types.js';
import { isShowcaseGuest, type Registry } from './registry.js';
import { addWithRoom } from './workspaces.js';

/** The most a channel's context holds: it goes to every agent with every message there, so it stays short. */
const CONTEXT_MAX = 1000;
export const MAX_ROLE = 40;

/** Creates a channel in a workspace the creator belongs to, with the creator as its owner and first member. */
export async function createChannel(registry: Registry, creator: AgentRecord, workspaceIdOrName: string, name: string): Promise<ChannelRecord> {
  const workspace = await registry.resolveMemberWorkspace(creator, workspaceIdOrName);
  if (isShowcaseGuest(workspace, creator)) {
    throw new HubError('forbidden', 'Only a workspace owner can create channels in a public showcase workspace');
  }
  const clean = cleanGroupName(name, 'Channel');
  // One live team per name in a workspace (three "Growth" teams helped nobody).
  const loose = (n: string) => n.toLowerCase().replace(/^#/, '').replace(/[\s_-]+/g, '');
  const same = await registry.workspaceStore.listWorkspaceChannels(workspace.id);
  if (same.some((c) => !c.archived && loose(c.name) === loose(clean))) {
    throw new HubError('conflict', `There's already a team called "${clean}" here: pick another name`);
  }
  const channel: ChannelRecord = {
    id: randomUUID(),
    workspaceId: workspace.id,
    name: clean,
    ownerId: creator.id,
    createdAt: new Date().toISOString(),
    // Open by default, like Slack; an owner can close it.
    open: true,
  };
  await registry.channelStore.createWithOwner(channel, creator.id);
  creator.channels = [...new Set([...(creator.channels ?? []), channel.id])];
  return channel;
}

/** An agent's own status (set_status): kept on its record, and in a week-long log (its log on the canvas). Null clears it. */
export async function setStatus(registry: Registry, agentId: string, status: AgentStatus | null): Promise<void> {
  await registry.channelStore.setStatus(agentId, status);
  if (status) {
    await registry.channelStore.addStatusLog({ agentId, ...status, expiresAt: new Date(Date.parse(status.at) + 7 * 24 * 60 * 60_000) });
  }
}

/**
 * A line in an agent's day written by the hub itself, from what the agent did (posted, ran a tool, woke): its log
 * fills whether or not the agent reports its own status. Its current status is left alone.
 */
export async function logActivity(registry: Registry, agentId: string, entry: AgentStatus): Promise<void> {
  await registry.channelStore.addStatusLog({ agentId, ...entry, auto: true, expiresAt: new Date(Date.parse(entry.at) + 7 * 24 * 60 * 60_000) });
}

/** Clears an agent's status only if it's still about `conversationId` (with `wholeChannel`, any conversation in the same channel), in one transaction (a newer one stays). */
export async function clearStatusIf(registry: Registry, agentId: string, conversationId: string, wholeChannel = false): Promise<void> {
  const scope = (key: string) => (wholeChannel && !key.startsWith('dm:') ? key.split(':')[1] : key);
  await registry.channelStore.clearStatusIf(agentId, (status) => scope(status.conversationId) === scope(conversationId));
}

/** What an agent said it was doing (kept a week), newest first, at most `limit`; only what came before `before` when it's given. */
export async function statusLog(registry: Registry, agentId: string, before: string | undefined, limit: number): Promise<AgentStatus[]> {
  return (await registry.channelStore.statusLog(agentId, before, limit)).map(({ text, at, conversationId }) => ({ text, at, conversationId }));
}

/** Moves or resizes a channel's frame on the canvas: anyone in the channel arranges it (except in a public showcase workspace, where only owners may). */
export async function setChannelCanvas(registry: Registry, caller: AgentRecord, channelId: string, box: CanvasBox): Promise<ChannelRecord> {
  const channel = await registry.resolveMemberChannel(caller, channelId);
  const workspace = await registry.workspaceDoc(channel.workspaceId);
  if (isPublicWorkspace(workspace) && !canManageChannel(channel, workspace, caller)) {
    throw new HubError('forbidden', 'Only a channel or workspace owner can arrange the canvas in a public showcase workspace');
  }
  const ok = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  if (!ok(box?.x, -1e6, 1e6) || !ok(box?.y, -1e6, 1e6) || !ok(box?.w, 120, 20_000) || !ok(box?.h, 120, 20_000)) {
    throw new HubError('invalid', 'canvas is { x, y, w, h } in pixels (w and h 120 to 20000)');
  }
  const canvas = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
  await registry.channelStore.update(channel.id, { canvas });
  return { ...channel, canvas };
}

/** The channels `agent` is in, optionally only those of one workspace. */
export async function channelsOf(registry: Registry, agent: AgentRecord, workspaceId?: string): Promise<ChannelRecord[]> {
  const ids = agent.channels ?? [];
  if (ids.length === 0) return [];
  return (await registry.channelStore.getMany(ids))
    .map(([, c]) => c)
    .filter((c) => !workspaceId || c.workspaceId === workspaceId);
}

/** A workspace's open channels that `agent`, a member of it, isn't in yet: the ones it can join. */
export async function joinableChannels(registry: Registry, agent: AgentRecord, workspaceIdOrName: string): Promise<ChannelRecord[]> {
  const workspace = await registry.resolveMemberWorkspace(agent, workspaceIdOrName);
  const channels = await registry.workspaceStore.listWorkspaceChannels(workspace.id);
  const mine = new Set(agent.channels ?? []);
  const guest = isShowcaseGuest(workspace, agent);
  return channels
    .filter(
      (c) =>
        !c.archived &&
        !mine.has(c.id) &&
        isOpenChannel(c) &&
        !(c.bannedAgents ?? []).includes(agent.id) &&
        (!guest || c.publicFromSeq !== undefined),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `agent` joins an open channel of a workspace it is in, or self-joins a public+open channel in a `publicShowcase` workspace as a guest. */
export async function joinChannel(registry: Registry, agent: AgentRecord, channelId: string): Promise<ChannelRecord> {
  const channel = await registry.channelDoc(channelId);
  if (!channel || channel.archived || !isOpenChannel(channel)) {
    throw new HubError('not_found', `No channel ${channelId} you can join`);
  }
  const workspace = await registry.workspaceDoc(channel.workspaceId);
  if (!workspace || workspace.archived) {
    throw new HubError('not_found', `No channel ${channelId} you can join`);
  }
  if ((workspace.bannedAgents ?? []).includes(agent.id) || (channel.bannedAgents ?? []).includes(agent.id)) {
    throw new HubError('forbidden', 'You have been removed from this public workspace or channel');
  }
  const inWorkspace = (agent.workspaces ?? []).includes(channel.workspaceId);
  if (!inWorkspace) {
    const canSelfJoin = agent.kind === 'human' && isPublicWorkspace(workspace) && channel.publicFromSeq !== undefined && isOpenChannel(channel);
    if (!canSelfJoin) {
      throw new HubError('not_found', `No channel ${channelId} you can join`);
    }
  } else if (isShowcaseGuest(workspace, agent) && channel.publicFromSeq === undefined) {
    throw new HubError('not_found', `No channel ${channelId} you can join`);
  }
  const alreadyInChannel = (agent.channels ?? []).includes(channel.id);
  if (inWorkspace && alreadyInChannel) {
    return channel;
  }
  if (inWorkspace) await registry.channelStore.join(agent.id, channel.id, undefined);
  else await addWithRoom(registry, [workspace], agent, undefined, (tx) => registry.channelStore.join(agent.id, channel.id, channel.workspaceId, tx));
  agent.workspaces = [...new Set([...(agent.workspaces ?? []), channel.workspaceId])];
  agent.channels = [...new Set([...(agent.channels ?? []), channel.id])];
  if (!alreadyInChannel) {
    await registry.onJoinChannel?.(agent.id, channel.id);
  }
  return channel;
}

/** How many agents are in each channel (archived bots included), one count query per channel. */
export async function channelMemberCounts(registry: Registry, channelIds: string[]): Promise<Map<string, number>> {
  return registry.countMembers('channels', channelIds);
}

/**
 * A channel `agent` is in, by id or (case-insensitive) name; `workspace` (id or name) narrows a
 * name shared across workspaces.
 */
export async function resolveMemberChannel(registry: Registry, agent: AgentRecord, idOrName: string, workspace?: string): Promise<ChannelRecord> {
  const scope = workspace ? await registry.resolveMemberWorkspace(agent, workspace) : undefined;
  const channels = await registry.channelsOf(agent, scope?.id);
  const byId = channels.find((c) => c.id === idOrName);
  if (byId) return byId;
  // Names match loosely: case, a leading #, and spaces, hyphens or underscores don't matter ("build in public" is #Build-in-public).
  const loose = (n: string) => n.toLowerCase().replace(/^#/, '').replace(/[\s_-]+/g, '');
  const exact = channels.filter((c) => c.name.toLowerCase() === idOrName.toLowerCase().replace(/^#/, ''));
  const byName = exact.length ? exact : channels.filter((c) => loose(c.name) === loose(idOrName));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const workspaces = new Map((await registry.workspacesOf(agent)).map((w) => [w.id, w.name]));
    const options = byName.map((c) => `${workspaces.get(c.workspaceId) ?? c.workspaceId}/${c.name} (${c.id})`).join(', ');
    throw new HubError('invalid', `You are in several channels named "${idOrName}": say which with workspace, or use the id: ${options}`);
  }
  const yours = channels.map((c) => c.name).slice(0, 30);
  throw new HubError('not_found', `You are not a member of a channel "${idOrName}"${scope ? ` in ${scope.name}` : ''}${yours.length ? `. Yours: ${yours.join(', ')}` : ''}`);
}

/**
 * Any channel member adds a member of the channel's workspace (a person or a bot) to the channel,
 * by id. Agents outside the workspace are added to the workspace first.
 */
export async function addToChannel(registry: Registry, adder: AgentRecord, channelIdOrName: string, agentId: string, workspace?: string): Promise<{ channel: ChannelRecord; agent: AgentRecord }> {
  const channel = await registry.resolveMemberChannel(adder, channelIdOrName, workspace);
  if (channel.archived) throw new HubError('conflict', 'This channel is archived');
  const ws = await registry.workspaceDoc(channel.workspaceId);
  if (isPublicWorkspace(ws) && !canManageChannel(channel, ws, adder)) {
    throw new HubError('forbidden', 'Only a channel or workspace owner can add members in a public showcase workspace');
  }
  const agent = await registry.requireVisible(agentId, adder);
  if (agent.archived) throw new HubError('invalid', 'Restore an archived bot before adding it');
  if (!(agent.workspaces ?? []).includes(channel.workspaceId)) {
    throw new HubError('invalid', `${agent.name} is not in this channel's workspace yet. ${agent.kind === 'human' ? 'Invite them by email' : 'Add it to the workspace'} first.`);
  }
  registry.inviteLimiter?.hit(adder.id);
  const bannedInChannel = (channel.bannedAgents ?? []).includes(agent.id);
  const bannedInWorkspace = (ws?.bannedAgents ?? []).includes(agent.id);
  if (bannedInChannel) channel.bannedAgents = (channel.bannedAgents ?? []).filter((id) => id !== agent.id);
  await registry.channelStore.addMember(agent.id, channel.id, bannedInChannel, bannedInWorkspace ? channel.workspaceId : undefined);
  agent.channels = [...new Set([...(agent.channels ?? []), channel.id])];
  await registry.onJoinChannel?.(agent.id, channel.id);
  return { channel, agent };
}

export async function leaveChannel(registry: Registry, agent: AgentRecord, channelId: string): Promise<void> {
  const channel = await registry.requireChannelMembership(agent, channelId);
  // ponytail: the creator can't leave, so a channel always has an owner; co-owners can. Add transfer/delete when needed
  if (channel.ownerId === agent.id) throw new HubError('conflict', 'The channel creator cannot leave the channel');
  await dropChannelMember(registry, agent, channelId);
  agent.channels = (agent.channels ?? []).filter((c) => c !== channelId);
}

/** Channel or workspace owner only. `member` is an agent id; it must be in the channel. In a public workspace, removing a non-owner guest also bans them from self-rejoining that channel. */
export async function removeFromChannel(registry: Registry, owner: AgentRecord, channelId: string, member: string): Promise<void> {
  const channel = await registry.requireChannelOwner(owner, channelId);
  const workspace = await registry.workspaceDoc(channel.workspaceId);
  const members = await registry.agentStore.membersOf('channels', channel.id);
  const target = members.find((a) => a.id === member);
  if (!target) throw new HubError('not_found', `"${member}" is not a member of this channel.${registry.idHint(member, members)}`);
  if (target.id === owner.id) throw new HubError('conflict', 'An owner cannot remove itself');
  if (target.id === channel.ownerId) throw new HubError('forbidden', 'The channel creator cannot be removed');
  await dropChannelMember(registry, target, channel.id, isPublicWorkspace(workspace) && !canManageChannel(channel, workspace, target));
}

/** Channel or workspace owner only. Makes `member` (an agent id in the channel) a co-owner. */
export async function addChannelOwner(registry: Registry, owner: AgentRecord, channelId: string, member: string): Promise<ChannelRecord> {
  const channel = await registry.requireChannelOwner(owner, channelId);
  const target = await registry.get(member);
  if (!target || !(target.channels ?? []).includes(channel.id)) throw new HubError('not_found', `"${member}" is not a member of this channel`);
  if (target.id !== channel.ownerId && !(channel.ownerIds ?? []).includes(target.id)) {
    await registry.channelStore.addOwner(channel.id, target.id);
    channel.ownerIds = [...new Set([...(channel.ownerIds ?? []), target.id])];
  }
  return channel;
}

/** Channel or workspace owner only: rename the channel and/or archive (or restore) it. */
export async function updateChannel(
  registry: Registry,
  owner: AgentRecord,
  channelId: string,
  changes: { name?: string; archived?: boolean; open?: boolean; publicFromSeq?: number | null; context?: string },
): Promise<ChannelRecord> {
  const channel = await registry.requireChannelOwner(owner, channelId);
  const update: Partial<ChannelRecord> = {};
  if (changes.context !== undefined) {
    const context = changes.context.trim();
    if (context.length > CONTEXT_MAX) throw new HubError('invalid', `A channel's context is at most ${CONTEXT_MAX} characters (this one is ${context.length})`);
    update.context = context;
  }
  if (changes.name !== undefined) update.name = cleanGroupName(changes.name, 'Channel');
  if (changes.archived !== undefined) update.archived = changes.archived;
  if (changes.open !== undefined) update.open = changes.open;
  // Already public: it stays public from where it started. Private again and then public: from then on.
  if (typeof changes.publicFromSeq === 'number' && channel.publicFromSeq === undefined) update.publicFromSeq = changes.publicFromSeq;
  const goPrivate = changes.publicFromSeq === null && channel.publicFromSeq !== undefined;
  if (Object.keys(update).length === 0 && !goPrivate && changes.publicFromSeq === undefined) {
    throw new HubError('invalid', 'Give a new name, archived: true/false, open: true/false, public: true/false or a context');
  }
  await registry.channelStore.updateChannel(channel.id, update, goPrivate);
  // channelId covers chat.ts's channelKey() and every threadKey() under it, without importing chat here.
  if (changes.archived === true) await registry.purgeGraph?.({ workspaceId: channel.workspaceId, channelId: channel.id });
  // Restoring puts back what the archive purged and no message re-extraction refills: its skills and room doc.
  if (changes.archived === false && channel.archived) await registry.syncGraph?.({ restoredChannel: { workspaceId: channel.workspaceId, channelId: channel.id } });
  const updated = { ...channel, ...update };
  if (goPrivate) delete updated.publicFromSeq;
  return updated;
}

/** Channel or workspace owner: anyone can read this post's thread (and its files), or not anymore. */
export async function setThreadPublic(registry: Registry, owner: AgentRecord, channelId: string, post: string, pub: boolean): Promise<ChannelRecord> {
  const channel = await registry.requireChannelOwner(owner, channelId);
  await registry.channelStore.setThreadFlag(channel.id, 'publicThreads', post, pub);
  const publicThreads = (channel.publicThreads ?? []).filter((p) => p !== post).concat(pub ? [post] : []);
  return { ...channel, publicThreads };
}

/** Thread starter (or a bot owned by the thread starter) or channel/workspace owner: marks a post's thread as done (or reopens it). */
export async function setThreadDone(registry: Registry, caller: AgentRecord, channelId: string, post: string, postAuthorId: string, done: boolean): Promise<ChannelRecord> {
  const isStarter = caller.id === postAuthorId || (Boolean(caller.ownerId) && caller.ownerId === postAuthorId);
  let channel: ChannelRecord;
  if (isStarter) {
    channel = await registry.requireChannelMembership(caller, channelId);
  } else {
    channel = await registry.requireChannelOwner(caller, channelId);
  }
  await registry.channelStore.setThreadFlag(channel.id, 'doneThreads', post, done);
  const doneThreads = (channel.doneThreads ?? []).filter((p) => p !== post).concat(done ? [post] : []);
  return { ...channel, doneThreads };
}

/** Clears a thread's done state when a human replies in it (auto-reopen). */
export async function clearThreadDone(registry: Registry, channelId: string, post: string): Promise<void> {
  await registry.channelStore.setThreadFlag(channelId, 'doneThreads', post, false);
}

/**
 * Channel or workspace owner (a person or a bot): sets `memberId`'s role in the channel, or clears it
 * with an empty role. Membership is read in the same transaction, so a concurrent removal can't
 * leave a role behind for someone no longer in the channel.
 */
export async function setChannelRole(registry: Registry, owner: AgentRecord, channelId: string, memberId: string, role: string): Promise<ChannelRecord> {
  const channel = await registry.requireChannelOwner(owner, channelId);
  const clean = cleanName(role ?? '');
  if (clean.length > MAX_ROLE) throw new HubError('invalid', `A role is up to ${MAX_ROLE} characters`);
  if (!validDocId(memberId)) throw new HubError('not_found', `Agent '${memberId}' was not found`);
  const current = await registry.channelStore.setRole(channel.id, channel.workspaceId, memberId, clean, (member, current, workspace) => {
    if (!current) throw new HubError('not_found', 'No such channel');
    // Ownership may have changed since the check above (a co-owner removed meanwhile): recheck on what this transaction read.
    if (!canManageChannel(current, workspace, owner)) throw new HubError('forbidden', 'Only a channel or workspace owner can do that');
    if (!member || !(member.channels ?? []).includes(channel.id)) throw new HubError('not_found', `"${memberId}" is not a member of this channel`);
  });
  const roles = { ...current.roles };
  if (clean) roles[memberId] = clean;
  else delete roles[memberId];
  return { ...current, roles };
}

/** Members' roles in a channel, for a viewer who may read it (a member, or someone who can manage it); otherwise none. */
export async function channelRolesFor(registry: Registry, viewer: AgentRecord | undefined, channelId: string): Promise<Record<string, string> | undefined> {
  if (!viewer) return undefined;
  const channel = await registry.channelDoc(channelId);
  if (!channel?.roles) return undefined;
  const readable = (viewer.channels ?? []).includes(channel.id) || canManageChannel(channel, await registry.workspaceDoc(channel.workspaceId), viewer);
  return readable ? channel.roles : undefined;
}

/** The channels with these ids (missing ones skipped), one batched read: for showing roles on delivered messages. */
export async function channelsById(registry: Registry, ids: string[]): Promise<Map<string, ChannelRecord>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  return new Map(await registry.channelStore.getMany(unique));
}

export async function requireChannelMembership(registry: Registry, agent: AgentRecord, channelId: string): Promise<ChannelRecord> {
  const channel = await registry.channelDoc(channelId);
  if (!channel || !(agent.channels ?? []).includes(channelId)) throw new HubError('not_found', 'You are not a member of that channel');
  return channel;
}

/** The channel, if `agent` has owner rights on it or on its workspace. Super admins need no membership. */
export async function requireChannelOwner(registry: Registry, agent: AgentRecord, channelId: string): Promise<ChannelRecord> {
  const channel = isSuperAdmin(agent) ? await registry.channelDoc(channelId) : await registry.requireChannelMembership(agent, channelId).catch(() => undefined);
  if (!channel) {
    // A workspace owner may manage channels there without being in them.
    const any = await registry.channelDoc(channelId);
    const workspace = any && (await registry.workspaceDoc(any.workspaceId));
    if (any && workspace && !workspace.room && isOwner(workspace, agent)) return any;
    throw new HubError('not_found', isSuperAdmin(agent) ? 'No such channel' : 'You are not a member of that channel');
  }
  if (!canManageChannel(channel, await registry.workspaceDoc(channel.workspaceId), agent)) throw new HubError('forbidden', 'Only a channel or workspace owner can do that');
  return channel;
}

/** Removes the agent from the channel, its co-owners and its roles, so rejoining restores neither. */
async function dropChannelMember(registry: Registry, agent: Pick<AgentRecord, 'id'>, channelId: string, ban = false): Promise<void> {
  await registry.channelStore.dropMember(agent.id, channelId, ban);
}
