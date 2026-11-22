import { describe, expect, it, vi } from 'vitest';
import { backfillEmbeddingChannels, createGraphSearch, ensureTextIndex, ensureVectorIndex } from '../src/graph/search.js';
import { EMBEDDINGS, GraphStore } from '../src/graph/store.js';
import { LlmMeter } from '../src/llm/llm.js';
import { testDb } from './helpers.js';

async function setup() {
  const db = testDb();
  const graph = new GraphStore(db, new LlmMeter(db, 1_000_000), { enabled: true, dailyCapMicros: 250_000 });
  const node = (workspaceId: string, conversationId: string, title: string, text?: string) =>
    graph.upsertNode({ workspaceId, conversationId, kind: 'decision', title, ...(text ? { text } : {}) });
  await node('w', 'channel:eng', 'Use Mongo for storage', 'Atlas, replica set');
  await node('w', 'thread:eng:p1', 'Mongoose is out', 'plain driver only');
  await node('w', 'channel:ops', 'Deploy on Cloud Run');
  await node('other', 'channel:eng', 'Use Mongo everywhere');
  await node('w', 'channel:aXb', 'Decoy cache');
  return { db, graph };
}

describe('graphSearch on a plain replica set (no Atlas)', () => {
  it('has no vector index and says so without throwing', async () => {
    const { db } = await setup();
    expect(await ensureVectorIndex(db, 768)).toBe(false);
    expect(await ensureTextIndex(db)).toBe(false);
  });

  it('backfills channelId onto embeddings stored before it existed', async () => {
    const { db } = await setup();
    const col = db.mongoDb.collection<{ _id: string; conversationId: string; channelId?: string | null }>(EMBEDDINGS);
    await col.insertMany([{ _id: 'e1', conversationId: 'thread:eng:p1' }, { _id: 'e2', conversationId: 'dm:a_b' }]);
    await backfillEmbeddingChannels(db);
    expect((await col.find({ _id: { $in: ['e1', 'e2'] } }).sort({ _id: 1 }).toArray()).map((d) => d.channelId)).toEqual(['eng', null]);
  });

  it('falls back to whole-word exact search, scoped to the workspace', async () => {
    const { db, graph } = await setup();
    const embed = vi.fn(async () => ({ ok: true, vector: [1], tokens: 1 }));
    const search = createGraphSearch({ db, graph, enabled: true, embedding: { embed, model: 'm', dimensions: 768, pricePerMTok: 0.15 } });

    const all = await search({ workspaceId: 'w' }, 'mongo');
    expect(all.mode).toBe('exact');
    expect(all.hits.map((h) => h.title)).toEqual(['Use Mongo for storage']); // "Mongoose" is not the word "mongo"
    expect(embed).not.toHaveBeenCalled(); // no vector index, so no paid embed

    const ranked = await search({ workspaceId: 'w' }, 'mongo storage driver');
    expect(ranked.hits.map((h) => [h.title, h.score])).toEqual([['Use Mongo for storage', 2 / 3], ['Mongoose is out', 1 / 3]]);

    expect((await search({ workspaceId: 'w', channelId: 'eng' }, 'driver')).hits.map((h) => h.conversationId)).toEqual(['thread:eng:p1']);
    expect((await search({ workspaceId: 'w', channelId: 'ops' }, 'mongo')).hits).toEqual([]);
    expect((await search({ workspaceId: 'w', conversationId: 'channel:ops' }, 'cloud')).hits).toHaveLength(1);
    expect((await search({ workspaceId: 'nobody' }, 'mongo')).hits).toEqual([]);
    expect((await search({ workspaceId: 'w', channelId: 'a.b' }, 'cache')).hits).toEqual([]); // the channel id is literal, not a regex
  });

  it('works with no Vertex configured', async () => {
    const { db, graph } = await setup();
    const search = createGraphSearch({ db, graph, enabled: true });
    expect(await search({ workspaceId: 'other' }, 'MONGO')).toMatchObject({ mode: 'exact', hits: [{ title: 'Use Mongo everywhere', conversationId: 'channel:eng' }] });
  });
});
