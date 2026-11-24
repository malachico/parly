import type { Database } from '../db/types.js';
import { channelOf, conversationFilter, EMBEDDINGS, escapeRegex, NODES, type GraphNodeKind, type GraphScope, type GraphStore } from './store.js';

const VECTOR_INDEX = 'graph_embeddings_vector';
const TEXT_INDEX = 'graph_nodes_text';

/** Atlas Vector Search index on graph_embeddings. `numDimensions` must match the embedding call's output size. */
const vectorIndexDefinition = (dimensions: number) => ({
  fields: [
    { type: 'vector', path: 'vector', numDimensions: dimensions, similarity: 'cosine' },
    { type: 'filter', path: 'workspaceId' },
    { type: 'filter', path: 'conversationId' },
    { type: 'filter', path: 'channelId' },
    { type: 'filter', path: 'model' },
    { type: 'filter', path: 'kind' },
  ],
});

/** Atlas Search (BM25) index on graph_nodes: title + text analyzed, scope fields as tokens for `equals`. */
const textIndexDefinition = {
  mappings: {
    dynamic: false,
    fields: { title: { type: 'string' }, text: { type: 'string' }, workspaceId: { type: 'token' }, conversationId: { type: 'token' }, kind: { type: 'token' } },
  },
};

export interface GraphHit {
  nodeId: string;
  kind: GraphNodeKind;
  title: string;
  text?: string;
  conversationId: string;
  score: number;
}

/**
 * `off`: graph disabled. The lexical leg always runs: `bm25` is Atlas Search, `exact` the whole-word regex fallback where
 * Atlas Search isn't available. `vector+…`: Atlas Vector Search found hits too, merged with the lexical ones (RRF).
 */
interface GraphSearchResult {
  mode: 'off' | 'bm25' | 'exact' | 'vector+bm25' | 'vector+exact';
  hits: GraphHit[];
}

/**
 * Internal only: no permission check. Callers must already know the reader may see `scope` (PR 3 adds that gate).
 * Never throws; a broken search returns no hits.
 */
export type GraphSearch = (scope: GraphScope, query: string, opts?: { limit?: number; kind?: GraphNodeKind }) => Promise<GraphSearchResult>;

export type Embedder = (text: string) => Promise<{ ok: boolean; vector: number[]; tokens: number; errorText?: string }>;

interface GraphSearchDeps {
  db: Database;
  graph: Pick<GraphStore, 'canSpendOnGraph' | 'recordGraphSpend'>;
  enabled: boolean;
  /** Absent when Vertex isn't configured: search is lexical only (BM25, or exact-word without Atlas Search). */
  embedding?: { embed: Embedder; model: string; dimensions: number; pricePerMTok: number };
  /** How long a "no vector index" answer is trusted before probing Atlas again. */
  reprobeMs?: number;
}

type SearchIndexDoc = { queryable?: boolean; latestDefinition?: { fields?: { path?: string }[] } };

/**
 * Finds or creates (or updates, when `stale` says the definition changed) an Atlas search index; true once it is
 * queryable. Never throws: a plain replica set (CI, self-hosters) rejects `$listSearchIndexes` and
 * `createSearchIndexes`, and that just means "no Atlas search of that kind".
 */
async function ensureSearchIndex(db: Database, collection: string, name: string, type: 'search' | 'vectorSearch', definition: object, stale = (_: SearchIndexDoc) => false): Promise<boolean> {
  try {
    const col = db.mongoDb.collection(collection);
    const [index] = await db.execute(() => col.listSearchIndexes(name).toArray()) as SearchIndexDoc[];
    if (!index) {
      await db.execute(() => col.createSearchIndex({ name, type, definition }));
      return false; // Atlas builds it in the background; the next probe sees it queryable.
    }
    if (stale(index)) {
      await db.execute(() => col.updateSearchIndex(name, definition));
      return false;
    }
    return index.queryable === true;
  } catch {
    return false;
  }
}

/** Sets `channelId` on embeddings stored before it existed (null outside channels). Never throws. */
export async function backfillEmbeddingChannels(db: Database): Promise<void> {
  try {
    const col = db.mongoDb.collection<{ _id: string; conversationId: string }>(EMBEDDINGS);
    const docs = await db.execute(() => col.find({ channelId: { $exists: false } }, { projection: { conversationId: 1 } }).toArray());
    if (!docs.length) return;
    await db.execute(() => col.bulkWrite(docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { channelId: channelOf(d.conversationId) } } } }))));
  } catch (err) {
    console.error('graph embeddings channelId backfill failed', err);
  }
}

