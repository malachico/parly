import { costMicros, type LlmMeter, type LlmPrices } from '../llm/llm.js';
import { generate, vertexProject } from '../lib/vertex.js';

/** Who pays for a search and how it's metered (same options as a model turn). */
interface WebSearchBilling {
  payer: string;
  agentId: string;
  meterOpts?: { freeOnly?: boolean; publicShowcase?: boolean; personId?: string };
}

/** Vertex bills each Google-Search-grounded request on top of tokens ($35 / 1,000), so each search charges it too. */
const GROUNDING_FEE_MICROS = 35_000;

export type WebSearch = (query: string, billing: WebSearchBilling) => Promise<Record<string, unknown>>;

/**
 * Web search for any agent: a separate Gemini call with Google Search grounding on (grounding only, no function
 * tools — the combination Gemini allows), returning a short researched answer + source links. Metered like a turn.
 */
export function makeWebSearch(opts: {
  model: string;
  project?: string;
  location: string;
  prices: LlmPrices;
  meter: Pick<LlmMeter, 'add' | 'used'>;
  accessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): WebSearch {
  return async (query, billing) => {
    const q = String(query ?? '').trim().slice(0, 500);
    if (!q) return { ok: false, error: 'web_search needs a query' };
    try {
      // Same gate as a model turn: an MCP caller has no turn-entry check, so refuse once the payer's allowance is spent.
      if ((await opts.meter.used(billing.payer, undefined, billing.meterOpts)) >= 1) return { ok: false, error: "This month's Parly credits are used up." };
      const project = await vertexProject(opts.project);
      const out = await generate({
        project,
        location: opts.location,
        model: opts.model,
        prompt: `Search the web and answer in 3-5 sentences with the key facts. Query: ${q}`,
        tools: [{ googleSearch: {} }],
        timeoutMs: 45_000, // grounded calls measured 10–42s; a cut-off search wastes the wait and returns nothing
        accessToken: opts.accessToken,
        fetchImpl: opts.fetchImpl,
      });
      if (!out.ok) return { ok: false, error: `web_search failed (HTTP ${out.status})` };
      if (out.usage)
        await opts.meter.add(billing.payer, costMicros(opts.prices, out.usage) + GROUNDING_FEE_MICROS, { id: billing.agentId, usage: out.usage }, undefined, billing.meterOpts).catch((err) => console.error('web_search meter', err));
      const text = out.text.trim();
      if (!text) return { ok: false, error: 'web_search found nothing' };
      const sources = (out.body.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
        .map((c) => (c.web?.uri ? { title: c.web.title ?? '', url: c.web.uri } : undefined))
        .filter((s): s is { title: string; url: string } => Boolean(s))
        .slice(0, 5);
      return { ok: true, whole: true, data: { answer: text, ...(sources.length ? { sources } : {}) } };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
}
