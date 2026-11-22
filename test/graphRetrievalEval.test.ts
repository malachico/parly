import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { channelKey, threadKey } from '../src/chat/chat.js';
import { NODES, normalizeKey, type GraphStore } from '../src/graph/store.js';
import type { HubService } from '../src/hub/hubService.js';
import { callMcpTool } from '../src/mcp/inProcess.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, testConfig, testDb } from './helpers.js';

/**
 * Baseline retrieval eval for find_decisions. It measures and changes nothing. It seeds decision nodes shaped the way
 * extraction writes them (title, text, the cited sourceMessageIds, a `supersedes` edge from new to old) and asks questions
 * through the real MCP tool as an agent who can't read the private channel.
 *
 * Mode: regex fallback (not BM25). A plain replica set has no Atlas vector index and tests have no embedder, so
 * find_decisions runs the exact-word fallback: regex candidates, each scored by the share of query words (stopwords
 * included) found as whole words. The test asserts the mode.
 *
 * Nodes get fixed ids (eval-01.. in fixture order) instead of upsertNode's hash of the random workspace id. Score ties
 * break by id, so every number below is deterministic. Fixture order puts a replaced decision first, so on a tie
 * the stale decision wins.
 *
 * Metrics (exact baselines; update them on purpose when retrieval changes):
 * - recall@5: the expected decision is in the top 5.
 * - citations correct: the hit cites every expected message id (`msgs`) and nothing else.
 *   Missing: an expected id is absent. Incorrect: it cites an id or link outside `msgs`.
 * - supersede order: for a question about a replaced decision, the replacement ranks strictly above the old one
 *   (old-only or neither fails).
 * - no-answer: questions on topics absent from the fixture. False positives count any readable result. "Correct"
 *   means empty, or the top exact-search score is below NO_ANSWER_SCORE.
 * - ACL leaks: a hard zero. Private titles/text must not appear, and no returned id or source may be a private node
 *   or private conversation.
 *
 * Known gaps (measured here, not fixed):
 * - Citations are seeded, so this measures that the tool returns them, not that the model cites the right messages
 *   (unmeasured: test/graphQuality.test.ts checks titles, people and replaces, not which messages are cited).
 * - Ranking ignores `supersedes` edges, so a stale decision can outrank its replacement.
 * - No stemming or synonyms ("deployment cadence" finds nothing), and stopwords count toward the score.
 */
interface Decision { key: string; conv: 'pub' | 'release' | 'docs' | 'priv'; title: string; text: string; msgs: string[]; replaces?: string }
const DECISIONS: Decision[] = [
  { key: 'ledger', conv: 'pub', title: 'Use Postgres for the billing ledger', text: 'The ledger needs multi-row transactions, so billing moves off the document store to Postgres.', msgs: ['m-101', 'm-104'] },
  { key: 'ratelimit', conv: 'pub', title: 'Rate limit the public API at 100 requests per minute', text: 'Per token, with a burst of 20. Partners can ask for more.', msgs: ['m-110'] },
  { key: 'keys', conv: 'pub', title: 'Rotate API keys every 90 days', text: 'Keys older than 90 days stop working; owners get an email a week before.', msgs: ['m-115'] },
  { key: 'pnpm', conv: 'pub', title: 'Adopt pnpm as the package manager', text: 'Faster installs and a strict node_modules; npm lockfiles are removed.', msgs: ['m-120'] },
  { key: 'uploads', conv: 'pub', title: 'Store user uploads in S3 with a 30-day lifecycle', text: 'Uploads expire after 30 days unless pinned to a conversation.', msgs: ['m-125'] },
  { key: 'oncall', conv: 'pub', title: 'On-call rotates weekly with a Monday handoff', text: 'The outgoing engineer hands off open incidents at Monday standup.', msgs: ['m-130'] },
  { key: 'node18', conv: 'pub', title: 'Drop support for Node 18', text: 'CI and the CLI require Node 20 or newer from the next minor version.', msgs: ['m-135'] },
  { key: 'flags', conv: 'pub', title: 'Gate the new onboarding flow behind feature flags', text: 'Ten percent rollout first, then everyone if activation holds.', msgs: ['m-140'] },
  { key: 'biweekly', conv: 'release', title: 'Ship releases every two weeks', text: 'Release train leaves every other Tuesday.', msgs: ['m-201'] },
  { key: 'weekly', conv: 'release', title: 'Ship releases weekly', text: 'After the retro the release train leaves every Tuesday.', msgs: ['m-230'], replaces: 'biweekly' },
  { key: 'netlify', conv: 'docs', title: 'Host the docs site on Netlify', text: 'Docs deploy from the main branch on every merge.', msgs: ['m-301'] },
  { key: 'pages', conv: 'docs', title: 'Host the docs site on Cloudflare Pages', text: 'Moved docs hosting for cheaper bandwidth; deploys still run on merge.', msgs: ['m-320'], replaces: 'netlify' },
  { key: 'prices', conv: 'priv', title: 'Raise prices 20% in January', text: 'Pricing increase for the team plan; announce in December.', msgs: ['m-401'] },
  { key: 'acquire', conv: 'priv', title: 'Acquire the analytics startup before Q3', text: 'Confidential: term sheet for the API analytics vendor.', msgs: ['m-410'] },
];

