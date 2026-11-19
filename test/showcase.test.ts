import { describe, expect, it } from 'vitest';
import { LlmMeter } from '../src/llm/llm.js';
import { CREDIT_MICROS } from '../src/billing/billing.js';
import { createHub } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { isShowcaseJudge, runShowcaseCloudTool, _fetchUrlForTest } from '../src/hub/showcase.js';
import { crew, testConfig, testDb } from './helpers.js';

const JUDGE = 'judge-agent-id';
const OWNER = 'judge-owner-id';

async function person(db: ReturnType<typeof testDb>, id: string, kind = 'human', archived = false) {
  await db.collection('agents').doc(id).set({ id, kind, ...(archived ? { archived: true } : {}) });
}
const award = (meter: LlmMeter, over: Partial<Parameters<LlmMeter['awardShowcaseCredits']>[0]> = {}) =>
  meter.awardShowcaseCredits({ poolId: 'default', poolCredits: 10_000, recipientId: 'visitor', amount: 5, ceiling: 50, key: 'k1', judgeId: JUDGE, judgeOwnerId: OWNER, ...over });

describe('awardShowcaseCredits (money path)', () => {
  it('grants credits, decrements the shared pool, and tops up the recipient billing', async () => {
    const db = testDb();
    await person(db, 'visitor');
    const meter = new LlmMeter(db, 5_000_000);
    const res = await award(meter, { amount: 5 });
    expect(res).toMatchObject({ ok: true, awarded: 5, recipientTotal: 5, poolRemaining: 9_995 });
    const billing = (await db.collection('billing').doc('visitor').get()).data();
    expect(billing?.extraMicros).toBe(5 * CREDIT_MICROS);
    expect((await db.collection('showcasePools').doc('default').get()).data()?.remaining).toBe(9_995);
  });

  it('rejects amounts outside 1..10 before touching the pool', async () => {
    const db = testDb();
    await person(db, 'visitor');
    const meter = new LlmMeter(db, 5_000_000);
    for (const amount of [0, 11, 101, 1.5, -5, Number.NaN]) {
      expect(await award(meter, { amount })).toMatchObject({ ok: false });
    }
    expect((await db.collection('showcasePools').doc('default').get()).exists).toBe(false);
  });

  it('enforces the per-person ceiling (never passes it)', async () => {
    const db = testDb();
    await person(db, 'visitor');
    const meter = new LlmMeter(db, 5_000_000);
    expect(await award(meter, { amount: 10, ceiling: 15, key: 'a' })).toMatchObject({ ok: true, recipientTotal: 10 });
    // 10 already granted; +6 would be 16 > 15 → refused.
    expect(await award(meter, { amount: 6, ceiling: 15, key: 'b' })).toMatchObject({ ok: false });
    // +5 → exactly 15, allowed.
    expect(await award(meter, { amount: 5, ceiling: 15, key: 'c' })).toMatchObject({ ok: true, recipientTotal: 15 });
    expect((await db.collection('showcaseAwards').doc('default_visitor').get()).data()?.granted).toBe(15);
  });

  it('never lets the pool go negative or overspend', async () => {
    const db = testDb();
    await person(db, 'visitor');
    const meter = new LlmMeter(db, 5_000_000);
    expect(await award(meter, { amount: 3, poolCredits: 4, key: 'a' })).toMatchObject({ ok: true, poolRemaining: 1 });
    // Only 1 left; 3 refused.
    expect(await award(meter, { amount: 3, poolCredits: 4, key: 'b' })).toMatchObject({ ok: false });
    expect((await db.collection('showcasePools').doc('default').get()).data()?.remaining).toBe(1);
  });

  it('is idempotent per key: a replayed judge decision pays once', async () => {
    const db = testDb();
    await person(db, 'visitor');
    const meter = new LlmMeter(db, 5_000_000);
    const a = await award(meter, { amount: 4, key: 'same' });
    const b = await award(meter, { amount: 4, key: 'same' });
    expect(a).toMatchObject({ ok: true, awarded: 4 });
    expect(b).toMatchObject({ ok: true, awarded: 4 });
    expect((await db.collection('showcasePools').doc('default').get()).data()?.remaining).toBe(9_996); // one decrement
    expect((await db.collection('billing').doc('visitor').get()).data()?.extraMicros).toBe(4 * CREDIT_MICROS);
  });

  it('two concurrent awards against a pool of 1 → exactly one succeeds, pool ends at 0', async () => {
    const db = testDb();
    await person(db, 'visitor');
    await db.collection('showcasePools').doc('default').set({ poolId: 'default', remaining: 1 });
    const meter = new LlmMeter(db, 5_000_000);
    const [a, b] = await Promise.all([award(meter, { amount: 1, key: 'x', poolCredits: 1 }), award(meter, { amount: 1, key: 'y', poolCredits: 1 })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await db.collection('showcasePools').doc('default').get()).data()?.remaining).toBe(0);
  });

  it('refuses a non-person recipient, the judge itself, and the judge owner', async () => {
    const db = testDb();
    await person(db, 'visitor');
    await person(db, 'a-bot', 'endpoint');
    await person(db, JUDGE);
    await person(db, OWNER);
    const meter = new LlmMeter(db, 5_000_000);
    expect(await award(meter, { recipientId: 'a-bot', key: '1' })).toMatchObject({ ok: false });
    expect(await award(meter, { recipientId: 'missing-person', key: '2' })).toMatchObject({ ok: false });
    expect(await award(meter, { recipientId: JUDGE, key: '3' })).toMatchObject({ ok: false });
    expect(await award(meter, { recipientId: OWNER, key: '4' })).toMatchObject({ ok: false });
    expect((await db.collection('showcasePools').doc('default').get()).exists).toBe(false);
  });

  it('refuses when the pool/ceiling is not configured (0 or NaN) or key is empty', async () => {
    const db = testDb();
    await person(db, 'visitor');
    const meter = new LlmMeter(db, 5_000_000);
    expect(await award(meter, { poolCredits: 0 })).toMatchObject({ ok: false });
    expect(await award(meter, { ceiling: 0 })).toMatchObject({ ok: false });
    expect(await award(meter, { poolCredits: Number.NaN })).toMatchObject({ ok: false });
    expect(await award(meter, { ceiling: Number.NaN })).toMatchObject({ ok: false });
    expect(await award(meter, { key: '   ' })).toMatchObject({ ok: false });
  });
});

