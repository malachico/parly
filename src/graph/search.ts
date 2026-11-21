import type { Database } from '../db/types.js';
import { conversationFilter, EMBEDDINGS, escapeRegex, NODES, type GraphNodeKind, type GraphScope, type GraphStore } from './store.js';

export const VECTOR_INDEX = 'graph_embeddings_vector';

/** Atlas Vector Search index on graph_embeddings. `numDimensions` must match the embedding call's output size. */
export const vectorIndexDefinition = (dimensions: number) => ({
  fields: [
    { type: 'vector', path: 'vector', numDimensions: dimensions, similarity: 'cosine' },
    { type: 'filter', path: 'workspaceId' },
    { type: 'filter', path: 'conversationId' },
    { type: 'filter', path: 'model' },
    { type: 'filter', path: 'kind' },
  ],
});

export interface GraphHit {
  nodeId: string;
  kind: GraphNodeKind;
  title: string;
  text?: string;
  conversationId: string;
  score: number;
}

/** `off`: graph disabled. `vector`: Atlas Vector Search. `exact`: whole-word match, the fallback everywhere else. */
export interface GraphSearchResult {
  mode: 'off' | 'vector' | 'exact';
  hits: GraphHit[];
}

/**
 * Internal only: no permission check. Callers must already know the reader may see `scope` (PR 3 adds that gate).
 * Never throws; a broken search returns no hits.
 */
export type GraphSearch = (scope: GraphScope, query: string, opts?: { limit?: number }) => Promise<GraphSearchResult>;

export type Embedder = (text: string) => Promise<{ ok: boolean; vector: number[]; tokens: number; errorText?: string }>;

export interface GraphSearchDeps {
  db: Database;
  graph: Pick<GraphStore, 'canSpendOnGraph' | 'recordGraphSpend'>;
  enabled: boolean;
  /** Absent when Vertex isn't configured: search is exact-word only. */
  embedding?: { embed: Embedder; model: string; dimensions: number; pricePerMTok: number };
  /** How long a "no vector index" answer is trusted before probing Atlas again. */
  reprobeMs?: number;
}

/**
 * Finds or creates the vector index; true once it is queryable. Never throws: a plain replica set (CI, self-hosters)
 * rejects `$listSearchIndexes` and `createSearchIndexes`, and that just means "no vector search".
 */
export async function ensureVectorIndex(db: Database, dimensions: number): Promise<boolean> {
  try {
    const col = db.mongoDb.collection(EMBEDDINGS);
    const [index] = await db.execute(() => col.listSearchIndexes(VECTOR_INDEX).toArray()) as { queryable?: boolean }[];
    if (!index) {
      await db.execute(() => col.createSearchIndex({ name: VECTOR_INDEX, type: 'vectorSearch', definition: vectorIndexDefinition(dimensions) }));
      return false; // Atlas builds it in the background; the next probe sees it queryable.
    }
    return index.queryable === true;
  } catch {
    return false;
  }
}

/** `$vectorSearch` pre-filters on workspace + model (+ conversation); a channel scope is a regex, so over-fetch and `$match` after. */
// ponytail: channel scope over-fetches 5x workspace-wide then filters, so a busy workspace can starve a quiet channel; store channelId on embeddings and pre-filter it when that bites.
export function vectorPipeline(scope: GraphScope, vector: number[], model: string, limit: number): object[] {
  const conv = conversationFilter(scope);
  const regex = typeof conv === 'object';
  const fetch = regex ? limit * 5 : limit;
  const filter = { workspaceId: { $eq: scope.workspaceId }, model: { $eq: model }, ...(typeof conv === 'string' ? { conversationId: { $eq: conv } } : {}) };
  return [
    { $vectorSearch: { index: VECTOR_INDEX, path: 'vector', queryVector: vector, numCandidates: Math.min(10_000, fetch * 20), limit: fetch, filter } },
    { $project: { nodeId: 1, kind: 1, conversationId: 1, score: { $meta: 'vectorSearchScore' } } },
    ...(regex ? [{ $match: { conversationId: conv } }, { $limit: limit }] : []),
    { $lookup: { from: NODES, localField: 'nodeId', foreignField: '_id', as: 'node' } },
    { $unwind: '$node' },
    { $project: { _id: 0, nodeId: 1, kind: 1, conversationId: 1, score: 1, title: '$node.title', text: '$node.text' } },
  ];
}

