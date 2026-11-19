import { COLLECTIONS, FieldValue, type Database, type Transaction } from '../db/types.js';
import type { AgentRecord, AgentStatus, ChannelRecord, WorkspaceRecord } from './types.js';

/** DB access for channels, channel membership and agents' status log. */
export class ChannelStore {
  constructor(private readonly db: Database) {}

  private get channels() {
    return this.db.collection(COLLECTIONS.channels);
  }

  private get agents() {
    return this.db.collection(COLLECTIONS.agents);
  }

  private get workspaces() {
    return this.db.collection(COLLECTIONS.workspaces);
  }

  private get statusLogs() {
    return this.db.collection(COLLECTIONS.statusLog);
  }

  async createWithOwner(channel: ChannelRecord, creatorId: string): Promise<void> {
    const batch = this.db.batch();
    batch.create(this.channels.doc(channel.id), channel);
    batch.update(this.agents.doc(creatorId), { channels: FieldValue.arrayUnion(channel.id) });
    await batch.commit();
  }

  /** Existing channels among `ids`, as [doc id, record], in one batched read. */
  async getMany(ids: string[]): Promise<Array<[string, ChannelRecord]>> {
    const snaps = await this.db.getAll(...ids.map((id) => this.channels.doc(id)));
    return snaps.filter((s) => s.exists).map((s) => [s.id, s.data() as ChannelRecord]);
  }

  async update(channelId: string, fields: Record<string, unknown>): Promise<void> {
    await this.channels.doc(channelId).update(fields);
  }

  async updateChannel(channelId: string, fields: Partial<ChannelRecord>, goPrivate: boolean): Promise<void> {
    await this.channels.doc(channelId).update({ ...fields, ...(goPrivate ? { publicFromSeq: FieldValue.delete() } : {}) });
  }

  async addOwner(channelId: string, agentId: string): Promise<void> {
    await this.channels.doc(channelId).update({ ownerIds: FieldValue.arrayUnion(agentId) });
  }

  /** Adds `post` to (or removes it from) one of a channel's thread lists. */
  async setThreadFlag(channelId: string, field: 'publicThreads' | 'doneThreads', post: string, on: boolean): Promise<void> {
    await this.channels.doc(channelId).update({ [field]: on ? FieldValue.arrayUnion(post) : FieldValue.arrayRemove(post) });
  }

  async join(agentId: string, channelId: string, workspaceId: string | undefined, tx?: Transaction): Promise<void> {
    const fields = { ...(workspaceId ? { workspaces: FieldValue.arrayUnion(workspaceId) } : {}), channels: FieldValue.arrayUnion(channelId) };
    if (tx) tx.update(this.agents.doc(agentId), fields);
    else await this.agents.doc(agentId).update(fields);
  }

  /** Puts the agent in the channel, lifting its ban there and, given `unbanWorkspaceId`, in that workspace. */
  async addMember(agentId: string, channelId: string, unbanChannel: boolean, unbanWorkspaceId: string | undefined): Promise<void> {
    const batch = this.db.batch();
    batch.update(this.agents.doc(agentId), { channels: FieldValue.arrayUnion(channelId) });
    if (unbanChannel) batch.update(this.channels.doc(channelId), { bannedAgents: FieldValue.arrayRemove(agentId) });
    if (unbanWorkspaceId) batch.update(this.workspaces.doc(unbanWorkspaceId), { bannedAgents: FieldValue.arrayRemove(agentId) });
    await batch.commit();
  }

  async dropMember(agentId: string, channelId: string, ban: boolean): Promise<void> {
    const batch = this.db.batch();
    batch.update(this.agents.doc(agentId), { channels: FieldValue.arrayRemove(channelId) });
    batch.update(this.channels.doc(channelId), {
      ownerIds: FieldValue.arrayRemove(agentId),
      [`roles.${agentId}`]: FieldValue.delete(),
      ...(ban ? { bannedAgents: FieldValue.arrayUnion(agentId) } : {}),
    });
    await batch.commit();
  }

  /**
   * Sets (or, with an empty role, clears) a member's role in one transaction that first reads the member, the channel
   * and its workspace and hands them to `check`, which throws to abort. Returns the channel as read.
   */
  async setRole(
    channelId: string,
    workspaceId: string,
    memberId: string,
    role: string,
    check: (member: AgentRecord | undefined, channel: ChannelRecord | undefined, workspace: WorkspaceRecord | undefined) => void,
  ): Promise<ChannelRecord> {
    return this.db.runTransaction(async (tx) => {
      const [memberSnap, channelSnap, workspaceSnap] = await Promise.all([
        tx.get(this.agents.doc(memberId)),
        tx.get(this.channels.doc(channelId)),
        tx.get(this.workspaces.doc(workspaceId)),
      ]);
      const current = channelSnap.data() as ChannelRecord | undefined;
      check(memberSnap.data() as AgentRecord | undefined, current, workspaceSnap.data() as WorkspaceRecord | undefined);
      tx.update(this.channels.doc(channelId), { [`roles.${memberId}`]: role ? role : FieldValue.delete() });
      return current!;
    });
  }

  async setStatus(agentId: string, status: AgentStatus | null): Promise<void> {
    await this.agents.doc(agentId).update({ status: status ?? FieldValue.delete() });
  }

  /** Clears the agent's status, in one transaction, if `matches` says it's still the one to clear. */
  async clearStatusIf(agentId: string, matches: (status: AgentStatus) => boolean): Promise<void> {
    const ref = this.agents.doc(agentId);
    await this.db.runTransaction(async (tx) => {
      const status = ((await tx.get(ref)).data() as AgentRecord | undefined)?.status;
      if (status && matches(status)) tx.update(ref, { status: FieldValue.delete() });
    });
  }

  async addStatusLog(entry: AgentStatus & { agentId: string; auto?: true; expiresAt: Date }): Promise<void> {
    await this.statusLogs.add(entry);
  }

  /** An agent's status log, newest first, at most `limit`, only before `before` when given. */
  async statusLog(agentId: string, before: string | undefined, limit: number): Promise<AgentStatus[]> {
    let q = this.statusLogs.where('agentId', '==', agentId);
    if (before) q = q.where('at', '<', before);
    const snap = await q.orderBy('at', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as AgentStatus);
  }
}
