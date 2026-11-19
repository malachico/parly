import { COLLECTIONS, FieldValue, type Database, type UpdateData } from '../db/types.js';
import { newId } from '../lib/wire.js';
import type { ScheduleRecord } from './schedules.js';
import type { TriggerListener, TriggerSource } from './triggers.js';
import type { WebhookRecord } from './webhooks.js';

/** Settings compared as one string, keys sorted: the same app event with the same settings is one source. */
const configKey = (config: Record<string, unknown> | undefined) =>
  JSON.stringify(Object.fromEntries(Object.entries(config ?? {}).sort(([a], [b]) => a.localeCompare(b))));

/**
 * DB access for triggers (`trigger_sources`, `trigger_listeners` and their `deliveries`), incoming webhooks
 * and scheduled messages.
 */
export class TriggerStore {
  /** In-process coalescing for concurrent ensureActiveSource on the same key. */
  private readonly ensureInflight = new Map<string, Promise<TriggerSource>>();

  constructor(private readonly db: Database) {}

  private get sources() {
    return this.db.collection(COLLECTIONS.triggerSources);
  }

  private get listeners() {
    return this.db.collection(COLLECTIONS.triggerListeners);
  }

  async addSource(s: Omit<TriggerSource, 'id' | 'createdAt'> & { id?: string }): Promise<TriggerSource> {
    const record: TriggerSource = { ...s, id: s.id ?? newId(), createdAt: new Date().toISOString() };
    await this.sources.doc(record.id).set(record);
    return record;
  }

  /**
   * Returns an existing active source for `(ownerId, slug, config)` or creates one so concurrent
   * `ensureSource` calls never duplicate active sources or Composio watches. Upsert runs before the
   * DB write; on upsert failure nothing is stored. Same-process racers share one in-flight promise.
   */
  async ensureActiveSource(
    s: Omit<TriggerSource, 'id' | 'createdAt'>,
    beforeCreate?: () => Promise<Pick<TriggerSource, 'composioId' | 'connectedAccountId'>>,
    /** When a concurrent create wins after `beforeCreate`, drop the unused external registration. */
    abandon?: (extra: Pick<TriggerSource, 'composioId' | 'connectedAccountId'>) => Promise<void>,
  ): Promise<TriggerSource> {
    const cfgKey = configKey(s.config);
    const matches = (x: TriggerSource) => !x.archivedAt && x.slug === s.slug && configKey(x.config) === cfgKey;
    const existing = (await this.sourcesOf(s.ownerId)).find(matches);
    if (existing) return existing;
    const inflightKey = `${s.ownerId}\0${s.slug}\0${cfgKey}`;
    const pending = this.ensureInflight.get(inflightKey);
    if (pending) return pending;
    const work = (async () => {
      try {
        const again = (await this.sourcesOf(s.ownerId)).find(matches);
        if (again) return again;
        // External register first: if it throws, the DB stays clean (no zombie row).
        const extra = beforeCreate ? await beforeCreate() : {};
        const record = await this.db.runTransaction(async (tx) => {
          const snap = await tx.get(this.sources.where('ownerId', '==', s.ownerId));
          const same = snap.docs.map((d) => d.data() as TriggerSource).find(matches);
          if (same) return same;
          const created: TriggerSource = { ...s, ...extra, id: newId(), createdAt: new Date().toISOString() };
          tx.set(this.sources.doc(created.id), created);
          return created;
        });
        // Lost the race: another row won; the Composio watch from beforeCreate would orphan.
        if (extra.composioId && record.composioId !== extra.composioId) {
          await abandon?.(extra).catch((err) => console.warn('composio orphan trigger not deleted', extra.composioId, String(err)));
        }
        return record;
      } finally {
        this.ensureInflight.delete(inflightKey);
      }
    })();
    this.ensureInflight.set(inflightKey, work);
    return work;
  }

  async addListener(l: Omit<TriggerListener, 'id' | 'createdAt' | 'enabled'> & { id?: string }): Promise<TriggerListener> {
    const record: TriggerListener = { ...l, id: l.id ?? newId(), enabled: true, createdAt: new Date().toISOString() };
    await this.listeners.doc(record.id).set(record);
    return record;
  }

  async source(id: string): Promise<TriggerSource | undefined> {
    return (await this.sources.doc(id).get()).data() as TriggerSource | undefined;
  }

  async listener(id: string): Promise<TriggerListener | undefined> {
    return (await this.listeners.doc(id).get()).data() as TriggerListener | undefined;
  }