/** Lowercased distinct letter/number runs, capped so a pasted essay can't build a giant `$or`. */
export const queryWords = (query: string) => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 8);

const wholeWord = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'iu');

// ponytail: scans the 500 most recent substring candidates in the workspace; add a text index when graphs outgrow that.
const EXACT_CANDIDATES = 500;

async function exactSearch(db: Database, scope: GraphScope, query: string, limit: number): Promise<GraphHit[]> {
  const words = queryWords(query);
  if (!words.length) return [];
  const conv = conversationFilter(scope);
  const filter = {
    workspaceId: scope.workspaceId,
    ...(conv !== undefined ? { conversationId: conv } : {}),
    $or: words.flatMap((w) => [{ title: { $regex: escapeRegex(w), $options: 'i' } }, { text: { $regex: escapeRegex(w), $options: 'i' } }]),
  };
  const docs = await db.execute(() => db.mongoDb.collection<{ _id: string; kind: GraphNodeKind; title: string; text?: string; conversationId: string }>(NODES)
    .find(filter, { projection: { kind: 1, title: 1, text: 1, conversationId: 1 } })
    .sort({ updatedAt: -1 })
    .limit(EXACT_CANDIDATES)
    .toArray());
  const patterns = words.map(wholeWord);
  return docs
    .map((d) => {
      const haystack = `${d.title}\n${d.text ?? ''}`;
      const score = patterns.filter((p) => p.test(haystack)).length / words.length;
      return { nodeId: d._id, kind: d.kind, title: d.title, ...(d.text !== undefined ? { text: d.text } : {}), conversationId: d.conversationId, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function createGraphSearch(deps: GraphSearchDeps): GraphSearch {
  const { db, graph, embedding } = deps;
  const reprobeMs = deps.reprobeMs ?? 10 * 60_000;
  // A "ready" answer sticks; a "not ready" one is re-asked after reprobeMs (the index may be building, or added later).
  let probe: { at: number; ready: Promise<boolean>; ok?: boolean } | undefined;
  const vectorReady = (dimensions: number) => {
    if (!probe || (probe.ok === false && Date.now() - probe.at > reprobeMs)) {
      const next: NonNullable<typeof probe> = { at: Date.now(), ready: ensureVectorIndex(db, dimensions) };
      void next.ready.then((ok) => { next.ok = ok; });
      probe = next;
    }
    return probe.ready;
  };

  async function vectorSearch(scope: GraphScope, query: string, limit: number): Promise<GraphHit[]> {
    if (!embedding || !(await vectorReady(embedding.dimensions)) || !(await graph.canSpendOnGraph(scope.workspaceId))) return [];
    const res = await embedding.embed(query);
    if (res.tokens > 0) await graph.recordGraphSpend(scope.workspaceId, Math.ceil(res.tokens * embedding.pricePerMTok));
    if (!res.ok) throw new Error(`embed failed: ${res.errorText ?? ''}`.slice(0, 300));
    try {
      return await db.execute(() => db.mongoDb.collection(EMBEDDINGS).aggregate<GraphHit>(vectorPipeline(scope, res.vector, embedding.model, limit)).toArray());
    } catch (err) {
      // Index dropped or the wrong size: stop paying for embeds until the next probe says otherwise.
      probe = { at: Date.now(), ready: Promise.resolve(false), ok: false };
      throw err;
    }
  }

  return async (scope, query, opts) => {
    if (!deps.enabled) return { mode: 'off', hits: [] };
    const limit = Math.max(1, Math.min(50, Math.trunc(opts?.limit ?? 10)));
    if (!queryWords(query).length) return { mode: 'exact', hits: [] };
    try {
      const hits = await vectorSearch(scope, query, limit);
      if (hits.length) return { mode: 'vector', hits };
    } catch (err) {
      console.error('graph vector search failed; falling back to exact-word', err);
    }
    try {
      return { mode: 'exact', hits: await exactSearch(db, scope, query, limit) };
    } catch (err) {
      console.error('graph exact-word search failed', err);
      return { mode: 'exact', hits: [] };
    }
  };
}
