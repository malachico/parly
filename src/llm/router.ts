import express, { type Request, type Response, type Router } from 'express';
import { costMicros, type LlmPrices, type LlmUsage } from '../lib/llmCost.js';
import { vertexAccessToken, vertexBase } from '../lib/vertex.js';
import type { AgentRecord } from '../registry/types.js';
import type { LlmMeter } from './llm.js';

/**
 * Reads the token counts out of a Gemini answer: one JSON object, a JSON array of chunks (streaming without SSE),
 * or SSE `data:` lines. Each chunk's `usageMetadata` is a running total, so the last one counts.
 */
class UsageTap {
  usage: LlmUsage = {};
  private buffer = '';

  private take(v: unknown): void {
    for (const item of Array.isArray(v) ? v : [v]) {
      const u = (item as { usageMetadata?: LlmUsage } | null)?.usageMetadata;
      if (u) this.usage = u;
      // The OpenAI-compatible shape (/llm/openai): `usage` on the answer, or on a stream's last chunk.
      const o = (item as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } } | null)?.usage;
      if (o?.prompt_tokens !== undefined) {
        this.usage = { promptTokenCount: o.prompt_tokens, candidatesTokenCount: o.completion_tokens, cachedContentTokenCount: o.prompt_tokens_details?.cached_tokens };
      }
    }
  }

  json(body: string): void {
    try {
      this.take(JSON.parse(body));
    } catch {
      // not JSON: an error page, nothing to bill
    }
  }

  sse(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        this.take(JSON.parse(line.slice(5)));
      } catch {
        // a partial or non-JSON line
      }
    }
  }
}

export const GEMINI_OPENAI_FALLBACK_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// Each side refuses the other's signatures: the Gemini API with 400 "Corrupted thought signature.", Vertex with 400 "Invalid thought signature.".
// This documented value skips the check on both, at some cost to the model.
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
export const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash';

/** A copy of the messages neither side will refuse. Only signature metadata changes: a tool schema may have its own thought_signature. */
function skipSignatures(messages: unknown): unknown {
  type Signed = { extra_content?: { google?: { thought_signature?: string } }; tool_calls?: unknown };
  const copy = structuredClone(messages);
  if (!Array.isArray(copy)) return copy;
  for (const m of copy as (Signed | null)[]) {
    const calls = Array.isArray(m?.tool_calls) ? (m.tool_calls as (Signed | null)[]) : [];
    for (const part of [m, ...calls]) if (part?.extra_content?.google?.thought_signature) part.extra_content.google.thought_signature = SKIP_THOUGHT_SIGNATURE;
  }
  return copy;
}

/** Who spoke last in a chat request, with no content. */
function lastTurns(body?: Buffer): string[] {
  try {
    const messages: { role?: string; tool_calls?: unknown[] }[] = JSON.parse(String(body)).messages;
    return messages.slice(-4).map((m) => `${m.role}${m.tool_calls ? `+${m.tool_calls.length}calls` : ''}`);
  } catch {
    return [];
  }
}

interface VertexOptions {
  project: string;
  /** `global`, or a region such as `us-central1`. */
  location: string;
  /** The one model hosted agents run on. */
  model: string;
  prices: LlmPrices;
  /** A Google access token for the hub's own account (tests stand in). */
  accessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** No first byte this long: a second identical call races the first (default 8s). */
  hedgeMs?: number;
  /** No first byte this long across hedged Vertex attempts: abort and treat as timeout. */
  timeoutMs?: number;
  /** Waits between tries on a 429, for tests. */
  retryMs?: number[];
  /** Gemini API key (`GEMINI_FALLBACK_API_KEY`) for pre-first-byte OpenAI-compat failover on Vertex 429/503/timeout. */
  fallbackApiKey?: string;
  /** Gemini API model (`GEMINI_FALLBACK_MODEL`, default `gemini-2.5-flash`) used on failover. */
  fallbackModel?: string;
  /** Raw model micro-dollars one hosted-agent turn may spend (`/llm/openai/turn/:turn/…`); unset or 0: no limit. */
  turnBudgetMicros?: number;
}

/** A runner's id for one turn: what it puts in the path, so the hub can add up that turn's spend. */
const TURN_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The text a turn over its budget gets as its model's answer; the runner spots it and posts where the agent got to. */
const TURN_BUDGET_STOP = 'Turn stopped: reached its spending limit';

