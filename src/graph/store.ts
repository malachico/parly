import { createHash } from 'node:crypto';
import type { Database } from '../db/types.js';
import type { LlmMeter } from '../llm/llm.js';
import type { GraphSource } from './sources.js';

export type GraphNodeKind = 'decision' | 'person' | 'topic' | 'doc' | 'skill';

/** A workspace, one conversation in it, or a channel (`channel:<channelId>` plus its `thread:<channelId>:<post>`s). */
export interface GraphScope {
  workspaceId: string;
  conversationId?: string;
  channelId?: string;
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const NODES = 'graph_nodes';
const EDGES = 'graph_edges';
export const EMBEDDINGS = 'graph_embeddings';

/** Mongo filter for `conversationId`: a channel plus its threads, one conversation, or undefined (whole workspace). */
export const conversationFilter = ({ conversationId, channelId }: GraphScope) =>
  channelId !== undefined ? { $regex: `^(channel:${escapeRegex(channelId)}$|thread:${escapeRegex(channelId)}:)` } : conversationId;
/** Per channel: the highest message seq already extracted. */
const WATERMARKS = 'graph_watermarks';

/** Case/whitespace-insensitive identity, so "Use  Mongo" and "use mongo" are one node. */
export const normalizeKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Deterministic id from the idempotency key: re-extracting the same thing lands on the same row. */
const idOf = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);

/** Topic word-set overlap (Jaccard) at or above which two topics are one entry: "Mongo migrations" ~ "migration to Mongo", not "Q3 launch" ~ "Q4 launch". */
export const TOPIC_MERGE_THRESHOLD = 0.6;

/** Lowercased words with a plain plural `s` dropped, so case, order, punctuation and plurals don't split an entry. */
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));

export interface EntityRef { kind: GraphNodeKind; key: string; title: string }

/**
 * Whether two person or topic entries name the same thing. Same key always does. A person keyed by agent id (key
 * isn't their name) is that agent, so two agents never merge whatever their names; otherwise one name's words must
 * all be in the other's ("Dana" ~ "Dana Levi"). Topics merge at TOPIC_MERGE_THRESHOLD word overlap.
 * ponytail: lexical only; compare entity embeddings with a cosine threshold once entity nodes are embedded.
 */
export function sameEntity(a: EntityRef, b: EntityRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.key === b.key) return true;
  const wa = words(a.title);
  const wb = words(b.title);
  if (!wa.size || !wb.size) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  if (a.kind === 'person') {
    const byAgent = (e: EntityRef) => e.key !== normalizeKey(e.title);
    return !(byAgent(a) && byAgent(b)) && shared === Math.min(wa.size, wb.size);
  }
  return shared / (wa.size + wb.size - shared) >= TOPIC_MERGE_THRESHOLD;
}

/**
 * The canonical id a new person or topic entry joins, given the workspace's existing ones of its kind. A same-key
 * entry's group wins; else the one group whose every member is sameEntity (all, not any, so "Dan" can't chain "Dan
 * Smith" and "Dan Jones" together); several or none: a group of its own, id'd by its key so a rerun lands on it again.
 */
export function canonicalIdFor(entry: EntityRef & { workspaceId: string }, existing: (EntityRef & { _id: string; canonicalId?: string })[]): string {
  const groups = new Map<string, EntityRef[]>();
  for (const n of existing) {
    const id = n.canonicalId ?? n._id;
    if (n.key === entry.key && n.kind === entry.kind) return id;
    groups.set(id, [...(groups.get(id) ?? []), n]);
  }
  const fits = [...groups].filter(([, members]) => members.every((m) => sameEntity(entry, m)));
  return fits.length === 1 ? fits[0]![0] : idOf(entry.workspaceId, entry.kind, entry.key);
}

// ponytail: matches against the 500 most recently updated entries of the kind, read then written, so two concurrent extractions can split one entity into two groups; a unique index on (workspaceId, kind, key) groups if that bites.
const MERGE_CANDIDATES = 500;

/**
 * The context graph's storage. Every helper is a no-op when the graph is disabled. Extraction is paid by Parly,
 * capped per workspace per day through the LlmMeter's graph counter; nothing here touches user credits.
 */
