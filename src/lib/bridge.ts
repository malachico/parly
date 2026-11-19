import type { MessageDoc } from '../chat/chat.js';
import type { HubService } from '../hub/hubService.js';
import { FieldValue, type Database } from '../db/types.js';

type SlackCopy = NonNullable<MessageDoc['slack']>[number];
type TelegramCopy = NonNullable<MessageDoc['telegram']>[number];

/** Is this copy of a message the one in that Slack channel (so the message is already there)? */
export const isOwnSlackCopy = (c: SlackCopy, at: Pick<SlackCopy, 'teamId' | 'channelId'>): boolean =>
  c.teamId === at.teamId && c.channelId === at.channelId;

/** Is this copy of a message the one in that Telegram chat (and topic, when it has one)? */
export const isOwnTelegramCopy = (c: TelegramCopy, at: { chatId: TelegramCopy['chatId']; topicId?: TelegramCopy['topicId'] }): boolean =>
  c.chatId === at.chatId && (at.topicId === undefined || c.topicId === at.topicId);

/** One message part as plain text: its text, its URL, or its data as JSON (cut to 2000 chars, inside `fence`). */
export const partText = (p: MessageDoc['parts'][number], fence: string): string =>
  p.text ?? (p.url ? p.url : p.data !== undefined ? fence + JSON.stringify(p.data).slice(0, 2000) + fence : '');

/** A kept event the sweep retries: older than this (its first try had its chance), at most this many times. */
const SWEEP_AFTER_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** A post a bridge keeps failing to deliver (not because the target is gone) is dropped after this long. */
const GIVE_UP_MS = 24 * 60 * 60_000;

/** Exponential backoff from 30s, capped at 1 hour between retries. */
function bridgeRetryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** attempts, 60 * 60_000);
}

/** Formats the sender display name for an outbound mirrored message, appending the sender's room side when applicable. */
export async function bridgeSenderName(hub: HubService, message: MessageDoc, parlyChannelId: string): Promise<string> {
  if (!parlyChannelId) return message.from.slice(0, 80);
  const channel = (await hub.registry.channelsById([parlyChannelId])).get(parlyChannelId);
  const room = channel && (await hub.registry.workspaceById(channel.workspaceId))?.room;
  const sender = room && (await hub.registry.get(message.fromId));
  const side = room && sender ? hub.rooms.sideOf(room, sender) : undefined;
  return (side ? `${message.from} · ${side.name}` : message.from).slice(0, 80);
}

interface BridgeSweepStore {
  pendingEvents(olderThanMs: number, maxAttempts: number): Promise<string[]>;
  dueOut(now?: number): Promise<string[]>;
}

interface BridgeOutboxStore {
  retryOut(key: string, nextAt: number, counted: boolean): Promise<void>;
  doneOut(key: string): Promise<void>;
}

/**
 * Shared outbox failure ladder (Slack + Telegram): honour a platform `retryAfterMs`, give up after
 * `GIVE_UP_MS`, otherwise exponential backoff. Call after platform-specific cleanup (unlink, pause, …).
 */
export async function bridgeOutboxFailure(
  store: BridgeOutboxStore,
  key: string,
  job: { attempts: number; at: number },
  err: unknown,
  opts: { label: string; retryAfterMs?: number; dropDetail?: unknown },
): Promise<void> {
  if (opts.retryAfterMs !== undefined) return store.retryOut(key, Date.now() + opts.retryAfterMs, false);
  if (Date.now() - job.at > GIVE_UP_MS) {
    console.error(`${opts.label} ${key} dropped after a day:`, opts.dropDetail ?? err);
    return store.doneOut(key);
  }
  // ponytail: exponential backoff from 30s, at most an hour between tries
  await store.retryOut(key, Date.now() + bridgeRetryDelayMs(job.attempts), true);
}

/** The `/tick` sweep: retries unhandled inbound events and due outbound posts, returning the number completed. */
export async function sweepBridge(
  store: BridgeSweepStore,
  process: (id: string) => Promise<void>,
  send: (key: string) => Promise<void>,
  label: { event: string; post: string },
): Promise<number> {
  let done = 0;
  for (const id of await store.pendingEvents(SWEEP_AFTER_MS, MAX_ATTEMPTS)) {
    await process(id).then(
      () => done++,
      (err) => console.error(`${label.event} ${id} (sweep)`, err),
    );
  }
  for (const key of await store.dueOut()) {
    await send(key).then(
      () => done++,
      (err) => console.error(`${label.post} ${key} (sweep)`, err),
    );
  }
  return done;
}

export const LINK_CODE_RE = /^[A-Za-z0-9_-]{10,64}$/;

export async function keepBridgeEvent(db: Database, collection: string, id: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    await db.collection(collection).doc(id).create({ ...payload, done: false, attempts: 0, at: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000) });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    throw err;
  }
}