  async sourcesOf(ownerId: string): Promise<TriggerSource[]> {
    return (await this.sources.where('ownerId', '==', ownerId).get()).docs.map((d) => d.data() as TriggerSource);
  }

  async sourcesByComposioId(composioId: string): Promise<TriggerSource[]> {
    return (await this.sources.where('composioId', '==', composioId).get()).docs.map((d) => d.data() as TriggerSource);
  }

  async listenersOf(sourceId: string): Promise<TriggerListener[]> {
    return (await this.listeners.where('sourceId', '==', sourceId).get()).docs.map((d) => d.data() as TriggerListener);
  }

  async listenersOfOwner(ownerId: string): Promise<TriggerListener[]> {
    return (await this.listeners.where('ownerId', '==', ownerId).get()).docs.map((d) => d.data() as TriggerListener);
  }

  async listenersOfAgent(agentId: string): Promise<TriggerListener[]> {
    return (await this.listeners.where('agentId', '==', agentId).get()).docs.map((d) => d.data() as TriggerListener);
  }

  async updateSource(id: string, patch: UpdateData<TriggerSource>): Promise<void> {
    await this.sources.doc(id).update(patch);
  }

  async updateListener(id: string, patch: UpdateData<TriggerListener>): Promise<void> {
    await this.listeners.doc(id).update(patch);
  }

  async sourceFired(id: string, at: string): Promise<void> {
    await this.sources.doc(id).update({ lastFiredAt: at, fired: FieldValue.increment(1) });
  }

  async delivered(id: string, at: string): Promise<void> {
    await this.listeners.doc(id).update({ lastDeliveredAt: at, delivered: FieldValue.increment(1) });
  }

  /** What became of one event for one listener: delivered (and where), or why not. Kept in its history. */
  async logOutcome(listenerId: string, entry: { at: string; outcome: 'delivered' | 'filtered' | 'skipped'; why?: string; to?: string }): Promise<void> {
    await this.listeners.doc(listenerId).collection('deliveries').add({ ...entry, expiresAt: new Date(Date.now() + 90 * 86_400_000) });
  }

  /** A listener's latest events, newest first; retained for 90 days. */
  async history(listenerId: string, limit = 25): Promise<{ at: string; outcome: string; why?: string; to?: string }[]> {
    const snap = await this.listeners.doc(listenerId).collection('deliveries').orderBy('at', 'desc').limit(limit).get();
    return snap.docs.map((d) => {
      const { expiresAt, ...event } = d.data();
      return event as { at: string; outcome: string; why?: string; to?: string };
    });
  }

  /** Turns an archived source back on, with its new Composio watch when it has one. */
  async restoreSource(id: string, watch: Partial<Pick<TriggerSource, 'composioId' | 'connectedAccountId'>> = {}): Promise<void> {
    await this.sources.doc(id).update({ ...watch, archivedAt: FieldValue.delete() });
  }

  /** Changes a listener's settings; `null` removes `detachedAt` or `task`. */
  async editListener(
    id: string,
    patch: { enabled?: boolean; detachedAt?: string | null; filter?: TriggerListener['filter']; task?: string | null },
  ): Promise<void> {
    const update: UpdateData<TriggerListener> = {};
    for (const [k, v] of Object.entries(patch)) (update as Record<string, unknown>)[k] = v === null ? FieldValue.delete() : v;
    await this.listeners.doc(id).update(update);
  }

  // Webhooks: `webhooks/{id}`.

  private get webhooks() {
    return this.db.collection(COLLECTIONS.webhooks);
  }

