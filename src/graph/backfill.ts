import { type ConversationDoc, parseKey } from '../chat/chat.js';
import type { PushQueue } from '../chat/queue.js';
import { COLLECTIONS, type Database } from '../db/types.js';
import type { GraphStore } from './store.js';

/** Per workspace: the highest conversation id the backfill has enqueued (or skipped). */
const CURSORS = 'graph_backfill';
const BACKFILL_DAYS = 90;
const MAX_BATCH = 50;

export interface BackfillSummary {
  enqueued: number;
  skipped: number;
  /** Workspaces at today's graph cap; their cursor stays put, a rerun after midnight UTC picks them up. */
  capped: string[];
  /** True when nothing is left in the window (no batch limit or cap stopped this run). */
  done: boolean;
}

/**
 * Feeds the last 90 days into the context graph by enqueuing the usual graph jobs: done threads like marking them
 * done does, channels like a quiet channel does (with its seq, so the debounce and task dedupe apply). Run by hand
 * from the admin API; resumable through a per-workspace cursor over conversation ids. Each call examines at most
 * `limit` (1..50) conversations, skips included. DMs, open threads, threads already extracted, and archived or
 * deleted channels and workspaces are left out.
 * ponytail: reads the whole 90-day window (kind+lastAt index) each call to find the cursors; page by _id if a run gets slow.
 */
export async function backfillGraph(
  deps: {
    db: Database;
    graph: Pick<GraphStore, 'canSpendOnGraph' | 'hasGraphRun'>;
    registry: { channelDoc(id: string): Promise<{ archived?: boolean } | undefined>; workspaceDoc(id: string): Promise<{ archived?: boolean } | undefined> };
    queue: Pick<PushQueue, 'enqueue'>;
  },
  { limit = MAX_BATCH, now = Date.now() }: { limit?: number; now?: number } = {},
): Promise<BackfillSummary> {
  const { db, graph, registry, queue } = deps;
  limit = Math.min(MAX_BATCH, Math.max(1, Math.trunc(limit) || MAX_BATCH));
  let examined = 0;
  const cursors = db.mongoDb.collection<{ _id: string; after: string }>(CURSORS);
  const after = new Map((await db.execute(() => cursors.find().toArray())).map((c) => [c._id, c.after]));
  const since = new Date(now - BACKFILL_DAYS * 86_400_000).toISOString();
  const convs = db.execute(() =>
    db.mongoDb.collection<ConversationDoc & { _id: string }>(COLLECTIONS.conversations)
      .find({ kind: { $in: ['channel', 'thread'] }, workspaceId: { $exists: true }, lastAt: { $gte: since } }, { projection: { _id: 1, kind: 1, workspaceId: 1, seq: 1, doneAt: 1 } })
      .sort({ _id: 1 })
      .toArray(),
  );
  const out: BackfillSummary = { enqueued: 0, skipped: 0, capped: [], done: true };
  const advance = (ws: string, id: string) => db.execute(() => cursors.updateOne({ _id: ws }, { $max: { after: id } }, { upsert: true }));
  for (const c of await convs) {
    const ws = c.workspaceId!;
    if (out.capped.includes(ws) || c._id <= (after.get(ws) ?? '')) continue;
    if (examined++ >= limit) {
      out.done = false;
      break;
    }
    const key = parseKey(c._id);
    const channelId = key.kind === 'dm' ? undefined : key.channelId;
    const [channel, workspace] = await Promise.all([channelId ? registry.channelDoc(channelId) : undefined, registry.workspaceDoc(ws)]);
    if (!channel || channel.archived || !workspace || workspace.archived || (c.kind === 'thread' && (!c.doneAt || (await graph.hasGraphRun(ws, c._id))))) {
      out.skipped++;
    } else if (!(await graph.canSpendOnGraph(ws))) {
      out.capped.push(ws);
      out.done = false;
      continue;
    } else {
      await queue.enqueue(c.kind === 'channel' ? { kind: 'graph', workspaceId: ws, conversationId: c._id, seq: c.seq } : { kind: 'graph', workspaceId: ws, conversationId: c._id });
      out.enqueued++;
    }
    await advance(ws, c._id);
  }
  return out;
}
