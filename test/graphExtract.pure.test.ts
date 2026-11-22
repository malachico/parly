import { describe, expect, it, vi } from 'vitest';
import type { ConversationDoc, MessageDoc } from '../src/chat/chat.js';
import { CloudTasksQueue, InlineQueue, parsePushJob } from '../src/chat/queue.js';
import { graphExtractor, graphPrompt, parseGraphExtraction, sameReaders } from '../src/graph/extract.js';
import type { GraphStore } from '../src/graph/store.js';

const msg = (id: string, from: string, fromId: string, text: string, seq = 0) => ({ id, from, fromId, seq, parts: [{ kind: 'text', text }] }) as unknown as MessageDoc;
const answer = { decisions: [{ title: 'Ship on Monday', text: 'Ship on Monday after QA.', people: ['ana', 'Bo'], topics: ['release'] }] };
const vertex = (body: unknown = answer) =>
  vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } })));

// null = the doc is missing.
const registry = (channel: { archived?: boolean; publicFromSeq?: number; publicThreads?: string[] } | null = {}, workspace: { archived?: boolean } | null = {}) => ({
  channelDoc: vi.fn(async (_id: string) => channel ?? undefined),
  workspaceDoc: vi.fn(async (_id: string) => workspace ?? undefined),
});

function setup(opts: { enabled?: boolean; canSpend?: boolean; cap?: number; latestSeq?: number; since?: MessageDoc[]; registry?: ReturnType<typeof registry>; decisions?: { id: string; title: string; conversationId: string }[]; body?: unknown; extractedSeq?: number } = {}) {
  let runs = 0;
  const graph = {
    enabled: opts.enabled ?? true,
    dailyCapMicros: opts.cap ?? 1,
    startGraphRun: vi.fn(async () => ++runs),
    isLatestGraphRun: vi.fn(async (_w: string, _c: string, run: number) => run === runs),
    canSpendOnGraph: vi.fn(async () => opts.canSpend ?? true),
    recordGraphSpend: vi.fn(async () => {}),
    purgeGraphFor: vi.fn(async () => {}),
    pruneDanglingEdges: vi.fn(async () => {}),
    rememberedTitles: vi.fn(async () => [] as string[]),
    upsertNode: vi.fn(async (n: { kind: string; key?: string; title: string }) => `${n.kind}:${n.key ?? n.title}`),
    upsertEdge: vi.fn(async (_e: { kind: string; to: { id: string } }) => 'e'),
    channelWatermark: vi.fn(async () => 4),
    setChannelWatermark: vi.fn(async () => {}),
    recentDecisions: vi.fn(async (_w: string, _c: string, _l: number) => opts.decisions ?? []),
    graphExtractedSeq: vi.fn(async () => opts.extractedSeq),
    setGraphExtractedSeq: vi.fn(async () => {}),
  };
  const store = {
    message: vi.fn(async () => msg('p', 'Ana', 'agent-ana', 'Ship Monday?')),
    page: vi.fn(async () => [msg('r1', 'Bo', 'agent-bo', 'Yes, after QA')]),
    conversation: vi.fn(async () => ({ seq: opts.latestSeq ?? 7 }) as ConversationDoc),
    since: vi.fn(async (_c: string, _s: number, _l: number) => opts.since ?? [msg('m5', 'Ana', 'agent-ana', 'Ship Monday?', 5), msg('m7', 'Bo', 'agent-bo', 'Yes, after QA', 7)]),
  };
  const fetchImpl = vertex(opts.body);
  const requeue = vi.fn(async (_job: unknown, _delayMs: number) => {});
  const run = graphExtractor({
    graph: graph as unknown as GraphStore,
    store,
    registry: opts.registry ?? registry(),
    requeue,
    llm: { project: 'p', location: 'global', model: 'flash-lite', accessToken: async () => 't', fetchImpl: fetchImpl as unknown as typeof fetch },
    prices: { input: 1, output: 1 },
  });
  return { graph, store, fetchImpl, requeue, run };
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
    expect(graph.purgeGraphFor).toHaveBeenCalledWith({ workspaceId: 'w', conversationId: job.conversationId }, { keepIncomingSupersedes: true, keepRemembered: true });
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

  it('cites the numbered messages of this batch, dropping any number the model made up', async () => {
    const { graph, fetchImpl, run } = setup({ body: { decisions: [{ ...answer.decisions[0], messages: [2, 1, 2, 99, 0, -1, 1.5] }] } });
    await run(job);
    expect(JSON.stringify((fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]?.[1]?.body)).toContain('[2] Bo: Yes, after QA');
    expect(graph.upsertNode.mock.calls[0]?.[0]).toMatchObject({ kind: 'decision', sourceMessageIds: ['r1', 'p'] });
  });

  it('lets the last-started of two overlapping thread runs write, so an older run finishing last never wins', async () => {
    const { graph, store } = setup();
    let releaseA!: () => void;
    const gateA = new Promise<void>((ok) => { releaseA = ok; });
    const reply = (title: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ decisions: [{ title, text: '', people: [], topics: [] }] }) }] } }] }));
    let calls = 0;
    const fetchImpl = (async () => (++calls === 1 ? gateA.then(() => reply('Old snapshot')) : reply('New snapshot'))) as typeof fetch;
    const run = graphExtractor({ graph: graph as unknown as GraphStore, store, registry: registry(), llm: { project: 'p', location: 'global', model: 'm', accessToken: async () => 't', fetchImpl } });
    const a = run(job);
    await vi.waitFor(() => expect(calls).toBe(1));
    await run(job);
    releaseA();
    await a;
    expect(graph.purgeGraphFor).toHaveBeenCalledTimes(1);
    expect(graph.upsertNode.mock.calls.map(([n]) => n.title)).toEqual(['New snapshot']);
  });

  it('skips with a log line once the daily cap is spent, and retries after midnight UTC', async () => {
    const { graph, fetchImpl, store, requeue, run } = setup({ canSpend: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(run(job)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('daily cap'));
    log.mockRestore();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.page).not.toHaveBeenCalled();
    expect(graph.upsertNode).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledWith({ ...job, deferred: 1 }, expect.any(Number));
  });

  it.each([
    ['a cap of 0', { cap: 0 }, job],
    ['a job already deferred 3 times', {}, { ...job, deferred: 3 }],
  ])('drops instead of requeueing %s', async (_name, opts, j) => {
    const { requeue, fetchImpl, run } = setup({ canSpend: false, ...opts });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(j);
    log.mockRestore();
    expect(requeue).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['an archived channel', registry({ archived: true })],
    ['a channel in a missing workspace', registry({}, null)],
  ])('skips a thread in %s', async (_name, reg) => {
    const { graph, fetchImpl, run } = setup({ registry: reg });
    await run(job);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(graph.startGraphRun).not.toHaveBeenCalled();
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
      store: { ...setup().store, message: async () => msg('p', 'Ana', 'a', 'x'), page: async () => [] },
      registry: registry(),
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
      store: { ...setup().store, message: async () => msg('p', 'Ana', 'a', 'x'), page: async () => [] },
      registry: registry(),
      llm: { project: 'p', location: 'global', model: 'm', accessToken: async () => 't', fetchImpl: (async () => new Response('bad', { status: 400 })) as typeof fetch },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(rejected(job)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('400'), 'bad');
    err.mockRestore();
    expect(graph.purgeGraphFor).not.toHaveBeenCalled();
    expect(graph.upsertNode).not.toHaveBeenCalled();
  });

  it('tells the model which remembered decisions are already recorded', () => {
    const msgs = [{ from: 'a', parts: [{ text: 'hi' }] }] as Parameters<typeof graphPrompt>[0];
    expect(graphPrompt(msgs, [], ['Use Mongo'])).toContain('do not extract these again:\n- Use Mongo');
    expect(graphPrompt(msgs, [])).not.toContain('Already recorded');
  });

  it('reads a graph job off the queue', () => {
    expect(parsePushJob({ kind: 'graph', workspaceId: 'w', conversationId: 'thread:c:p', extra: 1 })).toEqual({ kind: 'graph', workspaceId: 'w', conversationId: 'thread:c:p' });
    expect(parsePushJob({ kind: 'graph', workspaceId: 'w', conversationId: 'channel:c', seq: 3 })).toEqual({ kind: 'graph', workspaceId: 'w', conversationId: 'channel:c', seq: 3 });
    expect(() => parsePushJob({ kind: 'graph', workspaceId: 'w' })).toThrow();
    expect(parsePushJob({ agentId: 'a', conversationId: 'c' })).toEqual({ agentId: 'a', conversationId: 'c' });
  });

  describe('thread quiet period', () => {
    const reply = { ...job, seq: 7 };

    it('skips a reply job when a newer reply came, before any spend check or run', async () => {
      const { graph, fetchImpl, run } = setup({ latestSeq: 8 });
      await run(reply);
      expect(graph.canSpendOnGraph).not.toHaveBeenCalled();
      expect(graph.startGraphRun).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('runs the newest reply job and records the seq it extracted after the writes', async () => {
      const { graph, fetchImpl, run } = setup({ latestSeq: 7 });
      await run(reply);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(graph.setGraphExtractedSeq).toHaveBeenCalledWith('w', 'thread:c1:p', 7);
      expect(graph.setGraphExtractedSeq.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...graph.upsertNode.mock.invocationCallOrder));
    });

    it('skips a done job when nothing is new since the last run, without starting one', async () => {
      const { graph, fetchImpl, run } = setup({ latestSeq: 7, extractedSeq: 7 });
      await run(job);
      expect(graph.startGraphRun).not.toHaveBeenCalled();
      expect(graph.canSpendOnGraph).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('runs a done job when the thread moved on since the last run', async () => {
      const { fetchImpl, graph, run } = setup({ latestSeq: 9, extractedSeq: 7 });
      await run(job);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(graph.setGraphExtractedSeq).toHaveBeenCalledWith('w', 'thread:c1:p', 9);
    });
  });

  describe('channels', () => {
    const chan = { kind: 'graph' as const, workspaceId: 'w', conversationId: 'channel:c1', seq: 7 };

    it('extracts the capped window since the watermark without purging, then advances the watermark', async () => {
      const { graph, store, fetchImpl, run } = setup();
      await run(chan);
      expect(store.since).toHaveBeenCalledWith('channel:c1', 4, 80);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(graph.purgeGraphFor).not.toHaveBeenCalled();
      expect(graph.upsertNode).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'channel:c1', kind: 'decision' }));
      expect(graph.setChannelWatermark).toHaveBeenCalledWith('w', 'channel:c1', 7);
      expect(graph.setChannelWatermark.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...graph.upsertEdge.mock.invocationCallOrder));
    });

    it('skips (debounce) when a newer post arrived after it was scheduled', async () => {
      const { graph, store, fetchImpl, run } = setup({ latestSeq: 8 });
      await run(chan);
      expect(store.since).not.toHaveBeenCalled();
      expect(graph.canSpendOnGraph).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(graph.setChannelWatermark).not.toHaveBeenCalled();
    });

    it('does nothing when nothing is new since the watermark', async () => {
      const { graph, fetchImpl, run } = setup({ since: [] });
      await run(chan);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(graph.setChannelWatermark).not.toHaveBeenCalled();
    });

    it('keeps the watermark when the daily cap is spent, so the window is retried later', async () => {
      const { graph, fetchImpl, requeue, run } = setup({ canSpend: false });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Re-enqueued for the next UTC midnight, when the cap resets, plus up to 3 hours of jitter.
      vi.useFakeTimers({ now: Date.parse('2026-11-20T22:00:00Z') });
      const random = vi.spyOn(Math, 'random');
      try {
        random.mockReturnValue(0);
        await run(chan);
        random.mockReturnValue(1 - 1e-9); // Math.random is < 1
        await run({ ...chan, deferred: 1 });
      } finally {
        random.mockRestore();
        log.mockRestore();
        vi.useRealTimers();
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(graph.setChannelWatermark).not.toHaveBeenCalled();
      expect(requeue.mock.calls.map(([j, d]) => [j, d])).toEqual([
        [{ ...chan, deferred: 1 }, 2 * 3_600_000],
        [{ ...chan, deferred: 2 }, 5 * 3_600_000 - 1],
      ]);
    });

    it.each([
      ['an archived channel', registry({ archived: true })],
      ['a missing channel', registry(null)],
      ['a channel in an archived workspace', registry({}, { archived: true })],
      ['a channel in a missing workspace', registry({}, null)],
    ])('skips %s', async (_name, reg) => {
      const { graph, store, fetchImpl, run } = setup({ registry: reg });
      await run(chan);
      expect(reg.channelDoc).toHaveBeenCalledWith('c1');
      expect(store.since).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(graph.setChannelWatermark).not.toHaveBeenCalled();
    });

    it('does nothing when the flag is off', async () => {
      const { store, fetchImpl, graph, run } = setup({ enabled: false });
      await run(chan);
      expect(store.conversation).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(graph.setChannelWatermark).not.toHaveBeenCalled();
    });

    it('never extracts a DM', async () => {
      const { store, fetchImpl, graph, run } = setup();
      await run({ kind: 'graph', workspaceId: 'w', conversationId: 'dm:a_b', seq: 1 });
      expect(store.since).not.toHaveBeenCalled();
      expect(graph.canSpendOnGraph).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('replaced decisions', () => {
    const old = (n: string, conversationId: string) => ({ id: `old-${n}`, title: `Old ${n}`, conversationId });
    const replacing = (replaces: number) => ({ decisions: [{ ...answer.decisions[0], replaces }] });
    const prompt = (fetchImpl: ReturnType<typeof vertex>) => JSON.stringify((fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]?.[1]?.body);
    const supersedes = (graph: ReturnType<typeof setup>['graph']) => graph.upsertEdge.mock.calls.map(([e]) => e).filter((e) => e.kind === 'supersedes');

    it('only links decisions with the same readers, failing closed', () => {
      const priv = {};
      expect(sameReaders('thread:c1:p', 'channel:c1', priv)).toBe(true);
      expect(sameReaders('thread:c1:p', 'thread:c1:q', priv)).toBe(true);
      expect(sameReaders('thread:c1:p', 'channel:c2', priv)).toBe(false);
      expect(sameReaders('dm:a:b', 'channel:c1', priv)).toBe(false);
      expect(sameReaders('junk', 'channel:c1', priv)).toBe(false);
      expect(sameReaders('thread:c1:p', 'channel:c1', undefined)).toBe(false);
      expect(sameReaders('thread:c1:p', 'channel:c1', { publicFromSeq: 3 })).toBe(false);
      expect(sameReaders('thread:c1:p', 'channel:c1', { publicThreads: ['q'] })).toBe(false);
    });

    it('keeps a positive integer "replaces" and drops anything else', () => {
      const parse = (replaces: unknown) => parseGraphExtraction(JSON.stringify({ decisions: [{ title: 'T', replaces }] }))[0]?.replaces;
      expect(parse(2)).toBe(2);
      for (const bad of [0, -1, 1.5, '2', null]) expect(parse(bad)).toBeUndefined();
    });

    it('links a replacement to the numbered earlier decision, in its own conversation', async () => {
      const { graph, fetchImpl, run } = setup({ decisions: [old('a', 'channel:c1'), old('b', 'thread:c1:q')], body: replacing(2) });
      await run(job);
      expect(prompt(fetchImpl)).toContain('2. Old b');
      expect(supersedes(graph)).toEqual([expect.objectContaining({ from: { id: 'decision:Ship on Monday', conversationId: job.conversationId }, to: { id: 'old-b', conversationId: 'thread:c1:q' } })]);
    });

    it('writes no link for an out-of-range number', async () => {
      const { graph, run } = setup({ decisions: [old('a', 'channel:c1')], body: replacing(5) });
      await run(job);
      expect(supersedes(graph)).toEqual([]);
    });

    it('offers nothing in a channel with any public part, nor the thread its own decisions', async () => {
      const pub = setup({ decisions: [old('a', 'channel:c1')], body: replacing(1), registry: registry({ publicThreads: ['x'] }) });
      await pub.run(job);
      expect(prompt(pub.fetchImpl)).not.toContain('Old a');
      expect(supersedes(pub.graph)).toEqual([]);
      const own = setup({ decisions: [old('self', job.conversationId), old('a', 'channel:c1')], body: replacing(1) });
      await own.run(job);
      expect(prompt(own.fetchImpl)).not.toContain('Old self');
      expect(supersedes(own.graph)).toEqual([expect.objectContaining({ to: { id: 'old-a', conversationId: 'channel:c1' } })]);
    });
  });

  describe('queue dedupe', () => {
    const chan = { kind: 'graph' as const, workspaceId: 'w', conversationId: 'channel:c1', seq: 7 };

    it('names a channel graph task by conversation and seq, and treats ALREADY_EXISTS as done', async () => {
      const bodies: any[] = [];
      let exists = false;
      const queue = new CloudTasksQueue({ queue: 'projects/p/locations/l/queues/q', serviceAccount: 's', url: 'u' }, async (_url, body) => {
        if (exists) throw Object.assign(new Error('exists'), { response: { status: 409 } });
        bodies.push(body);
        exists = true;
      });
      await queue.enqueue(chan, 1000);
      await expect(queue.enqueue(chan, 1000)).resolves.toBeUndefined();
      expect(bodies).toHaveLength(1);
      expect(bodies[0].task.name).toMatch(/^projects\/p\/locations\/l\/queues\/q\/tasks\/graph-channel_c1-7-\d{8}$/);
    });

    it('names a cap-deferred thread job by conversation and run day, so concurrent deferrals dedupe', async () => {
      const names: string[] = [];
      const queue = new CloudTasksQueue({ queue: 'projects/p/locations/l/queues/q', serviceAccount: 's', url: 'u' }, async (_url, body: any) => void names.push(body.task.name));
      const thread = { kind: 'graph' as const, workspaceId: 'w', conversationId: 'thread:c1:p' };
      await queue.enqueue(thread, 1000);
      await queue.enqueue({ ...thread, deferred: 1 }, 1000);
      expect(names[0]).toBeUndefined();
      expect(names[1]).toMatch(/\/tasks\/graph-thread_c1_p-thread-\d{8}$/);
      expect(parsePushJob({ ...thread, deferred: 2 })).toEqual({ ...thread, deferred: 2 });
    });

    it('runs the same channel graph job once on the inline queue, without holding up idle()', async () => {
      vi.useFakeTimers();
      try {
        const queue = new InlineQueue();
        const graph = vi.fn(async () => {});
        queue.setHandler(async () => {}, graph);
        await queue.enqueue(chan, 60_000);
        await queue.enqueue(chan, 60_000);
        await queue.idle();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(graph).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
