import { describe, expect, it } from 'vitest';
import { decisionsRouter } from '../src/chat/router.js';

describe('decisionsRouter', () => {
  it('wakes every agent it answers yes for, and everyone when it fails', async () => {
    let body: { model: string; input: string; questions: Record<string, { type: string }> } | undefined;
    let next = () => new Response(JSON.stringify({ answers: { a0: { type: 'noul', noul: 0.9 }, a1: { type: 'noul', noul: 0.1 }, a2: { type: 'noul', noul: 0.7 } } }));
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return next();
    }) as unknown as typeof fetch;
    const route = decisionsRouter({ apiKey: 'k', model: 'gemini-decision-1', fetchImpl });
    const cands = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() }));
    expect(await route('plan and ship it', cands)).toEqual(['a', 'c']);
    expect(body!.model).toBe('gemini-decision-1');
    expect(Object.values(body!.questions).map((q) => q.type)).toEqual(['noul', 'noul', 'noul']);
    expect(body!.input).toContain('Message: plan and ship it');
    next = () => new Response('{"error":{"code":"safety"}}', { status: 400 });
    expect(await route('hi', cands)).toBeUndefined();
  });
});