/** A model answer (OpenAI shape, streamed or not) that ends the turn with `text` and no tool calls. */
function stopAnswer(res: Response, text: string, stream: boolean): void {
  const id = `parly-stop-${Date.now()}`;
  if (!stream) {
    res.json({ id, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const chunk = (c: unknown) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [c] })}\n\n`;
  res.end(chunk({ index: 0, delta: { role: 'assistant', content: text } }) + chunk({ index: 0, delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
}

type Answer = { i: number; res: globalThis.Response; reader?: ReadableStreamDefaultReader<Uint8Array>; first?: Uint8Array };

/** A 400's `error.message`, once its body is complete JSON. Vertex wraps it in an array. */
function errorMessage(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString());
    return String((Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message ?? '');
  } catch {
    return undefined;
  }
}

/**
 * Whether a 400 is Vertex refusing a signature. What it read stays in `first` for the relay; its first chunk can be a lone "[".
 * Stops once the error parses. A body that stalls before that loses the rest: a read lost to the deadline would eat the next chunk.
 */
async function signatureRefused(a: Answer, ms: number): Promise<boolean> {
  let head = Buffer.from(a.first ?? []);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)));
  try {
    for (;;) {
      const message = errorMessage(head);
      if (message !== undefined) return message.includes('Invalid thought signature');
      if (!a.reader || head.length >= 4096) return false;
      const part = await Promise.race([a.reader.read(), deadline]);
      if (!part) void a.reader.cancel().catch(() => {});
      if (!part?.value) return false;
      head = Buffer.concat([head, part.value]);
    }
  } finally {
    clearTimeout(timer);
    if (head.length) a.first = head;
  }
}

/**
 * Vertex answers most calls in a few seconds but now and then sits on one for minutes (1 in ~15 in testing, up to
 * 4 min). Past `delayMs` without a first byte, a second identical call races the first; the first to answer wins and
 * the other is cancelled. With no `delayMs`, no second call (see relay: an answer that isn't streamed).
 */
// ponytail: one hedge; a cancelled call may still be billed for its input, which the meter doesn't count.
async function hedged(call: (signal: AbortSignal) => Promise<globalThis.Response>, delayMs: number | undefined, timeoutMs?: number): Promise<Answer> {
  const controllers: AbortController[] = [];
  const launch = (i: number): Promise<Answer> => {
    const ctl = new AbortController();
    controllers.push(ctl);
    const p = call(ctl.signal).then(async (res) => {
      const reader = res.body?.getReader();
      const first = reader ? (await reader.read()).value : undefined;
      return { i, res, reader, first };
    });
    p.catch(() => {});
    return p;
  };
  const a = launch(0);
  let timer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const late = delayMs === undefined ? new Promise<'late'>(() => {}) : new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), delayMs)));
  const timedOut = timeoutMs
    ? new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          controllers.forEach((c) => c.abort());
          reject(new Error(`Vertex timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    : undefined;
  try {
    let winner = await Promise.race([a, late, ...(timedOut ? [timedOut] : [])]).finally(() => clearTimeout(timer));
    if (winner === 'late') {
      const both = Promise.any([a, launch(1)]);
      both.catch(() => {});
      winner = await (timedOut ? Promise.race([both, timedOut]) : both);
    }
    const won = winner;
    controllers.forEach((c, i) => i !== won.i && c.abort());
    return won;
  } catch (err) {
    controllers.forEach((c) => c.abort());
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/** Waits between tries when the model answers 429, before passing that on. */
const RETRY_429_MS = [2000, 5000, 10_000, 20_000];

const geminiError = (res: Response, status: number, gStatus: string, message: string) =>
  res.status(status).json({ error: { code: status, message, status: gStatus } });

/** The agent's Parly key, from whichever header its client sends it in (never the URL, which access logs keep). */
const keyOf = (req: Request) =>
  req.header('x-goog-api-key') ?? req.header('x-api-key') ?? req.header('authorization')?.replace(/^Bearer /, '');

/** `…/models/<any>:<action>`: the model in the path is ignored (every call goes to the configured one). */
const CREDITS_OUT = "This month's Parly credits are used up. They renew at the start of next month.";
const CALL = /\/models\/[^/:]+:(generateContent|streamGenerateContent|countTokens)$/;

/**
 * `/llm/vertex/…/models/{model}:generateContent | :streamGenerateContent | :countTokens`, Gemini's own API shape,
 * so a Gemini client works with this as its base URL. Streams through as is.
 */
export function llmRouter(
  meter: LlmMeter,
  vertex: VertexOptions | undefined,
  getAgent: (agentId: string) => Promise<Pick<AgentRecord, 'id' | 'payerId' | 'ownerId' | 'archived'> | undefined>,
  onCall?: (ownerId: string) => void,
): Router {
  const router = express.Router();
  const fetchImpl = vertex?.fetchImpl ?? fetch;
  const token = vertexAccessToken(vertex?.accessToken);
  // A long conversation with its files is far past the hub's usual 1 MB.
  router.use(express.raw({ type: () => true, limit: '32mb' }));
  /** Who is calling: key ok, agent exists and isn't archived. Charges go to meter.payerOf(agent) (a company pool when its person is linked to one), not the ownerId baked into the key. */
  const caller = async (req: Request) => {
    const who = await meter.resolve(keyOf(req));
    if (!who) return undefined;
    const agent = await getAgent(who.agentId);
    if (!agent || agent.archived) return undefined;
    // Key ownerId fills in only when the record has neither owner nor payerId (tests, or a lookup that only returns id).
    const payerId = agent.ownerId ?? agent.payerId ? await meter.payerOf(agent) : who.ownerId;
    return { agentId: agent.id, payerId, ownerId: agent.ownerId ?? who.ownerId, personId: agent.ownerId ?? agent.payerId ?? who.ownerId };
  };

  router.post(/^\/vertex\/.*$/, (req: Request, res: Response) => {
    void (async () => {
      const action = CALL.exec(req.path)?.[1];
      if (!action) return geminiError(res, 404, 'NOT_FOUND', 'Only generateContent, streamGenerateContent and countTokens are proxied');
      if (!vertex) return geminiError(res, 503, 'UNAVAILABLE', "This hub doesn't run hosted agents");
      const who = await caller(req);
      if (!who) return geminiError(res, 401, 'UNAUTHENTICATED', 'Unknown, revoked or archived Parly agent key');
      onCall?.(who.ownerId);
      const metered = action !== 'countTokens';
      // ponytail: calls already under way can overshoot the allowance by their own cost; a reservation per call if that matters
      if (metered && (await meter.used(who.payerId)) >= 1) {
        return geminiError(res, 429, 'RESOURCE_EXHAUSTED', await meter.stopText(who.payerId, who.personId, CREDITS_OUT));
      }
      const query = req.query.alt === 'sse' ? '?alt=sse' : '';
      const url = `${vertexBase(vertex)}/publishers/google/models/${vertex.model}:${action}${query}`;
      await relay(res, who, url, Buffer.isBuffer(req.body) ? req.body : undefined, metered, vertex, action === 'streamGenerateContent');
    })().catch((err) => failed(res, err));
  });

  /**
   * `/llm/openai/chat/completions`: OpenAI's chat API, for agent engines that only speak it (ZeroClaw, PicoClaw…),
   * through Vertex's OpenAI-compatible endpoint. Same keys, allowance and model as above.
   */
  const openai = (req: Request, res: Response) => {
    void (async () => {
      if (!vertex) return geminiError(res, 503, 'UNAVAILABLE', "This hub doesn't run hosted agents");
      const who = await caller(req);
      if (!who) return geminiError(res, 401, 'UNAUTHENTICATED', 'Unknown, revoked or archived Parly agent key');
      onCall?.(who.ownerId);
      if ((await meter.used(who.payerId)) >= 1) {
        return geminiError(res, 429, 'RESOURCE_EXHAUSTED', await meter.stopText(who.payerId, who.personId, CREDITS_OUT));
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
      } catch {
        return geminiError(res, 400, 'INVALID_ARGUMENT', 'Expected a JSON body');
      }
      // A turn past its budget: no more model calls. Answered as the model, so the agent's engine ends the turn cleanly
      // (an error would be retried); the runner sees the line and posts where the agent got to.
      // ponytail: checked before each call, so a turn overshoots by its last call; a runner that changes its turn id isn't stopped.
      const turnId = typeof req.params.turn === 'string' && TURN_ID.test(req.params.turn) ? req.params.turn : undefined;
      const budget = vertex.turnBudgetMicros ?? 0;
      const turn = turnId && budget > 0 ? { id: turnId, budget } : undefined;
      if (turn && (await meter.store.getTurnSpend(who.agentId, turn.id)) >= turn.budget) {
        console.log(`llm turn over budget ${JSON.stringify({ agentId: who.agentId, turn: turn.id })}`);
        return stopAnswer(res, `${TURN_BUDGET_STOP} ($${(turn.budget / 1_000_000).toFixed(2)}).`, Boolean(body.stream));
      }
      // Every call goes to the hub's model; a stream ends with its usage, so it can be metered.
      body.model = `google/${vertex.model}`;
      if (body.stream) body.stream_options = { ...(body.stream_options as object), include_usage: true };
      const fallbackKey = vertex.fallbackApiKey?.trim();
      const fallbackModel = vertex.fallbackModel?.trim() || DEFAULT_GEMINI_FALLBACK_MODEL;
      const skipped = fallbackKey ? skipSignatures(body.messages) : undefined;
      const fallback = fallbackKey
        ? {
            url: GEMINI_OPENAI_FALLBACK_URL,
            apiKey: fallbackKey,
            body: Buffer.from(JSON.stringify({ ...body, model: fallbackModel, messages: skipped })),
            vertexBody: Buffer.from(JSON.stringify({ ...body, messages: skipped })),
          }
        : undefined;
      await relay(res, who, `${vertexBase(vertex)}/endpoints/openapi/chat/completions`, Buffer.from(JSON.stringify(body)), true, vertex, Boolean(body.stream), fallback, turn?.id);
    })().catch((err) => failed(res, err));
  };
  router.post('/openai/chat/completions', openai);
  // The same, for one turn of a hosted agent (its runner puts the turn's id in the path): its spend is added up and capped.
  router.post('/openai/turn/:turn/chat/completions', openai);

  /** Calls Vertex as the hub, streams its answer back as is, and meters what it cost. */
  async function relay(
    res: Response,
    who: { agentId: string; payerId: string; ownerId: string; personId?: string },
    url: string,
    body: Buffer | undefined,
    metered: boolean,
    vertex: VertexOptions,
    stream: boolean,
    fallback?: { url: string; apiKey: string; body: Buffer; vertexBody: Buffer },
    turn?: string,
  ): Promise<void> {
    /** Bills a call's usage to its payer (and to its turn, when it has one). */
    const bill = async (usage: LlmUsage) => {
      const cost = costMicros(vertex.prices, usage);
      await Promise.all([
        meter.add(who.payerId, cost, { id: who.agentId, usage }, undefined, { personId: who.personId }),
        turn ? meter.store.addTurnSpend(who.agentId, turn, cost) : undefined,
      ]);
    };
    const started = Date.now();
    // Sizes and timings only, never the body or a key. elapsedMs stops at the first byte, so a stream that dies later still has its line.
    const logCall = (backend: 'vertex' | 'fallback' | 'none', status?: number) =>
      console.log(`llm call ${JSON.stringify({ backend, status, stream, requestBytes: body?.length ?? 0, elapsedMs: Date.now() - started })}`);
    const auth = `Bearer ${await token()}`;
    let answer: Answer | undefined;
    let vertexErr: unknown;
    const to = vertex.timeoutMs ?? (fallback ? 25_000 : undefined);
    let backend: 'vertex' | 'fallback' = 'vertex';
    // Hedged only when streamed: unstreamed, the first byte comes with the whole answer, so any long answer would look
    // stuck and be asked for twice (Google bills both; the meter counts one).
    const askVertex = () =>
      hedged(
        (signal) => fetchImpl(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body, signal }),
        stream ? (vertex.hedgeMs ?? 8000) : undefined,
        to,
      );
    let resigned = false;
    // A busy model answers 429 for a while: wait it out here, rather than lose an agent's whole turn to it.
    for (const pause of [...(vertex.retryMs ?? RETRY_429_MS), undefined]) {
      answer = undefined;
      vertexErr = undefined;
      try {
        answer = await askVertex();
        // An agent echoes what the fallback signed, and Vertex loses the turn to it. Only then skip the check: Vertex's own signatures do the model good.
        if (fallback && !resigned && answer.res.status === 400 && (await signatureRefused(answer, to || 25_000))) {
          console.warn('llm vertex refused a signature, resending with skips');
          void answer.reader?.cancel().catch(() => {});
          resigned = true;
          body = fallback.vertexBody;
          answer = await askVertex();
        }
      } catch (err) {
        if (!fallback) {
          logCall('none');
          throw err;
        }
        vertexErr = err;
      }
      // Pre-first-byte failover: on Vertex 429/503 or timeout, escalate once (unhedged) to the Gemini API OpenAI-compat endpoint.
      if (fallback && (vertexErr || answer?.res.status === 429 || answer?.res.status === 503)) {
        // A deadline to the first byte, like hedged(): AbortSignal.timeout would stay live and cut a long answer off mid-stream.
        // Without stream the first byte comes only when the whole answer is done, so it gets double.
        const fbMs = (to || 25_000) * (stream ? 1 : 2);
        const fbAbort = new AbortController();
        let fbTimer: NodeJS.Timeout | undefined;
        const fbDeadline = new Promise<never>((_, reject) => {
          fbTimer = setTimeout(() => {
            fbAbort.abort();
            reject(new Error(`Gemini fallback timed out after ${fbMs}ms`));
          }, fbMs);
        });
        const clean = (text: string) => JSON.stringify(text.replaceAll(fallback.apiKey, '[redacted]').slice(0, 300));
        try {
          const fbRes = await Promise.race([
            fetchImpl(fallback.url, {
              method: 'POST',
              headers: { authorization: `Bearer ${fallback.apiKey}`, 'content-type': 'application/json' },
              body: fallback.body,
              signal: fbAbort.signal,
            }),
            fbDeadline,
          ]);
          const fbReader = fbRes.body?.getReader();
          const fbRead = fbReader && Promise.race([fbReader.read(), fbDeadline]);
          if (fbRes.ok) {
            const fbFirst = (await fbRead)?.value;
            void answer?.reader?.cancel().catch(() => {});
            answer = { i: 0, res: fbRes, reader: fbReader, first: fbFirst };
            vertexErr = undefined;
            backend = 'fallback';
          } else {
            // Only as far as the excerpt: an error body can be huge, hang, or echo the prompt. Its first chunk can be a lone "[".
            const decoder = new TextDecoder();
            let excerpt = '';
            let part = await fbRead?.catch(() => undefined);
            while (part?.value) {
              excerpt += decoder.decode(part.value, { stream: true });
              if (excerpt.length >= 300) break;
              part = await Promise.race([fbReader!.read(), fbDeadline]).catch(() => undefined);
            }
            console.warn(`llm fallback not ok ${fbRes.status} ${clean(excerpt)}`);
            void fbReader?.cancel().catch(() => {});
          }
        } catch (err) {
          // Fallback also failed: surface the original Vertex error below.
          const cause = (err as Error).cause;
          console.warn(`llm fallback failed ${clean(cause ? `${String(err)}: ${String(cause)}` : String(err))}`);
        } finally {
          clearTimeout(fbTimer);
        }
      }
      if (answer?.res.status !== 429 || pause === undefined) break;
      void answer.reader?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, pause));
    }
    if (vertexErr) {
      logCall('none');
      throw vertexErr;
    }
    logCall(backend, answer!.res.status);
    const { res: up, reader, first } = answer!;
    res.status(up.status);
    const type = up.headers.get('content-type');
    if (type) res.setHeader('content-type', type);
    const tap = new UsageTap();
    const sse = (type ?? '').includes('text/event-stream');
    const decoder = new TextDecoder();
    let whole = '';
    let rejected = '';
    try {
      for (let chunk = first; chunk; chunk = (await reader!.read()).value) {
        res.write(chunk);
        if (up.status === 400 && rejected.length < 4096) rejected += decoder.decode(chunk, { stream: true });
        if (!metered || !up.ok) continue;
        const text = decoder.decode(chunk, { stream: true });
        if (sse) tap.sse(text);
        else whole += text;
      }
    } catch (err) {
      // Upstream broke mid-stream: bill the usage it already reported, then let the caller close the response.
      if (metered && up.ok && Object.keys(tap.usage).length) {
        await bill(tap.usage).catch((e) => console.error('llm meter', e));
      }
      throw err;
    }
    res.end();
    // ponytail: only error.message, the rest of a 400 can echo the prompt; delete once the signature resend is proven live.
    if (rejected) console.warn(`llm vertex 400 ${JSON.stringify(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(rejected)?.[1]?.slice(0, 300) ?? null)} ${JSON.stringify(lastTurns(body))}`);
    if (!metered || !up.ok) return;
    if (!sse) tap.json(whole);
    await bill(tap.usage);
  }

  const failed = (res: Response, err: unknown) => {
    console.error('llm proxy', err);
    if (!res.headersSent) geminiError(res, 502, 'UNAVAILABLE', 'The model could not be reached');
    else res.end();
  };
  return router;
}
