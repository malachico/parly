import { randomUUID } from 'node:crypto';
import { HubError, PlanLimitError } from '../lib/errors.js';
import { limitsOf, type Plan } from '../lib/plans.js';
import { isOwner, isSuperAdmin } from '../lib/admin.js';
import { cleanGroupName, cleanName } from './fields.js';
import { domainOf, normalizeDomain } from '../lib/domains.js';
import { DEFAULT_WORKSPACE_SKILL_IDS, withDefaultWorkspaceSkills } from './defaultSkills.js';
import {
  isOpenChannel,
  isPublicWorkspace,
  type AgentRecord,
  type ChannelRecord,
  type InviteRecord,
  type RoomInfo,
  type WorkspaceRecord,
} from './types.js';
import type { Transaction } from '../db/types.js';
import { isShowcaseGuest, MAX_NAME, normalizeEmail, type Registry } from './registry.js';
import { MAX_ROLE } from './channels.js';

const MAX_DOMAINS = 10;
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** "Ada's workspace": the default name of a workspace created for a person with no active workspaces. */
export function homeWorkspaceName(personName: string): string {
  return `${personName}'s workspace`.slice(0, 100);
}

/** A workspace by id, for server-side checks (rooms); callers check membership themselves. */
export async function workspaceById(registry: Registry, id: string): Promise<WorkspaceRecord | undefined> {
  return registry.workspaceDoc(id);
}

/** The rooms an app opened over /v1, newest first. */
export async function appRooms(registry: Registry, appId: string): Promise<WorkspaceRecord[]> {
  // ponytail: the newest 100 (Mongo index: room.appId + createdAt); add a cursor when an app needs more.
  return registry.workspaceStore.listAppRooms(appId, 100);
}

/** Records a room on a workspace, or adds a side to it, atomically. */
export async function updateRoom(registry: Registry, workspaceId: string, change: (room: RoomInfo | undefined) => RoomInfo): Promise<RoomInfo> {
  const room = await registry.workspaceStore.updateRoom(workspaceId, change);
  if (!room) throw new HubError('not_found', 'No such workspace');
  return room;
}

/** A member's side shown in a room's channel, set by the room itself (the member needn't own the channel). */
export async function setRoomRole(registry: Registry, channelId: string, memberId: string, role: string): Promise<void> {
  await registry.workspaceStore.setRoomRole(channelId, memberId, cleanName(role).slice(0, MAX_ROLE));
}

/**
 * Creates a workspace owned by (and including) `owner`, a person.
 */
export async function createWorkspace(registry: Registry, owner: AgentRecord, name: string, opts: { unchecked?: boolean } = {}): Promise<WorkspaceRecord> {
  if (owner.kind !== 'human') throw new HubError('forbidden', 'Only people make workspaces; a bot is added to one by a member');
  const workspace: WorkspaceRecord = {
    id: randomUUID(),
    name: cleanGroupName(name, 'Workspace'),
    ownerId: owner.id,
    createdAt: new Date().toISOString(),
    attachedSkills: [...DEFAULT_WORKSPACE_SKILL_IDS],
  };
  await withWorkspaceRoom(registry, opts.unchecked ? undefined : owner, (tx) => registry.workspaceStore.createWorkspaceForOwner(workspace, owner.id, tx));
  owner.workspaces = [...new Set([...(owner.workspaces ?? []), workspace.id])];
  return workspace;
}

type Usage = { count: number; max: number | null; plan: Plan };

/** A workspace owner's (or co-owner's) membership: in a public workspace only they and bots take a seat. */
function takesSeat(ws: WorkspaceRecord, agent: AgentRecord): boolean {
  if (agent.kind === 'human' && isPublicWorkspace(ws)) return ws.ownerId === agent.id || (ws.ownerIds ?? []).includes(agent.id);
  return !agent.archived;
}

/** No limits shown or applied: a hub without plans, or a super-admin. */
function exempt(registry: Registry, who?: AgentRecord): boolean {
  return !registry.plans || (!!who && isSuperAdmin(who));
}

