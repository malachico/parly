import type { AgentRecord } from '../registry/types.js';
import type { LlmMeter } from '../llm/llm.js';
import { checkOutboundUrl } from './agentFetch.js';
import { publicFetch, readBodyCapped } from '../lib/publicFetch.js';

/**
 * Native tools for the public Parly Showcase, available ONLY to a configured judge agent on a public-showcase turn
 * (see cloudAgent.ts `showcaseEnabled`): `award_credits` (grant a visitor prize credits from the shared pool) and
 * `fetch_url` (read a pitched page, SSRF-safe). The authorization gate is hub-controlled (SHOWCASE_JUDGE_AGENT_IDS),
 * never the owner-editable toolkit/skill flags, because `award_credits` spends a real, hub-wide prize pool.
 */

/** web_search: read-only; any showcase crew agent gets it. Backed by a separate grounded Gemini call in the hub. */
export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: "Searches the web (Google) and returns a short researched answer with source links, so you can check facts about a pitch instead of guessing. Use it when you don't know a product/company or a claim needs verifying.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for, e.g. "madgic.ai what does it do" or "SMB bookkeeping automation market"' },
    },
    required: ['query'],
  },
} as const;

/** award_credits: judge-only (moves real credit). */
export const AWARD_CREDITS_TOOL = {
  name: 'award_credits',
  description:
    "Awards Parly prize credits to the visitor you are judging, from the showcase's shared pool. Use once, only when your rubric says they earned it; the amount is whole credits 1–10. The hub decides who gets it (the person who brought the pitch) and enforces the pool and per-person caps — you only choose the amount and a short reason.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      amount: { type: 'integer', description: 'Whole number of credits to award, 1 to 10' },
      reason: { type: 'string', description: 'One short sentence on why they earned it (shown to the visitor)' },
    },
    required: ['amount'],
  },
} as const;

/** fetch_url: read-only + SSRF-safe, so any showcase crew agent gets it (to read a pitched page), not just judges. */
export const FETCH_URL_TOOL = {
  name: 'fetch_url',
  description: "Fetches the text of a public https page (e.g. a pitched landing page or repo) so you can read it before judging — don't guess from the domain. Returns the page text (truncated). https only; private/internal addresses are refused.",
  parametersJsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A public https URL to read' },
    },
    required: ['url'],
  },
} as const;

/** True when `agent` is one of the hub-configured showcase judges allowed to award credits. */
export function isShowcaseJudge(agent: Pick<AgentRecord, 'id'>, judgeIds?: string[]): boolean {
  return Boolean(judgeIds?.length && judgeIds.includes(agent.id));
}

/** Per-turn facts the hub resolves (never the model): who to pay, the de-dup key, the judge, and the pool/caps. */
interface ShowcaseContext {
  /** The visitor to award — the human who brought the pitch (thread's originating person). */
  recipientId?: string;
  /** Idempotency key for this judge decision (the triggering message id). */
  key?: string;
  judgeId: string;
  judgeOwnerId: string;
  poolId: string;
  poolCredits: number;
  ceiling: number;
}

const FETCH_MAX_BYTES = 1_000_000; // 1 MB cap on a fetched page.
const FETCH_MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_OK_TYPES = [/^text\//i, /^application\/(json|xml|xhtml\+xml)/i];

/**
 * SSRF-safe GET of a public https page. `checkOutboundUrl` forces https + rejects private literals; `publicFetch`
 * blocks DNS results that resolve inward (incl. rebinding). Redirects are followed manually so each hop is
 * re-validated (an IP-literal redirect would otherwise skip the DNS guard). Body is capped and must be text-ish.
 */
async function fetchUrl(raw: string, fetchImpl: typeof fetch = publicFetch): Promise<Record<string, unknown>> {
  let url: URL;
  try {
    url = checkOutboundUrl(String(raw ?? ''), false, 'fetch_url');
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    let res: Response | undefined;
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': 'parly-showcase', accept: 'text/*, application/json' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop === FETCH_MAX_REDIRECTS) return { ok: false, error: 'too many redirects' };
        url = checkOutboundUrl(new URL(res.headers.get('location')!, url).toString(), false, 'fetch_url (redirect)');
        continue;
      }
      break;
    }
    if (!res) return { ok: false, error: 'no response' };
    if (!res.ok) return { ok: false, error: `the page returned HTTP ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (!FETCH_OK_TYPES.some((re) => re.test(type))) return { ok: false, error: `unsupported content type: ${type || 'unknown'} (text/html, text/*, or JSON only)` };
    // Stream the body and cut at the cap so a huge page can't blow up memory.
    if (!res.body) return { ok: false, error: 'empty body' };
    const { bytes, truncated } = await readBodyCapped(res, FETCH_MAX_BYTES);
    const text = Buffer.from(bytes).toString('utf8');
    return { ok: true, whole: true, data: { url: url.toString(), contentType: type, text, ...(truncated ? { truncated: true } : {}) } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Executes a showcase native tool. `ctx.enabled` must be true (the caller is a judge on a public turn). */
export async function runShowcaseCloudTool(
  meter: Pick<LlmMeter, 'awardShowcaseCredits'>,
  ctx: ShowcaseContext,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = publicFetch,
): Promise<unknown> {
  if (name === 'fetch_url') return fetchUrl(String(args.url ?? ''), fetchImpl);
  if (name === 'award_credits') {
    if (!ctx.recipientId) return { ok: false, error: 'there is no visitor in this turn to award (awards go to the person who brought the pitch).' };
    if (!ctx.key) return { ok: false, error: 'cannot record an award without a message to tie it to.' };
    const res = await meter.awardShowcaseCredits({
      poolId: ctx.poolId,
      poolCredits: ctx.poolCredits,
      recipientId: ctx.recipientId,
      amount: Number(args.amount),
      ceiling: ctx.ceiling,
      key: ctx.key,
      judgeId: ctx.judgeId,
      judgeOwnerId: ctx.judgeOwnerId,
    });
    return res.ok ? { ok: true, data: { awarded: res.awarded, recipientTotal: res.recipientTotal, poolRemaining: res.poolRemaining } } : res;
  }
  return { ok: false, error: `No showcase tool ${name}` };
}

export { fetchUrl as _fetchUrlForTest };
