import { describe, expect, it } from 'vitest';
import type { GraphJob } from '../src/chat/queue.js';
import { backfillGraph } from '../src/graph/backfill.js';
import { GraphStore } from '../src/graph/store.js';
import { LlmMeter } from '../src/llm/llm.js';
import { testDb } from './helpers.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const recent = new Date(NOW - 86_400_000).toISOString();
const old = new Date(NOW - 100 * 86_400_000).toISOString();

async function setup(workspaceDoc: (id: string) => Promise<{ archived?: boolean } | undefined> = async () => ({})) {
  const db = testDb();
  const meter = new LlmMeter(db, 1_000_000);
  await db.execute(() =>
    db.mongoDb.collection<{ _id: string }>('conversations').insertMany([
      { _id: 'channel:a', kind: 'channel', workspaceId: 'w1', seq: 7, lastAt: recent },
      { _id: 'thread:a:1', kind: 'thread', workspaceId: 'w1', doneAt: recent, lastAt: recent },
      { _id: 'thread:a:2', kind: 'thread', workspaceId: 'w1', lastAt: recent }, // open
      { _id: 'channel:b', kind: 'channel', workspaceId: 'w1', seq: 3, lastAt: recent },
      { _id: 'channel:gone', kind: 'channel', workspaceId: 'w1', seq: 1, lastAt: recent }, // archived
      { _id: 'thread:gone:1', kind: 'thread', workspaceId: 'w1', doneAt: recent, lastAt: recent }, // under the archived channel
      { _id: 'channel:old', kind: 'channel', workspaceId: 'w1', seq: 1, lastAt: old },
      { _id: 'channel:c', kind: 'channel', workspaceId: 'w2', seq: 2, lastAt: recent },
      { _id: 'dm:x:y', kind: 'dm', lastAt: recent },
    ] as never),
  );
  const registry = {
    channelDoc: async (id: string) => (['a', 'b', 'c'].includes(id) ? {} : id === 'gone' ? { archived: true } : undefined),
    workspaceDoc,
  };
  const jobs: GraphJob[] = [];
  const queue = { enqueue: async (job: GraphJob) => void jobs.push(job) };
  const run = (graph: GraphStore, limit?: number) => backfillGraph({ db, graph, registry, queue }, { limit, now: NOW });
  const graph = (dailyCapMicros: number) => new GraphStore(db, meter, { enabled: true, dailyCapMicros });
  return { jobs, run, graph };
}

const ids = (jobs: GraphJob[]) => jobs.map((j) => j.conversationId).sort();

describe('backfillGraph', () => {
  it('resumes from its cursor and is idempotent on rerun', async () => {
    const { jobs, run, graph } = await setup();
    const g = graph(1_000_000);
    // limit counts every conversation examined, skips included.
    expect(await run(g, 2)).toEqual({ enqueued: 2, skipped: 0, capped: [], done: false });
    expect(await run(g, 2)).toEqual({ enqueued: 1, skipped: 1, capped: [], done: false }); // channel:c; the archived channel
    expect(await run(g, -1)).toEqual({ enqueued: 1, skipped: 0, capped: [], done: false }); // clamped to 1
    expect(ids(jobs)).toEqual(['channel:a', 'channel:b', 'channel:c', 'thread:a:1']);
    expect(jobs.find((j) => j.conversationId === 'channel:a')).toEqual({ kind: 'graph', workspaceId: 'w1', conversationId: 'channel:a', seq: 7 });
    expect(jobs.find((j) => j.conversationId === 'thread:a:1')).toEqual({ kind: 'graph', workspaceId: 'w1', conversationId: 'thread:a:1' });

    expect(await run(g)).toEqual({ enqueued: 0, skipped: 2, capped: [], done: true }); // the open thread, the archived channel's thread
    expect(await run(g)).toEqual({ enqueued: 0, skipped: 0, capped: [], done: true });
    expect(jobs).toHaveLength(4);
  });

  it('stops a workspace at its daily cap and picks it up where it stopped', async () => {
    const { jobs, run, graph } = await setup();
    const capped = graph(1_000);
    await capped.recordGraphSpend('w1', 1_000);
    expect(await run(capped)).toEqual({ enqueued: 1, skipped: 0, capped: ['w1'], done: false });
    expect(ids(jobs)).toEqual(['channel:c']);

    // Next day (simulated by a higher cap): w1 starts from its first conversation, nothing is enqueued twice.
    expect(await run(graph(1_000_000))).toMatchObject({ enqueued: 3, capped: [], done: true });
    expect(ids(jobs)).toEqual(['channel:a', 'channel:b', 'channel:c', 'thread:a:1']);
  });

  it('skips a thread that already has a graph run', async () => {
    const { jobs, run, graph } = await setup();
    const g = graph(1_000_000);
    await g.startGraphRun('w1', 'thread:a:1');
    expect(await run(g)).toMatchObject({ enqueued: 3, skipped: 4, done: true });
    expect(ids(jobs)).toEqual(['channel:a', 'channel:b', 'channel:c']);
  });

  it.each([
    ['a deleted workspace', undefined],
    ['an archived workspace', { archived: true }],
  ])('leaves out %s', async (_name, doc) => {
    const { jobs, run, graph } = await setup(async (id) => (id === 'w2' ? doc : {}));
    expect(await run(graph(1_000_000))).toMatchObject({ enqueued: 3, skipped: 4, done: true });
    expect(ids(jobs)).toEqual(['channel:a', 'channel:b', 'thread:a:1']);
  });
});