/** Seat-taking members of `ws` and its seat count; read in `tx` when given (locking agents and invites). */
async function seats(registry: Registry, ws: WorkspaceRecord, tx?: Transaction): Promise<Usage & { members: AgentRecord[] }> {
  const limits = limitsOf(await registry.agentStore.billingOf(ws.ownerId, ws.id), 0);
  const members = (await registry.workspaceStore.listWorkspaceMembers(ws.id, tx)).filter((a) => takesSeat(ws, a));
  const invites = isPublicWorkspace(ws) ? 0 : (await registry.workspaceStore.listInvitesOfWorkspace(ws.id, Date.now(), tx)).length;
  return { count: members.length + invites, max: limits.maxParticipants, plan: limits.plan, members };
}

/** Seats taken in `ws` against its owner's plan: members (archived bots and public-workspace guests aside) plus live invites. max is null on a hub without plans, or for a super-admin `viewer`. */
export async function workspaceUsage(registry: Registry, ws: WorkspaceRecord, viewer?: AgentRecord): Promise<Usage> {
  const { count, max, plan } = await seats(registry, ws);
  return { count, max: exempt(registry, viewer) ? null : max, plan };
}

/**
 * Refuses adding `adding` (an agent, an invite, or 'seat': one more seat regardless, e.g. a bot about to be made or a guest made co-owner) to a full workspace.
 * Over-cap workspaces keep everyone; they just can't grow. In `tx` it re-reads `ws` and its seats there, so a concurrent add conflicts and retries against the new count.
 */
export async function assertParticipantRoom(registry: Registry, ws: WorkspaceRecord, adding: AgentRecord | 'invite' | 'seat', actor?: AgentRecord, tx?: Transaction): Promise<void> {
  if (exempt(registry, actor)) return;
  if (tx) ws = (await registry.workspaceStore.workspaceIn(tx, ws.id)) ?? ws;
  if (adding === 'invite' ? isPublicWorkspace(ws) : adding !== 'seat' && !takesSeat(ws, adding)) return;
  const { count, max, plan, members } = await seats(registry, ws, tx);
  if (typeof adding === 'object' && members.some((m) => m.id === adding.id)) return;
  if (typeof adding === 'object' && adding.kind === 'human') await assertJoinRoom(registry, adding, actor, tx);
  const who = actor ?? (typeof adding === 'object' ? adding : undefined);
  const byOwner = !who || who.id === ws.ownerId || who.ownerId === ws.ownerId;
  if (max !== null && count >= max) throw new PlanLimitError('participants', count, max, plan, byOwner);
}

/**
 * Checks room for `adding` in each of `workspaces` and runs `write` in one Mongo transaction. The check reads lock the
 * agents/invites/workspaces collections, so two adds racing for the last seat (on any instance) write-conflict: one
 * commits, the other retries, sees the new count and gets PLAN_LIMIT. Exempt callers just write.
 */
export async function addWithRoom(
  registry: Registry,
  workspaces: WorkspaceRecord[],
  adding: AgentRecord | 'invite' | 'seat',
  actor: AgentRecord | undefined,
  write: (tx?: Transaction) => Promise<void>,
): Promise<void> {
  if (exempt(registry, actor)) return write();
  await registry.db.runTransaction(async (tx) => {
    for (const ws of workspaces) await assertParticipantRoom(registry, ws, adding, actor, tx);
    await write(tx);
  });
}

/** Free caps every workspace a person is in (owned or joined); paid plans cap only the ones they own. */
const countsJoined = (plan: Plan) => plan === 'free';

/**
 * Active (not archived, not room) workspaces counted against `owner`'s plan: the ones they created, plus on Free the
 * ones they joined (public-workspace guests aside). max is null on a hub without plans, or for a super-admin `viewer`.
 */
export async function ownedWorkspaceUsage(registry: Registry, owner: AgentRecord, viewer?: AgentRecord, tx?: Transaction): Promise<Usage> {
  const limits = limitsOf(await registry.agentStore.billingOf(owner.id), 0);
  const joined = countsJoined(limits.plan);
  const owned = (await registry.workspaceStore.getWorkspaces(owner.workspaces ?? [], tx)).filter(
    (w) => !w.archived && !w.room && (w.ownerId === owner.id || (joined && takesSeat(w, owner))),
  );
  return { count: owned.length, max: exempt(registry, viewer) ? null : limits.maxWorkspaces, plan: limits.plan };
}

/**
 * Runs `write` (one more active workspace for `owner`) after checking their workspace cap, in one transaction that
 * re-reads `owner` and their workspaces, so concurrent creates/restores conflict and the loser retries against the new count.
 * No `owner` (an unchecked create), a hub without plans or a super-admin owner just writes.
 */
