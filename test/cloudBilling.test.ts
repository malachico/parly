import { describe, expect, it, vi } from 'vitest';
import { payerName } from '../src/billing/payer.js';
import { CloudAgents } from '../src/hub/cloudAgent.js';
import type { LlmMeter } from '../src/llm/llm.js';
import type { AgentRecord } from '../src/registry/types.js';
import type { WireMessage } from '../src/lib/wire.js';

const agent = { id: 'judge', ownerId: 'owner', name: 'Judge', cloud: true } as AgentRecord;
const message = (publicShowcase = true): WireMessage => ({ messageId: 'wire', role: 'ROLE_USER', parts: [{ text: 'Help' }], metadata: { a2aHub: { fromId: 'relaying-bot', conversationId: 'thread:channel:root', messageId: 'reply', publicShowcase } } });
function setup(rootHuman?: string, maxRounds = 15) {
  let exhausted = false;
  const meter = {
    used: vi.fn(async (_payer: string, _period?: string, _opts?: { freeOnly?: boolean }) => exhausted ? 1 : 0),
    publicShowcaseOverCeiling: vi.fn(async () => false),
    payerOf: async (a: AgentRecord) => a.payerId ?? a.ownerId ?? a.id,
    add: vi.fn(async (_payer: string, _cost: number, _agent: unknown, _period?: string, _opts?: unknown) => {}),
  };
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Answer' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } })));
  const cloud = new CloudAgents({ model: 'test', project: 'test', location: 'global', prices: { input: 1, output: 1 }, meter: meter as unknown as LlmMeter, fetchImpl: fetchImpl as typeof fetch, accessToken: async () => 'test', showcaseJudgeAgentIds: [agent.id], maxRounds, taskMaxRounds: maxRounds });
  cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => [], callMcp: async () => ({}), showcaseVisitor: vi.fn(async () => rootHuman) };
  return { cloud, meter, fetchImpl, exhaust: () => { exhausted = true; } };
}

