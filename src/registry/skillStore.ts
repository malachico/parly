import { COLLECTIONS, FieldValue, type Database } from '../db/types.js';
import type { AgentRecord, ChannelRecord, SkillRecord, WorkspaceRecord } from './types.js';

/** DB access for `skills/{id}` and skill attachment queries across workspaces, channels, and agents. */
export class SkillStore {
  constructor(private readonly db: Database) {}

  private get skills() {
    return this.db.collection(COLLECTIONS.skills);
  }

  private get agents() {
    return this.db.collection(COLLECTIONS.agents);
  }

  private get channels() {
    return this.db.collection(COLLECTIONS.channels);
  }

  private get workspaces() {
    return this.db.collection(COLLECTIONS.workspaces);
  }

  async getSkill(id: string): Promise<SkillRecord | undefined> {
    const snap = await this.skills.doc(id).get();
    if (!snap.exists) return undefined;
    const data = snap.data() as SkillRecord;
    return data.id ? data : { ...data, id: snap.id };
  }

  async getSkills(ids: string[]): Promise<SkillRecord[]> {
    if (!ids.length) return [];
    const snaps = await this.db.getAll(...ids.map((id) => this.skills.doc(id)));
    return snaps.filter((s) => s.exists).map((s) => {
      const data = s.data() as SkillRecord;
      return data.id ? data : { ...data, id: s.id };
    });
  }

  async saveSkill(skill: SkillRecord): Promise<void> {
    await this.skills.doc(skill.id).set(skill);
  }