/** The vector index, its `channelId` filter added to one built before it existed; embeddings get `channelId` first. */
export async function ensureVectorIndex(db: Database, dimensions: number): Promise<boolean> {
  await backfillEmbeddingChannels(db);
  return ensureSearchIndex(db, EMBEDDINGS, VECTOR_INDEX, 'vectorSearch', vectorIndexDefinition(dimensions),
    (index) => !index.latestDefinition?.fields?.some((f) => f.path === 'channelId'));
}

export const ensureTextIndex = (db: Database) => ensureSearchIndex(db, NODES, TEXT_INDEX, 'search', textIndexDefinition);

/** The scope's channels, by `conversationFilter`'s precedence; undefined when the scope isn't a channel one. */
const scopeChannels = (scope: GraphScope) => scope.channelIds ?? (scope.channelId !== undefined ? [scope.channelId] : undefined);

/** `$vectorSearch` pre-filters on workspace + model (+ kind) + channel(s) or conversation; the `$match` re-checks the exact conversation scope. */
export function vectorPipeline(scope: GraphScope, vector: number[], model: string, limit: number, kind?: GraphNodeKind): object[] {
  const conv = conversationFilter(scope);
  const channels = scopeChannels(scope);
  const filter = {
    workspaceId: { $eq: scope.workspaceId },
    model: { $eq: model },
    ...(kind ? { kind: { $eq: kind } } : {}),
    ...(channels ? { channelId: { $in: channels } } : typeof conv === 'string' ? { conversationId: { $eq: conv } } : {}),
  };
  return [
    { $vectorSearch: { index: VECTOR_INDEX, path: 'vector', queryVector: vector, numCandidates: Math.min(10_000, limit * 20), limit, filter } },
    { $project: { nodeId: 1, kind: 1, conversationId: 1, score: { $meta: 'vectorSearchScore' } } },
    ...(typeof conv === 'object' ? [{ $match: { conversationId: conv } }] : []),
    { $lookup: { from: NODES, localField: 'nodeId', foreignField: '_id', as: 'node' } },
    { $unwind: '$node' },
    { $project: { _id: 0, nodeId: 1, kind: 1, conversationId: 1, score: 1, title: '$node.title', text: '$node.text' } },
  ];
}

/** Where a lexical search may look: the workspace, and the scope's conversations and kind. */
const nodeScope = (scope: GraphScope, kind?: GraphNodeKind) => {
  const conv = conversationFilter(scope);
  return { workspaceId: scope.workspaceId, ...(conv !== undefined ? { conversationId: conv } : {}), ...(kind ? { kind } : {}) };
};

/**
 * BM25 over title + text. `$search` pre-filters the workspace (and a single conversation / kind); the `$match` applies
 * the exact scope. `$search` has no limit of its own, so the `$match` doesn't starve a quiet channel.
 */
export function textPipeline(scope: GraphScope, query: string, limit: number, kind?: GraphNodeKind): object[] {
  const conv = conversationFilter(scope);
  const equals = (path: string, value: string) => ({ equals: { path, value } });
  const filter = [equals('workspaceId', scope.workspaceId), ...(typeof conv === 'string' ? [equals('conversationId', conv)] : []), ...(kind ? [equals('kind', kind)] : [])];
  return [
    { $search: { index: TEXT_INDEX, compound: { must: [{ text: { query: queryWords(query).join(' '), path: ['title', 'text'] } }], filter } } },
    { $match: nodeScope(scope, kind) },
    { $limit: limit },
    { $project: { _id: 0, nodeId: '$_id', kind: 1, title: 1, text: 1, conversationId: 1, score: { $meta: 'searchScore' } } },
  ];
}

