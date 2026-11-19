import { COLLECTIONS, FieldValue, type Database } from '../db/types.js';
import type { AgentRecord, InviteRecord, WorkspaceRecord } from './types.js';

/** DB access for sign-in: token and session lookups, password-claim markers, sessions and invite/domain joins. */
export class AuthStore {
  constructor(private readonly db: Database) {}

  private get agents() {
    return this.db.collection(COLLECTIONS.agents);
  }

  private get claims() {
    return this.db.collection(COLLECTIONS.passwordClaims);
  }

  private get invites() {
    return this.db.collection(COLLECTIONS.invites);
  }

  private get workspaces() {
    return this.db.collection(COLLECTIONS.workspaces);
  }

  async agent(id: string): Promise<AgentRecord | undefined> {
    return (await this.agents.doc(id).get()).data() as AgentRecord | undefined;
  }

  /** The agent whose main token has this hash, and the one with a web session of it: both queries at once. */
  async byTokenHash(hash: string): Promise<{ main: AgentRecord | undefined; session: AgentRecord | undefined }> {
    const [main, session] = await Promise.all([
      this.agents.where('tokenHash', '==', hash).limit(1).get(),
      this.agents.where('sessionHashes', 'array-contains', hash).limit(1).get(),
    ]);
    return { main: main.docs[0]?.data() as AgentRecord | undefined, session: session.docs[0]?.data() as AgentRecord | undefined };
  }

  /** The first agent with this email or Google account. */
  async findBy(field: 'email' | 'googleSub', value: string): Promise<AgentRecord | undefined> {
    return (await this.agents.where(field, '==', value).limit(1).get()).docs[0]?.data() as AgentRecord | undefined;
  }

  /** Plain field writes on one agent. */
  async update(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.agents.doc(id).update(fields);
  }

  /** Deletes the agent's password and every web session, along with `fields`. */
  async dropPassword(id: string, fields: Record<string, unknown> = {}): Promise<void> {
    await this.agents.doc(id).update({ passwordHash: FieldValue.delete(), sessionHashes: [], ...fields });
  }

  /** Archives these bots, each with the given new token hash, in one batch. */
  async archiveBots(bots: Array<{ id: string; tokenHash: string }>): Promise<void> {
    const batch = this.db.batch();
    for (const bot of bots) batch.update(this.agents.doc(bot.id), { archived: true, tokenHash: bot.tokenHash });
    await batch.commit();
  }

  async deleteAgent(id: string): Promise<void> {
    await this.agents.doc(id).delete();
  }

  async removeSession(id: string, hash: string): Promise<void> {
    await this.agents.doc(id).update({ sessionHashes: FieldValue.arrayRemove(hash) });
  }

  /**
   * Sets the agent's sessions, in one transaction, to what `next` makes of the current record (it throws to abort).
   * Returns what was written.
   */
  async setSessions(id: string, next: (current: AgentRecord | undefined) => string[]): Promise<string[]> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.agents.doc(id);
      const current = (await tx.get(ref)).data() as AgentRecord | undefined;
      const sessions = next(current);
      tx.update(ref, { sessionHashes: sessions });
      return sessions;
    });
  }

  /** Creates the claim marker; fails (gRPC code 6, ALREADY_EXISTS) if it exists. */
  async createClaim(key: string, data: Record<string, unknown>): Promise<void> {
    await this.claims.doc(key).create(data);
  }

  async releaseClaim(key: string): Promise<void> {
    await this.claims.doc(key).delete();
  }

  /**
   * In one transaction: reads the claim and whether any agent has `email`; if `stale` says so, re-stamps the claim
   * with `at`. Returns whether it did.
   */
  async retakeClaim(key: string, email: string, stale: (claim: Record<string, unknown> | undefined, someoneHasEmail: boolean) => boolean, at: () => string): Promise<boolean> {
    const ref = this.claims.doc(key);
    return this.db.runTransaction(async (tx) => {
      const [claim, people] = await Promise.all([tx.get(ref), tx.get(this.agents.where('email', '==', email).limit(1))]);
      if (!stale(claim.data(), !people.empty)) return false;
      tx.set(ref, { at: at() });
      return true;
    });
  }

  /** Every workspace invite for this email, expired ones too, as [doc id, record]. */
  async invitesFor(email: string): Promise<Array<[string, InviteRecord]>> {
    const snap = await this.invites.where('email', '==', email).get();
    return snap.docs.map((d) => [d.id, d.data() as InviteRecord]);
  }

  /**
   * One batch: joins `workspaceIds` (lifting the agent's ban in each), sets `referredBy` when given, and deletes the
   * invites `inviteIds`.
   */
  async acceptInvites(agentId: string, workspaceIds: string[], referredBy: string | undefined, inviteIds: string[]): Promise<void> {
    const batch = this.db.batch();
    if (workspaceIds.length) {
      batch.update(this.agents.doc(agentId), { workspaces: FieldValue.arrayUnion(...workspaceIds) });
      for (const wid of workspaceIds) {
        batch.update(this.workspaces.doc(wid), { bannedAgents: FieldValue.arrayRemove(agentId) });
      }
    }
    if (referredBy) batch.update(this.agents.doc(agentId), { referredBy });
    for (const id of inviteIds) batch.delete(this.invites.doc(id));
    await batch.commit();
  }

  /** Workspaces that take this email domain, as [doc id, record]. */
  async workspacesWithDomain(domain: string): Promise<Array<[string, WorkspaceRecord]>> {
    const snap = await this.workspaces.where('domains', 'array-contains', domain).get();
    return snap.docs.map((d) => [d.id, d.data() as WorkspaceRecord]);
  }
}
