import { COLLECTIONS, FieldValue, toMillis, type Database, type Query, type Transaction } from '../db/types.js';
import { BILLING, limitsOf, type BillingRecord } from '../lib/plans.js';
import type { AgentRecord, ChannelRecord, RoutineSetup, WakeRecord, WorkspaceRecord } from './types.js';

type Fire = { at: string; ok: boolean };

/** DB access for `agents/{id}`, pairing codes, and the agent-side reads and writes of Registry. */
export class AgentStore {
  constructor(private readonly db: Database) {}

  get col() {
    return this.db.collection(COLLECTIONS.agents);
  }

  get workspaceCol() {
    return this.db.collection(COLLECTIONS.workspaces);
  }

  get channelCol() {
    return this.db.collection(COLLECTIONS.channels);
  }

  get inviteCol() {
    return this.db.collection(COLLECTIONS.invites);
  }

  get skillCol() {
    return this.db.collection(COLLECTIONS.skills);
  }

  private get pairings() {
    return this.db.collection(COLLECTIONS.pairings);
  }

  private read(q: Query): Promise<AgentRecord[]> {
    return q.get().then((snap) => snap.docs.map((d) => d.data() as AgentRecord));
  }

  // ---- Single agents ------------------------------------------------------------------------

  async get(id: string): Promise<AgentRecord | undefined> {
    const snap = await this.col.doc(id).get();
    return snap.exists ? (snap.data() as AgentRecord) : undefined;
  }

  async getMany(ids: string[]): Promise<AgentRecord[]> {
    const snaps = await this.db.getAll(...ids.map((id) => this.col.doc(id)));
    return snaps.filter((s) => s.exists).map((s) => s.data() as AgentRecord);
  }

  async create(agent: AgentRecord): Promise<void> {
    await this.col.doc(agent.id).create(agent);
  }

  /** Plain field writes on one agent (no deletes, no array ops). */
  async update(id: string, fields: Record<string, unknown>, tx?: Transaction): Promise<void> {
    if (tx) tx.update(this.col.doc(id), fields);
    else await this.col.doc(id).update(fields);
  }

  /**
   * Registration's write: `fields` as given, each of `orDelete` set or deleted when undefined,
   * and wake deleted when `dropWake`.
   */
  async saveRegistration(id: string, fields: Record<string, unknown>, orDelete: Record<string, unknown>, dropWake: boolean): Promise<void> {
    const gone = (v: unknown) => v ?? FieldValue.delete();
    await this.col.doc(id).update({
      ...fields,
      ...Object.fromEntries(Object.entries(orDelete).map(([k, v]) => [k, gone(v)])),
      ...(dropWake ? { wake: FieldValue.delete() } : {}),
    });
  }

  async addChannel(id: string, channelId: string): Promise<void> {
    await this.col.doc(id).update({ channels: FieldValue.arrayUnion(channelId) });
  }

  async setAuthProblem(id: string, problem: string | undefined): Promise<void> {
    await this.col.doc(id).update({ authProblem: problem ?? FieldValue.delete() });
  }

  async clearWake(id: string): Promise<void> {
    await this.col.doc(id).update({ wake: FieldValue.delete() });
  }

  async clearTelegramBot(id: string): Promise<void> {
    await this.col.doc(id).update({ telegramBot: FieldValue.delete() });
  }

