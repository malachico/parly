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
  /** Any of these channels plus their threads; an empty list matches nothing. */
  channelIds?: string[];
}

/** A node or edge as the agent tools read it. */
export type GraphNodeDoc = { _id: string; workspaceId: string; conversationId: string; kind: GraphNodeKind; title: string; text?: string; canonicalId?: string; sourceMessageIds?: string[]; createdAt?: string; updatedAt?: string };
export type GraphEdgeDoc = { _id: string; workspaceId: string; kind: string; from: string; to: string; fromConversationId: string; toConversationId: string };

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const NODES = 'graph_nodes';
const EDGES = 'graph_edges';
export const EMBEDDINGS = 'graph_embeddings';

/** Mongo filter for `conversationId`: a channel plus its threads, one conversation, or undefined (whole workspace). */
export const conversationFilter = ({ conversationId, channelId, channelIds }: GraphScope) => {
  if (channelIds !== undefined) {
    const any = `(${channelIds.map(escapeRegex).join('|')})`;
    return channelIds.length ? { $regex: `^(channel:${any}$|thread:${any}:)` } : { $in: [] as string[] };
  }
  return channelId !== undefined ? { $regex: `^(channel:${escapeRegex(channelId)}$|thread:${escapeRegex(channelId)}:)` } : conversationId;
};