export class GraphStore {
  constructor(
    private readonly db: Database,
    private readonly meter: Pick<LlmMeter, 'graphSpent' | 'addGraphSpend'>,
    private readonly options: { enabled: boolean; dailyCapMicros: number },
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Inserts or refreshes a node (keyed by `key`, default its title) and returns its id; undefined when disabled. `source` defaults to its conversation. */
  async upsertNode(node: GraphScope & { conversationId: string; kind: GraphNodeKind; title: string; text?: string; key?: string; sourceMessageIds?: string[]; source?: GraphSource }): Promise<string | undefined> {
    if (!this.options.enabled) return undefined;
    const { workspaceId, conversationId, kind, title, text, source = { kind: 'conversation', conversationId } } = node;
    const key = normalizeKey(node.key ?? title);
    const id = idOf(workspaceId, conversationId, kind, key);
    const now = new Date().toISOString();
    // Duplicate people and topics share a canonicalId; each keeps its own row, text and source (see mergedReadableGraph).
    const canonicalId = kind === 'person' || kind === 'topic'
      ? canonicalIdFor({ workspaceId, kind, key, title }, await this.db.execute(() => this.db.mongoDb.collection<EntityRef & { _id: string; canonicalId?: string }>(NODES)
        .find({ workspaceId, kind }, { projection: { kind: 1, key: 1, title: 1, canonicalId: 1 } }).sort({ updatedAt: -1 }).limit(MERGE_CANDIDATES).toArray()))
      : undefined;
    await this.db.execute(() => this.db.mongoDb.collection<{ _id: string }>(NODES).updateOne(
      { _id: id },
      {
        $set: { title, ...(text !== undefined ? { text } : {}), source, updatedAt: now },
        $setOnInsert: { workspaceId, conversationId, kind, key, ...(canonicalId ? { canonicalId } : {}), createdAt: now },
        $addToSet: { sourceMessageIds: { $each: node.sourceMessageIds ?? [] } },
      },
      { upsert: true },
    ));
    return id;
  }

  /** Inserts or refreshes an edge between two nodes, recording both ends' conversations so either one's purge drops it. */
  async upsertEdge(edge: { workspaceId: string; kind: string; from: { id: string; conversationId: string }; to: { id: string; conversationId: string } }): Promise<string | undefined> {
    if (!this.options.enabled) return undefined;
    const { workspaceId, from, to } = edge;
    const kind = normalizeKey(edge.kind);
    const key = `${from.id}>${to.id}`;
    const id = idOf(workspaceId, from.conversationId, kind, key);
    const now = new Date().toISOString();
    await this.db.execute(() => this.db.mongoDb.collection<{ _id: string }>(EDGES).updateOne(
      { _id: id },
      {
        $set: { updatedAt: now },
        $setOnInsert: {
          workspaceId, conversationId: from.conversationId, kind, key,
          from: from.id, to: to.id, fromConversationId: from.conversationId, toConversationId: to.conversationId, createdAt: now,
        },
      },
      { upsert: true },
    ));
    return id;
  }

  /** Stores (or replaces) a node's embedding; one per node. */
  async upsertEmbedding(embedding: { workspaceId: string; conversationId: string; nodeId: string; kind: GraphNodeKind; model: string; vector: number[] }): Promise<void> {
    if (!this.options.enabled) return;
    const { workspaceId, conversationId, nodeId, kind, model, vector } = embedding;
    const now = new Date().toISOString();
    await this.db.execute(() => this.db.mongoDb.collection<{ _id: string }>(EMBEDDINGS).updateOne(
      { _id: idOf(workspaceId, conversationId, kind, nodeId) },
      { $set: { model, vector, updatedAt: now }, $setOnInsert: { workspaceId, conversationId, kind, key: nodeId, nodeId, createdAt: now } },
      { upsert: true },
    ));
  }

  /** Deletes the scope's nodes and embeddings, and every edge with either end in it. */
  async purgeGraphFor(scope: GraphScope): Promise<void> {
    if (!this.options.enabled) return;
    const { workspaceId } = scope;
    const conv = conversationFilter(scope);
    const own = conv === undefined ? { workspaceId } : { workspaceId, conversationId: conv };
    const edges = conv === undefined ? { workspaceId } : { workspaceId, $or: [{ fromConversationId: conv }, { toConversationId: conv }] };
    const col = (name: string) => this.db.mongoDb.collection(name);
    await this.db.execute(() => Promise.all([col(NODES).deleteMany(own), col(EMBEDDINGS).deleteMany(own), col(EDGES).deleteMany(edges), col(WATERMARKS).deleteMany(own)]));
    // Channel-scoped skill nodes live under `skill:<id>`, not the channel's conversations.
    if (scope.channelId !== undefined) await this.deleteNodes({ workspaceId, kind: 'skill', 'source.channelId': scope.channelId });
  }

  /** Deletes the nodes matching `filter`, their embeddings, and every edge touching them. */
  async deleteNodes(filter: Record<string, unknown>): Promise<void> {
    if (!this.options.enabled) return;
    const col = (name: string) => this.db.mongoDb.collection<{ _id: string }>(name);
    await this.db.execute(async () => {
      const ids = (await col(NODES).find(filter, { projection: { _id: 1 } }).toArray()).map((n) => n._id);
      if (ids.length === 0) return;
      await Promise.all([
        col(NODES).deleteMany({ _id: { $in: ids } }),
        col(EMBEDDINGS).deleteMany({ nodeId: { $in: ids } }),
        col(EDGES).deleteMany({ $or: [{ from: { $in: ids } }, { to: { $in: ids } }] }),
      ]);
    });
  }

  /** The highest seq of `conversationId` already extracted; 0 when never (or disabled). */
  async channelWatermark(workspaceId: string, conversationId: string): Promise<number> {
    if (!this.options.enabled) return 0;
    const doc = await this.db.execute(() => this.db.mongoDb.collection<{ _id: string; seq: number }>(WATERMARKS).findOne({ _id: idOf(workspaceId, conversationId) }));
    return doc?.seq ?? 0;
  }

  /** Moves the watermark up to `seq`; never back, so an overlapping older run can't rewind it. */
  async setChannelWatermark(workspaceId: string, conversationId: string, seq: number): Promise<void> {
    if (!this.options.enabled) return;
    await this.db.execute(() => this.db.mongoDb.collection<{ _id: string }>(WATERMARKS).updateOne(
      { _id: idOf(workspaceId, conversationId) },
      { $max: { seq }, $setOnInsert: { workspaceId, conversationId } },
      { upsert: true },
    ));
  }

  /**
   * Whether `workspaceId` is still under today's graph extraction cap.
   * ponytail: soft cap (check, then record after the call), so concurrent extractions can overshoot by one call each; reserve-then-settle if that matters.
   */
  async canSpendOnGraph(workspaceId: string): Promise<boolean> {
    if (!this.options.enabled || this.options.dailyCapMicros <= 0) return false;
    return (await this.meter.graphSpent(workspaceId)) < this.options.dailyCapMicros;
  }

  /** Records extraction `cost` (raw model micro-dollars) against the workspace's daily graph cap. Never debits credits. */
  async recordGraphSpend(workspaceId: string, cost: number): Promise<void> {
    if (!this.options.enabled) return;
    await this.meter.addGraphSpend(workspaceId, cost);
  }
}