  /** Moves listeningUntil forward to `until` (never back); returns the value now stored. */
  async extendListening(id: string, until: number): Promise<string> {
    const ref = this.col.doc(id);
    return this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).get('listeningUntil') as string | undefined;
      if (current && Date.parse(current) >= until) return current;
      const next = new Date(until).toISOString();
      tx.update(ref, { listeningUntil: next });
      return next;
    });
  }

  /** Deletes the agent and, when `withOwned`, the bots it owns; returns every deleted id. */
  async deleteAgent(id: string, withOwned: boolean): Promise<string[]> {
    const batch = this.db.batch();
    const ids = [id];
    batch.delete(this.col.doc(id));
    if (withOwned) {
      for (const d of (await this.col.where('ownerId', '==', id).get()).docs) {
        batch.delete(d.ref);
        ids.push(d.id);
      }
    }
    await batch.commit();
    return ids;
  }

  // ---- Queries ------------------------------------------------------------------------------

  async ownedBy(ownerId: string): Promise<AgentRecord[]> {
    return this.read(this.col.where('ownerId', '==', ownerId));
  }

  async listByName(): Promise<AgentRecord[]> {
    return this.read(this.col.orderBy('name'));
  }

  async publicAgents(): Promise<AgentRecord[]> {
    return this.read(this.col.where('public', '==', true));
  }

  /** Agents whose array `field` holds any of `ids` (at most 30, a legacy array-contains-any cap). */
  async withAny(field: string, ids: string[]): Promise<AgentRecord[]> {
    return this.read(this.col.where(field, 'array-contains-any', ids));
  }

  /** Agents whose array `field` (channels, workspaces) holds `id`. */
  async membersOf(field: string, id: string): Promise<AgentRecord[]> {
    return this.read(this.col.where(field, 'array-contains', id));
  }

  async memberCount(field: string, id: string): Promise<number> {
    return (await this.col.where(field, 'array-contains', id).count().get()).data().count;
  }

  /** A person's billing record for their workspace and participant caps: a Free person gets Pro's when `workspaceId`'s pool, or the pool they're billed to, is on Team. */
  async billingOf(ownerId: string, workspaceId?: string): Promise<BillingRecord | undefined> {
    const own = (await this.db.collection(BILLING).doc(ownerId).get()).data() as BillingRecord | undefined;
    if (limitsOf(own, 0).plan !== 'free') return own;
    const team = async (id?: string) => !!id && limitsOf((await this.db.collection(BILLING).doc(id).get()).data() as BillingRecord | undefined, 0).plan === 'team';
    const pro = (await team(workspaceId)) || (await team(((await this.col.doc(ownerId).get()).data() as AgentRecord | undefined)?.billingAccountId));
    return pro ? { ...own, ownerId, plan: 'pro' } : own;
  }

  async workspaceDoc(id: string): Promise<WorkspaceRecord | undefined> {
    return (await this.workspaceCol.doc(id).get()).data() as WorkspaceRecord | undefined;
  }

  async channelDoc(id: string): Promise<ChannelRecord | undefined> {
    return (await this.channelCol.doc(id).get()).data() as ChannelRecord | undefined;
  }

  // ---- Rooms --------------------------------------------------------------------------------

  async archiveRoomAgents(workspaceId: string): Promise<void> {
    const members = await this.col.where('workspaces', 'array-contains', workspaceId).get();
    const batch = this.db.batch();
    for (const doc of members.docs) {
      const agent = doc.data() as AgentRecord;
      if (agent.kind !== 'human' && !agent.ownerId) batch.update(doc.ref, { archived: true });
    }
    await batch.commit();
  }

  async discardRoom(workspaceId: string): Promise<void> {
    const [members, channels] = await Promise.all([
      this.col.where('workspaces', 'array-contains', workspaceId).get(),
      this.channelCol.where('workspaceId', '==', workspaceId).get(),
    ]);
    const channelIds = channels.docs.map((d) => d.id);
    const batch = this.db.batch();
    for (const doc of members.docs) {
      const agent = doc.data() as AgentRecord;
      batch.update(doc.ref, {
        workspaces: FieldValue.arrayRemove(workspaceId),
        ...(channelIds.length ? { channels: FieldValue.arrayRemove(...channelIds) } : {}),
        ...(agent.kind !== 'human' && !agent.ownerId ? { archived: true } : {}),
      });
    }
    batch.update(this.workspaceCol.doc(workspaceId), { archived: true });
    await batch.commit();
  }

  // ---- Pairing codes ------------------------------------------------------------------------

  async createPairing(hash: string, data: { ownerId: string; expiresAt: Date; name?: string; agentId?: string }): Promise<void> {
    await this.pairings.doc(hash).create(data);
  }

  /** Deletes the pairing (once) and returns it with its expiry in ms, or undefined if there was none. */
  async takePairing(hash: string): Promise<{ ownerId: string; name?: string; agentId?: string; expiresMs: number } | undefined> {
    const ref = this.pairings.doc(hash);
    const pairing = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) tx.delete(ref);
      return snap.data() as { ownerId: string; name?: string; agentId?: string; expiresAt: string | Date | { toMillis(): number } } | undefined;
    });
    if (!pairing) return undefined;
    // ISO strings from older docs; Date/Timestamp once TTL fieldOverride applies.
    const expiresMs = typeof pairing.expiresAt === 'string' ? Date.parse(pairing.expiresAt) : toMillis(pairing.expiresAt);
    return { ...pairing, expiresMs };
  }

  // ---- Routines and wakes -------------------------------------------------------------------

  async noteRoutineSetup(ownerId: string, at: string, note: { sessionUrl?: string; problem?: string }): Promise<void> {
    const ref = this.col.doc(ownerId);
    await this.db.runTransaction(async (tx) => {
      const setup = (await tx.get(ref)).get('routineSetup') as RoutineSetup | undefined;
      if (setup?.at !== at) return;
      tx.update(ref, { routineSetup: { ...setup, ...note } });
    });
  }

  /** Points `agentId` at the routine: other agents of `ownerId` on it lose their wake, and the owner's setup ends. */
  async attachRoutine(agentId: string, ownerId: string, routineId: string, wake: WakeRecord): Promise<void> {
    const before = await this.col.where('wake.routineId', '==', routineId).get();
    const batch = this.db.batch();
    for (const d of before.docs) if (d.id !== agentId && d.get('ownerId') === ownerId) batch.update(d.ref, { wake: FieldValue.delete() });
    batch.update(this.col.doc(agentId), { wake });
    batch.update(this.col.doc(ownerId), { routineSetup: FieldValue.delete() });
    await batch.commit();
  }

  async wakeable(limit: number): Promise<AgentRecord[]> {
    return this.read(this.col.where('wake.type', 'in', ['claude-routine', 'webhook', 'computer']).limit(limit));
  }

  async endpoints(limit: number): Promise<AgentRecord[]> {
    return this.read(this.col.where('kind', '==', 'endpoint').limit(limit));
  }

  async claimFire(agentId: string, seenAt: string | undefined): Promise<WakeRecord | undefined> {
    const ref = this.col.doc(agentId);
    return this.db.runTransaction(async (tx) => {
      const wake = (await tx.get(ref)).get('wake') as WakeRecord | undefined;
      if (!wake || wake.lastFire?.at !== seenAt) return undefined;
      const lastFire = { at: new Date().toISOString(), ok: true };
      tx.update(ref, { 'wake.lastFire': lastFire });
      return { ...wake, lastFire };
    });
  }

  async claimConversationFires(
    agentId: string,
    waiting: string[],
    due: (lastFires: Record<string, Fire>) => string[],
  ): Promise<{ wake: WakeRecord; conversations: string[] } | undefined> {
    const ref = this.col.doc(agentId);
    return this.db.runTransaction(async (tx) => {
      const wake = (await tx.get(ref)).get('wake') as WakeRecord | undefined;
      if (!wake?.perConversation) return undefined;
      const conversations = due(wake.lastFires ?? {});
      if (conversations.length === 0) return undefined;
      const lastFire = { at: new Date().toISOString(), ok: true };
      const fires = Object.entries(wake.lastFires ?? {}).filter(([c]) => waiting.includes(c));
      const lastFires = Object.fromEntries([...fires, ...conversations.map((c) => [c, lastFire] as const)]);
      tx.update(ref, { 'wake.lastFire': lastFire, 'wake.lastFires': lastFires });
      return { wake: { ...wake, lastFire, lastFires }, conversations };
    });
  }

  async failConversationFires(agentId: string, at: string, conversations: string[]): Promise<void> {
    const ref = this.col.doc(agentId);
    await this.db.runTransaction(async (tx) => {
      const wake = (await tx.get(ref)).get('wake') as WakeRecord | undefined;
      if (wake?.lastFire?.at !== at) return;
      tx.update(ref, { 'wake.lastFires': { ...wake.lastFires, ...Object.fromEntries(conversations.map((c) => [c, { at, ok: false }])) } });
    });
  }

  async recordFire(agentId: string, at: string, result: { sessionUrl?: string } | { problem: string }): Promise<void> {
    const ok = !('problem' in result);
    const ref = this.col.doc(agentId);
    await this.db.runTransaction(async (tx) => {
      // Disconnected or connected anew meanwhile: this fire is no longer its last.
      const wake = (await tx.get(ref)).get('wake') as WakeRecord | undefined;
      if (wake?.lastFire?.at !== at) return;
      tx.update(ref, {
        'wake.lastFire': { at, ok, ...(ok && result.sessionUrl ? { sessionUrl: result.sessionUrl } : {}) },
        'wake.problem': ok ? FieldValue.delete() : result.problem,
      });
    });
  }
}
