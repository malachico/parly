import { createHmac, randomUUID } from 'node:crypto';
import type { Database } from '../db/types.js';
import { publicFetch } from '../lib/publicFetch.js';
import type { Apps } from './apps.js';
import { AppsStore } from './store.js';

/** What a room tells the app that opened it. */
const ROOM_EVENTS = ['room.needs_decision', 'room.document_updated', 'room.agreed', 'room.stuck', 'room.closed'] as const;
export type RoomEventType = (typeof ROOM_EVENTS)[number];

export interface EventRecord {
  appId: string;
  type: RoomEventType;
  createdAt: string;
  data: Record<string, unknown>;
  attempts: number;
  /** When to try again; removed once delivered or given up, so only pending events match the sweep. */
  nextAt?: number;
  delivered?: boolean;
  /** Set while one instance sends it, so the sweep and the first try don't both send. */
  leaseUntil?: number;
  lastError?: string;
}

/** Wait before each retry; after the last one the event is given up. */
const BACKOFF_MS = [10_000, 60_000, 10 * 60_000, 60 * 60_000];
const TIMEOUT_MS = 10_000;
const LEASE_MS = 30_000;

/** `Parly-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
function signature(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * Webhooks to apps: each event is stored first, then sent; a failed send is retried by the /tick sweep with
 * backoff, so a restart or a CPU-throttled instance doesn't lose it. Receivers dedupe by the event `id`.
 */
export class AppWebhooks {
  private readonly store: AppsStore;
  /** Public addresses only (a webhookUrl is typed in by people); tests and local dev may allow private ones. */
  fetchImpl: typeof fetch = publicFetch;

  constructor(db: Database, private readonly apps: Apps) {
    this.store = new AppsStore(db);
  }

  /** Records an event for an app with a webhook and sends it now; never throws. */
  async emit(appId: string, type: RoomEventType, data: Record<string, unknown>): Promise<string | undefined> {
    try {
      const app = await this.apps.get(appId);
      if (!app?.webhookUrl) return undefined;
      const id = `evt_${randomUUID()}`;
      await this.store.createEvent(id, { appId, type, createdAt: new Date().toISOString(), data, attempts: 0, nextAt: Date.now() } satisfies EventRecord);
      await this.attempt(id);
      return id;
    } catch (err) {
      console.error('app webhook not recorded', appId, type, err);
      return undefined;
    }
  }

  /** Retries what's due (the /tick job, every minute). */
  async sweep(now = Date.now()): Promise<number> {
    const dueIds = await this.store.listDueEventIds(now, 50);
    await Promise.all(dueIds.map((id) => this.attempt(id, now)));
    return dueIds.length;
  }

  /** One send of an event: delivered on a 2xx; otherwise scheduled again, or given up after the last backoff. */
  async attempt(id: string, now = Date.now()): Promise<void> {
    const event = await this.store.claimEventLease(id, now, LEASE_MS);
    if (!event) return;
    let error: string | undefined;
    try {
      const app = await this.apps.get(event.appId);
      if (!app?.webhookUrl) throw new Error('app has no webhook');
      if (this.fetchImpl === publicFetch && !app.webhookUrl.startsWith('https:')) throw new Error('webhooks go to https URLs only');
      const body = JSON.stringify({ id, type: event.type, createdAt: event.createdAt, data: event.data });
      const res = await this.fetchImpl(app.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Parly-Webhooks/1', 'parly-signature': signature(app.webhookSecret, body, Math.floor(Date.now() / 1000)) },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (!error) {
      await this.store.markEventDelivered(id, event.attempts + 1);
      return;
    }
    const wait = BACKOFF_MS[event.attempts];
    await this.store.markEventFailed(
      id,
      event.attempts + 1,
      error.slice(0, 300),
      wait === undefined ? undefined : now + wait,
    );
  }
}