async function withWorkspaceRoom(registry: Registry, owner: AgentRecord | undefined, write: (tx?: Transaction) => Promise<void>): Promise<void> {
  if (!owner || exempt(registry, owner)) return write();
  await registry.db.runTransaction(async (tx) => {
    const fresh = (await registry.workspaceStore.agentIn(tx, owner.id)) ?? owner;
    const { count, max, plan } = await ownedWorkspaceUsage(registry, fresh, undefined, tx);
    if (max !== null && count >= max) throw new PlanLimitError('workspaces', count, max, plan);
    await write(tx);
  });
}

/** Refuses a Free person joining one more workspace past their cap. Re-reads them in `tx`. Over-cap people keep their workspaces. */
async function assertJoinRoom(registry: Registry, joiner: AgentRecord, actor: AgentRecord | undefined, tx?: Transaction): Promise<void> {
  if (exempt(registry, joiner)) return;
  const fresh = (tx && (await registry.workspaceStore.agentIn(tx, joiner.id))) || joiner;
  const { count, max, plan } = await ownedWorkspaceUsage(registry, fresh, undefined, tx);
  if (countsJoined(plan) && max !== null && count >= max) throw new PlanLimitError('workspaces', count, max, plan, !actor || actor.id === joiner.id);
}

/** Workspaces a Free person can still join (Infinity on paid plans or without plans). */
export async function joinRoom(registry: Registry, agent: AgentRecord): Promise<number> {
  if (exempt(registry, agent)) return Infinity;
  const { count, max, plan } = await ownedWorkspaceUsage(registry, agent);
  return countsJoined(plan) && max !== null ? Math.max(0, max - count) : Infinity;
}

/** The workspaces `agent` belongs to. */
export async function workspacesOf(registry: Registry, agent: AgentRecord): Promise<WorkspaceRecord[]> {
  const ids = agent.workspaces ?? [];
  if (ids.length === 0) return [];
  const workspaces = await registry.workspaceStore.getWorkspaces(ids);
  return workspaces.map((s) => withDefaultWorkspaceSkills(s)!);
}

/** A workspace `agent` belongs to, by id or (case-insensitive) name. */
export async function resolveMemberWorkspace(registry: Registry, agent: AgentRecord, idOrName: string): Promise<WorkspaceRecord> {
  const workspace = (await registry.workspacesOf(agent)).find((w) => w.id === idOrName || w.name.toLowerCase() === idOrName.toLowerCase());
  if (!workspace) throw new HubError('not_found', `You are not a member of a workspace "${idOrName}"`);
  return workspace;
}

export async function requireWorkspaceMembership(registry: Registry, agent: AgentRecord, workspaceId: string): Promise<WorkspaceRecord> {
  const workspace = await registry.workspaceDoc(workspaceId);
  if (!workspace || !(agent.workspaces ?? []).includes(workspaceId)) throw new HubError('not_found', 'You are not a member of that workspace');
  return workspace;
}

export async function requireWorkspaceOwner(registry: Registry, agent: AgentRecord, workspaceId: string): Promise<WorkspaceRecord> {
  if (isSuperAdmin(agent)) {
    const workspace = await registry.workspaceDoc(workspaceId);
    if (!workspace) throw new HubError('not_found', 'No such workspace');
    return workspace;
  }
  const workspace = await registry.requireWorkspaceMembership(agent, workspaceId);
  if (!isOwner(workspace, agent)) throw new HubError('forbidden', 'Only a workspace owner can do that');
  return workspace;
}

/** How many agents are in each workspace (archived bots included), one count query per workspace. */
export async function workspaceMemberCounts(registry: Registry, workspaceIds: string[]): Promise<Map<string, number>> {
  return registry.countMembers('workspaces', workspaceIds);
}

/**
 * Any member adds a person to a workspace by email: a Google-signed-in human with that email
 * joins now; otherwise a pending invite waits (30 days) for their first Google sign-in. The
 * response doesn't say which happened. (Members can still infer it: a registered person appears
 * in the member list at once instead of in pending invites. That's inherent in auto-join.)
 */