/** expect: the decision that answers it for the outsider; 'private' when the only answer is private; 'none' when the topic is absent. */
const QUESTIONS: { q: string; expect: string }[] = [
  { q: 'which database do we use for the billing ledger', expect: 'ledger' },
  { q: 'what is the API rate limit', expect: 'ratelimit' },
  { q: 'how often should API keys be rotated', expect: 'keys' },
  { q: 'what package manager do we use', expect: 'pnpm' },
  { q: 'where do user uploads go and when do they expire', expect: 'uploads' },
  { q: 'when is the on-call handoff', expect: 'oncall' },
  { q: 'which Node versions are supported', expect: 'node18' },
  { q: 'is the new signup experience behind a toggle', expect: 'flags' },
  { q: 'how often do we ship releases', expect: 'weekly' },
  { q: 'what is our deployment cadence', expect: 'weekly' },
  { q: 'where are the docs hosted', expect: 'pages' },
  { q: 'are we raising prices', expect: 'private' },
  { q: 'API analytics vendor acquisition', expect: 'private' },
  { q: 'parental leave policy', expect: 'none' },
  { q: 'which espresso beans does the office kitchen stock', expect: 'none' },
  { q: 'what is the API timeout', expect: 'none' },
];

/** Today's exact numbers. Change them deliberately when retrieval changes; a drop is a regression. */
const BASELINE = { recallAt5: 10, citationsCorrect: 10, citationsMissing: 0, citationsIncorrect: 0, supersedeOrder: 0, noAnswerCorrect: 3, noAnswerFalsePositives: 2 };
/** ponytail: one fixed cut-off; tune it once a real ranker produces comparable scores. */
const NO_ANSWER_SCORE = 0.5;

async function call(hub: HubService, who: AgentRecord, query: string) {
  const r = (await callMcpTool(hub, who, 'find_decisions', { query, limit: 20 })) as { ok: boolean; result?: string; error?: string };
  if (!r.ok) throw new Error(r.error);
  return JSON.parse(r.result!).decisions as { id: string; title: string; sources: { conversation?: string; messageIds?: string[]; links?: string[] }[] }[];
}