describe('isShowcaseJudge', () => {
  it('is true only for a configured judge id', () => {
    expect(isShowcaseJudge({ id: JUDGE }, [JUDGE, 'other'])).toBe(true);
    expect(isShowcaseJudge({ id: 'nope' }, [JUDGE])).toBe(false);
    expect(isShowcaseJudge({ id: JUDGE }, [])).toBe(false);
    expect(isShowcaseJudge({ id: JUDGE }, undefined)).toBe(false);
  });
});

describe('fetch_url (SSRF-safe)', () => {
  const ok = (body: string, type = 'text/html', status = 200) =>
    new Response(body, { status, headers: { 'content-type': type } });

  it('refuses http, private literals, and non-http schemes (no network)', async () => {
    for (const url of ['http://example.com', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/', 'https://localhost/', 'file:///etc/passwd', 'not-a-url']) {
      const res = (await _fetchUrlForTest(url, (async () => ok('should not be called')) as unknown as typeof fetch)) as { ok: boolean };
      expect(res.ok, url).toBe(false);
    }
  });

  it('fetches a public https page and returns its text', async () => {
    const res = (await _fetchUrlForTest('https://example.com/pitch', (async () => ok('<h1>Hi</h1>')) as unknown as typeof fetch)) as { ok: boolean; data?: { text: string } };
    expect(res.ok).toBe(true);
    expect(res.data?.text).toContain('Hi');
  });

  it('refuses a redirect that points at a private address', async () => {
    const mock = (async (input: string | URL) => {
      const u = String(input);
      if (u === 'https://example.com/go') return new Response('', { status: 302, headers: { location: 'https://169.254.169.254/' } });
      return ok('secret');
    }) as unknown as typeof fetch;
    const res = (await _fetchUrlForTest('https://example.com/go', mock)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('stops at the redirect-hop cap', async () => {
    let n = 0;
    const mock = (async () => new Response('', { status: 302, headers: { location: `https://example.com/${n++}` } })) as unknown as typeof fetch;
    const res = (await _fetchUrlForTest('https://example.com/start', mock)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/redirect/i);
  });

  it('refuses a non-text content type', async () => {
    const res = (await _fetchUrlForTest('https://example.com/bin', (async () => ok('\x00\x01', 'application/octet-stream')) as unknown as typeof fetch)) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('truncates a body over the size cap', async () => {
    const big = 'a'.repeat(1_200_000);
    const res = (await _fetchUrlForTest('https://example.com/big', (async () => ok(big)) as unknown as typeof fetch)) as { ok: boolean; data?: { truncated?: boolean; text: string } };
    expect(res.ok).toBe(true);
    expect(res.data?.truncated).toBe(true);
    expect(res.data!.text.length).toBeLessThanOrEqual(1_000_000);
  });
});

describe('runShowcaseCloudTool dispatch', () => {
  it('refuses award_credits with no resolved visitor', async () => {
    const meter = { awardShowcaseCredits: async () => ({ ok: true as const, awarded: 1, recipientTotal: 1, poolRemaining: 1 }) };
    const res = (await runShowcaseCloudTool(meter, { judgeId: JUDGE, judgeOwnerId: OWNER, poolId: 'default', poolCredits: 10_000, ceiling: 500, key: 'm1' }, 'award_credits', { amount: 10 })) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('loadConfig accepts explicit 0 for SHOWCASE_POOL_CREDITS and SHOWCASE_USER_CEILING', () => {
    const prevPool = process.env.SHOWCASE_POOL_CREDITS;
    const prevCeil = process.env.SHOWCASE_USER_CEILING;
    try {
      process.env.SHOWCASE_POOL_CREDITS = '0';
      process.env.SHOWCASE_USER_CEILING = '0';
      const cfg = loadConfig();
      expect(cfg.showcasePoolCredits).toBe(0);
      expect(cfg.showcaseUserCeiling).toBe(0);
    } finally {
      if (prevPool === undefined) delete process.env.SHOWCASE_POOL_CREDITS;
      else process.env.SHOWCASE_POOL_CREDITS = prevPool;
      if (prevCeil === undefined) delete process.env.SHOWCASE_USER_CEILING;
      else process.env.SHOWCASE_USER_CEILING = prevCeil;
    }
  });

  it('resolves showcaseVisitor on both a root channel post turn and a thread reply turn (never a bot root)', async () => {
    const db = testDb();
    let awardedTo: unknown;
    const hub = createHub({
      db,
      config: testConfig({
        cloudAgents: { model: 'fake', project: 'proj', location: 'global', prices: { input: 1, output: 1 } },
        showcaseJudgeAgentIds: ['judge-1'],
        showcasePoolCredits: 1000,
        showcaseUserCeiling: 500,
      }),
      cloudToken: async () => 'tok',
      cloudFetch: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { contents?: { parts?: { functionResponse?: { response?: unknown } }[] }[] };
        const fr = body.contents?.flatMap((c) => c.parts ?? []).find((p) => p.functionResponse)?.functionResponse;
        if (fr) {
          awardedTo = fr.response;
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Awarded!' }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'award_credits', args: { amount: 5, reason: 'great pitch' } } }] }, finishReason: 'STOP' }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const { owner, workspace, channel, members } = await crew(hub.registry, 'show', ['crew-bot']);
    const crewBot = members[0]!;
    await db.collection('workspaces').doc(workspace.id).update({ publicShowcase: true });
    await db.collection('agents').doc('judge-1').set({ id: 'judge-1', name: 'Judge', kind: 'endpoint', cloud: true, ownerId: 'judge-owner', workspaces: [workspace.id], channels: [channel.id], lastSeen: new Date().toISOString() });
    await db.collection('channels').doc(channel.id).update({ members: [owner.id, crewBot.id, 'judge-1'] });
    const rootPost = await hub.chat.post(owner, { channelId: channel.id }, { parts: [{ text: 'Here is my pitch @Judge' }] });
    await hub.wakeService.idle();
    expect(awardedTo).toMatchObject({ ok: true, data: { awarded: 5, recipientTotal: 5, poolRemaining: 995 } });
    // A relaying crew bot replies in the thread and @mentions the judge → award still goes to the root human (owner), not the bot.
    awardedTo = undefined;
    await hub.chat.post(crewBot, { channelId: channel.id, thread: rootPost.message.id }, { parts: [{ text: 'Synthesized pitch for @Judge' }] });
    await hub.wakeService.idle();
    expect(awardedTo).toMatchObject({ ok: true, data: { awarded: 5, recipientTotal: 10, poolRemaining: 990 } });
    expect((await db.collection('billing').doc(owner.id).get()).data()?.extraMicros).toBe(10 * CREDIT_MICROS);
  });
});