export async function inviteToWorkspace(registry: Registry, inviter: AgentRecord, workspaceIdOrName: string, rawEmail: string): Promise<WorkspaceRecord> {
  const workspace = await registry.resolveMemberWorkspace(inviter, workspaceIdOrName);
  if (isShowcaseGuest(workspace, inviter)) {
    throw new HubError('forbidden', 'Only a workspace owner can invite people to a public showcase workspace');
  }
  const email = normalizeEmail(rawEmail);
  registry.inviteLimiter?.hit(inviter.id);
  const existing = await registry.workspaceStore.findAgentByEmail(email);
  const joinsNow = !!existing?.googleSub;
  const alreadyIn = joinsNow
    ? (existing!.workspaces ?? []).includes(workspace.id)
    : (await registry.workspaceStore.listInvitesOfWorkspace(workspace.id, Date.now())).some((i) => i.email === email);
  const invite: InviteRecord = {
    workspaceId: workspace.id,
    email,
    invitedBy: inviter.id,
    invitedByName: inviter.name,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  };
  const unban = !!existing && joinsNow && (workspace.bannedAgents ?? []).includes(existing.id);
  const write = (tx?: Transaction) =>
    existing && joinsNow ? registry.workspaceStore.addAgentToWorkspace(existing.id, workspace.id, unban, tx) : registry.workspaceStore.saveInvite(invite, tx);
  if (alreadyIn) await write();
  else await addWithRoom(registry, [workspace], joinsNow ? existing! : 'invite', inviter, write);
  if (unban) workspace.bannedAgents = (workspace.bannedAgents ?? []).filter((id) => id !== existing!.id);
  // Fire and forget: a mail failure shouldn't fail the invite.
  const room = workspace.room && { goal: workspace.room.goal, workspaceId: workspace.id, ...(workspace.room.sides.find((s) => s.id === inviter.id) ? { fromSide: workspace.room.sides.find((s) => s.id === inviter.id)!.name } : {}) };
  registry.mailInvite?.({ email, workspaceName: workspace.name, invitedByName: inviter.name, ...(room ? { room } : {}) }).catch((err) => console.error('invite email failed', err));
  return workspace;
}

/**
 * Any member adds a bot they can see (one they own, a public one, or one in a workspace they
 * share) to a workspace, by id. People are invited by email instead, so nobody is pulled into a
 * workspace without signing in.
 */
export async function addToWorkspace(registry: Registry, adder: AgentRecord, workspaceIdOrName: string, agentId: string): Promise<{ workspace: WorkspaceRecord; agent: AgentRecord }> {
  const workspace = await registry.resolveMemberWorkspace(adder, workspaceIdOrName);
  if (isShowcaseGuest(workspace, adder)) {
    throw new HubError('forbidden', 'Only a workspace owner can add bots to a public showcase workspace');
  }
  const agent = await registry.requireVisible(agentId, adder);
  if (agent.kind === 'human') throw new HubError('invalid', `${agent.name} is a person: invite people to a workspace by email`);
  if (agent.archived) throw new HubError('invalid', 'Restore an archived bot before adding it');
  registry.inviteLimiter?.hit(adder.id);
  const unban = (workspace.bannedAgents ?? []).includes(agent.id);
  const write = (tx?: Transaction) => registry.workspaceStore.addAgentToWorkspace(agent.id, workspace.id, unban, tx);
  if ((agent.workspaces ?? []).includes(workspace.id)) await write();
  else await addWithRoom(registry, [workspace], agent, adder, write);
  if (unban) {
    workspace.bannedAgents = (workspace.bannedAgents ?? []).filter((id) => id !== agent.id);
  }
  agent.workspaces = [...new Set([...(agent.workspaces ?? []), workspace.id])];
  return { workspace, agent };
}

/** Pending invites for a workspace the caller belongs to. */
export async function listWorkspaceInvites(registry: Registry, member: AgentRecord, workspaceIdOrName: string): Promise<InviteRecord[]> {
  const workspace = await registry.resolveMemberWorkspace(member, workspaceIdOrName);
  if (isShowcaseGuest(workspace, member)) {
    throw new HubError('forbidden', 'Only a workspace owner can view invites in a public showcase workspace');
  }
  return registry.workspaceStore.listInvitesOfWorkspace(workspace.id, Date.now());
}

export async function revokeWorkspaceInvite(registry: Registry, member: AgentRecord, workspaceIdOrName: string, rawEmail: string): Promise<void> {
  const workspace = await registry.resolveMemberWorkspace(member, workspaceIdOrName);
  if (isShowcaseGuest(workspace, member)) {
    throw new HubError('forbidden', 'Only a workspace owner can revoke invites in a public showcase workspace');
  }
  await registry.workspaceStore.deleteInvite(workspace.id, normalizeEmail(rawEmail));
}