describe('cloud turn billing boundary', () => {
  it.each(['visitor', 'owner', undefined])('uses trusted root human %s, never the relaying bot', async (root) => {
    const { cloud, meter } = setup(root);
    await cloud.answer(agent, message());
    expect(meter.add).toHaveBeenCalledWith(root ?? 'owner', expect.any(Number), expect.any(Object), undefined, root === 'visitor' ? { freeOnly: true, publicShowcase: true } : { publicShowcase: true });
    expect(meter.used.mock.calls.every((args) => args[0] !== 'relaying-bot')).toBe(true);
  });

  it('bills human B replying in A’s thread while the prize still belongs to A', async () => {
    const { cloud, meter, fetchImpl } = setup('human-A', 2);
    cloud.parly!.humanId = vi.fn(async (id) => id === 'human-B' ? id : undefined);
    const award = vi.fn(async () => ({ ok: true, awarded: 10 }));
    Object.assign(meter, { awardShowcaseCredits: award });
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: fetchImpl.mock.calls.length === 1 ? [{ functionCall: { name: 'award_credits', args: { amount: 10 } } }] : [{ text: 'Done' }] } }], usageMetadata: { promptTokenCount: 100 } })));
    const input = message();
    (input.metadata!.a2aHub as { fromId: string }).fromId = 'human-B';
    await cloud.answer(agent, input);
    expect(meter.add.mock.calls.every((args) => args[0] === 'human-B')).toBe(true);
    expect(award).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'human-A' }));
  });

  it('stops before another tool round when the first round exhausts credits', async () => {
    const { cloud, meter, fetchImpl, exhaust } = setup('visitor');
    meter.add.mockImplementation(async () => exhaust());
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'parly_read_channel', args: { channel: 'test' } } }] } }], usageMetadata: { promptTokenCount: 100 } })));
    await cloud.answer(agent, message());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops between rounds when another turn exhausts the daily showcase ceiling', async () => {
    const { cloud, meter, fetchImpl } = setup('visitor');
    fetchImpl.mockImplementation(async () => {
      meter.publicShowcaseOverCeiling.mockResolvedValue(true);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'parly_read_channel', args: { channel: 'test' } } }] } }], usageMetadata: { promptTokenCount: 100 } }));
    });
    await cloud.answer(agent, message());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not synthesize after the final model call exhausts credits', async () => {
    const two = setup('visitor', 2);
    two.fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: two.fetchImpl.mock.calls.length === 1 ? [{ functionCall: { name: 'parly_read_channel', args: { channel: 'test' } } }] : [] } }], usageMetadata: { promptTokenCount: 100 } })));
    two.meter.add.mockImplementation(async () => { if (two.meter.add.mock.calls.length === 2) two.exhaust(); });
    await two.cloud.answer(agent, message());
    expect(two.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('neither advertises nor executes credit awards on a private judge turn', async () => {
    const { cloud, fetchImpl } = setup('visitor', 2);
    fetchImpl.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools?.flatMap((t: { functionDeclarations: { name: string }[] }) => t.functionDeclarations).map((t: { name: string }) => t.name)).not.toContain('award_credits');
      if (fetchImpl.mock.calls.length === 2) expect(JSON.stringify(body.contents)).toContain('Only a showcase judge can award credits.');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: fetchImpl.mock.calls.length === 1 ? [{ functionCall: { name: 'award_credits', args: { amount: 10 } } }] : [{ text: 'Done' }] } }] }));
    });
    const spy = vi.spyOn(cloud.parly!, 'showcaseVisitor');
    await cloud.answer(agent, message(false));
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads the meter once per round (collapses redundant checks)', async () => {
    const { cloud, meter } = setup('owner', 2);
    await cloud.answer(agent, message());
    // The owner's own public turn is paid, so the free-only ceiling is never read; used once at entry, not again in round 0.
    expect(meter.publicShowcaseOverCeiling).not.toHaveBeenCalled();
    expect(meter.used).toHaveBeenCalledTimes(1);
  });

  it('a visitor out of free turns is told once, then pays from their own credits outside the free ceiling', async () => {
    const { cloud, meter, fetchImpl } = setup('visitor');
    meter.used.mockImplementation(async (_payer, _period, opts) => (opts?.freeOnly ? 1 : 0));
    const first = await cloud.answer(agent, message());
    expect(JSON.stringify(first)).toContain('your own Parly credits');
    expect(fetchImpl).not.toHaveBeenCalled();
    await cloud.answer(agent, message());
    expect(fetchImpl).toHaveBeenCalled();
    expect(meter.add).toHaveBeenCalledWith('visitor', expect.any(Number), expect.any(Object), undefined, { publicShowcase: true });
  });

  it('a paying visitor keeps going past the free daily ceiling', async () => {
    const { cloud, meter, fetchImpl } = setup('visitor');
    meter.publicShowcaseOverCeiling.mockResolvedValue(true);
    expect(JSON.stringify(await cloud.answer(agent, message()))).toContain('your own Parly credits');
    await cloud.answer(agent, message());
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('names the payer when their credits run out', async () => {
    const { cloud, exhaust } = setup('visitor');
    exhaust();
    cloud.parly!.name = async (id) => (id === 'owner' ? 'Dana' : undefined);
    expect(JSON.stringify(await cloud.answer(agent, message(false)))).toContain('paid by Dana');
  });

  it('bills the pool but rewards the referral to the person, and names the pool when it runs out', async () => {
    const { cloud, meter, exhaust } = setup();
    meter.payerOf = async () => 'ws';
    await cloud.answer(agent, message(false));
    expect(meter.add).toHaveBeenCalledWith('ws', expect.any(Number), expect.any(Object), undefined, { personId: 'owner' });
    exhaust();
    cloud.parly!.name = (id) => payerName(id, { agent: async () => undefined, workspace: async (w) => (w === 'ws' ? { name: 'Acme' } : undefined) });
    expect(JSON.stringify(await cloud.answer(agent, message(false)))).toContain('paid by Acme');
  });
});

describe('cloud model call input log', () => {
  it('logs the size of each input section with Vertex prompt and cached token counts', async () => {
    const { cloud, fetchImpl } = setup('owner');
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Answer' }] } }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20 } })));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cloud.answer(agent, message());
      const line = log.mock.calls.map(([l]) => String(l)).find((l) => l.includes('cloud_agent_input'));
      const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
      expect(JSON.parse(line!)).toEqual({
        event: 'cloud_agent_input',
        agentId: 'judge',
        call: 'loop',
        chars: { system: sent.systemInstruction.parts[0].text.length, tools: JSON.stringify(sent.tools[0].functionDeclarations).length, history: JSON.stringify(sent.contents).length, toolResults: 0 },
        estTokens: expect.any(Object),
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
      });
    } finally {
      log.mockRestore();
    }
  });
});