/** Reciprocal rank fusion: each list adds 1/(k + rank) per hit, deduped by nodeId, best first. */
export function fuseHits(lists: GraphHit[][], limit: number, k = 60): GraphHit[] {
  const fused = new Map<string, GraphHit>();
  for (const list of lists) {
    list.forEach((h, i) => {
      const prev = fused.get(h.nodeId);
      fused.set(h.nodeId, { ...(prev ?? h), score: (prev?.score ?? 0) + 1 / (k + i + 1) });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Lowercased distinct letter/number runs, capped so a pasted essay can't build a giant `$or`. */
export const queryWords = (query: string) => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 8);

const wholeWord = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'iu');

// ponytail: the no-Atlas-Search fallback scans the 500 most recent substring candidates in the workspace; fine for self-hosters' graph sizes.
const EXACT_CANDIDATES = 500;

async function exactSearch(db: Database, scope: GraphScope, query: string, limit: number, kind?: GraphNodeKind): Promise<GraphHit[]> {
  const words = queryWords(query);
  if (!words.length) return [];
  const filter = {
    ...nodeScope(scope, kind),
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
  // `fail` forgets a ready answer after the index stops working.
  const prober = (ensure: () => Promise<boolean>) => {
    let probe: { at: number; ready: Promise<boolean>; ok?: boolean } | undefined;
    return {
      ready: () => {
        if (!probe || (probe.ok === false && Date.now() - probe.at > reprobeMs)) {
          const next: NonNullable<typeof probe> = { at: Date.now(), ready: ensure() };
          void next.ready.then((ok) => { next.ok = ok; });
          probe = next;
        }
        return probe.ready;
      },
      fail: () => { probe = { at: Date.now(), ready: Promise.resolve(false), ok: false }; },
    };
  };
  const vectorIndex = embedding ? prober(() => ensureVectorIndex(db, embedding.dimensions)) : undefined;
  const textIndex = prober(() => ensureTextIndex(db));

  /** A workspace with no stored embeddings can't get vector hits, so don't pay for the query embed (nothing writes them until #787). */
  const hasEmbeddings = async (workspaceId: string) =>
    (await db.execute(() => db.mongoDb.collection(EMBEDDINGS).countDocuments({ workspaceId }, { limit: 1 }))) > 0;

  async function vectorSearch(scope: GraphScope, query: string, limit: number, kind?: GraphNodeKind): Promise<GraphHit[]> {
    if (!embedding || !vectorIndex || scopeChannels(scope)?.length === 0 || !(await vectorIndex.ready()) || !(await hasEmbeddings(scope.workspaceId)) || !(await graph.canSpendOnGraph(scope.workspaceId))) return [];
    const res = await embedding.embed(query);
    if (res.tokens > 0) await graph.recordGraphSpend(scope.workspaceId, Math.ceil(res.tokens * embedding.pricePerMTok));
    if (!res.ok) throw new Error(`embed failed: ${res.errorText ?? ''}`.slice(0, 300));
    try {
      return await db.execute(() => db.mongoDb.collection(EMBEDDINGS).aggregate<GraphHit>(vectorPipeline(scope, res.vector, embedding.model, limit, kind)).toArray());
    } catch (err) {
      // Index dropped or the wrong size: stop paying for embeds until the next probe says otherwise.
      vectorIndex.fail();
      throw err;
    }
  }

  /** BM25 when the Atlas Search index is queryable, else the whole-word regex fallback. Never throws. */
  async function lexicalSearch(scope: GraphScope, query: string, limit: number, kind?: GraphNodeKind): Promise<{ mode: 'bm25' | 'exact'; hits: GraphHit[] }> {
    if (await textIndex.ready()) {
      try {
        return { mode: 'bm25', hits: await db.execute(() => db.mongoDb.collection(NODES).aggregate<GraphHit>(textPipeline(scope, query, limit, kind)).toArray()) };
      } catch (err) {
        textIndex.fail();
        console.error('graph BM25 search failed; falling back to exact-word', err);
      }
    }
    try {
      return { mode: 'exact', hits: await exactSearch(db, scope, query, limit, kind) };
    } catch (err) {
      console.error('graph exact-word search failed', err);
      return { mode: 'exact', hits: [] };
    }
  }

  return async (scope, query, opts) => {
    if (!deps.enabled) return { mode: 'off', hits: [] };
    const limit = Math.max(1, Math.min(50, Math.trunc(opts?.limit ?? 10)));
    if (!queryWords(query).length) return { mode: 'exact', hits: [] };
    const [vector, lexical] = await Promise.all([
      vectorSearch(scope, query, limit, opts?.kind).catch((err) => {
        console.error('graph vector search failed; lexical only', err);
        return [];
      }),
      lexicalSearch(scope, query, limit, opts?.kind),
    ]);
    // Lexical-only keeps its own scores; with vector hits both rank lists are fused, so a word match the embedding missed still shows.
    return vector.length ? { mode: `vector+${lexical.mode}`, hits: fuseHits([vector, lexical.hits], limit) } : lexical;
  };
}