/** Email domains of this workspace's owners who signed in with Google (so their email is verified). */
export async function verifiedOwnerDomains(registry: Registry, workspace: WorkspaceRecord): Promise<Set<string>> {
  const ids = [...new Set([workspace.ownerId, ...(workspace.ownerIds ?? [])].filter(Boolean))];
  const owners = await registry.workspaceStore.getAgentsByIds(ids);
  return new Set(owners.filter((o) => o?.googleSub && o.email).map((o) => domainOf(o!.email!)));
}

/**
 * Owner only. Replaces the email domains whose Google sign-ins join this workspace
 * automatically (up to 10; public mail providers are refused). Each domain must be the
 * domain of a workspace owner's verified (Google) email.
 */
export async function setWorkspaceDomains(registry: Registry, owner: AgentRecord, workspaceId: string, domains: string[]): Promise<WorkspaceRecord> {
  const workspace = await registry.requireWorkspaceOwner(owner, workspaceId);
  if (!Array.isArray(domains)) throw new HubError('invalid', 'domains must be a list');
  const clean = [...new Set(domains.map((d) => normalizeDomain(String(d))))];
  if (clean.length > MAX_DOMAINS) throw new HubError('invalid', `Up to ${MAX_DOMAINS} domains`);
  const owned = await verifiedOwnerDomains(registry, workspace);
  const unowned = clean.find((d) => !owned.has(d));
  if (unowned) throw new HubError('invalid', `${unowned} isn't the domain of a workspace owner's Google sign-in email`);
  await registry.workspaceStore.setWorkspaceDomains(workspace.id, clean);
  workspace.domains = clean;
  return workspace;
}

/** Owner only: renames a workspace (including a personal workspace). */
export async function renameWorkspace(registry: Registry, owner: AgentRecord, workspaceId: string, name: string): Promise<WorkspaceRecord> {
  const workspace = await registry.requireWorkspaceOwner(owner, workspaceId);
  const clean = cleanName(name ?? '');
  if (!clean || clean.length > MAX_NAME) throw new HubError('invalid', `Workspace name is required (up to ${MAX_NAME} characters)`);
  await registry.workspaceStore.renameWorkspace(workspace.id, clean);
  workspace.name = clean;
  return workspace;
}

/**
 * Owner only: enables or disables public mode (`public` + `publicShowcase`) on a workspace.
 * When `opts.publicChannels` is provided on enable, atomically sets those channels to `open: true` + `publicFromSeq`
 * and flips any unselected existing channels in the workspace to `open: false` (and clears `publicFromSeq`),
 * so existing internal channels are never accidentally exposed when flipping a workspace to public.
 */
export async function setWorkspacePublicShowcase(
  registry: Registry,
  owner: AgentRecord,
  workspaceId: string,
  publicShowcase: boolean,
  opts?: { publicChannels?: string[]; channelSeqs?: Map<string, number>; channelSeq?: (channelId: string) => Promise<number> },
): Promise<WorkspaceRecord> {
  const workspace = await registry.requireWorkspaceOwner(owner, workspaceId);
  const wasPublic = isPublicWorkspace(workspace);
  let channelUpdates: Array<{ id: string; open: boolean; publicFromSeq?: number }> | undefined;
  if (publicShowcase && Array.isArray(opts?.publicChannels)) {
    const selected = new Set(opts.publicChannels);
    const existingChannels = await registry.workspaceStore.listWorkspaceChannels(workspace.id);
    channelUpdates = [];
    for (const ch of existingChannels) {
      if (ch.archived) continue;
      if (selected.has(ch.id)) {
        const seq =
          ch.publicFromSeq !== undefined
            ? ch.publicFromSeq
            : opts.channelSeqs?.has(ch.id)
              ? opts.channelSeqs.get(ch.id)!
              : opts.channelSeq
                ? await opts.channelSeq(ch.id)
                : 0;
        channelUpdates.push({ id: ch.id, open: true, publicFromSeq: seq });
      } else {
        channelUpdates.push({ id: ch.id, open: false });
      }
    }
  }
  await registry.workspaceStore.setWorkspacePublicShowcase(workspace.id, publicShowcase, channelUpdates);
  if (!publicShowcase && wasPublic) {
    const [members, channels] = await Promise.all([
      registry.workspaceStore.listWorkspaceMembers(workspace.id),
      registry.workspaceStore.listWorkspaceChannels(workspace.id),
    ]);
    const nonPublicChannelIds = new Set(
      channels.filter((c) => !(c.publicFromSeq !== undefined && isOpenChannel(c))).map((c) => c.id),
    );
    const channelOwnerIds = new Set(
      channels.flatMap((c) => [c.ownerId, ...(c.ownerIds ?? [])]),
    );
    const guests = members.filter(
      (m) =>
        m.kind === 'human' &&
        !isOwner(workspace, m) &&
        !channelOwnerIds.has(m.id) &&
        !(m.channels ?? []).some((cid) => nonPublicChannelIds.has(cid)),
    );
    await Promise.all(guests.map((m) => dropWorkspaceMember(registry, m, workspace, false, channels)));
  }
  if (publicShowcase) {
    workspace.public = true;
    workspace.publicShowcase = true;
  } else {
    delete workspace.public;
    delete workspace.publicShowcase;
  }
  return workspace;
}

