import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach } from 'vitest';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AI_MARKUP, costMicros, LlmMeter } from '../src/llm/llm.js';
import { DEFAULT_GEMINI_FALLBACK_MODEL, GEMINI_OPENAI_FALLBACK_URL, llmRouter } from '../src/llm/router.js';
import { CREDIT_MICROS } from '../src/billing/billing.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const VERTEX = { model: 'gemini-test', project: 'proj', location: 'global', prices: { input: 2, output: 12 } };

const chunk = (text: string, usage?: object) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], ...(usage ? { usageMetadata: usage } : {}) });
const SSE = `data: ${chunk('Hel', { promptTokenCount: 3000, cachedContentTokenCount: 2000, candidatesTokenCount: 1 })}\r\n\r\ndata: ${chunk('lo', { promptTokenCount: 3000, cachedContentTokenCount: 2000, candidatesTokenCount: 400, thoughtsTokenCount: 100 })}\r\n\r\n`;

/** The proxy in front of a fake Vertex that records what reached it. */
async function proxy(
  meter: LlmMeter,
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { hedgeMs?: number; timeoutMs?: number; fallbackApiKey?: string; fallbackModel?: string; retryMs?: number[]; turnBudgetMicros?: number } = {},
  getAgent: (agentId: string) => Promise<{ id: string; payerId?: string; ownerId?: string; archived?: boolean } | undefined> = async (id) => ({ id }),
) {
  const seen: { url: string; auth?: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return answer(url, init);
  }) as typeof fetch;
  const app = express();
  app.use('/llm', llmRouter(meter, { ...VERTEX, fetchImpl, accessToken: async () => 'ya29.hub', retryMs: [], ...opts }, getAgent));
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/llm/vertex`;
  const call = (key: string, path: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [] }) });
  return { call, seen, base, close: () => server.close() };
}

describe('LLM proxy', () => {
  it('prices output and thoughts as output, cached prompt tokens at a quarter', () => {
    expect(costMicros({ input: 2, output: 12 }, { promptTokenCount: 1_000_000 })).toBe(2_000_000);
    expect(costMicros({ input: 2, output: 12 }, { promptTokenCount: 3000, cachedContentTokenCount: 2000, candidatesTokenCount: 400, thoughtsTokenCount: 100 })).toBe(
      2 * 1000 + 2 * 0.25 * 2000 + 12 * 500,
    );
  });

  it("bills an ownerless room agent's payerId, not the ownerId baked into the proxy key", async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-payer', ownerId: 'key-owner' });
    const cost = AI_MARKUP * (2 * 100 + 12 * 10) / 1_000_000;
    const p = await proxy(
      meter,
      () => new Response(chunk('hi', { promptTokenCount: 100, candidatesTokenCount: 10 }), { headers: { 'content-type': 'application/json' } }),
      {},
      async (id) => (id === 'agent-payer' ? { id, payerId: 'real-payer' } : undefined),
    );
    expect((await p.call(key, '/v1/models/x:generateContent')).status).toBe(200);
    await expect.poll(() => meter.used('real-payer')).toBeCloseTo(cost);
    expect(await meter.used('key-owner')).toBe(0);
    p.close();
  });

  it('streams through to the configured model as the hub, and bills the owner from the last usage', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-1', ownerId: 'owner-stream' });
    const p = await proxy(meter, () => new Response(SSE, { headers: { 'content-type': 'text/event-stream' } }));
    // Whatever model the client names, the configured one answers.
    const res = await p.call(key, '/v1beta/models/gemini-ultra-expensive:streamGenerateContent?alt=sse');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SSE);
    expect(p.seen[0]).toEqual({
      url: 'https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google/models/gemini-test:streamGenerateContent?alt=sse',
      auth: 'Bearer ya29.hub',
    });
    await expect.poll(() => meter.used('owner-stream')).toBeCloseTo(AI_MARKUP * (2 * 1000 + 2 * 0.25 * 2000 + 12 * 500) / 1_000_000);
    p.close();
  });

  it('bills the usage already seen when the stream breaks mid-way', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-mid', ownerId: 'owner-mid' });
    const first = `data: ${chunk('Hel', { promptTokenCount: 100, candidatesTokenCount: 10 })}\r\n\r\n`;
    const p = await proxy(meter, () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) return c.error(new Error('upstream reset'));
          sent = true;
          c.enqueue(new TextEncoder().encode(first));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const res = await p.call(key, '/v1beta/models/x:streamGenerateContent?alt=sse');
    expect(res.status).toBe(200);
    await res.text().catch(() => '');
    await expect.poll(() => meter.used('owner-mid')).toBeCloseTo(AI_MARKUP * (2 * 100 + 12 * 10) / 1_000_000, 9);
    p.close();
  });

  it('bills a plain JSON answer too, and lets countTokens through unbilled', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-2', ownerId: 'owner-json' });
    const p = await proxy(meter, () => new Response(chunk('hi', { promptTokenCount: 100, candidatesTokenCount: 10 }), { headers: { 'content-type': 'application/json' } }));
    expect((await p.call(key, '/v1/models/x:generateContent')).status).toBe(200);
    expect((await p.call(key, '/v1/models/x:countTokens')).status).toBe(200);
    await expect.poll(() => meter.used('owner-json')).toBeCloseTo(AI_MARKUP * (2 * 100 + 12 * 10) / 1_000_000);
    expect((await p.call(key, '/v1/models/x:deleteEverything')).status).toBe(404);
    p.close();
  });

  it("stops a hosted agent's turn at its spending limit, answering as the model so the turn ends cleanly", async () => {
    const meter = new LlmMeter(testDb(), 1_000_000_000);
    const key = await meter.mint({ id: 'agent-turn', ownerId: 'owner-turn' });
    // Each call costs 2 * 1000 + 12 * 100 = 3200 micro-dollars; the turn may spend 5000.
    const p = await proxy(meter, () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { headers: { 'content-type': 'application/json' } }), { turnBudgetMicros: 5000 });
    const port = new URL(p.base).port;
    const ask = (path: string, stream = false) =>
      fetch(`http://127.0.0.1:${port}/llm/openai${path}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ stream, messages: [{ role: 'user', content: 'go' }] }),
      });
    const json = async (r: Promise<Response>) => (await (await r).json()) as any;
    expect((await json(ask('/turn/turn-0001'))).choices[0].message.content).toBe('ok');
    expect((await json(ask('/turn/turn-0001'))).choices[0].message.content).toBe('ok');
    await expect.poll(() => meter.store.getTurnSpend('agent-turn', 'turn-0001')).toBe(6400);
    // Past the limit: the model isn't called; the answer is a plain stop, streamed or not.
    const stopped = await json(ask('/turn/turn-0001'));
    expect(stopped.choices[0]).toMatchObject({ message: { role: 'assistant' }, finish_reason: 'stop' });
    expect(stopped.choices[0].message.content).toContain('Turn stopped: reached its spending limit');
    const streamed = await (await ask('/turn/turn-0001', true)).text();
    expect(streamed).toContain('reached its spending limit');
    expect(streamed).toContain('data: [DONE]');
    expect(p.seen).toHaveLength(2);
    // Another turn, or a call with no turn (an older runner), isn't stopped.
    expect((await json(ask('/turn/turn-0002'))).choices[0].message.content).toBe('ok');
    expect((await json(ask(''))).choices[0].message.content).toBe('ok');
    expect(p.seen).toHaveLength(4);
    p.close();
  });

  it("doesn't hedge an answer that isn't streamed: its first byte comes only with the whole answer", async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-slow', ownerId: 'owner-slow' });
    const p = await proxy(
      meter,
      async () => {
        await new Promise((r) => setTimeout(r, 80));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'long answer' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { headers: { 'content-type': 'application/json' } });
      },
      { hedgeMs: 10 },
    );
    const port = new URL(p.base).port;
    const res = await fetch(`http://127.0.0.1:${port}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'write a lot' }] }),
    });
    expect(((await res.json()) as any).choices[0].message.content).toBe('long answer');
    expect(p.seen).toHaveLength(1);
    p.close();
  });

  it('serves the OpenAI chat API through Vertex: the configured model, usage asked of streams, and billed', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-oa', ownerId: 'owner-openai' });
    let sent: Record<string, any> = {};
    const p = await proxy(meter, (_url, init) => {
      sent = JSON.parse(init.body!.toString());
      const last = JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 200 } } });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\ndata: ${last}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const port = new URL(p.base).port;
    const res = await fetch(`http://127.0.0.1:${port}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-anything', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('[DONE]');
    expect(p.seen[0]!.url).toBe('https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi/chat/completions');
    expect(sent).toMatchObject({ model: 'google/gemini-test', stream_options: { include_usage: true } });
    await expect.poll(() => meter.used('owner-openai')).toBeCloseTo(AI_MARKUP * (2 * (100 + 0.25 * 200) + 12 * 20) / 1_000_000);
    p.close();
  });

  it('races a second call when Vertex sits on the first, answers with the faster one, and cancels the other', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-h', ownerId: 'owner-hedge' });
    let cancelled = false;
    let calls = 0;
    const p = await proxy(
      meter,
      (_url, init) => {
        if (calls++ > 0) return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } });
        // The stuck one: no answer until it is cancelled.
        return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => ((cancelled = true), reject(new Error('aborted')))));
      },
      { hedgeMs: 20 },
    );
    const res = await p.call(key, '/v1beta/models/x:streamGenerateContent?alt=sse');
    expect(await res.text()).toBe(SSE);
    expect(p.seen).toHaveLength(2);
    expect(cancelled).toBe(true);
    // Billed once, from the answer that was used.
    await expect.poll(() => meter.used('owner-hedge')).toBeCloseTo(AI_MARKUP * (2 * 1000 + 2 * 0.25 * 2000 + 12 * 500) / 1_000_000);
    p.close();
  });

  it('waits out a 429 from the model, and passes it on only if it lasts', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-429', ownerId: 'owner-429' });
    const busy = () => new Response('{"error":{"code":429}}', { status: 429 });
    let left = 2;
    const p = await proxy(meter, () => (left-- > 0 ? busy() : new Response(chunk('ok', { promptTokenCount: 1, candidatesTokenCount: 1 }))), { retryMs: [1, 1] });
    const res = await p.call(key, '/v1/models/x:generateContent');
    expect(res.status).toBe(200);
    expect(p.seen).toHaveLength(3);
    left = 9;
    expect((await p.call(key, '/v1/models/x:generateContent')).status).toBe(429);
    expect(p.seen).toHaveLength(6);
    p.close();
  });

  it('refuses unknown and revoked keys, and an owner past the allowance, without calling Vertex', async () => {
    const meter = new LlmMeter(testDb(), 1000);
    const key = await meter.mint({ id: 'agent-3', ownerId: 'owner-cap' });
    const p = await proxy(meter, () => new Response('{}'));
    expect((await p.call('plk_nope', '/v1/models/x:generateContent')).status).toBe(401);
    await meter.add('owner-cap', 1000);
    const over = await p.call(key, '/v1/models/x:generateContent');
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { status: string } }).error.status).toBe('RESOURCE_EXHAUSTED');
    await meter.revoke('agent-3');
    expect((await p.call(key, '/v1/models/x:generateContent')).status).toBe(401);
    expect(p.seen).toEqual([]);
    p.close();
  });

  it("stops serving an archived agent's key on both routes, without calling Vertex, and serves it again once restored", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => (seen.push(url), new Response(chunk('hi', { promptTokenCount: 1, candidatesTokenCount: 1 })))) as typeof fetch;
    const vertex = { ...VERTEX, fetchImpl, accessToken: async () => 'ya29.hub', retryMs: [] };
    // The real app, so the check is proved wired in and not only present in the router.
    const { app, hub } = createApp({ db: testDb(), config: testConfig({ vertex }) });
    const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
      const s = app.listen(0, () => r(s));
    });
    const llm = `http://127.0.0.1:${(server.address() as AddressInfo).port}/llm`;
    const owner = await testPerson(hub.registry);
    const { agent } = await hub.registry.createBot(owner, { name: 'archived-llm' });
    const key = await hub.llm.mint({ id: agent.id, ownerId: owner.id });
    const statuses = async () =>
      Promise.all([
        fetch(`${llm}/vertex/v1/models/x:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key }, body: '{}' }),
        fetch(`${llm}/openai/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{"messages":[]}' }),
      ]).then((all) => all.map((r) => r.status));

    expect(await statuses()).toEqual([200, 200]);
    expect(seen).toHaveLength(2);

    await hub.registry.setArchived(owner, agent.id, true);
    expect(await statuses()).toEqual([401, 401]);
    expect(seen).toHaveLength(2);

    await hub.registry.setArchived(owner, agent.id, false);
    expect(await statuses()).toEqual([200, 200]);
    expect(seen).toHaveLength(4);
    server.close();
  });

  it('takes the agent key only from a header, never from ?key= in the URL', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-qk', ownerId: 'owner-qk' });
    const p = await proxy(meter, () => new Response('{}'));
    const res = await fetch(`${p.base}/v1/models/x:generateContent?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(p.seen).toEqual([]);
    expect((await p.call(key, '/v1/models/x:countTokens')).status).toBe(200);
    p.close();
  });

  it('chargeOnce leaves no mark when the spend fails, so a retry still charges (once)', async () => {
    const db = testDb();
    const meter = new LlmMeter(db, 1_000_000);
    vi.spyOn(db, 'runTransaction').mockRejectedValueOnce(new Error('contention'));
    await expect(meter.chargeOnce('owner-once', 1, 'evt-1')).rejects.toThrow('contention');
    await meter.chargeOnce('owner-once', 1, 'evt-1');
    await meter.chargeOnce('owner-once', 1, 'evt-1');
    expect((await meter.balance('owner-once')).spentMicros).toBe(CREDIT_MICROS);
  });

  it('falls back to the Gemini API OpenAI-compat endpoint on Vertex 429/503/timeout before first byte and still records cost', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-fb', ownerId: 'owner-fb' });
    const bodies: Record<string, unknown>[] = [];
    let attempt = 0;
    const answer = (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body!.toString()));
      if (url.startsWith('https://aiplatform.googleapis.com/')) {
        attempt++;
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: { code: 429, message: 'Vertex rate limit' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (attempt === 2) {
          return new Response(JSON.stringify({ error: { code: 503, message: 'Vertex unavailable' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      const last = JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } } });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fallback answer' } }] })}\n\ndata: ${last}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const p = await proxy(meter, answer, { hedgeMs: 500, timeoutMs: 30, fallbackApiKey: 'AIzaSyTestFallbackKey' });
    const port = new URL(p.base).port;
    const res429 = await fetch(`http://127.0.0.1:${port}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-anything', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res429.status).toBe(200);
    const text429 = await res429.text();
    expect(text429).toContain('fallback answer');
    expect(text429).toContain('[DONE]');
    expect(p.seen).toEqual([
      {
        url: 'https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi/chat/completions',
        auth: 'Bearer ya29.hub',
      },
      {
        url: GEMINI_OPENAI_FALLBACK_URL,
        auth: 'Bearer AIzaSyTestFallbackKey',
      },
    ]);
    expect(bodies[0]).toMatchObject({ model: 'google/gemini-test', stream_options: { include_usage: true } });
    expect(bodies[1]).toMatchObject({ model: DEFAULT_GEMINI_FALLBACK_MODEL, stream_options: { include_usage: true } });
    const oneCallShare = AI_MARKUP * (2 * (300 + 0.25 * 100) + 12 * 50) / 1_000_000;
    await expect.poll(() => meter.used('owner-fb'), { timeout: 15_000 }).toBeCloseTo(oneCallShare, 6);

    p.close();
    const p2 = await proxy(meter, answer, { hedgeMs: 500, timeoutMs: 30, fallbackApiKey: 'AIzaSyTestFallbackKey', fallbackModel: 'gemini-2.5-pro' });
    const port2 = new URL(p2.base).port;
    const res503 = await fetch(`http://127.0.0.1:${port2}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-anything', stream: true, messages: [{ role: 'user', content: 'hello 2' }] }),
    });
    expect(res503.status).toBe(200);
    expect(bodies[3]).toMatchObject({ model: 'gemini-2.5-pro', stream_options: { include_usage: true } });
    await expect.poll(() => meter.used('owner-fb'), { timeout: 15_000 }).toBeCloseTo(2 * oneCallShare, 6);

    const resTimeout = await fetch(`http://127.0.0.1:${port2}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-anything', stream: true, messages: [{ role: 'user', content: 'hello 3' }] }),
    });
    expect(resTimeout.status).toBe(200);
    await expect.poll(() => meter.used('owner-fb'), { timeout: 15_000 }).toBeCloseTo(3 * oneCallShare, 6);
    p2.close();
  });

  it('surfaces the original Vertex error when the Gemini API fallback also fails', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-fb-fail', ownerId: 'owner-fb-fail' });
    const vertexErrorBody = JSON.stringify({ error: { code: 429, message: 'Original Vertex quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
    const p = await proxy(meter, (url) => {
      if (url === GEMINI_OPENAI_FALLBACK_URL) {
        return new Response(JSON.stringify({ error: { code: 500, message: 'Fallback internal error' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(vertexErrorBody, { status: 429, headers: { 'content-type': 'application/json' } });
    }, { fallbackApiKey: 'AIzaSyTestFallbackKey' });
    const port = new URL(p.base).port;
    const res = await fetch(`http://127.0.0.1:${port}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-anything', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(vertexErrorBody);
    expect(p.seen).toHaveLength(2);
    expect(await meter.used('owner-fb-fail')).toBe(0);
    p.close();

    // Double failure on pre-first-byte timeout/network rejection -> rethrows original error (502 UNAVAILABLE).
    const pTimeout = await proxy(meter, () => Promise.reject(new Error('network timeout')), { fallbackApiKey: 'AIzaSyTestFallbackKey' });
    const portTimeout = new URL(pTimeout.base).port;
    const resTimeout = await fetch(`http://127.0.0.1:${portTimeout}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-anything', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(resTimeout.status).toBe(502);
    expect(((await resTimeout.json()) as { error: { status: string } }).error.status).toBe('UNAVAILABLE');
    expect(pTimeout.seen).toHaveLength(2);
    pTimeout.close();
  });

  it('does not call the Gemini API fallback when GEMINI_FALLBACK_API_KEY is unset', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-no-fb', ownerId: 'owner-no-fb' });
    const vertexErrorBody = JSON.stringify({ error: { code: 429, message: 'Vertex 429 no fallback' } });
    const p = await proxy(meter, () => new Response(vertexErrorBody, { status: 429, headers: { 'content-type': 'application/json' } }));
    const port = new URL(p.base).port;
    const res = await fetch(`http://127.0.0.1:${port}/llm/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-anything', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(vertexErrorBody);
    expect(p.seen).toEqual([
      {
        url: 'https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi/chat/completions',
        auth: 'Bearer ya29.hub',
      },
    ]);
    p.close();
  });

  it('defaults timeoutMs to 25s when fallback is set and timeoutMs is unset, failing over on a pre-first-byte hang', async () => {
    const meter = new LlmMeter(testDb(), 1_000_000);
    const key = await meter.mint({ id: 'agent-hang-default', ownerId: 'owner-hang-default' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let abortedCount = 0;
      const p = await proxy(
        meter,
        (url, init) => {
          if (url.startsWith('https://aiplatform.googleapis.com/')) {
            return new Promise<Response>((_, reject) =>
              init.signal!.addEventListener('abort', () => {
                abortedCount++;
                reject(new Error('aborted'));
              }),
            );
          }
          const last = JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'recovered from default 25s timeout' } }] })}\n\ndata: ${last}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        },
        // Explicitly leave timeoutMs unset while fallbackApiKey is set:
        { fallbackApiKey: 'AIzaSyDefaultTimeoutKey' },
      );
      const port = new URL(p.base).port;
      const resPromise = fetch(`http://127.0.0.1:${port}/llm/openai/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-anything', stream: true, messages: [{ role: 'user', content: 'hang' }] }),
      });
      await expect.poll(() => p.seen.length).toBe(1);
      // Advance past hedgeMs (8000ms) -> launches second Vertex attempt.
      await vi.advanceTimersByTimeAsync(8_000);
      await expect.poll(() => p.seen.length).toBe(2);
      // Advance remaining 17_000ms to hit the 25_000ms default timeoutMs -> aborts both Vertex calls and fails over to Gemini.
      await vi.advanceTimersByTimeAsync(17_000);
      const res = await resPromise;
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('recovered from default 25s timeout');
      expect(abortedCount).toBe(2);
      expect(p.seen).toHaveLength(3);
      expect(p.seen[2]).toEqual({
        url: GEMINI_OPENAI_FALLBACK_URL,
        auth: 'Bearer AIzaSyDefaultTimeoutKey',
      });
      p.close();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('fallback diagnostics', () => {
    const FB_KEY = 'AIzaSyDiagnosticsFallbackKey';
    const PROMPT = 'PROMPT-SENTINEL-do-not-log';
    const FAST = { fallbackApiKey: FB_KEY, timeoutMs: 100, hedgeMs: 5000 };
    const isFallback = (url: string) => url === GEMINI_OPENAI_FALLBACK_URL;
    let spies: ReturnType<typeof vi.spyOn>[];
    /** Everything logged at any level, as one string. */
    const logs = () => spies.flatMap((s) => s.mock.calls.flat().map((a: unknown) => (a instanceof Error ? `${a.stack}` : String(a)))).join('\n');
    /** The structured per-call line. */
    const callLines = () => logs().split('\n').filter((l) => l.startsWith('llm call ')).map((l) => JSON.parse(l.slice('llm call '.length)));

    /** One chat call through a fresh proxy; the deadline keeps a hung proxy a failure, not a stuck run. */
    async function chat(answer: Parameters<typeof proxy>[1], opts: Parameters<typeof proxy>[2], stream = false, messages: object[] = [{ role: 'user', content: PROMPT }]) {
      const meter = new LlmMeter(testDb(), 1_000_000);
      const key = await meter.mint({ id: 'agent-diag', ownerId: 'owner-diag' });
      const p = await proxy(meter, answer, opts);
      try {
        const res = await fetch(`http://127.0.0.1:${new URL(p.base).port}/llm/openai/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ stream, messages }),
          signal: AbortSignal.timeout(2000),
        });
        const text = await res.text();
        for (const secret of [PROMPT, FB_KEY, key, 'ya29.hub']) expect(logs()).not.toContain(secret);
        return { status: res.status, text, seen: p.seen };
      } finally {
        p.close();
      }
    }

    beforeEach(() => {
      spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    });
    afterEach(() => spies.forEach((s) => s.mockRestore()));

    it('logs the status and a bounded excerpt of a non-ok fallback, never the key it echoes', async () => {
      const r = await chat((url) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        return new Response(`{"error":"Fallback quota for ${FB_KEY}"}${'x'.repeat(400)}PAST-THE-EXCERPT`, { status: 403 });
      }, FAST);
      expect(r.status).toBe(502);
      expect(logs()).toMatch(/llm fallback not ok.*403/);
      expect(logs()).toContain('Fallback quota for');
      expect(logs()).not.toContain('x'.repeat(300));
      expect(logs()).not.toContain('PAST-THE-EXCERPT');
    });

    it('logs a non-ok fallback past a first chunk of just "["', async () => {
      await chat((url) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        const bytes = ['[', '{"error":{"message":"Corrupted thought signature."}}]'].map((c) => new TextEncoder().encode(c));
        return new Response(new ReadableStream({ pull: (ctl) => { const b = bytes.shift(); if (b) ctl.enqueue(b); else ctl.close(); } }), { status: 400 });
      }, FAST);
      expect(logs()).toContain('Corrupted thought signature.');
    });

    it('sends the fallback no Vertex thought signature, and Vertex its own', async () => {
      const bodies: Record<string, string> = {};
      const sig = () => ({ google: { thought_signature: 'VERTEX-SIG' } });
      const signed = [
        { role: 'assistant', extra_content: sig(), tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: sig() }] },
        { role: 'assistant', tool_calls: 'malformed' },
      ];
      await chat((url, init) => {
        bodies[isFallback(url) ? 'fallback' : 'vertex'] = String(init.body);
        return isFallback(url) ? new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'SECRET-ANSWER' } }] })) : Promise.reject(new Error('vertex down'));
      }, FAST, false, signed);
      expect(bodies.vertex).toContain('VERTEX-SIG');
      expect(bodies.fallback).not.toContain('VERTEX-SIG');
      const [first] = JSON.parse(bodies.fallback!).messages;
      expect(first.extra_content.google.thought_signature).toBe('skip_thought_signature_validator');
      expect(first.tool_calls[0].extra_content.google.thought_signature).toBe('skip_thought_signature_validator');
      expect(logs()).not.toContain('SECRET-ANSWER');
    });

    const signed = [{ role: 'assistant', extra_content: { google: { thought_signature: 'FOREIGN-SIG' } } }, { role: 'user', content: PROMPT }];
    const refusal = (message: string) => {
      const chunks = ['[', JSON.stringify({ error: { code: 400, message } }), ']'].map((c) => new TextEncoder().encode(c));
      return new Response(new ReadableStream({ start: (ctl) => { chunks.forEach((c) => ctl.enqueue(c)); ctl.close(); } }), { status: 400 });
    };

    it('resends once with skip signatures when Vertex refuses a signature, even if it refuses again', async () => {
      const sent: string[] = [];
      const again = await chat((_url, init) => {
        sent.push(String(init.body));
        return refusal('Invalid thought signature.');
      }, FAST, false, signed);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('FOREIGN-SIG');
      expect(sent[1]).not.toContain('FOREIGN-SIG');
      expect(JSON.parse(sent[1]!).messages[0].extra_content.google.thought_signature).toBe('skip_thought_signature_validator');
      expect(again.status).toBe(400);

      const ok = await chat((_url, init) => (String(init.body).includes('FOREIGN-SIG') ? refusal('Invalid thought signature.') : new Response('{"answer":1}')), FAST, false, signed);
      expect(ok.status).toBe(200);
      expect(ok.text).toBe('{"answer":1}');
    });

    it('passes any other 400 on whole, without a resend', async () => {
      let calls = 0;
      const { status, text } = await chat(() => {
        calls++;
        return refusal('Invalid image.');
      }, FAST, false, signed);
      expect(calls).toBe(1);
      expect(status).toBe(400);
      expect(text).toContain('Invalid image.');
    });

    it('resends past a refusal whose body then stalls', async () => {
      const stalled = (text: string) => new Response(new ReadableStream({ start: (ctl) => ctl.enqueue(new TextEncoder().encode(text)) }), { status: 400 });
      const sent: string[] = [];
      const { status } = await chat((_url, init) => {
        sent.push(String(init.body));
        return sent.length === 1 ? stalled(JSON.stringify({ error: { message: 'Invalid thought signature.' } })) : new Response('{"answer":1}');
      }, FAST, false, signed);
      expect(sent).toHaveLength(2);
      expect(status).toBe(200);
    });

    it('gives up on a 400 that stalls before its error is whole, passing on what came', async () => {
      let calls = 0;
      const { status, text } = await chat(() => {
        calls++;
        return new Response(new ReadableStream({ start: (ctl) => ctl.enqueue(new TextEncoder().encode('[{"error":{"mess')) }), { status: 400 });
      }, FAST, false, signed);
      expect(calls).toBe(1);
      expect(status).toBe(400);
      expect(text).toBe('[{"error":{"mess');
    });

    it('goes by the error message, not the phrase elsewhere in the body', async () => {
      let calls = 0;
      const body = JSON.stringify([{ error: { message: 'Invalid image.', details: ['Invalid thought signature.'] } }]);
      const { status, text } = await chat(() => {
        calls++;
        return new Response(body, { status: 400 });
      }, FAST, false, signed);
      expect(calls).toBe(1);
      expect(status).toBe(400);
      expect(text).toBe(body);
    });

    it('does not crash on a 400 with no body', async () => {
      const { status } = await chat(() => new Response(null, { status: 400 }), FAST, false, signed);
      expect(status).toBe(400);
    });

    it('logs only the bounded message of a Vertex 400, array-wrapped and in any chunks', async () => {
      const body = JSON.stringify([{ error: { code: 400, message: `Requests ending with a "model" turn. ${'x'.repeat(400)}`, status: 'INVALID_ARGUMENT', details: [PROMPT] } }]);
      const r = await chat(() => new Response(new ReadableStream({
        start(c) {
          for (const part of [body.slice(0, 1), body.slice(1)]) c.enqueue(new TextEncoder().encode(part));
          c.close();
        },
      }), { status: 400 }), FAST, false, [{ role: 'user', content: PROMPT }, { role: 'assistant', tool_calls: [{ id: 'c1' }] }]);
      expect(r.status).toBe(400);
      expect(r.text).toBe(body);
      const line = logs().split('\n').find((l) => l.startsWith('llm vertex 400 '))!;
      expect(line).toContain('Requests ending with a \\\\\\"model\\\\\\" turn.');
      expect(line.endsWith('["user","assistant+1calls"]')).toBe(true);
      expect(line.length).toBeLessThan(380);
    });

    it('keeps a tool parameter named thought_signature intact for the fallback', async () => {
      const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { thought_signature: { type: 'string' } } } } }];
      let sent = '';
      const meter = new LlmMeter(testDb(), 1_000_000);
      const key = await meter.mint({ id: 'agent-diag', ownerId: 'owner-diag' });
      const p = await proxy(meter, (url, init) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        sent = String(init.body);
        return new Response('{}');
      }, FAST);
      await fetch(`http://127.0.0.1:${new URL(p.base).port}/llm/openai/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tools, messages: [{ role: 'user', content: PROMPT }] }),
        signal: AbortSignal.timeout(2000),
      }).then((r) => r.text()).finally(() => p.close());
      expect(JSON.parse(sent).tools).toEqual(tools);
    });

    it('stops reading a fallback error once the excerpt is full, even if the body then stalls', async () => {
      let reads = 0;
      let cancelled = false;
      const { status } = await chat((url) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        return new Response(new ReadableStream({
          pull(ctl) {
            if (++reads === 1) ctl.enqueue(new TextEncoder().encode('x'.repeat(300)));
            else return new Promise<void>(() => {});
          },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }), { status: 400 });
      }, { ...FAST, timeoutMs: 800 });
      expect(status).toBe(502);
      expect(reads).toBe(1);
      expect(cancelled).toBe(true);
    });

    it('logs a thrown fallback with its cause', async () => {
      const r = await chat((url) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        return Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }));
      }, FAST);
      expect(r.status).toBe(502);
      expect(logs()).toMatch(/llm fallback failed.*fetch failed.*ECONNRESET/);
    });

    it('gives up on a fallback fetch that hangs, aborting it, and ends in the 502', async () => {
      let signal: AbortSignal | undefined;
      const r = await chat((url, init) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      }, FAST, true);
      expect(r.status).toBe(502);
      expect(signal?.aborted).toBe(true);
      expect(logs()).toMatch(/llm fallback failed.*timed out after 100ms/);
    });

    it('gives up on a fallback whose first read hangs, and ends in the 502', async () => {
      const r = await chat((url) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        return new Response(new ReadableStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }, FAST, true);
      expect(r.status).toBe(502);
      expect(logs()).toMatch(/llm fallback failed.*timed out after 100ms/);
    });

    it('gives a stream:false fallback longer, since its first byte comes when the whole answer is done', async () => {
      const r = await chat(async (url) => {
        if (!isFallback(url)) throw new Error('vertex down');
        await new Promise((d) => setTimeout(d, 150));
        return new Response('{"choices":[{"message":{"content":"slow answer"}}]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }, FAST);
      expect(r.status).toBe(200);
      expect(r.text).toContain('slow answer');
    });

    it('still gives up on a stream:false fallback that hangs', async () => {
      const r = await chat((url) => (isFallback(url) ? new Promise<Response>(() => {}) : Promise.reject(new Error('vertex down'))), FAST);
      expect(r.status).toBe(502);
      expect(logs()).toMatch(/llm fallback failed.*timed out after 200ms/);
    });

    it('still reports a non-ok fallback whose error body hangs, and ends in the 502', async () => {
      const r = await chat((url) => {
        if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
        return new Response(new ReadableStream(), { status: 500 });
      }, FAST);
      expect(r.status).toBe(502);
      expect(logs()).toMatch(/llm fallback not ok.*500/);
    });

    it('leaves a healthy fallback stream running past the first-byte deadline', async () => {
      const r = await chat(
        (url, init) => {
          if (!isFallback(url)) return Promise.reject(new Error('vertex down'));
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              const enc = new TextEncoder();
              // As a real fetch does: an abort after the headers errors the body.
              init.signal?.addEventListener('abort', () => c.error(new Error('stream aborted')));
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"start"}}]}\n\n'));
              setTimeout(() => {
                if (init.signal?.aborted) return;
                c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"finish"}}]}\n\ndata: [DONE]\n\n'));
                c.close();
              }, 300);
            },
          });
          return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        },
        FAST,
        true,
      );
      expect(r.status).toBe(200);
      expect(r.text).toContain('finish');
    });

    it('logs which backend answered, for each kind of call', async () => {
      let sent = 0;
      await chat((_, init) => {
        sent = (init.body as Buffer).length;
        return new Response('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}', { status: 200, headers: { 'content-type': 'application/json' } });
      }, FAST);
      await chat((url) => {
        if (!isFallback(url)) return new Response('busy', { status: 503 });
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }, FAST, true);
      await chat((url) => Promise.reject(new Error(isFallback(url) ? 'fallback down' : 'vertex down')), FAST);
      await chat(() => new Response('busy', { status: 503 }), { retryMs: [] });
      await chat(() => Promise.reject(new Error('vertex down')), {});

      const meter = new LlmMeter(testDb(), 1_000_000);
      const p = await proxy(meter, () => new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      await (await p.call(await meter.mint({ id: 'agent-diag', ownerId: 'owner-diag' }), '/v1/models/x:streamGenerateContent')).text();
      p.close();

      const lines = callLines();
      expect(lines).toMatchObject([
        { backend: 'vertex', status: 200, stream: false, requestBytes: sent },
        { backend: 'fallback', status: 200, stream: true },
        { backend: 'none', stream: false },
        { backend: 'vertex', status: 503, stream: false },
        { backend: 'none', stream: false },
        { backend: 'vertex', status: 200, stream: true },
      ]);
      for (const l of lines) expect(l.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('hiring an agent', () => {
  it('makes a hosted bot of the person, with a working proxy key, that greets them in their DM', async () => {
    const { createHub } = await import('../src/app.js');
    const { crew, testConfig } = await import('./helpers.js');
    const { unseal } = await import('../src/lib/sealing.js');
    const key = Buffer.alloc(32, 7);
    const hub = createHub({ db: testDb(), config: testConfig({ vertex: VERTEX, credentialsKey: key }) });
    const { owner, workspace } = await crew(hub.registry, 'hire', []);
    // An agent with its own computer is Pro.
    await expect(hub.hire(owner, 'Atlas', workspace.id)).rejects.toThrow(/part of Pro/);
    await hub.billing.setPlan(owner.id, { plan: 'pro' });
    const agent = await hub.hire(owner, '  Atlas ', workspace.id);
    expect((await hub.registry.get(agent.id))!.workspaces).toContain(workspace.id);
    expect(agent).toMatchObject({ name: 'Atlas', ownerId: owner.id, wake: { type: 'computer' } });
    const stored = (await hub.registry.get(agent.id))!;
    const secrets = JSON.parse(unseal(stored.hosted!.sealed!, key)) as { token: string; llmKey: string };
    expect(await hub.llm.resolve(secrets.llmKey)).toEqual({ agentId: agent.id, ownerId: owner.id });
    const dm = await hub.chat.page(owner, `agent:${agent.id}`, 10);
    expect(dm.messages.map((m) => m.fromId)).toEqual([agent.id]);
    expect(dm.messages[0]!.parts[0]!.text).toMatch(/^Hi, I'm Atlas\./);

    await expect(hub.hire(owner, ' ')).rejects.toThrow(/name/);
    await expect(hub.hire(owner, 'Ghost', 'not-mine')).rejects.toThrow(/No workspace/);
    await expect(createHub({ db: testDb(), config: testConfig() }).hire(owner, 'x')).rejects.toThrow(/doesn't host/);
  });

  it('deduplicates same-name hosted agent hires (idempotent on double-submit) while allowing re-hire after archiving', async () => {
    const { createHub } = await import('../src/app.js');
    const { crew, testConfig } = await import('./helpers.js');
    const { readFileSync } = await import('node:fs');
    const hub = createHub({ db: testDb(), config: testConfig({ vertex: VERTEX }) });
    const { owner, workspace } = await crew(hub.registry, 'hire-dedup', []);
    const secondWs = await hub.registry.createWorkspace(owner, 'hire-dedup-2');
    const freshOwner = (await hub.registry.get(owner.id))!;
    await hub.billing.setPlan(freshOwner.id, { plan: 'pro' });

    // Concurrent + sequential hires for the same trimmed name return the exact same hosted agent (no duplicate Compi4s).
    const [first, concurrent] = await Promise.all([
      hub.hire(freshOwner, 'Compi4', workspace.id),
      hub.hire(freshOwner, '  compi4  ', workspace.id),
    ]);
    expect(concurrent.id).toBe(first.id);

    // A subsequent call with another workspace adds the existing agent to that workspace instead of creating a duplicate.
    const second = await hub.hire(freshOwner, 'Scout', workspace.id);
    expect(second.id).not.toBe(first.id);
    const repeatInSecondWs = await hub.hire(freshOwner, 'Compi4', secondWs.id);
    expect(repeatInSecondWs.id).toBe(first.id);
    expect((await hub.registry.get(first.id))!.workspaces).toEqual(expect.arrayContaining([workspace.id, secondWs.id]));

    const bots = (await hub.registry.botsOf(freshOwner)).filter((b) => b.hosted && !b.archived);
    expect(bots.map((b) => b.id)).toEqual([first.id, second.id]);

    // Only one greeting DM was sent by Compi4.
    const dm = await hub.chat.page(freshOwner, `agent:${first.id}`, 10);
    expect(dm.messages).toHaveLength(1);

    // Archiving Compi4 frees the slot and allows hiring a fresh Compi4.
    await hub.registry.setArchived(freshOwner, first.id, true);
    const rehired = await hub.hire(freshOwner, 'Compi4', workspace.id);
    expect(rehired.id).not.toBe(first.id);

    // Client form disables the submit button while pending via useFormStatus().pending.
    const dialogSrc = readFileSync(new URL('../web/components/HireAgentDialog.tsx', import.meta.url), 'utf8');
    expect(dialogSrc).toContain('useFormStatus');
    expect(dialogSrc).toContain('disabled={pending}');
  });
});

describe('hiring caps', () => {
  it("refuses a hire into a full workspace before making the agent, but not for super admins", async () => {
    const { createHub } = await import('../src/app.js');
    const { testConfig, testPerson } = await import('./helpers.js');
    const hub = createHub({ db: testDb(), config: testConfig({ vertex: VERTEX, cloudAgents: VERTEX }) });
    const person = await testPerson(hub.registry, 'Capped');
    const admin = await testPerson(hub.registry, 'Admin');
    const ws = await hub.registry.createWorkspace(person, 'capped-ws');
    await hub.billing.setPlan(person.id, { plan: 'pro', maxParticipants: 1 });
    await expect(hub.hire(person, 'One too many', ws.id)).rejects.toThrow(/This workspace has 1 of 1 participants on the Pro plan/);
    expect(await hub.registry.botsOf(person)).toHaveLength(0);
    const before = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = admin.email;
    try {
      const adminWs = await hub.registry.createWorkspace(admin, 'admin-ws');
      await hub.billing.setPlan(admin.id, { plan: 'free', maxParticipants: 1 });
      await hub.hire(admin, 'B0', adminWs.id);
    } finally {
      process.env.SUPER_ADMIN_EMAILS = before;
    }
  });
});
