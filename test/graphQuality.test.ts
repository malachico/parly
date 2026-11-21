import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRAPH_SCHEMA, type ExtractedDecision, graphPrompt, parseGraphExtraction } from '../src/graph/extract.js';
import { generate } from '../src/lib/vertex.js';

interface Expected { words: string[]; people?: string[]; replaces?: number }
interface Case { name: string; earlier?: string[]; messages: [string, string][]; expect: Expected[]; extra?: number }

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/graph-quality.json', import.meta.url), 'utf8')) as { cases: Case[] };
const msgs = (c: Case) => c.messages.map(([from, text]) => ({ from, parts: [{ kind: 'text' as const, text }] }));

/** Whether the model's decisions satisfy the hand labels (see the fixture's `_doc`). */
function casePasses(c: Case, got: ExtractedDecision[]): boolean {
  if (got.length < c.expect.length || got.length > c.expect.length + (c.extra ?? 0)) return false; // one merged decision can't stand for two
  return c.expect.every((e) => got.some((d) => {
    const hay = `${d.title} ${d.text}`.toLowerCase();
    const people = d.people.map((p) => p.toLowerCase());
    return e.words.every((w) => hay.includes(w.toLowerCase()))
      && (e.people ?? []).every((p) => people.includes(p.toLowerCase()))
      && (e.replaces === undefined || d.replaces === e.replaces);
  }));
}

describe('graph extraction quality fixture', () => {
  it('is well formed', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect(c.messages.length, c.name).toBeGreaterThan(0);
      for (const e of c.expect) if (e.replaces !== undefined) {
        expect(e.replaces, c.name).toBeGreaterThanOrEqual(1);
        expect(e.replaces, c.name).toBeLessThanOrEqual(c.earlier?.length ?? 0);
      }
    }
  });

  it('prompt numbers earlier decisions and lists every message', () => {
    const first = cases[0]!;
    const p = graphPrompt(msgs(first), [{ title: 'Use Postgres' }, { title: 'Ship Friday' }]);
    expect(p).toContain('1. Use Postgres\n2. Ship Friday');
    for (const [from] of first.messages) expect(p).toContain(`${from}: `);
    expect(graphPrompt(msgs(first), [])).not.toContain('Earlier decisions');
  });

  it('scorer: words, people, replaces and the decision budget', () => {
    const c: Case = { name: 't', messages: [['A', 'x']], expect: [{ words: ['monday'], people: ['Bo'], replaces: 1 }] };
    const d = { title: 'Ship Monday', text: '', people: ['bo'], topics: [], replaces: 1 };
    expect(casePasses(c, [d])).toBe(true);
    expect(casePasses(c, [{ ...d, replaces: undefined }])).toBe(false);
    expect(casePasses(c, [d, d])).toBe(false);
    expect(casePasses({ ...c, expect: [c.expect[0]!, c.expect[0]!] }, [d])).toBe(false);
    expect(casePasses({ ...c, expect: [] }, [])).toBe(true);
  });

  // Live: GRAPH_QUALITY=1 VERTEX_PROJECT=<project> npx vitest run --project pure test/graphQuality.test.ts (needs gcloud ADC).
  it.skipIf(!process.env.GRAPH_QUALITY)('the model passes at least 80% of the cases', async () => {
    const project = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('set VERTEX_PROJECT');
    const results = await Promise.all(cases.map(async (c) => {
      const out = await generate({
        project, location: 'global', model: process.env.GRAPH_MODEL || 'gemini-3.5-flash-lite',
        prompt: graphPrompt(msgs(c), (c.earlier ?? []).map((title) => ({ title }))), thinkingLevel: 'low', timeoutMs: 30_000, schema: GRAPH_SCHEMA,
      });
      // A failed or unparseable answer fails the case; scored as no decisions it would pass the empty ones.
      let valid = out.ok;
      if (out.ok) try { JSON.parse(out.text); } catch { valid = false; }
      const got = valid && out.ok ? parseGraphExtraction(out.text) : [];
      const ok = valid && casePasses(c, got);
      if (!ok) console.log(`FAIL ${c.name}:`, out.ok ? JSON.stringify(got) : `HTTP ${out.status}`);
      return ok;
    }));
    const passed = results.filter(Boolean).length;
    console.log(`graph quality: ${passed}/${cases.length}`);
    expect(passed / cases.length).toBeGreaterThanOrEqual(0.8);
  }, 120_000);
});