/** Owner only: archive (or restore) a workspace. A user's last remaining active workspace cannot be archived. */
export async function setWorkspaceArchived(registry: Registry, owner: AgentRecord, workspaceId: string, archived: boolean): Promise<WorkspaceRecord> {
  const workspace = await registry.requireWorkspaceOwner(owner, workspaceId);
  if (archived) {
    const freshOwner = (await registry.get(owner.id)) ?? owner;
    const otherActive = (await registry.workspacesOf(freshOwner)).filter((w) => w.id !== workspace.id && !w.archived && !w.room);
    if (otherActive.length === 0) throw new HubError('invalid', 'Your last remaining workspace cannot be archived');
  }
  const write = (tx?: Transaction) => registry.workspaceStore.setWorkspaceArchived(workspace.id, archived, tx);
  if (!archived && workspace.archived && !workspace.room && !isSuperAdmin(owner)) {
    const creator = workspace.ownerId === owner.id ? owner : await registry.get(workspace.ownerId);
    await withWorkspaceRoom(registry, creator, write);
  } else {
    await write();
  }
  if (archived) {
    workspace.archived = true;
    await registry.purgeGraph?.({ workspaceId: workspace.id });
  } else delete workspace.archived;
  return workspace;
}

export async function leaveWorkspace(registry: Registry, agent: AgentRecord, workspaceId: string): Promise<void> {
  const workspace = await registry.requireWorkspaceMembership(agent, workspaceId);
  // ponytail: the creator can't leave, so a workspace always has an owner; co-owners can. Add transfer/delete when needed
  if (workspace.ownerId === agent.id) throw new HubError('conflict', 'The workspace creator cannot leave the workspace');
  await dropWorkspaceMember(registry, agent, workspace);
}

/** Owner only. `member` is an agent id; it must be in the workspace. In a public workspace, removing a non-owner guest also bans them from self-rejoining. */
export async function removeFromWorkspace(registry: Registry, owner: AgentRecord, workspaceId: string, member: string): Promise<void> {
  const workspace = await registry.requireWorkspaceOwner(owner, workspaceId);
  const members = await registry.workspaceStore.listWorkspaceMembers(workspace.id);
  const target = members.find((a) => a.id === member);
  if (!target) throw new HubError('not_found', `"${member}" is not a member of this workspace.${registry.idHint(member, members)}`);
  if (target.id === owner.id) throw new HubError('conflict', 'An owner cannot remove itself');
  if (target.id === workspace.ownerId) throw new HubError('forbidden', 'The workspace creator cannot be removed');
  await dropWorkspaceMember(registry, target, workspace, isPublicWorkspace(workspace) && !isOwner(workspace, target));
}

