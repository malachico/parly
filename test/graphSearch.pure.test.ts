import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/types.js';
import { type Embedder, type GraphHit, createGraphSearch, fuseHits, queryWords, textPipeline, vectorPipeline } from '../src/graph/search.js';
import { channelOf } from '../src/graph/store.js';
import { embed } from '../src/lib/vertex.js';

const explodingDb = new Proxy({}, { get: () => { throw new Error('db touched'); } }) as Database;
const hit = { nodeId: 'n1', kind: 'decision', title: 'Use Mongo', conversationId: 'c', score: 0.9 };

/**
 * Atlas stand-in: a queryable vector index answering `$vectorSearch` with `vectorHits`; a queryable text index answering
 * `$search` with `bm25Hits` only when they're given (else no Atlas Search); `find` answers the regex fallback with n2.
 */
function atlasDb(vectorHits: object[] | Error, bm25Hits?: object[], embeddings = 1) {
  const aggregate = vi.fn((pipeline: Record<string, unknown>[]) => ({
    toArray: async () => {
      if (pipeline[0]?.$search) return bm25Hits ?? [];
      if (vectorHits instanceof Error) throw vectorHits;
      return vectorHits;
    },
  }));
  const node = { _id: 'n2', kind: 'decision', title: 'mongo fallback', conversationId: 'c' };
  const find = vi.fn(() => ({ toArray: async () => [], sort: () => ({ limit: () => ({ toArray: async () => [node] }) }) }));
  const indexes = (name: string) => name === 'graph_nodes' ? (bm25Hits ? [{ queryable: true }] : []) : [{ queryable: true, latestDefinition: { fields: [{ path: 'channelId' }] } }];
  const collection = (name: string) => ({ listSearchIndexes: () => ({ toArray: async () => indexes(name) }), createSearchIndex: async () => 'x', aggregate, find, countDocuments: async () => embeddings });
  return { db: { execute: (f: () => unknown) => f(), mongoDb: { collection } } as unknown as Database, aggregate, find };
}

function setup(opts: { canSpend?: boolean; embed?: Embedder; vectorHits?: object[] | Error; bm25Hits?: object[]; embeddings?: number } = {}) {
  const graph = { canSpendOnGraph: vi.fn(async () => opts.canSpend ?? true), recordGraphSpend: vi.fn(async () => {}) };
  const embedFn = opts.embed ?? vi.fn(async () => ({ ok: true, vector: [0.1, 0.2], tokens: 10 }));
  const { db, aggregate, find } = atlasDb(opts.vectorHits ?? [hit], opts.bm25Hits, opts.embeddings);
  const search = createGraphSearch({ db, graph, enabled: true, embedding: { embed: embedFn, model: 'm', dimensions: 2, pricePerMTok: 0.15 } });
  return { search, graph, embedFn, aggregate, find };
}

