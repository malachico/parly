import { describe, expect, it, vi } from 'vitest';
import { CloudAgents, compactHistory, shrinkOldResults } from '../src/hub/cloudAgent.js';
import type { LlmMeter } from '../src/llm/llm.js';
import type { AgentRecord } from '../src/registry/types.js';
import type { WireMessage } from '../src/lib/wire.js';

/** A turn carrying one big tool result, plus an attachment that must not be re-sent. */
function bigResultTurns() {
  return [
    {
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            response: { text: 'x'.repeat(5_000) },
            parts: [{ mimeType: 'application/pdf', data: 'AAAA' }],
          },
        },
      ],
    },
  ];
}

describe('shrinkOldResults', () => {
  it('shrinks a large earlier result once and is idempotent across rounds', () => {
    const turns = bigResultTurns();
    const seen = new WeakSet<object>();

    shrinkOldResults(turns, seen); // round N: first time this result is old
    const afterOnce = structuredClone(turns);

    shrinkOldResults(turns, seen); // round N+1: same object seen again
    shrinkOldResults(turns, seen); // and again

    // Byte-stable: re-sending never mutates an already-shrunk result (this is what keeps the prefix cacheable).
    expect(turns).toEqual(afterOnce);

    const r = turns[0]!.parts[0]!.functionResponse as { response: { earlier?: string }; parts?: unknown };
    // Shrunk: capped and attachment dropped.
    expect(typeof r.response.earlier).toBe('string');
    expect(r.response.earlier!.length).toBeLessThan(1_300);
    expect(r.parts).toBeUndefined();
    // Not re-wrapped: the old bug produced nested `{"earlier":"{\"earlier\":…` soup; one pass must not.
    expect(r.response.earlier).not.toContain('earlier');
  });

  it('leaves a small result untouched', () => {
    const turns = [{ parts: [{ functionResponse: { name: 'ping', response: { ok: true } } }] }];
    const seen = new WeakSet<object>();
    shrinkOldResults(turns, seen);
    expect(turns[0]!.parts[0]!.functionResponse!.response).toEqual({ ok: true });
  });
});

describe('compactHistory', () => {
  it('keeps the last 4 messages (capped at 1500 chars) and cuts older ones to one line', () => {
    const long = (n: number) => `line one\nline two ${'x'.repeat(5_000)}`.slice(0, n);
    const earlier = Array.from({ length: 6 }, (_, i) => ({ mine: false, from: `p${i}`, text: i === 5 ? 'short' : long(3_000) }));

    const out = compactHistory(earlier);

    expect(out.map((m) => m.from)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    // Older: one line, about what it began with.
    expect(out[0]?.text).toBe(`line one line two ${'x'.repeat(182)}…[truncated]`);
    // Recent: in full up to the cap, newlines kept; short ones untouched.
    expect(out[2]?.text).toBe(`${long(1_500)}…[truncated]`);
    expect(out[5]?.text).toBe('short');
  });
});

describe('cloud agent system prompt', () => {
  it('asks for parallel tool calls and a stop after answering, byte-identical on every round', async () => {
    const systems: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      systems.push(body.systemInstruction.parts[0].text);
      const parts = systems.length === 1 ? [{ functionCall: { name: 'parly_read_channel', args: { channel: 'dev' } } }] : [{ text: 'Done.' }];
      return Response.json({ candidates: [{ content: { parts } }] });
    }) as typeof fetch;
    const meter = { used: vi.fn(async () => 0), payerOf: async (a: AgentRecord) => a.ownerId ?? a.id, add: vi.fn(async () => {}), hasCredits: vi.fn(async () => true) };
    const cloud = new CloudAgents({ model: 'test', project: 'test', location: 'global', prices: { input: 1, output: 1 }, meter: meter as unknown as LlmMeter, fetchImpl, accessToken: async () => 'tok' });
    cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => [], callMcp: async () => ({}) };
    const agent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true } as AgentRecord;
    const msg: WireMessage = { messageId: 'w', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:owner:scout', messageId: 'm' } } };

    await cloud.answer(agent, msg);

    expect(systems).toHaveLength(2);
    expect(systems[1]).toBe(systems[0]); // stable prefix: no per-turn data, so it stays cached
    expect(systems[0]).toContain('together in one step');
    expect(systems[0]).toContain('once you have answered or posted your answer, stop');
  });
});