/** Owner only. Makes `member` (an agent id in the workspace) a co-owner. */
export async function addWorkspaceOwner(registry: Registry, owner: AgentRecord, workspaceId: string, member: string): Promise<WorkspaceRecord> {
  const workspace = await registry.requireWorkspaceOwner(owner, workspaceId);
  const target = await registry.get(member);
  if (!target || !(target.workspaces ?? []).includes(workspace.id)) throw new HubError('not_found', `"${member}" is not a member of this workspace`);
  if (target.id !== workspace.ownerId && !(workspace.ownerIds ?? []).includes(target.id)) {
    const write = (tx?: Transaction) => registry.workspaceStore.addWorkspaceOwnerId(workspace.id, target.id, tx);
    // A public workspace's human guest takes no seat (nor one of their Free workspaces) until made an owner; everyone else already counts.
    if (isPublicWorkspace(workspace) && target.kind === 'human')
      await addWithRoom(registry, [workspace], 'seat', owner, async (tx) => {
        await assertJoinRoom(registry, target, owner, tx);
        await write(tx);
      });
    else await write();
    workspace.ownerIds = [...new Set([...(workspace.ownerIds ?? []), target.id])];
  }
  return workspace;
}

/**
 * Removes the agent from the workspace and from every channel in it (and from their co-owners,
 * so rejoining doesn't restore ownership), in one batch.
 */
async function dropWorkspaceMember(
  registry: Registry,
  agent: AgentRecord,
  workspace: WorkspaceRecord,
  ban = false,
  workspaceChannels?: ChannelRecord[],
): Promise<void> {
  const channels =
    workspaceChannels ??
    (await registry.workspaceStore.listWorkspaceChannels(workspace.id));
  const mine = new Set(agent.channels ?? []);
  const dropped = channels.filter((c) => mine.has(c.id));
  const droppedChannelIds = dropped.map((c) => c.id);
  await registry.workspaceStore.dropWorkspaceMember(agent.id, workspace.id, droppedChannelIds, ban);
  agent.workspaces = (agent.workspaces ?? []).filter((w) => w !== workspace.id);
  agent.channels = (agent.channels ?? []).filter((c) => !dropped.some((d) => d.id === c));
}

/** Public metadata and public+open channels for a public workspace (anyone, signed in or not). */
export async function publicWorkspace(registry: Registry, workspaceId: string): Promise<{ workspace: WorkspaceRecord; channels: ChannelRecord[] }> {
  const workspace = await registry.workspaceDoc(workspaceId);
  if (!workspace || workspace.archived || !isPublicWorkspace(workspace)) {
    throw new HubError('not_found', `No public workspace "${workspaceId}"`);
  }
  const snapDocs = await registry.workspaceStore.listWorkspaceChannels(workspace.id);
  const channels = snapDocs
    .filter((c) => !c.archived && c.publicFromSeq !== undefined && isOpenChannel(c))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { workspace, channels };
}

/** Signed-in human self-joins a public workspace as a guest, entering its public+open channels. */
export async function joinPublicWorkspace(registry: Registry, agent: AgentRecord, workspaceId: string): Promise<{ workspace: WorkspaceRecord; channels: ChannelRecord[] }> {
  if (agent.kind !== 'human') throw new HubError('forbidden', 'Only people can join a public workspace');
  const { workspace, channels } = await registry.publicWorkspace(workspaceId);
  if ((workspace.bannedAgents ?? []).includes(agent.id)) {
    throw new HubError('forbidden', 'You have been removed from this public workspace');
  }
  if (channels.length === 0) {
    throw new HubError('not_found', `No public channels in workspace "${workspaceId}" you can join`);
  }
  const allowedChannels = channels.filter((c) => !(c.bannedAgents ?? []).includes(agent.id));
  if (allowedChannels.length === 0) {
    throw new HubError('forbidden', 'You have been removed from this public workspace or channel');
  }
  const existingChannels = new Set(agent.channels ?? []);
  const newChannels = allowedChannels.filter((c) => !existingChannels.has(c.id));
  const inWorkspace = (agent.workspaces ?? []).includes(workspace.id);
  if (!inWorkspace || newChannels.length > 0) {
    const newChannelIds = newChannels.map((c) => c.id);
    const write = (tx?: Transaction) => registry.workspaceStore.joinPublicWorkspace(agent.id, workspace.id, newChannelIds, inWorkspace, tx);
    if (inWorkspace) await write();
    else await addWithRoom(registry, [workspace], agent, undefined, write);
    agent.workspaces = [...new Set([...(agent.workspaces ?? []), workspace.id])];
    agent.channels = [...new Set([...(agent.channels ?? []), ...newChannelIds])];
    for (const c of newChannels) {
      await registry.onJoinChannel?.(agent.id, c.id);
    }
  }
  return { workspace, channels: allowedChannels };
}
