import { describe, expect, it, vi } from 'vitest';
import type { MessageDoc } from '../src/chat/chat.js';
import { graphExtractor } from '../src/graph/extract.js';
import { GraphStore } from '../src/graph/store.js';
import { LlmMeter } from '../src/llm/llm.js';
import { Registry } from '../src/registry/registry.js';
import { crew, testDb } from './helpers.js';

function setup(dailyCapMicros = 250_000) {
  const db = testDb();
  const graph = new GraphStore(db, new LlmMeter(db, 1_000_000), { enabled: true, dailyCapMicros });
  const count = (name: string, filter: object = {}) => db.execute(() => db.mongoDb.collection(name).countDocuments(filter));
  return { db, graph, count };
}

describe('GraphStore', () => {
  it('upserts idempotently, merging sources', async () => {
    const { db, graph, count } = setup();
    const a = await graph.upsertNode({ workspaceId: 'w', conversationId: 'c', kind: 'decision', title: 'Use  Mongo', sourceMessageIds: ['m1'] });
    const b = await graph.upsertNode({ workspaceId: 'w', conversationId: 'c', kind: 'decision', title: 'use mongo', sourceMessageIds: ['m1', 'm2'] });
    expect(a).toBe(b);
    expect(await count('graph_nodes')).toBe(1);
    const node = await db.execute(() => db.mongoDb.collection<{ _id: string; title?: string; sourceMessageIds?: string[] }>('graph_nodes').findOne({ _id: a! }));
    expect(node?.sourceMessageIds).toEqual(['m1', 'm2']);
    expect(node?.title).toBe('use mongo');

    const e1 = await graph.upsertEdge({ workspaceId: 'w', kind: 'about', from: { id: a!, conversationId: 'c' }, to: { id: a!, conversationId: 'c' } });
    const e2 = await graph.upsertEdge({ workspaceId: 'w', kind: 'About', from: { id: a!, conversationId: 'c' }, to: { id: a!, conversationId: 'c' } });
    expect(e1).toBe(e2);
    expect(await count('graph_edges')).toBe(1);
  });

  it('purges only the scope, plus edges with either end in it', async () => {
    const { graph, count } = setup();
    const node = (workspaceId: string, conversationId: string) => graph.upsertNode({ workspaceId, conversationId, kind: 'topic', title: conversationId });
    const x = (await node('w', 'x'))!;
    const y = (await node('w', 'y'))!;
    const z = (await node('w', 'z'))!;
    const other = (await node('w2', 'x'))!;
    await graph.upsertEmbedding({ workspaceId: 'w', conversationId: 'x', nodeId: x, kind: 'topic', model: 'm', vector: [1, 2] });
    await graph.upsertEmbedding({ workspaceId: 'w', conversationId: 'y', nodeId: y, kind: 'topic', model: 'm', vector: [3, 4] });
    await graph.upsertEmbedding({ workspaceId: 'w2', conversationId: 'x', nodeId: other, kind: 'topic', model: 'm', vector: [5, 6] });
    await graph.upsertEdge({ workspaceId: 'w', kind: 'rel', from: { id: y, conversationId: 'y' }, to: { id: x, conversationId: 'x' } });
    await graph.upsertEdge({ workspaceId: 'w', kind: 'rel', from: { id: x, conversationId: 'x' }, to: { id: z, conversationId: 'z' } });
    await graph.upsertEdge({ workspaceId: 'w', kind: 'rel', from: { id: y, conversationId: 'y' }, to: { id: z, conversationId: 'z' } });
    await graph.upsertEdge({ workspaceId: 'w2', kind: 'rel', from: { id: other, conversationId: 'x' }, to: { id: other, conversationId: 'x' } });

    await graph.purgeGraphFor({ workspaceId: 'w', conversationId: 'x' });
    expect(await count('graph_nodes', { workspaceId: 'w' })).toBe(2);
    expect(await count('graph_nodes', { workspaceId: 'w', conversationId: 'x' })).toBe(0);
    expect(await count('graph_embeddings', { workspaceId: 'w' })).toBe(1);
    expect(await count('graph_edges', { workspaceId: 'w' })).toBe(1); // y>x (to-end) and x>z (from-end) went with x; y>z survives
    for (const name of ['graph_nodes', 'graph_edges', 'graph_embeddings']) expect(await count(name, { workspaceId: 'w2' })).toBe(1); // same conversation id, other workspace

    await graph.purgeGraphFor({ workspaceId: 'w' });
    for (const name of ['graph_nodes', 'graph_edges', 'graph_embeddings']) expect(await count(name, { workspaceId: 'w' })).toBe(0);
    for (const name of ['graph_nodes', 'graph_edges', 'graph_embeddings']) expect(await count(name, { workspaceId: 'w2' })).toBe(1);
  });

  it('keeps remembered decisions through a rebuild purge, and lists their titles', async () => {
    const { graph, count } = setup();
    await graph.upsertNode({ workspaceId: 'w', conversationId: 't', kind: 'decision', title: 'Use Mongo', remembered: true });
    await graph.upsertNode({ workspaceId: 'w', conversationId: 't', kind: 'decision', title: 'Extracted one' });
    await graph.upsertNode({ workspaceId: 'w', conversationId: 't', kind: 'decision', title: 'use mongo' }); // a re-extraction never clears the flag
    expect(await graph.rememberedTitles('w', 't')).toEqual(['use mongo']);
    await graph.purgeGraphFor({ workspaceId: 'w', conversationId: 't' }, { keepRemembered: true });
    expect(await count('graph_nodes', { workspaceId: 'w' })).toBe(1);
    await graph.purgeGraphFor({ workspaceId: 'w', conversationId: 't' });
    expect(await count('graph_nodes', { workspaceId: 'w' })).toBe(0);
  });

  it('purges a channel with its threads, edges on either end, and nothing else', async () => {
    const { graph, count } = setup();
    const node = (conversationId: string) => graph.upsertNode({ workspaceId: 'w', conversationId, kind: 'topic', title: conversationId });
    const chan = (await node('channel:c1'))!;
    const thread = (await node('thread:c1:p1'))!;
    const keep = (await node('channel:c10'))!; // id prefix of another channel must not match
    const keepThread = (await node('thread:c10:p1'))!;
    await graph.upsertEmbedding({ workspaceId: 'w', conversationId: 'thread:c1:p1', nodeId: thread, kind: 'topic', model: 'm', vector: [1] });
    await graph.upsertEdge({ workspaceId: 'w', kind: 'rel', from: { id: thread, conversationId: 'thread:c1:p1' }, to: { id: keep, conversationId: 'channel:c10' } });
    await graph.upsertEdge({ workspaceId: 'w', kind: 'rel', from: { id: keep, conversationId: 'channel:c10' }, to: { id: chan, conversationId: 'channel:c1' } });
    await graph.upsertEdge({ workspaceId: 'w', kind: 'rel', from: { id: keep, conversationId: 'channel:c10' }, to: { id: keepThread, conversationId: 'thread:c10:p1' } });

    await graph.purgeGraphFor({ workspaceId: 'w', channelId: 'c1' });
    expect(await count('graph_nodes')).toBe(2);
    expect(await count('graph_nodes', { _id: { $in: [keep, keepThread] } })).toBe(2);
    expect(await count('graph_embeddings')).toBe(0);
    expect(await count('graph_edges')).toBe(1);
  });

  it('archiving a channel or workspace purges its graph, and a failing purge does not fail the archive', async () => {
    const scopes: object[] = [];
    const registry = new Registry(testDb(), { purgeGraph: async (scope) => { scopes.push(scope); throw new Error('boom'); } });
    const { owner, workspace, channel } = await crew(registry, 'graphpurge', []);
    await registry.createWorkspace(owner, 'spare'); // the last active workspace can't be archived
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await registry.updateChannel(owner, channel.id, { archived: true })).archived).toBe(true);
    expect((await registry.setWorkspaceArchived(owner, workspace.id, true)).archived).toBe(true);
    expect(scopes).toEqual([{ workspaceId: workspace.id, channelId: channel.id }, { workspaceId: workspace.id }]);
    expect(quiet).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });

  it('groups the same person across threads, keeping one node per source', async () => {
    const { db, graph, count } = setup();
    const person = (conversationId: string, title: string, key?: string) => graph.upsertNode({ workspaceId: 'w', conversationId, kind: 'person', title, key });
    const a = (await person('thread:c:1', 'Ana Gomez', 'agent-ana'))!;
    const b = (await person('thread:c:2', 'ana'))!;
    const c = (await person('thread:c:3', 'Bo'))!;
    await person('thread:c:2', 'ana'); // rerun keeps the group
    const canon = async (id: string) => (await db.execute(() => db.mongoDb.collection<{ _id: string; canonicalId?: string }>('graph_nodes').findOne({ _id: id })))?.canonicalId;
    expect(await count('graph_nodes')).toBe(3);
    expect(await canon(b)).toBe(await canon(a));
    expect(await canon(c)).not.toBe(await canon(a));
  });

  it('keeps a per-channel watermark that never rewinds and is purged with the channel', async () => {
    const { graph } = setup();
    expect(await graph.channelWatermark('w', 'channel:c')).toBe(0);
    await graph.setChannelWatermark('w', 'channel:c', 9);
    await graph.setChannelWatermark('w', 'channel:c', 5);
    expect(await graph.channelWatermark('w', 'channel:c')).toBe(9);
    await graph.purgeGraphFor({ workspaceId: 'w', channelId: 'c' });
    expect(await graph.channelWatermark('w', 'channel:c')).toBe(0);
  });

  it('enforces the daily cap through the meter', async () => {
    const { graph } = setup(1000);
    expect(await graph.canSpendOnGraph('w')).toBe(true);
    await graph.recordGraphSpend('w', 600);
    expect(await graph.canSpendOnGraph('w')).toBe(true);
    await graph.recordGraphSpend('w', 400);
    expect(await graph.canSpendOnGraph('w')).toBe(false);
    expect(await graph.canSpendOnGraph('w2')).toBe(true);
  });

  it('extracts a thread idempotently, and a reworded rerun replaces the old nodes', async () => {
    const { graph, count } = setup();
    const msg = (id: string, from: string, fromId: string, text: string) => ({ id, from, fromId, parts: [{ kind: 'text', text }] }) as unknown as MessageDoc;
    const answers = [
      { decisions: [{ title: 'Ship Monday', text: 'After QA.', people: ['Ana', 'Bo'], topics: ['release', 'qa'] }] },
      { decisions: [{ title: 'Release on Monday', text: 'Once QA passes.', people: ['ana'], topics: ['launch'] }] },
    ];
    let answer = answers[0];
    let seq = 0; // each rerun stands for a new post (a reopen)
    const run = graphExtractor({
      graph,
      store: { message: async () => msg('p', 'Ana', 'agent-ana', 'Ship Monday?'), page: async () => [msg('r', 'Bo', 'agent-bo', 'Yes')], since: async () => [], conversation: async () => ({ seq: ++seq }) as never },
      registry: { channelDoc: async () => ({}), workspaceDoc: async () => ({}) },
      llm: {
        project: 'p',
        location: 'global',
        model: 'm',
        accessToken: async () => 't',
        fetchImpl: (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }))) as typeof fetch,
      },
    });
    const job = { kind: 'graph' as const, workspaceId: 'w', conversationId: 'thread:c:p' };
    await run(job);
    await run(job);
    expect(await count('graph_nodes')).toBe(5);
    expect(await count('graph_edges')).toBe(4);
    expect(await count('graph_nodes', { kind: 'person', conversationId: 'thread:c:p' })).toBe(2);
    answer = answers[1];
    await run(job);
    expect(await count('graph_nodes')).toBe(3);
    expect(await count('graph_edges')).toBe(2);
    expect(await count('graph_nodes', { title: 'Ship Monday' })).toBe(0);
  });

  it('a reopened old thread keeps newer threads\' supersedes edges into it, and cannot replace them', async () => {
    const { db, graph, count } = setup();
    const at = { a: '2026-01-01T00:00:00.000Z', b: '2026-02-01T00:00:00.000Z' };
    const root = (post: string) => ({ id: post, from: 'Ana', fromId: 'agent-ana', at: at[post as 'a' | 'b'], parts: [{ kind: 'text', text: 'x' }] }) as unknown as MessageDoc;
    let answer: unknown;
    let seq = 0;
    const run = graphExtractor({
      graph,
      store: { message: async (id: string) => root(id), page: async () => [], since: async () => [], conversation: async () => ({ seq: ++seq }) as never },
      registry: { channelDoc: async () => ({}), workspaceDoc: async () => ({}) },
      llm: { project: 'p', location: 'global', model: 'm', accessToken: async () => 't', fetchImpl: (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }))) as typeof fetch },
    });
    const thread = (post: string) => ({ kind: 'graph' as const, workspaceId: 'w', conversationId: `thread:c:${post}` });
    const decision = (title: string, replaces?: number) => ({ decisions: [{ title, text: title, people: [], topics: [], messages: [1], ...(replaces ? { replaces } : {}) }] });
    const supersedes = () => db.execute(() => db.mongoDb.collection<{ fromConversationId: string; toConversationId: string }>('graph_edges').find({ kind: 'supersedes' }).toArray());

    answer = decision('Use Postgres');
    await run(thread('a'));
    answer = decision('Use Mongo', 1);
    await run(thread('b'));
    expect((await supersedes()).map((e) => `${e.fromConversationId}>${e.toConversationId}`)).toEqual(['thread:c:b>thread:c:a']);

    // A rebuilds with the same decision, and the model claims it replaces B's (the newest candidate): B's evidence is newer, so no.
    answer = decision('Use Postgres', 1);
    await run(thread('a'));
    expect((await supersedes()).map((e) => `${e.fromConversationId}>${e.toConversationId}`)).toEqual(['thread:c:b>thread:c:a']);
    expect((await graph.recentDecisions('w', 'c', 5)).map((d) => d.title)).toEqual(['Use Mongo', 'Use Postgres']);

    // A reopens in March and switches back to Postgres, replacing B's: now A's evidence is newer, so A>B, and B>A goes.
    at.a = '2026-03-01T00:00:00.000Z';
    answer = decision('Use Postgres', 1);
    await run(thread('a'));
    expect((await supersedes()).map((e) => `${e.fromConversationId}>${e.toConversationId}`)).toEqual(['thread:c:a>thread:c:b']);

    // A's decision changes: the edges from and into the old one go with it.
    answer = decision('Use SQLite');
    await run(thread('a'));
    expect(await supersedes()).toEqual([]);
    expect(await count('graph_edges', { toConversationId: 'thread:c:a' })).toBe(0);
  });
});