export async function claimBridgeEvent<T extends Record<string, unknown>>(db: Database, collection: string, id: string, now = Date.now()): Promise<(T & { attempts: number }) | undefined> {
  const ref = db.collection(collection).doc(id);
  return db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() as (T & { done: boolean; attempts: number; claimedAt?: number }) | undefined;
    if (!data || data.done || (data.claimedAt && now - data.claimedAt < 60_000)) return undefined;
    tx.update(ref, { claimedAt: now });
    return data;
  });
}

export async function markBridgeEventDone(db: Database, collection: string, id: string): Promise<void> {
  await db.collection(collection).doc(id).update({ done: true });
}

export async function markBridgeEventFailed(db: Database, collection: string, id: string, error: string, maxAttempts = MAX_ATTEMPTS): Promise<void> {
  const ref = db.collection(collection).doc(id);
  await db.runTransaction(async (tx) => {
    const attempts = (((await tx.get(ref)).data()?.attempts as number | undefined) ?? 0) + 1;
    // A poison event goes terminal (done) once it's used up its attempts, so the sweep drops it and newer events aren't starved.
    tx.update(ref, { attempts, error, claimedAt: FieldValue.delete(), ...(attempts >= maxAttempts && { done: true }) });
  });
}

export async function pendingBridgeEvents(db: Database, collection: string, olderThanMs: number, maxAttempts: number, now = Date.now()): Promise<string[]> {
  const snap = await db.collection(collection).where('done', '==', false).where('attempts', '<', maxAttempts).orderBy('at', 'asc').limit(100).get();
  const cutoff = new Date(now - olderThanMs).toISOString();
  return snap.docs.filter((d) => d.data().at <= cutoff).map((d) => d.id);
}

export async function queueBridgeOut<T extends object>(db: Database, collection: string, key: string, job: T): Promise<boolean> {
  try {
    await db.collection(collection).doc(key).create({ ...job, attempts: 0, nextAt: Date.now(), at: Date.now() });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 6) return false;
    throw err;
  }
}

export async function claimBridgeOut<T>(db: Database, collection: string, key: string, now = Date.now()): Promise<(T & { attempts: number; at: number }) | undefined> {
  const ref = db.collection(collection).doc(key);
  return db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() as (T & { attempts: number; at: number; nextAt: number; claimedAt?: number }) | undefined;
    if (!data || data.nextAt > now || (data.claimedAt && now - data.claimedAt < 60_000)) return undefined;
    tx.update(ref, { claimedAt: now });
    return data;
  });
}

export async function retryBridgeOut(db: Database, collection: string, key: string, nextAt: number, counted: boolean): Promise<void> {
  await db.collection(collection).doc(key).update({ nextAt, claimedAt: FieldValue.delete(), ...(counted ? { attempts: FieldValue.increment(1) } : {}) });
}

export async function doneBridgeOut(db: Database, collection: string, key: string): Promise<void> {
  await db.collection(collection).doc(key).delete();
}

export async function dueBridgeOut(db: Database, collection: string, now = Date.now()): Promise<string[]> {
  const snap = await db.collection(collection).where('nextAt', '<=', now).limit(100).get();
  return snap.docs.map((d) => d.id);
}

/**
 * The event inbox and outbox both bridges keep (`events` and `outbox` are their collections). Each store keeps its own
 * keepEvent, claimEvent and queueOut, since what they store (`envelope` / `update`) and how they key it differ.
 */
export class BridgeQueue<Out> {
  constructor(
    protected readonly db: Database,
    protected readonly events: string,
    protected readonly outbox: string,
  ) {}

  async eventDone(id: string): Promise<void> {
    await markBridgeEventDone(this.db, this.events, id);
  }

  async eventFailed(id: string, error: string): Promise<void> {
    await markBridgeEventFailed(this.db, this.events, id, error);
  }

  /** Events kept but not handled (the process stopped, or handling failed), oldest first, for the sweep. */
  async pendingEvents(olderThanMs: number, maxAttempts: number, now = Date.now()): Promise<string[]> {
    return pendingBridgeEvents(this.db, this.events, olderThanMs, maxAttempts, now);
  }

  /** Takes a waiting post to send it (as claimEvent): undefined when it's gone, not due, or another sender has it. */
  async claimOut(key: string, now = Date.now()): Promise<(Out & { attempts: number; at: number }) | undefined> {
    return claimBridgeOut<Out>(this.db, this.outbox, key, now);
  }

  /** Tries again later (`nextAt`), counting the attempt unless the platform only asked to slow down. */
  async retryOut(key: string, nextAt: number, counted: boolean): Promise<void> {
    await retryBridgeOut(this.db, this.outbox, key, nextAt, counted);
  }

  async doneOut(key: string): Promise<void> {
    await doneBridgeOut(this.db, this.outbox, key);
  }

  /** Waiting posts that are due, for the sweep. */
  async dueOut(now = Date.now()): Promise<string[]> {
    return dueBridgeOut(this.db, this.outbox, now);
  }
}
