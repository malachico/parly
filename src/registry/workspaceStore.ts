import { COLLECTIONS, FieldValue, toMillis, type Database, type Transaction } from '../db/types.js';
import type { AgentRecord, ChannelRecord, InviteRecord, RoomInfo, WorkspaceRecord } from './types.js';

/** DB access for workspaces, workspace invites, and workspace membership mutations. */
export class WorkspaceStore {
  constructor(private readonly db: Database) {}

  private get workspaces() {
    return this.db.collection(COLLECTIONS.workspaces);
  }

  private get invites() {
    return this.db.collection(COLLECTIONS.invites);
  }

  private get channels() {
    return this.db.collection(COLLECTIONS.channels);
  }

  private get agents() {
    return this.db.collection(COLLECTIONS.agents);
  }

  async getWorkspaces(ids: string[], tx?: Transaction): Promise<WorkspaceRecord[]> {
    if (!ids.length) return [];
    const refs = ids.map((id) => this.workspaces.doc(id));
    const snaps = await (tx ? tx.getAll(...refs) : this.db.getAll(...refs));
    return snaps.filter((s) => s.exists).map((s) => {
      const data = s.data() as WorkspaceRecord;
      return data.id ? data : { ...data, id: s.id };
    });
  }

  async listAppRooms(appId: string, limit = 100): Promise<WorkspaceRecord[]> {
    const snap = await this.workspaces.where('room.appId', '==', appId).orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as WorkspaceRecord);
  }

  async updateRoom(workspaceId: string, change: (room: RoomInfo | undefined) => RoomInfo): Promise<RoomInfo | undefined> {
    const ref = this.workspaces.doc(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as WorkspaceRecord | undefined;
      if (!current) return undefined;
      const room = change(current.room);
      tx.update(ref, { room });
      return room;
    });
  }

  async setRoomRole(channelId: string, memberId: string, role: string): Promise<void> {
    await this.channels.doc(channelId).update({ [`roles.${memberId}`]: role });
  }

  /** The person's agent doc, read in `tx` (which locks agents for the plan checks). */
  async agentIn(tx: Transaction, id: string): Promise<AgentRecord | undefined> {
    return (await tx.get(this.agents.doc(id))).data() as AgentRecord | undefined;
  }

  async workspaceIn(tx: Transaction, id: string): Promise<WorkspaceRecord | undefined> {
    const snap = await tx.get(this.workspaces.doc(id));
    return snap.exists ? { ...(snap.data() as WorkspaceRecord), id } : undefined;
  }

  /** Buffers `fn`'s writes in `tx` when given (a plan check's transaction), else commits them as one batch. */
  private async write(tx: Transaction | undefined, fn: (w: Transaction | ReturnType<Database['batch']>) => void): Promise<void> {
    if (tx) return fn(tx);
    const batch = this.db.batch();
    fn(batch);
    await batch.commit();
  }

  async createWorkspaceForOwner(workspace: WorkspaceRecord, ownerId: string, tx?: Transaction): Promise<void> {
    await this.write(tx, (w) => {
      w.create(this.workspaces.doc(workspace.id), workspace);
      w.update(this.agents.doc(ownerId), { workspaces: FieldValue.arrayUnion(workspace.id) });
    });
  }

  async setWorkspaceDomains(id: string, domains: string[]): Promise<void> {
    await this.workspaces.doc(id).update({ domains });
  }

  async renameWorkspace(id: string, name: string): Promise<void> {
    await this.workspaces.doc(id).update({ name });
  }

  async setWorkspaceArchived(id: string, archived: boolean, tx?: Transaction): Promise<void> {
    await this.write(tx, (w) => w.update(this.workspaces.doc(id), { archived: archived || FieldValue.delete() }));
  }

  async addWorkspaceOwnerId(id: string, ownerId: string, tx?: Transaction): Promise<void> {
    await this.write(tx, (w) => w.update(this.workspaces.doc(id), { ownerIds: FieldValue.arrayUnion(ownerId) }));
  }

  // ---- Workspace Invites & Members -----------------------------------------------------------

  async findAgentByEmail(email: string): Promise<AgentRecord | undefined> {
    return (await this.agents.where('email', '==', email).limit(1).get()).docs[0]?.data() as AgentRecord | undefined;
  }

  async getAgentsByIds(ids: string[]): Promise<AgentRecord[]> {
    if (!ids.length) return [];
    const snaps = await this.db.getAll(...ids.map((id) => this.agents.doc(id)));
    return snaps.map((s) => s.data() as AgentRecord | undefined).filter((a): a is AgentRecord => a !== undefined);
  }

  async saveInvite(invite: InviteRecord, tx?: Transaction): Promise<void> {
    await this.write(tx, (w) => w.set(this.invites.doc(`${invite.workspaceId}:${invite.email}`), invite));
  }

  async deleteInvite(workspaceId: string, email: string): Promise<void> {
    await this.invites.doc(`${workspaceId}:${email}`).delete();
  }

  async listInvitesOfWorkspace(workspaceId: string, now: number, tx?: Transaction): Promise<InviteRecord[]> {
    const query = this.invites.where('workspaceId', '==', workspaceId);
    const snap = await (tx ? tx.get(query) : query.get());
    return snap.docs
      .map((d) => d.data() as InviteRecord)
      .filter((i) => toMillis(i.expiresAt) > now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addAgentToWorkspace(agentId: string, workspaceId: string, unban = false, tx?: Transaction): Promise<void> {
    await this.write(tx, (w) => {
      w.update(this.agents.doc(agentId), { workspaces: FieldValue.arrayUnion(workspaceId) });
      if (unban) w.update(this.workspaces.doc(workspaceId), { bannedAgents: FieldValue.arrayRemove(agentId) });
    });
  }

  async dropWorkspaceMember(
    agentId: string,
    workspaceId: string,
    droppedChannelIds: string[],
    ban = false,
  ): Promise<void> {
    const batch = this.db.batch();
    batch.update(this.agents.doc(agentId), {
      workspaces: FieldValue.arrayRemove(workspaceId),
      ...(droppedChannelIds.length ? { channels: FieldValue.arrayRemove(...droppedChannelIds) } : {}),
    });
    batch.update(this.workspaces.doc(workspaceId), {
      ownerIds: FieldValue.arrayRemove(agentId),
      ...(ban ? { bannedAgents: FieldValue.arrayUnion(agentId) } : {}),
    });
    for (const cid of droppedChannelIds) {
      batch.update(this.channels.doc(cid), {
        ownerIds: FieldValue.arrayRemove(agentId),
        [`roles.${agentId}`]: FieldValue.delete(),
      });
    }
    await batch.commit();
  }

  async joinPublicWorkspace(
    agentId: string,
    workspaceId: string,
    newChannelIds: string[],
    inWorkspace: boolean,
    tx?: Transaction,
  ): Promise<void> {
    await this.write(tx, (w) => w.update(this.agents.doc(agentId), {
      ...(inWorkspace ? {} : { workspaces: FieldValue.arrayUnion(workspaceId) }),
      ...(newChannelIds.length ? { channels: FieldValue.arrayUnion(...newChannelIds) } : {}),
    }));
  }

  async setWorkspacePublicShowcase(
    workspaceId: string,
    publicShowcase: boolean,
    channelUpdates?: Array<{ id: string; open: boolean; publicFromSeq?: number }>,
  ): Promise<void> {
    const batch = this.db.batch();
    batch.update(this.workspaces.doc(workspaceId), {
      public: publicShowcase ? true : FieldValue.delete(),
      publicShowcase: publicShowcase ? true : FieldValue.delete(),
    });
    if (channelUpdates) {
      for (const u of channelUpdates) {
        if (u.open && u.publicFromSeq !== undefined) {
          batch.update(this.channels.doc(u.id), { open: true, publicFromSeq: u.publicFromSeq });
        } else {
          batch.update(this.channels.doc(u.id), { open: false, publicFromSeq: FieldValue.delete() });
        }
      }
    }
    await batch.commit();
  }

  async listWorkspaceChannels(workspaceId: string): Promise<ChannelRecord[]> {
    const snap = await this.channels.where('workspaceId', '==', workspaceId).get();
    return snap.docs.map((d) => d.data() as ChannelRecord);
  }

  async listWorkspaceMembers(workspaceId: string, tx?: Transaction): Promise<AgentRecord[]> {
    const query = this.agents.where('workspaces', 'array-contains', workspaceId);
    const snap = await (tx ? tx.get(query) : query.get());
    return snap.docs.map((d) => d.data() as AgentRecord);
  }
}
