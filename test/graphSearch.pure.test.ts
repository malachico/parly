import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/types.js';
import { type Embedder, createGraphSearch, queryWords, vectorPipeline } from '../src/graph/search.js';
import { embed } from '../src/lib/vertex.js';

const explodingDb = new Proxy({}, { get: () => { throw new Error('db touched'); } }) as Database;
const hit = { nodeId: 'n1', kind: 'decision', title: 'Use Mongo', conversationId: 'c', score: 0.9 };

/** Atlas stand-in: a queryable vector index, `aggregate` answering with `vectorHits`, `find` with nothing. */
function atlasDb(vectorHits: object[] | Error) {
  const aggregate = vi.fn(() => ({ toArray: async () => { if (vectorHits instanceof Error) throw vectorHits; return vectorHits; } }));
  const node = { _id: 'n2', kind: 'decision', title: 'mongo fallback', conversationId: 'c' };
  const find = vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [node] }) }) }));
  const collection = () => ({ listSearchIndexes: () => ({ toArray: async () => [{ queryable: true }] }), aggregate, find });
  return { db: { execute: (f: () => unknown) => f(), mongoDb: { collection } } as unknown as Database, aggregate, find };
}

function setup(opts: { canSpend?: boolean; embed?: Embedder; vectorHits?: object[] | Error } = {}) {
  const graph = { canSpendOnGraph: vi.fn(async () => opts.canSpend ?? true), recordGraphSpend: vi.fn(async () => {}) };
  const embedFn = opts.embed ?? vi.fn(async () => ({ ok: true, vector: [0.1, 0.2], tokens: 10 }));
  const { db, aggregate, find } = atlasDb(opts.vectorHits ?? [hit]);
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

  it('vector path: embeds, records spend, returns hits', async () => {
    const { search, graph, embedFn } = setup();
    expect(await search({ workspaceId: 'w' }, 'which db?')).toEqual({ mode: 'vector', hits: [hit] });
    expect(embedFn).toHaveBeenCalledWith('which db?');
    expect(graph.recordGraphSpend).toHaveBeenCalledWith('w', 2); // ceil(10 tokens × 0.15 µ$)
  });

  it('cap exhausted: no embed call, exact-word instead', async () => {
    const { search, embedFn, find } = setup({ canSpend: false });
    expect((await search({ workspaceId: 'w' }, 'mongo')).mode).toBe('exact');
    expect(embedFn).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalled();
  });

  it('falls back to exact-word when embed fails, rejects, or $vectorSearch throws or finds nothing', async () => {
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

  it('builds the $vectorSearch pipeline with pre-filters, over-fetching for a channel', () => {
    const conv = vectorPipeline({ workspaceId: 'w', conversationId: 'dm:a' }, [1], 'm', 5) as Record<string, any>[];
    expect(conv[0]?.$vectorSearch).toMatchObject({ index: 'graph_embeddings_vector', path: 'vector', limit: 5, filter: { workspaceId: { $eq: 'w' }, model: { $eq: 'm' }, conversationId: { $eq: 'dm:a' } } });
    const chan = vectorPipeline({ workspaceId: 'w', channelId: 'a.b' }, [1], 'm', 5) as Record<string, any>[];
    expect(chan[0]?.$vectorSearch.limit).toBe(25);
    expect(chan[0]?.$vectorSearch.filter).toEqual({ workspaceId: { $eq: 'w' }, model: { $eq: 'm' } });
    expect(chan[2]).toEqual({ $match: { conversationId: { $regex: '^(channel:a\\.b$|thread:a\\.b:)' } } });
    expect(chan[3]).toEqual({ $limit: 5 });
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