describe('graphSearch (pure)', () => {
  it('flag off: touches neither db nor network', async () => {
    const embedFn = vi.fn();
    const graph = { canSpendOnGraph: vi.fn(), recordGraphSpend: vi.fn() };
    const search = createGraphSearch({ db: explodingDb, graph, enabled: false, embedding: { embed: embedFn, model: 'm', dimensions: 2, pricePerMTok: 1 } });
    expect(await search({ workspaceId: 'w' }, 'mongo')).toEqual({ mode: 'off', hits: [] });
    expect(embedFn).not.toHaveBeenCalled();
    expect(graph.canSpendOnGraph).not.toHaveBeenCalled();
  });

  it('vector path: embeds, records spend, fuses vector hits with the lexical ones', async () => {
    const { search, graph, embedFn } = setup();
    expect(await search({ workspaceId: 'w' }, 'which db?')).toMatchObject({ mode: 'vector+exact', hits: [{ nodeId: 'n1', score: 1 / 61 }] }); // n2 lacks the words; fused score is RRF;
    expect(embedFn).toHaveBeenCalledWith('which db?');
    expect(graph.recordGraphSpend).toHaveBeenCalledWith('w', 2); // ceil(10 tokens × 0.15 µ$)
  });

  it('hybrid: a BM25-only match survives when vector returns results', async () => {
    const bm25 = { nodeId: 'lex', kind: 'decision', title: 'Mongo ADR-17', conversationId: 'c', score: 7.5 };
    const { search } = setup({ bm25Hits: [bm25] });
    const res = await search({ workspaceId: 'w' }, 'ADR-17');
    expect(res.mode).toBe('vector+bm25');
    expect(res.hits.map((h) => h.nodeId).sort()).toEqual(['lex', 'n1']);
    expect((await setup({ bm25Hits: [bm25], vectorHits: [] }).search({ workspaceId: 'w' }, 'ADR-17'))).toEqual({ mode: 'bm25', hits: [bm25] }); // raw BM25 scores alone
  });

  it('an empty channel list searches nothing and pays for no embed', async () => {
    const { search, embedFn, aggregate } = setup({ bm25Hits: [{ nodeId: 'x', kind: 'decision', title: 't', conversationId: 'channel:a', score: 1 }] });
    await search({ workspaceId: 'w', channelIds: [] }, 'mongo');
    expect(embedFn).not.toHaveBeenCalled();
    expect(aggregate.mock.calls.map(([p]) => p.at(1))).toEqual([{ $match: { workspaceId: 'w', conversationId: { $in: [] } } }]);
  });

  it('fuses rank lists by RRF: dedupes by nodeId, a hit in both lists wins, respects limit', () => {
    const h = (nodeId: string) => ({ nodeId, kind: 'decision', title: nodeId, conversationId: 'c', score: 99 }) as GraphHit;
    const fused = fuseHits([[h('a'), h('b')], [h('c'), h('b')]], 2);
    expect(fused.map((x) => x.nodeId)).toEqual(['b', 'a']);
    expect(fused[0]!.score).toBeCloseTo(2 / 62);
    expect(fuseHits([[h('a')], [h('z')]], 5).map((x) => x.nodeId)).toEqual(['a', 'z']);
  });

  it('a workspace with no embeddings pays for no embed, exact-word instead', async () => {
    const { search, graph, embedFn, find } = setup({ embeddings: 0 });
    expect(await search({ workspaceId: 'w' }, 'mongo')).toMatchObject({ mode: 'exact', hits: [{ nodeId: 'n2' }] });
    expect(embedFn).not.toHaveBeenCalled();
    expect(graph.recordGraphSpend).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalled();
  });

  it('cap exhausted: no embed call, exact-word instead', async () => {
    const { search, embedFn, find } = setup({ canSpend: false });
    expect((await search({ workspaceId: 'w' }, 'mongo')).mode).toBe('exact');
    expect(embedFn).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalled();
  });

  it('lexical only when embed fails, rejects, or $vectorSearch throws or finds nothing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = [
      setup({ embed: vi.fn(async () => ({ ok: false, vector: [], tokens: 0, errorText: '500' })) }),
      setup({ embed: vi.fn(async () => { throw new Error('network'); }) }),
      setup({ vectorHits: new Error('$vectorSearch is only allowed on Atlas') }),
      setup({ vectorHits: [] }),
    ];
    for (const { search } of failing) expect(await search({ workspaceId: 'w' }, 'mongo')).toMatchObject({ mode: 'exact', hits: [{ nodeId: 'n2', score: 1 }] });
    expect(failing[0]!.graph.recordGraphSpend).not.toHaveBeenCalled();
    expect(failing[2]!.graph.recordGraphSpend).toHaveBeenCalledWith('w', 2); // the embed was billed even though the search failed
    quiet.mockRestore();
  });

  it('stops paying for embeds after $vectorSearch fails, until the next probe', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { search, embedFn } = setup({ vectorHits: new Error('index gone') });
    await search({ workspaceId: 'w' }, 'mongo');
    await search({ workspaceId: 'w' }, 'mongo');
    expect(embedFn).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it('skips everything for a query with no words', async () => {
    const { search, embedFn, find } = setup();
    expect(await search({ workspaceId: 'w' }, ' ?! ')).toEqual({ mode: 'exact', hits: [] });
    expect(embedFn).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('builds the $vectorSearch pipeline with pre-filters, channel scopes on channelId', () => {
    const conv = vectorPipeline({ workspaceId: 'w', conversationId: 'dm:a' }, [1], 'm', 5) as Record<string, any>[];
    expect(conv[0]?.$vectorSearch).toMatchObject({ index: 'graph_embeddings_vector', path: 'vector', limit: 5, filter: { workspaceId: { $eq: 'w' }, model: { $eq: 'm' }, conversationId: { $eq: 'dm:a' } } });
    const chan = vectorPipeline({ workspaceId: 'w', channelId: 'a.b' }, [1], 'm', 5) as Record<string, any>[];
    expect(chan[0]?.$vectorSearch.limit).toBe(5);
    expect(chan[0]?.$vectorSearch.filter).toEqual({ workspaceId: { $eq: 'w' }, model: { $eq: 'm' }, channelId: { $in: ['a.b'] } });
    expect(chan[2]).toEqual({ $match: { conversationId: { $regex: '^(channel:a\\.b$|thread:a\\.b:)' } } });
    const many = vectorPipeline({ workspaceId: 'w', channelId: 'x', channelIds: ['a', 'b'] }, [1], 'm', 5, 'decision') as Record<string, any>[];
    expect(many[0]?.$vectorSearch.filter).toEqual({ workspaceId: { $eq: 'w' }, model: { $eq: 'm' }, kind: { $eq: 'decision' }, channelId: { $in: ['a', 'b'] } });
  });

  it('builds the BM25 $search pipeline: workspace pre-filter, exact scope $match, limit', () => {
    const p = textPipeline({ workspaceId: 'w', channelId: 'a.b' }, 'Use MONGO!', 5, 'decision') as Record<string, any>[];
    expect(p[0]?.$search).toEqual({ index: 'graph_nodes_text', compound: { must: [{ text: { query: 'use mongo', path: ['title', 'text'] } }], filter: [{ equals: { path: 'workspaceId', value: 'w' } }, { equals: { path: 'kind', value: 'decision' } }] } });
    expect(p[1]).toEqual({ $match: { workspaceId: 'w', conversationId: { $regex: '^(channel:a\\.b$|thread:a\\.b:)' }, kind: 'decision' } });
    expect(p[2]).toEqual({ $limit: 5 });
    const one = textPipeline({ workspaceId: 'w', conversationId: 'dm:a_b' }, 'x', 5) as Record<string, any>[];
    expect(one[0]?.$search.compound.filter).toEqual([{ equals: { path: 'workspaceId', value: 'w' } }, { equals: { path: 'conversationId', value: 'dm:a_b' } }]);
  });

  it('derives an embedding channelId the way conversationFilter scopes channels', () => {
    expect(channelOf('channel:a.b')).toBe('a.b');
    expect(channelOf('thread:eng:p1')).toBe('eng');
    expect(channelOf('dm:a_b')).toBeNull();
    expect(channelOf('skill:s1')).toBeNull();
    expect(channelOf('channel:a:b')).toBeNull();
  });

  it('splits a query into distinct lowercase words, any script', () => {
    expect(queryWords('Use MONGO, use mongo! שלום 42')).toEqual(['use', 'mongo', 'שלום', '42']);
    expect(queryWords('a b c d e f g h i j')).toHaveLength(8);
    expect(queryWords(' ?! ')).toEqual([]);
  });
});

describe('vertex embed', () => {
  const call = (res: Response) => {
    const fetchImpl = vi.fn(async () => res);
    return { fetchImpl, result: embed({ project: 'p', location: 'us-central1', model: 'gemini-embedding-001', text: 'hello world!', taskType: 'RETRIEVAL_QUERY', dimensions: 768, accessToken: async () => 't', fetchImpl }) };
  };

  it('posts one instance and reads values and token count', async () => {
    const { fetchImpl, result } = call(Response.json({ predictions: [{ embeddings: { values: [0.5, 0.25], statistics: { token_count: 3 } } }] }));
    expect(await result).toEqual({ ok: true, status: 200, vector: [0.5, 0.25], tokens: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-embedding-001:predict');
    expect(JSON.parse(init.body as string)).toEqual({ instances: [{ content: 'hello world!', task_type: 'RETRIEVAL_QUERY' }], parameters: { outputDimensionality: 768 } });
  });

  it('estimates tokens when Vertex omits them, and reports HTTP errors without throwing', async () => {
    expect((await call(Response.json({ predictions: [{ embeddings: { values: [1] } }] })).result).tokens).toBe(3);
    expect(await call(new Response('quota', { status: 429 })).result).toEqual({ ok: false, status: 429, vector: [], tokens: 0, errorText: 'quota' });
  });
});