  /**
   * Atomically reads `skills/{id}` and applies the patch computed by `compute`.
   * Fields listed in `deleteFields` are deleted via `FieldValue.delete()`.
   * Returns `undefined` when the skill does not exist.
   */
  async updateSkill(
    id: string,
    compute: (current: SkillRecord) => { record: SkillRecord; patch: Record<string, unknown>; deleteFields?: string[] },
  ): Promise<SkillRecord | undefined> {
    const ref = this.skills.doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      const current = snap.data() as SkillRecord;
      const { record, patch, deleteFields } = compute(current);
      const update: Record<string, unknown> = { ...patch };
      if (deleteFields) {
        for (const k of deleteFields) {
          update[k] = FieldValue.delete();
        }
      }
      tx.update(ref, update);
      return record;
    });
  }

  async deleteSkillAndDetach(skillId: string): Promise<void> {
    const [agentsSnap, channelsSnap, workspacesSnap] = await Promise.all([
      this.agents.where('attachedSkills', 'array-contains', skillId).get(),
      this.channels.where('attachedSkills', 'array-contains', skillId).get(),
      this.workspaces.where('attachedSkills', 'array-contains', skillId).get(),
    ]);
    const batch = this.db.batch();
    batch.delete(this.skills.doc(skillId));
    for (const d of agentsSnap.docs) batch.update(d.ref, { attachedSkills: FieldValue.arrayRemove(skillId) });
    for (const d of channelsSnap.docs) batch.update(d.ref, { attachedSkills: FieldValue.arrayRemove(skillId) });
    for (const d of workspacesSnap.docs) batch.update(d.ref, { attachedSkills: FieldValue.arrayRemove(skillId) });
    await batch.commit();
  }

  async attachSkillToAgent(agentId: string, skillId: string, addDirect: boolean, wasDetached: boolean): Promise<void> {
    await this.agents.doc(agentId).update({
      ...(addDirect ? { attachedSkills: FieldValue.arrayUnion(skillId) } : {}),
      ...(wasDetached ? { detachedSkills: FieldValue.arrayRemove(skillId) } : {}),
    });
  }

  async attachSkillToChannel(channelId: string, skillId: string, addDirect: boolean, wasDetached: boolean): Promise<void> {
    await this.channels.doc(channelId).update({
      ...(addDirect ? { attachedSkills: FieldValue.arrayUnion(skillId) } : {}),
      ...(wasDetached ? { detachedSkills: FieldValue.arrayRemove(skillId) } : {}),
    });
  }

  async attachSkillToWorkspace(workspaceId: string, skillId: string, attachedSkills: string[], isDefault: boolean): Promise<void> {
    await this.workspaces.doc(workspaceId).update({
      attachedSkills,
      ...(isDefault ? { detachedSkills: FieldValue.arrayRemove(skillId) } : {}),
    });
  }

  async detachSkillFromAgent(agentId: string, skillId: string, isInherited: boolean): Promise<void> {
    await this.agents.doc(agentId).update({
      attachedSkills: FieldValue.arrayRemove(skillId),
      ...(isInherited ? { detachedSkills: FieldValue.arrayUnion(skillId) } : {}),
    });
  }

  async detachSkillFromChannel(channelId: string, skillId: string, isInherited: boolean): Promise<void> {
    await this.channels.doc(channelId).update({
      attachedSkills: FieldValue.arrayRemove(skillId),
      ...(isInherited ? { detachedSkills: FieldValue.arrayUnion(skillId) } : {}),
    });
  }

  async detachSkillFromWorkspace(workspaceId: string, skillId: string, attachedSkills: string[], isDefault: boolean): Promise<void> {
    await this.workspaces.doc(workspaceId).update({
      attachedSkills,
      ...(isDefault ? { detachedSkills: FieldValue.arrayUnion(skillId) } : {}),
    });
  }

  async listSkillsOwnedBy(ownerId: string): Promise<SkillRecord[]> {
    const snap = await this.skills.where('ownerId', '==', ownerId).get();
    return snap.docs.map((d) => {
      const data = d.data() as SkillRecord;
      return data.id ? data : { ...data, id: d.id };
    });
  }

  /** Skills created for one workspace or channel (their `scope`). */
  async listSkillsScopedTo(kind: 'workspace' | 'channel', id: string): Promise<SkillRecord[]> {
    const snap = await this.skills.where('scope.kind', '==', kind).where('scope.id', '==', id).get();
    return snap.docs.map((d) => {
      const data = d.data() as SkillRecord;
      return data.id ? data : { ...data, id: d.id };
    });
  }

  async listSkillsCoOwnedBy(ownerId: string): Promise<SkillRecord[]> {
    const snap = await this.skills.where('ownerIds', 'array-contains', ownerId).get();
    return snap.docs.map((d) => {
      const data = d.data() as SkillRecord;
      return data.id ? data : { ...data, id: d.id };
    });
  }

  async listChannelsOfWorkspaces(workspaceIds: string[]): Promise<ChannelRecord[]> {
    if (!workspaceIds.length) return [];
    const snaps = await Promise.all(workspaceIds.map((wid) => this.channels.where('workspaceId', '==', wid).get()));
    return snaps.flatMap((s) => s.docs.map((d) => d.data() as ChannelRecord));
  }

  async listMembersOfWorkspaces(workspaceIds: string[]): Promise<AgentRecord[]> {
    if (!workspaceIds.length) return [];
    const snaps = await Promise.all(workspaceIds.map((wid) => this.agents.where('workspaces', 'array-contains', wid).get()));
    return snaps.flatMap((s) => s.docs.map((d) => d.data() as AgentRecord));
  }

  async listMembersOfChannels(channelIds: string[]): Promise<AgentRecord[]> {
    if (!channelIds.length) return [];
    const snaps = await Promise.all(channelIds.map((cid) => this.agents.where('channels', 'array-contains', cid).get()));
    return snaps.flatMap((s) => s.docs.map((d) => d.data() as AgentRecord));
  }

  async listScopesWithAttachedSkill(skillId: string): Promise<{
    channels: ChannelRecord[];
    workspaces: WorkspaceRecord[];
    agents: AgentRecord[];
  }> {
    const [channelsSnap, workspacesSnap, agentsSnap] = await Promise.all([
      this.channels.where('attachedSkills', 'array-contains', skillId).get(),
      this.workspaces.where('attachedSkills', 'array-contains', skillId).get(),
      this.agents.where('attachedSkills', 'array-contains', skillId).get(),
    ]);
    return {
      channels: channelsSnap.docs.map((d) => d.data() as ChannelRecord),
      workspaces: workspacesSnap.docs.map((d) => d.data() as WorkspaceRecord),
      agents: agentsSnap.docs.map((d) => d.data() as AgentRecord),
    };
  }
}