  /** Stores `webhook` in one transaction unless its channel already has `max`; returns false then (nothing written). */
  async addWebhook(webhook: WebhookRecord, max: number): Promise<boolean> {
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.webhooks.where('channelId', '==', webhook.channelId));
      if (snap.size >= max) return false;
      tx.set(this.webhooks.doc(webhook.id), webhook);
      return true;
    });
  }

  async webhookByTokenHash(tokenHash: string): Promise<WebhookRecord | undefined> {
    const snap = await this.webhooks.where('tokenHash', '==', tokenHash).limit(1).get();
    return snap.docs[0]?.data() as WebhookRecord | undefined;
  }

  async webhook(id: string): Promise<WebhookRecord | undefined> {
    return (await this.webhooks.doc(id).get()).data() as WebhookRecord | undefined;
  }

  async webhooksOfChannel(channelId: string): Promise<WebhookRecord[]> {
    return (await this.webhooks.where('channelId', '==', channelId).get()).docs.map((d) => d.data() as WebhookRecord);
  }

  async webhookUsed(id: string, at: string): Promise<void> {
    await this.webhooks.doc(id).update({ lastUsedAt: at });
  }

  async removeWebhook(id: string): Promise<void> {
    await this.webhooks.doc(id).delete();
  }

  // Scheduled messages: `schedules/{id}`.

  private get schedules() {
    return this.db.collection(COLLECTIONS.schedules);
  }

  /**
   * Stores `record` in one transaction unless its channel (or, with no channel, its owner's schedules to that agent)
   * already has `max`; returns false then (nothing written).
   */
  async addSchedule(record: ScheduleRecord, max: number): Promise<boolean> {
    const same = record.channelId ? this.schedules.where('channelId', '==', record.channelId) : this.schedules.where('to', '==', record.to).where('ownerId', '==', record.ownerId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(same);
      if (snap.size >= max) return false;
      tx.set(this.schedules.doc(record.id), record);
      return true;
    });
  }

  async schedule(id: string): Promise<ScheduleRecord | undefined> {
    return (await this.schedules.doc(id).get()).data() as ScheduleRecord | undefined;
  }

  async schedulesToAgent(ownerId: string, to: string): Promise<ScheduleRecord[]> {
    return (await this.schedules.where('to', '==', to).where('ownerId', '==', ownerId).get()).docs.map((d) => d.data() as ScheduleRecord);
  }

  async schedulesOfOwner(ownerId: string): Promise<ScheduleRecord[]> {
    return (await this.schedules.where('ownerId', '==', ownerId).get()).docs.map((d) => d.data() as ScheduleRecord);
  }

  async schedulesOfChannel(channelId: string): Promise<ScheduleRecord[]> {
    return (await this.schedules.where('channelId', '==', channelId).get()).docs.map((d) => d.data() as ScheduleRecord);
  }

  /** Replaces a schedule's whole record. */
  async saveSchedule(record: ScheduleRecord): Promise<void> {
    await this.schedules.doc(record.id).set(record);
  }

  /** Pause (no `nextAt`), or resume with the next post at `nextAt`; either way its failures are cleared. */
  async setScheduleActive(id: string, active: boolean, nextAt: string | undefined): Promise<void> {
    const update = { active, nextAt: nextAt ?? FieldValue.delete(), failures: 0, problem: FieldValue.delete() };
    await this.schedules.doc(id).update(update);
  }

  async removeSchedule(id: string): Promise<void> {
    await this.schedules.doc(id).delete();
  }

  /** Ids of up to 50 schedules whose `nextAt` is at or before `now`. */
  async listDueSchedules(now: Date): Promise<string[]> {
    return (await this.schedules.where('nextAt', '<=', now.toISOString()).limit(50).get()).docs.map((d) => d.id);
  }

  /**
   * Claims schedule `id` in one transaction if it's active and due: moves its `nextAt` on to `nextOf(record, now)`
   * (none: it goes inactive) and stamps `lastRunAt`. Returns the record as it was, or undefined if not due.
   */
  async claimDueSchedule(id: string, now: Date, nextOf: (s: ScheduleRecord, now: Date) => Date | undefined): Promise<ScheduleRecord | undefined> {
    const ref = this.schedules.doc(id);
    return this.db.runTransaction(async (tx) => {
      const s = (await tx.get(ref)).data() as ScheduleRecord | undefined;
      if (!s?.active || !s.nextAt || s.nextAt > now.toISOString()) return undefined;
      const next = nextOf(s, now);
      tx.update(ref, { nextAt: next ? next.toISOString() : FieldValue.delete(), lastRunAt: now.toISOString(), ...(next ? {} : { active: false }) });
      return s;
    });
  }

  async clearScheduleFailures(id: string): Promise<void> {
    await this.schedules.doc(id).update({ failures: 0, problem: FieldValue.delete() });
  }

  /** Records a failed post; `pause` turns it off, `retryAt` keeps it on and posts again then. */
  async scheduleFailed(id: string, failures: number, problem: string, then: { pause: true } | { retryAt: string } | undefined): Promise<void> {
    await this.schedules.doc(id).update({ failures, problem, ...(then && 'pause' in then
      ? { active: false, nextAt: FieldValue.delete() }
      : then ? { active: true, nextAt: then.retryAt } : {}) });
  }
}
