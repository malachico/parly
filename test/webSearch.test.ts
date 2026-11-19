import { describe, expect, it } from 'vitest';
import { makeWebSearch } from '../src/hub/webSearch.js';

const prices = { input: 2, output: 12 };

describe('web_search (grounded Gemini call)', () => {
  it('sends a grounding-only request and returns the answer, sources, and meters the payer', async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const metered: unknown[][] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'Stripe is payments infrastructure for the internet.' }] },
              groundingMetadata: { groundingChunks: [{ web: { uri: 'https://stripe.com', title: 'Stripe' } }, { web: {} }] },
            },
          ],
          usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30 },
        }),
      );
    }) as typeof fetch;
    const search = makeWebSearch({
      model: 'gemini-x',
      project: 'proj',
      location: 'global',
      prices,
      meter: { add: async (...a: unknown[]) => void metered.push(a), used: async () => 0 } as never,
      accessToken: async () => 'tok',
      fetchImpl,
    });
    const out = await search('what does stripe do', { payer: 'owner-1', agentId: 'agent-1', meterOpts: { freeOnly: true, publicShowcase: true } });
    expect(out).toEqual({ ok: true, whole: true, data: { answer: 'Stripe is payments infrastructure for the internet.', sources: [{ title: 'Stripe', url: 'https://stripe.com' }] } });
    expect(sent!.url).toBe('https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google/models/gemini-x:generateContent');
    // Grounding only: the search sub-call carries googleSearch and no function declarations.
    expect(sent!.body.tools).toEqual([{ googleSearch: {} }]);
    expect(metered).toHaveLength(1);
    expect(metered[0]![0]).toBe('owner-1');
    expect(metered[0]![1]).toBe(2 * 200 + 12 * 30 + 35_000); // tokens + grounding fee
    expect(metered[0]![4]).toEqual({ freeOnly: true, publicShowcase: true });
  });

  it('rejects an empty query without calling the model, and reports HTTP errors', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('nope', { status: 429 });
    }) as typeof fetch;
    const search = makeWebSearch({ model: 'm', project: 'p', location: 'global', prices, meter: { add: async () => {}, used: async () => 0 } as never, accessToken: async () => 't', fetchImpl });
    expect(await search('   ', { payer: 'o', agentId: 'a' })).toMatchObject({ ok: false });
    expect(calls).toBe(0);
    expect(await search('anything', { payer: 'o', agentId: 'a' })).toMatchObject({ ok: false, error: expect.stringContaining('429') });
  });

  it('refuses without calling the model when the payer is out of credits', async () => {
    let calls = 0;
    const fetchImpl = (async () => (calls++, new Response('{}'))) as typeof fetch;
    const search = makeWebSearch({ model: 'm', project: 'p', location: 'global', prices, meter: { add: async () => {}, used: async () => 1 } as never, accessToken: async () => 't', fetchImpl });
    expect(await search('anything', { payer: 'o', agentId: 'a' })).toMatchObject({ ok: false, error: expect.stringContaining('used up') });
    expect(calls).toBe(0);
  });
});