/** The channel `conversationFilter` would place this conversation in (`channel:X`, `thread:X:...`); null for DMs, skills etc. */
export const channelOf = (conversationId: string): string | null => /^(?:channel:([^:]+)$|thread:([^:]+):)/.exec(conversationId)?.slice(1).find(Boolean) ?? null;
/** Per channel: the highest message seq already extracted. */
const WATERMARKS = 'graph_watermarks';
/** Per thread: a counter bumped by each extraction run, so only the last-started run writes. */
const RUNS = 'graph_runs';

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

  get dailyCapMicros(): number {
    return this.options.dailyCapMicros;
  }

  /** Inserts or refreshes a node (keyed by `key`, default its title) and returns its id; undefined when disabled. `source` defaults to its conversation. */
  async upsertNode(node: GraphScope & { conversationId: string; kind: GraphNodeKind; title: string; text?: string; key?: string; sourceMessageIds?: string[]; source?: GraphSource; evidenceAt?: string }): Promise<string | undefined> {
    if (!this.options.enabled) return undefined;
    const { workspaceId, conversationId, kind, title, text, evidenceAt, source = { kind: 'conversation', conversationId } } = node;
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
        $set: { title, ...(text !== undefined ? { text } : {}), ...(evidenceAt ? { evidenceAt } : {}), source, updatedAt: now },
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

  /** Stores (or replaces) a node's embedding; one per node. `channelId` lets `$vectorSearch` pre-filter a channel scope. */
  async upsertEmbedding(embedding: { workspaceId: string; conversationId: string; nodeId: string; kind: GraphNodeKind; model: string; vector: number[] }): Promise<void> {
    if (!this.options.enabled) return;
    const { workspaceId, conversationId, nodeId, kind, model, vector } = embedding;
    const now = new Date().toISOString();
    await this.db.execute(() => this.db.mongoDb.collection<{ _id: string }>(EMBEDDINGS).updateOne(
      { _id: idOf(workspaceId, conversationId, kind, nodeId) },
      { $set: { model, vector, channelId: channelOf(conversationId), updatedAt: now }, $setOnInsert: { workspaceId, conversationId, kind, key: nodeId, nodeId, createdAt: now } },
      { upsert: true },
    ));
  }

  /** Deletes the scope's nodes and embeddings, and every edge with either end in it. */
  /**
   * Deletes a scope's graph. `keepIncomingSupersedes` (a thread rebuild only) keeps other conversations' supersedes
   * edges into this one; call pruneDanglingEdges after the rebuild to drop those whose target didn't come back.
   */
  async purgeGraphFor(scope: GraphScope, opts: { keepIncomingSupersedes?: boolean } = {}): Promise<void> {
    if (!this.options.enabled) return;
    const { workspaceId } = scope;
    const conv = conversationFilter(scope);
    const own = conv === undefined ? { workspaceId } : { workspaceId, conversationId: conv };
    const keep = opts.keepIncomingSupersedes && scope.conversationId !== undefined
      ? { $nor: [{ kind: 'supersedes', toConversationId: scope.conversationId, fromConversationId: { $ne: scope.conversationId } }] }
      : {};
    const edges = conv === undefined ? { workspaceId } : { workspaceId, $or: [{ fromConversationId: conv }, { toConversationId: conv }], ...keep };
    const col = (name: string) => this.db.mongoDb.collection(name);
    await this.db.execute(() => Promise.all([col(NODES).deleteMany(own), col(EMBEDDINGS).deleteMany(own), col(EDGES).deleteMany(edges), col(WATERMARKS).deleteMany(own)]));
    // A thread run purges its own graph; its run counter must outlive that, so only wider purges drop counters.
    if (scope.conversationId === undefined) await this.db.execute(() => col(RUNS).deleteMany(own));
    else await this.db.execute(() => col(RUNS).updateOne({ _id: idOf(workspaceId, scope.conversationId!) as never }, { $unset: { extractedSeq: '' } }));
    // Channel-scoped skill nodes live under `skill:<id>`, not the channel's conversations.
    if (scope.channelId !== undefined) await this.deleteNodes({ workspaceId, kind: 'skill', 'source.channelId': scope.channelId });
  }

  /**
   * After a thread rebuild that kept incoming edges: deletes those whose target node didn't come back, and other
   * conversations' supersedes edges whose source's evidence is no newer than the rebuilt target's (it switched back).
   */
  async pruneDanglingEdges(workspaceId: string, conversationId: string): Promise<void> {
    if (!this.options.enabled) return;
    type N = { _id: string; evidenceAt?: string };
    await this.db.execute(async () => {
      const nodes = this.db.mongoDb.collection<N>(NODES);
      const edges = this.db.mongoDb.collection<{ _id: string; from: string; to: string }>(EDGES);
      const own = new Map((await nodes.find({ workspaceId, conversationId }, { projection: { evidenceAt: 1 } }).toArray()).map((n) => [n._id, n.evidenceAt]));
      await edges.deleteMany({ workspaceId, toConversationId: conversationId, to: { $nin: [...own.keys()] } });
      const incoming = await edges.find({ workspaceId, kind: 'supersedes', toConversationId: conversationId, fromConversationId: { $ne: conversationId } }).toArray();
      if (!incoming.length) return;
      const from = new Map((await nodes.find({ _id: { $in: incoming.map((e) => e.from) } }, { projection: { evidenceAt: 1 } }).toArray()).map((n) => [n._id, n.evidenceAt]));
      const stale = incoming.filter((e) => { const f = from.get(e.from), t = own.get(e.to); return f && t && f <= t; }).map((e) => e._id);
      if (stale.length) await edges.deleteMany({ _id: { $in: stale } });
    });
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

  /**
   * The channel's (and its threads') newest decisions by when their evidence was posted, newest first; none when
   * disabled. Decisions extracted before evidenceAt existed sort by extraction time instead.
   */
  async recentDecisions(workspaceId: string, channelId: string, limit: number): Promise<{ id: string; title: string; conversationId: string; evidenceAt?: string }[]> {
    if (!this.options.enabled) return [];
    const docs = await this.db.execute(() => this.db.mongoDb.collection(NODES).aggregate<{ _id: string; title: string; conversationId: string; evidenceAt?: string }>([
      { $match: { workspaceId, kind: 'decision', conversationId: conversationFilter({ workspaceId, channelId }) } },
      { $addFields: { t: { $ifNull: ['$evidenceAt', '$updatedAt'] } } },
      { $sort: { t: -1, _id: 1 } },
      { $limit: limit },
      { $project: { title: 1, conversationId: 1, evidenceAt: 1 } },
    ]).toArray());
    return docs.map((d) => ({ id: d._id, title: d.title, conversationId: d.conversationId, ...(d.evidenceAt ? { evidenceAt: d.evidenceAt } : {}) }));
  }

  /** Nodes in `workspaceIds` matching `filter`. Unchecked: show them only through graph/acl.ts. */
  async nodes(workspaceIds: string[], filter: Record<string, unknown>, limit: number, page: { newestFirst?: boolean; skip?: number } = {}): Promise<GraphNodeDoc[]> {
    if (!this.options.enabled) return [];
    return this.db.execute(() => this.db.mongoDb.collection<GraphNodeDoc>(NODES).find({ ...filter, workspaceId: { $in: workspaceIds } }, { projection: { _id: 1, workspaceId: 1, conversationId: 1, kind: 1, title: 1, text: 1, canonicalId: 1, sourceMessageIds: 1, createdAt: 1, updatedAt: 1 } })
      .sort(page.newestFirst ? { updatedAt: -1, _id: 1 } : { _id: 1 }).skip(page.skip ?? 0).limit(limit).toArray());
  }

  /** How many entries (a canonical group counts once) of each kind match `filter` in `workspaceIds`. Unchecked: pass a filter no wider than the caller's ACL. */
  async countByKind(workspaceIds: string[], filter: Record<string, unknown>): Promise<Record<string, number>> {
    if (!this.options.enabled) return {};
    const rows = await this.db.execute(() => this.db.mongoDb.collection<GraphNodeDoc>(NODES).aggregate<{ _id: string; n: number }>([
      { $match: { ...filter, workspaceId: { $in: workspaceIds } } },
      { $group: { _id: { kind: '$kind', entry: { $ifNull: ['$canonicalId', '$_id'] } } } },
      { $group: { _id: '$_id.kind', n: { $sum: 1 } } },
    ]).toArray());
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }

  /** Edges in `workspaceIds` touching any of `ids` (and matching `filter`). Unchecked: show them only through graph/acl.ts. */
  async edgesOf(workspaceIds: string[], ids: string[], limit: number, filter: Record<string, unknown> = {}): Promise<GraphEdgeDoc[]> {
    if (!this.options.enabled || ids.length === 0) return [];
    return this.db.execute(() => this.db.mongoDb.collection<GraphEdgeDoc>(EDGES).find({ ...filter, workspaceId: { $in: workspaceIds }, $or: [{ from: { $in: ids } }, { to: { $in: ids } }] }).sort({ _id: 1 }).limit(limit).toArray());
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

  /** Starts an extraction run of `conversationId` and returns its token; a later start gets a larger one. 0 when disabled. */
  async startGraphRun(workspaceId: string, conversationId: string): Promise<number> {
    if (!this.options.enabled) return 0;
    const doc = await this.db.execute(() => this.db.mongoDb.collection<{ _id: string; run: number }>(RUNS).findOneAndUpdate(
      { _id: idOf(workspaceId, conversationId) },
      { $inc: { run: 1 }, $setOnInsert: { workspaceId, conversationId } },
      { upsert: true, returnDocument: 'after' },
    ));
    return doc?.run ?? 0;
  }

  /** The thread seq the last finished run extracted (undefined until one finishes, or after a purge). */
  async graphExtractedSeq(workspaceId: string, conversationId: string): Promise<number | undefined> {
    if (!this.options.enabled) return undefined;
    const doc = await this.db.execute(() => this.db.mongoDb.collection<{ _id: string; extractedSeq?: number }>(RUNS).findOne({ _id: idOf(workspaceId, conversationId) }, { projection: { extractedSeq: 1 } }));
    return doc?.extractedSeq;
  }

  async setGraphExtractedSeq(workspaceId: string, conversationId: string, seq: number): Promise<void> {
    if (!this.options.enabled) return;
    await this.db.execute(() => this.db.mongoDb.collection<{ _id: string }>(RUNS).updateOne({ _id: idOf(workspaceId, conversationId) }, { $set: { extractedSeq: seq } }));
  }

  /** Whether `run` is still the newest run started for `conversationId` (always true when disabled). */
  async isLatestGraphRun(workspaceId: string, conversationId: string, run: number): Promise<boolean> {
    if (!this.options.enabled) return true;
    const doc = await this.db.execute(() => this.db.mongoDb.collection<{ _id: string; run: number }>(RUNS).findOne({ _id: idOf(workspaceId, conversationId) }));
    return (doc?.run ?? 0) === run;
  }

  /**
   * Whether `workspaceId` is still under today's graph extraction cap.
   * ponytail: soft cap (check, then record after the call), so concurrent extractions can overshoot by one call each; reserve-then-settle if that matters.
   */
  /** True once a thread run has started for this conversation (the backfill skips those). */
  async hasGraphRun(workspaceId: string, conversationId: string): Promise<boolean> {
    return !!(await this.db.execute(() => this.db.mongoDb.collection(RUNS).findOne({ _id: idOf(workspaceId, conversationId) as never }, { projection: { _id: 1 } })));
  }

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
