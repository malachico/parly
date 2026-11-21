import { describe, expect, it, vi } from 'vitest';
import type { MessageDoc } from '../src/chat/chat.js';
import { parsePushJob } from '../src/chat/queue.js';
import { graphExtractor, parseGraphExtraction } from '../src/graph/extract.js';
import type { GraphStore } from '../src/graph/store.js';

const msg = (id: string, from: string, fromId: string, text: string) => ({ id, from, fromId, parts: [{ kind: 'text', text }] }) as unknown as MessageDoc;
const answer = { decisions: [{ title: 'Ship on Monday', text: 'Ship on Monday after QA.', people: ['ana', 'Bo'], topics: ['release'] }] };
const vertex = (body: unknown = answer) =>
  vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } })));

function setup(opts: { enabled?: boolean; canSpend?: boolean } = {}) {
  const graph = {
    enabled: opts.enabled ?? true,
    canSpendOnGraph: vi.fn(async () => opts.canSpend ?? true),
    recordGraphSpend: vi.fn(async () => {}),
    purgeGraphFor: vi.fn(async () => {}),
    upsertNode: vi.fn(async (n: { kind: string; key?: string; title: string }) => `${n.kind}:${n.key ?? n.title}`),
    upsertEdge: vi.fn(async (_e: { kind: string; to: { id: string } }) => 'e'),
  };
  const store = { message: vi.fn(async () => msg('p', 'Ana', 'agent-ana', 'Ship Monday?')), page: vi.fn(async () => [msg('r1', 'Bo', 'agent-bo', 'Yes, after QA')]) };
  const fetchImpl = vertex();
  const run = graphExtractor({
    graph: graph as unknown as GraphStore,
    store,
    llm: { project: 'p', location: 'global', model: 'flash-lite', accessToken: async () => 't', fetchImpl: fetchImpl as unknown as typeof fetch },
    prices: { input: 1, output: 1 },
  });
  return { graph, store, fetchImpl, run };
}
const job = { kind: 'graph' as const, workspaceId: 'w', conversationId: 'thread:c1:p' };

describe('graph extraction (pure)', () => {
  it('parses and normalises the answer, dropping junk', () => {
    expect(parseGraphExtraction('not json')).toEqual([]);
    expect(parseGraphExtraction('null')).toEqual([]);
    expect(parseGraphExtraction('{"decisions":"x"}')).toEqual([]);
    expect(
      parseGraphExtraction(JSON.stringify({ decisions: [{ title: '  ' }, { title: ' Use Mongo ', people: [' Ana', 'Ana', 3], topics: 'db' }, null] })),
    ).toEqual([{ title: 'Use Mongo', text: '', people: ['Ana'], topics: [] }]);
  });

  it('upserts decisions, people (keyed by agent id when known) and topics with edges, metering the call', async () => {
    const { graph, fetchImpl, run } = setup();
    await run(job);
    await run(job);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(graph.purgeGraphFor).toHaveBeenCalledWith({ workspaceId: 'w', conversationId: job.conversationId });
    expect(graph.purgeGraphFor.mock.invocationCallOrder[0]).toBeLessThan(graph.upsertNode.mock.invocationCallOrder[0] ?? 0);
    expect(graph.recordGraphSpend).toHaveBeenCalledWith('w', 110);
    const nodes = graph.upsertNode.mock.calls.map(([n]) => n);
    // Same input, same keys on every run.
    expect(nodes.slice(0, 4)).toEqual(nodes.slice(4));
    expect(nodes.slice(0, 4)).toEqual([
      { workspaceId: 'w', conversationId: job.conversationId, kind: 'decision', title: 'Ship on Monday', text: 'Ship on Monday after QA.' },
      { workspaceId: 'w', conversationId: job.conversationId, kind: 'person', title: 'Ana', key: 'agent-ana' },
      { workspaceId: 'w', conversationId: job.conversationId, kind: 'person', title: 'Bo', key: 'agent-bo' },
      { workspaceId: 'w', conversationId: job.conversationId, kind: 'topic', title: 'release' },
    ]);
    expect(graph.upsertEdge.mock.calls.slice(0, 3).map(([e]) => [e.kind, e.to.id])).toEqual([
      ['involves', 'person:agent-ana'],
      ['involves', 'person:agent-bo'],
      ['about', 'topic:release'],
    ]);
  });

  it('skips with a log line once the daily cap is spent', async () => {
    const { graph, fetchImpl, store, run } = setup({ canSpend: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(run(job)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('daily cap'));
    log.mockRestore();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.page).not.toHaveBeenCalled();
    expect(graph.upsertNode).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is off', async () => {
    const { graph, fetchImpl, store, run } = setup({ enabled: false });
    await run(job);
    expect(graph.canSpendOnGraph).not.toHaveBeenCalled();
    expect(store.message).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a model error so the queue retries', async () => {
    const { graph } = setup();
    const failing = graphExtractor({
      graph: graph as unknown as GraphStore,
      store: { message: async () => msg('p', 'Ana', 'a', 'x'), page: async () => [] },
      llm: { project: 'p', location: 'global', model: 'm', accessToken: async () => 't', fetchImpl: (async () => new Response('busy', { status: 503 })) as typeof fetch },
    });
    await expect(failing(job)).rejects.toThrow('503');
    expect(graph.purgeGraphFor).not.toHaveBeenCalled();
    expect(graph.upsertNode).not.toHaveBeenCalled();
  });

  it('logs and drops a non-retryable 4xx, keeping the old graph', async () => {
    const { graph } = setup();
    const rejected = graphExtractor({
      graph: graph as unknown as GraphStore,
      store: { message: async () => msg('p', 'Ana', 'a', 'x'), page: async () => [] },
      llm: { project: 'p', location: 'global', model: 'm', accessToken: async () => 't', fetchImpl: (async () => new Response('bad', { status: 400 })) as typeof fetch },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(rejected(job)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('400'), 'bad');
    err.mockRestore();
    expect(graph.purgeGraphFor).not.toHaveBeenCalled();
    expect(graph.upsertNode).not.toHaveBeenCalled();
  });

  it('reads a graph job off the queue', () => {
    expect(parsePushJob({ kind: 'graph', workspaceId: 'w', conversationId: 'thread:c:p', extra: 1 })).toEqual({ kind: 'graph', workspaceId: 'w', conversationId: 'thread:c:p' });
    expect(() => parsePushJob({ kind: 'graph', workspaceId: 'w' })).toThrow();
    expect(parsePushJob({ agentId: 'a', conversationId: 'c' })).toEqual({ agentId: 'a', conversationId: 'c' });
  });
});
