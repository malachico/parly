import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { vertexAgentRanker } from '../src/apps/appAgents.js';
import { testConfig, testDb } from './helpers.js';

async function setup() {
  const { app, hub } = createApp({ db: testDb(), config: testConfig() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, key: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
  };
  const owner = await hub.registry.signInWithGoogle('dev:maker@talent.test');
  const ws = await hub.registry.createWorkspace(owner.agent, 'Talent');
  const { key } = await hub.apps.create(owner.agent, ws.id, { name: 'Talent' });
  const seen: string[] = [];
  hub.agentRanker = async (query, cards) => {
    seen.push(JSON.stringify({ query, cards }));
    return { ranked: cards.map((c, i) => ({ key: c.key, score: c.card.includes('Go') ? 90 - i : 30, why: `fits: ${c.card.slice(0, 10)}` })).sort((a, b) => b.score - a.score), usage: { promptTokenCount: 1000, candidatesTokenCount: 100 } };
  };
  hub.vertexPrices = { input: 0.3, output: 2.5 };
  return { hub, call, owner, key, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('/v1/agents', () => {
  it('search ranks listed agents by card only; unlisted and excluded ones never come back; instructions never leave', async () => {
    const { call, key, seen, close } = await setup();
    try {
      const put = (k: string, card: string, listed: boolean) => call(`/v1/agents/${k}`, key, { method: 'PUT', body: { name: `Candidate #${k}`, instructions: `PRIVATE-${k} minimum 200k`, card, listed } });
      expect((await put('c-aaaa', 'Senior Go engineer, payments', true)).status).toBe(201);
      expect((await put('c-bbbb', 'Frontend React developer', true)).status).toBe(201);
      expect((await put('c-cccc', 'Go and Kubernetes', false)).status).toBe(201);
      expect((await put('c-dddd', 'Staff Go engineer', true)).status).toBe(201);
      expect((await put('c-aaaa', 'Senior Go engineer, payments, 8 years', true)).status).toBe(200);

      const found = await call('/v1/agents/search', key, { method: 'POST', body: { query: 'backend Go', exclude: ['c-dddd'], limit: 5 } });
      expect(found.status).toBe(200);
      expect(found.body.results.map((r: any) => r.key)).toEqual(['c-aaaa', 'c-bbbb']);
      expect(found.body.results[0]).toMatchObject({ name: 'Candidate #c-aaaa', card: 'Senior Go engineer, payments, 8 years', score: 90 });
      expect(JSON.stringify(found.body)).not.toMatch(/PRIVATE/);
      expect(seen.join()).not.toMatch(/PRIVATE/);
      expect(seen.join()).not.toMatch(/c-cccc|Kubernetes/);

      expect((await call('/v1/agents/c-bbbb', key, { method: 'DELETE' })).status).toBe(200);
      expect((await call('/v1/agents/search', key, { method: 'POST', body: { query: 'React' } })).body.results.map((r: any) => r.key)).not.toContain('c-bbbb');
      expect((await call('/v1/agents/c-bbbb', key, { method: 'DELETE' })).status).toBe(404);
      expect((await call('/v1/agents/search', key, { method: 'POST', body: { query: '' } })).status).toBe(400);
      expect((await call('/v1/agents/x', key, { method: 'PUT', body: { name: 'x', instructions: 'y', card: 5 } })).status).toBe(400);
    } finally { await close(); }
  });

  it("another app can't search, open rooms with or delete these agents", async () => {
    const { hub, call, owner, key, close } = await setup();
    try {
      await call('/v1/agents/c-aaaa', key, { method: 'PUT', body: { name: 'Candidate #a', instructions: 'PRIVATE', card: 'Go engineer', listed: true } });
      const other = await hub.apps.create(owner.agent, (await hub.registry.createWorkspace(owner.agent, 'Other')).id, { name: 'Other' });
      await call('/v1/agents/hiring', other.key, { method: 'PUT', body: { name: 'Hiring', instructions: 'Hire.' } });
      expect((await call('/v1/agents/search', other.key, { method: 'POST', body: { query: 'Go' } })).body.results).toEqual([]);
      expect((await call('/v1/agents/c-aaaa', other.key, { method: 'DELETE' })).status).toBe(404);
      const room = { goal: 'Fit', sides: [{ ref: 'co', name: 'Hiring', brief: '', agent: 'hiring' }, { ref: 'ca', name: 'Candidate', brief: '', agent: 'c-aaaa' }] };
      expect((await call('/v1/rooms', other.key, { method: 'POST', body: room })).status).toBe(400);
    } finally { await close(); }
  });

  it('a Vertex timeout (generate rejects) surfaces as "unavailable", not a raw 500', async () => {
    const rank = vertexAgentRanker({
      project: 'p', location: 'global', model: 'm',
      accessToken: async () => 'tok',
      fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); },
    });
    await expect(rank('Go engineer', [{ key: 'c-aaaa', card: 'Senior Go engineer' }]))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it("a room side opened with an app's own agent gets a private copy of its instructions", async () => {
    const { hub, call, key, close } = await setup();
    try {
      await call('/v1/agents/c-aaaa', key, { method: 'PUT', body: { name: 'Candidate #a', instructions: 'CANDIDATE-OWN minimum 200k', card: 'Go engineer', listed: true } });
      await call('/v1/agents', key, { method: 'POST', body: { key: 'hiring', name: 'Hiring team', instructions: 'Hire well.' } });
      const made = await call('/v1/rooms', key, { method: 'POST', body: { goal: 'Fit', sides: [{ ref: 'co', name: 'Hiring team', brief: 'band 180k', agent: 'hiring' }, { ref: 'ca', name: 'Candidate #a', brief: '', agent: 'c-aaaa' }] } });
      expect(made.status).toBe(201);
      const info = (await hub.registry.workspaceById(made.body.id))!.room!;
      const copy = (await hub.registry.get(info.sides[1]!.agents![0]!))!;
      expect(copy.description).toBe('CANDIDATE-OWN minimum 200k');
      expect((await hub.registry.get(info.sides[0]!.agents![0]!))!.description).toBe('Hire well.');
    } finally { await close(); }
  });
});
