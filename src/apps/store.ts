import { FieldValue, type Database } from '../db/types.js';
import type { AppKeyRecord, AppRecord } from './apps.js';
import type { AppAgent } from './appAgents.js';
import type { EventRecord } from './webhooks.js';

/** Persistence for workspace apps, API keys, app agents, and app webhook events. */
export class AppsStore {
  private readonly apps;
  private readonly keys;
  private readonly agents;
  private readonly events;

  constructor(private readonly db: Database) {
    this.apps = db.collection('apps');
    this.keys = db.collection('app_keys');
    this.agents = db.collection('app_agents');
    this.events = db.collection('app_events');
  }

  // ---- apps & API keys --------------------------------------------------------------------------

  async createApp(app: AppRecord): Promise<void> {
    await this.apps.doc(app.id).create(app);
  }

  async getApp(appId: string): Promise<AppRecord | undefined> {
    return (await this.apps.doc(appId).get()).data() as AppRecord | undefined;
  }

  async listAppsByWorkspace(workspaceId: string): Promise<AppRecord[]> {
    return (await this.apps.where('workspaceId', '==', workspaceId).get()).docs.map((d) => d.data() as AppRecord);
  }

  async deleteApp(appId: string): Promise<void> {
    await this.apps.doc(appId).delete();
  }

  async createKey(hash: string, record: AppKeyRecord): Promise<void> {
    await this.keys.doc(hash).create(record);
  }

  async getKey(hash: string): Promise<AppKeyRecord | undefined> {
    return (await this.keys.doc(hash).get()).data() as AppKeyRecord | undefined;
  }

  async listKeysForApps(appIds: string[]): Promise<AppKeyRecord[]> {
    if (!appIds.length) return [];
    return (await this.keys.where('appId', 'in', appIds).get()).docs.map((d) => d.data() as AppKeyRecord);
  }

  async revokeKeyByPrefix(appId: string, prefix: string, revokedAt: string): Promise<boolean> {
    const found = (await this.keys.where('appId', '==', appId).where('prefix', '==', prefix).get()).docs;
    if (!found.length) return false;
    await Promise.all(found.map((d) => d.ref.update({ revokedAt })));
    return true;
  }

  async revokeAllKeysForApp(appId: string, revokedAt: string): Promise<void> {
    const keys = (await this.keys.where('appId', '==', appId).get()).docs;
    await Promise.all(keys.map((d) => d.ref.update({ revokedAt })));
  }

  // ---- app agents (/v1/agents) ------------------------------------------------------------------

  private agentRef(appId: string, key: string) {
    return this.agents.doc(`${appId}:${key}`);
  }

  async upsertAgent(
    appId: string,
    key: string,
    input: { name: string; instructions: string; card?: string; listed?: boolean },
    updatedAt: string,
  ): Promise<{ created: boolean }> {
    const ref = this.agentRef(appId, key);
    return this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as AppAgent | undefined;
      const next: AppAgent = {
        appId,
        key,
        name: input.name,
        instructions: input.instructions,
        listed: input.listed ?? current?.listed ?? false,
        updatedAt,
      };
      const card = input.card ?? current?.card;
      if (card) next.card = card;
      tx.set(ref, next);
      return { created: !current };
    });
  }

  async getAgent(appId: string, key: string): Promise<AppAgent | undefined> {
    return (await this.agentRef(appId, key).get()).data() as AppAgent | undefined;
  }

  async deleteAgent(appId: string, key: string): Promise<boolean> {
    const ref = this.agentRef(appId, key);
    if (!(await ref.get()).exists) return false;
    await ref.delete();
    return true;
  }

  async listListedAgents(appId: string): Promise<AppAgent[]> {
    const snap = await this.agents.where('appId', '==', appId).where('listed', '==', true).get();
    return snap.docs.map((d) => d.data() as AppAgent);
  }

  // ---- app webhook events -----------------------------------------------------------------------

  async createEvent(id: string, record: EventRecord): Promise<void> {
    await this.events.doc(id).create(record);
  }

  async listDueEventIds(now: number, limit: number): Promise<string[]> {
    const due = await this.events.where('nextAt', '<=', now).limit(limit).get();
    return due.docs.map((d) => d.id);
  }

  async claimEventLease(id: string, now: number, leaseMs: number): Promise<EventRecord | undefined> {
    const ref = this.events.doc(id);
    return this.db.runTransaction(async (tx) => {
      const e = (await tx.get(ref)).data() as EventRecord | undefined;
      if (!e || e.delivered || e.nextAt === undefined || e.nextAt > now || (e.leaseUntil ?? 0) > now) return undefined;
      tx.update(ref, { leaseUntil: now + leaseMs });
      return e;
    });
  }

  async markEventDelivered(id: string, attempts: number): Promise<void> {
    await this.events.doc(id).update({
      delivered: true,
      attempts,
      nextAt: FieldValue.delete(),
      leaseUntil: FieldValue.delete(),
    });
  }

  async markEventFailed(id: string, attempts: number, lastError: string, nextAt: number | undefined): Promise<void> {
    await this.events.doc(id).update({
      attempts,
      lastError,
      leaseUntil: FieldValue.delete(),
      nextAt: nextAt === undefined ? FieldValue.delete() : nextAt,
    });
  }
}