describe('find_decisions retrieval eval (baseline, regex fallback (not BM25))', () => {
  let hub: HubService;
  let outsider: AgentRecord; // in the public channel, not the private one
  let ws: string;
  let privConv: string;
  const byKey = new Map(DECISIONS.map((d) => [d.key, d]));
  const idOf = new Map(DECISIONS.map((d, i) => [d.key, `eval-${String(i + 1).padStart(2, '0')}`]));
  const PROBE = { id: 'eval-99', title: 'Citation probe quokka', msgs: ['m-901', 'm-902'] };

  beforeAll(async () => {
    const db = testDb();
    hub = createApp({ db, config: testConfig() }).hub;
    const w = await crew(hub.registry, 'eval');
    ws = w.workspace.id;
    const priv = (await hub.registry.createChannel(w.owner, ws, 'eval-exec')).id;
    await hub.registry.addToChannel(w.owner, priv, w.members[0]!.id);
    await hub.registry.updateChannel(w.owner, priv, { open: false });
    outsider = (await hub.registry.get(w.members[1]!.id))!;
    const convs = { pub: channelKey(w.channel.id), release: threadKey(w.channel.id, 'release'), docs: threadKey(w.channel.id, 'docs'), priv: threadKey(priv, 'board') };
    privConv = convs.priv;
    const now = new Date().toISOString();
    // Same fields upsertNode writes, with fixed ids, citing each decision's messages as extraction now does.
    const doc = (_id: string, conversationId: string, title: string, text: string, sourceMessageIds: string[]) =>
      ({ _id, workspaceId: ws, conversationId, kind: 'decision', key: normalizeKey(title), title, text, source: { kind: 'conversation', conversationId }, sourceMessageIds, createdAt: now, updatedAt: now });
    await db.mongoDb.collection<{ _id: string }>(NODES).insertMany([
      ...DECISIONS.map((d) => doc(idOf.get(d.key)!, convs[d.conv], d.title, d.text, d.msgs)),
      doc(PROBE.id, convs.pub, PROBE.title, 'Seeded with message ids to check the tool forwards them.', PROBE.msgs),
    ]);
    const graph = hub.graph as GraphStore;
    for (const d of DECISIONS.filter((x) => x.replaces)) {
      const old = byKey.get(d.replaces!)!;
      await graph.upsertEdge({ workspaceId: ws, kind: 'supersedes', from: { id: idOf.get(d.key)!, conversationId: convs[d.conv] }, to: { id: idOf.get(old.key)!, conversationId: convs[old.conv] } });
    }
  });

  it('measures recall@5, citations, supersede order and no-answer over the regex fallback (not BM25)', async () => {
    const { mode } = await hub.graphSearch!({ workspaceId: ws }, 'docs');
    expect(mode).toBe('exact'); // regex fallback (not BM25)

    const privDecisions = DECISIONS.filter((d) => d.conv === 'priv');
    const secretText = privDecisions.flatMap((d) => [d.title, d.text]);
    const secretIds = new Set(privDecisions.map((d) => idOf.get(d.key)!));
    let recall = 0, correct = 0, missing = 0, incorrect = 0, leaks = 0, supersede = 0, noAnswerOk = 0, falsePos = 0;
    const answerable = QUESTIONS.filter((x) => byKey.has(x.expect));
    const aboutReplaced = answerable.filter((x) => byKey.get(x.expect)!.replaces);
    const noAnswer = QUESTIONS.filter((x) => x.expect === 'none');
    const rows = [];
    for (const { q, expect: want } of QUESTIONS) {
      const got = await call(hub, outsider, q);
      const json = JSON.stringify(got);
      if (secretText.some((s) => json.includes(s)) || got.some((d) => secretIds.has(d.id) || d.sources.some((s) => s.conversation === privConv))) leaks++;
      const rank = (key: string) => got.findIndex((d) => d.title === byKey.get(key)!.title);
      const at = byKey.has(want) ? rank(want) : -1;
      let top: number | string = '-';
      if (at >= 0 && at < 5) {
        recall++;
        const expected = byKey.get(want)!.msgs;
        const cited = got[at]!.sources.flatMap((s) => [...(s.messageIds ?? []), ...(s.links ?? [])]);
        const isMissing = expected.some((m) => !cited.includes(m));
        const isIncorrect = cited.some((m) => !expected.includes(m));
        if (isMissing) missing++;
        if (isIncorrect) incorrect++;
        if (!isMissing && !isIncorrect) correct++;
      }
      const replaced = byKey.get(want)?.replaces;
      if (replaced && at >= 0 && (rank(replaced) < 0 || at < rank(replaced))) supersede++;
      if (want === 'none') {
        if (got.length) falsePos++;
        const { hits } = await hub.graphSearch!({ workspaceId: ws, channelIds: outsider.channels ?? [] }, q, { kind: 'decision', limit: 50 });
        const score = got.length ? (hits.find((h) => h.nodeId === got[0]!.id)?.score ?? 0) : 0;
        top = got.length ? Number(score.toFixed(2)) : '-';
        if (!got.length || score < NO_ANSWER_SCORE) noAnswerOk++;
      }
      rows.push({ q, expect: want, rank: at >= 0 ? at + 1 : '-', top: got[0]?.title ?? '-', topScore: top });
    }
    const metrics = { recallAt5: recall, citationsCorrect: correct, citationsMissing: missing, citationsIncorrect: incorrect, supersedeOrder: supersede, noAnswerCorrect: noAnswerOk, noAnswerFalsePositives: falsePos };
    console.log('mode: regex fallback (not BM25)');
    console.table(rows);
    console.table({
      'recall@5': `${recall}/${answerable.length}`,
      'citations correct / missing / incorrect': `${correct} / ${missing} / ${incorrect} of ${recall}`,
      'supersede order': `${supersede}/${aboutReplaced.length}`,
      'no-answer correct': `${noAnswerOk}/${noAnswer.length}`,
      'no-answer false positives': `${falsePos}/${noAnswer.length}`,
      'ACL leaks': leaks,
    });

    expect(leaks).toBe(0);
    expect(metrics).toEqual(BASELINE);
  });

  it('propagation only: find_decisions forwards seeded source message ids (does not prove extraction writes them)', async () => {
    const hit = (await call(hub, outsider, 'citation probe quokka')).find((d) => d.id === PROBE.id);
    expect(hit).toBeDefined();
    const forwarded = PROBE.msgs.every((m) => hit!.sources.some((s) => s.messageIds?.includes(m)));
    expect(forwarded).toBe(true);
  });
});
