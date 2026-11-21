import { createHash } from 'node:crypto';
import type { Database } from '../db/types.js';
import type { LlmMeter } from '../llm/llm.js';

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

/** Case/whitespace-insensitive identity, so "Use  Mongo" and "use mongo" are one node. */
export const normalizeKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Deterministic id from the idempotency key: re-extracting the same thing lands on the same row. */
const idOf = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);

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

  /** Inserts or refreshes a node (keyed by `key`, default its title) and returns its id; undefined when disabled. */
  async upsertNode(node: GraphScope & { conversationId: string; kind: GraphNodeKind; title: string; text?: string; key?: string; sourceMessageIds?: string[] }): Promise<string | undefined> {
    if (!this.options.enabled) return undefined;
    const { workspaceId, conversationId, kind, title, text } = node;
    const key = normalizeKey(node.key ?? title);
    const id = idOf(workspaceId, conversationId, kind, key);
    const now = new Date().toISOString();
    await this.db.execute(() => this.db.mongoDb.collection<{ _id: string }>(NODES).updateOne(
      { _id: id },
      {
        $set: { title, ...(text !== undefined ? { text } : {}), updatedAt: now },
        $setOnInsert: { workspaceId, conversationId, kind, key, createdAt: now },
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
    await this.db.execute(() => Promise.all([col(NODES).deleteMany(own), col(EMBEDDINGS).deleteMany(own), col(EDGES).deleteMany(edges)]));
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
