import { MAX_CATCHUP_MESSAGES, normalizeList, truncateMessageText } from '../chat/catchup.js';
import { type MessageDoc, parseKey } from '../chat/chat.js';
import type { GraphJob } from '../chat/queue.js';
import type { ChatStore } from '../chat/store.js';
import { type LlmPrices, costMicros } from '../lib/llmCost.js';
import { generate } from '../lib/vertex.js';
import type { ChannelRecord } from '../registry/types.js';
import { textOf } from '../lib/wire.js';
import type { GraphStore } from './store.js';

export interface ExtractedDecision {
  title: string;
  text: string;
  people: string[];
  topics: string[];
  /** 1-based index into the earlier decisions offered in the prompt that this one replaces. */
  replaces?: number;
  /** 1-based indexes into the prompt's messages that state or settle this decision. */
  messages?: number[];
}

/** The model's answer as decisions with trimmed, de-duplicated people and topics; malformed answers yield none. */
export function parseGraphExtraction(text: string): ExtractedDecision[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(list)) return [];
  const out: ExtractedDecision[] = [];
  for (const d of list.slice(0, 12) as Partial<Record<keyof ExtractedDecision, unknown>>[]) {
    const title = typeof d?.title === 'string' ? d.title.trim() : '';
    if (!title) continue;
    out.push({
      title, text: typeof d.text === 'string' ? d.text.trim() : '', people: normalizeList(d.people), topics: normalizeList(d.topics),
      ...(Number.isInteger(d.replaces) && (d.replaces as number) > 0 ? { replaces: d.replaces as number } : {}),
      ...(Array.isArray(d.messages) ? { messages: d.messages.filter((i): i is number => Number.isInteger(i) && i > 0) } : {}),
    });
  }
  return out;
}

/**
 * Decision 3: whether conversations `a` and `b` have the same readers, so a decision in one may be marked as
 * replacing one in the other. A channel and its threads are read by the channel's members, unless some of it is
 * public (`channel` is the channel both are in). Fails closed: a DM, another channel, a bad key, a missing channel
 * doc, or a channel with anything public (even one shared thread) is never the same readers.
 */
export function sameReaders(a: string, b: string, channel: Pick<ChannelRecord, 'publicFromSeq' | 'publicThreads'> | undefined): boolean {
  try {
    const [x, y] = [parseKey(a), parseKey(b)];
    if (x.kind === 'dm' || y.kind === 'dm' || x.channelId !== y.channelId) return false;
  } catch {
    return false;
  }
  return !!channel && channel.publicFromSeq === undefined && !channel.publicThreads?.length;
}

/** The structured answer the extraction model must give. */
export const GRAPH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    decisions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' }, text: { type: 'STRING' }, people: { type: 'ARRAY', items: { type: 'STRING' } }, topics: { type: 'ARRAY', items: { type: 'STRING' } }, replaces: { type: 'INTEGER' }, messages: { type: 'ARRAY', items: { type: 'INTEGER' } } },
        required: ['title', 'text', 'people', 'topics'],
      },
    },
  },
  required: ['decisions'],
};

/** The extraction prompt for `messages`, offering `replaceable` (numbered from 1) as decisions a new one may replace. */
export function graphPrompt(messages: Pick<MessageDoc, 'from' | 'parts'>[], replaceable: { title: string }[]): string {
  return [
    'Extract the decisions this team conversation reached. For each: a short "title", one sentence of "text" on what was decided and why,',
    'the "people" (by the names shown) who made or own it, and up to three short lowercase "topics".',
    'A decision is something the conversation agreed or someone with the say settled. Proposals, open questions, options still being weighed,',
    'status updates and plans nobody agreed to are not decisions. A decision later reversed in the same conversation counts once, as its final form.',
    'Only name people who appear as speakers or are named in the messages; never invent one. No decisions: an empty array.',
    'Set "messages" to the numbers of the messages that state or settle it.',
    'Write in the conversation\'s language.',
    ...(replaceable.length
      ? ['', 'Earlier decisions in this channel, numbered. If a decision here changes or reverses one of them, set its "replaces" to that number. Do not repeat an earlier decision that is only mentioned again:', ...replaceable.map((c, i) => `${i + 1}. ${c.title}`)]
      : []),
    '',
    ...messages.map((m, i) => `[${i + 1}] ${m.from}: ${truncateMessageText(textOf(m))}`),
  ].join('\n');
}

/** How many of the channel's newest decisions a run offers the model as replaceable. */
const MAX_REPLACEABLE = 20;

/** Cap deferrals: requeued up to MAX_DEFERRALS times, landing within DEFER_JITTER_MS after midnight UTC. */
const MAX_DEFERRALS = 3;
const DEFER_JITTER_MS = 3 * 3_600_000;

/** gemini-3.5-flash-lite, USD per million tokens. ponytail: hardcoded; move to config if the extraction model changes. */
const FLASH_LITE_PRICES: LlmPrices = { input: 0.1, output: 0.4 };

/**
 * Builds the GraphJob runner: reads a done thread, or a quiet channel's messages since its watermark, asks the
 * model for its decisions with the people and topics behind them, and upserts them as nodes and edges sourced to
 * the conversation. A thread run first purges the thread's graph, so a rerun replaces rather than accumulates; ids
 * are deterministic. A channel run never purges: it skips when a newer post scheduled a later run, and moves the
 * channel's watermark only after its writes. Skips, with a log line, once the
 * workspace's daily cap is spent, and requeues the job for a few hours after midnight UTC (at most 3 times); throws (so the queue retries) only on 429, 5xx or a timeout.
 */
export function graphExtractor(deps: {
  graph: GraphStore;
  store: Pick<ChatStore, 'message' | 'page' | 'since' | 'conversation'>;
  /** Runs skip archived (or deleted) channels and workspaces. */
  registry: { channelDoc(id: string): Promise<(Pick<ChannelRecord, 'publicFromSeq' | 'publicThreads'> & { archived?: boolean }) | undefined>; workspaceDoc(id: string): Promise<{ archived?: boolean } | undefined> };
  llm: { project: string; location: string; model: string; accessToken?: () => Promise<string>; fetchImpl?: typeof fetch };
  prices?: LlmPrices;
  /** Re-schedules a job the daily cap skipped. */
  requeue?: (job: GraphJob, delayMs: number) => Promise<void>;
}): (job: GraphJob) => Promise<void> {
  const { graph, store, registry, llm, prices = FLASH_LITE_PRICES, requeue } = deps;
  return async (job) => {
    const { workspaceId, conversationId, seq } = job;
    if (!graph.enabled) return;
    const key = parseKey(conversationId);
    if (key.kind === 'dm') return;
    if (key.kind === 'channel' && seq !== undefined && ((await store.conversation(conversationId))?.seq ?? 0) > seq) return; // debounce: a newer post scheduled its own run
    const [channel, workspace] = await Promise.all([registry.channelDoc(key.channelId), registry.workspaceDoc(workspaceId)]);
    if (!channel || channel.archived || !workspace || workspace.archived) return;
    let messages: MessageDoc[] | undefined;
    if (key.kind === 'channel') {
      // ponytail: a burst over the cap keeps only its newest MAX_CATCHUP_MESSAGES; page from the watermark if big bursts lose facts.
      messages = await store.since(conversationId, await graph.channelWatermark(workspaceId, conversationId), MAX_CATCHUP_MESSAGES);
      if (!messages.length) return;
    }
    if (!(await graph.canSpendOnGraph(workspaceId))) {
      console.log(`graph: daily cap reached for workspace ${workspaceId}, skipping ${conversationId}`);
      // Retried after the cap resets at the next UTC midnight, spread over a few hours (a channel's watermark stays
      // put, so it rereads the window). Dropped when there is no cap to wait for, or after MAX_DEFERRALS days.
      const deferred = job.deferred ?? 0;
      if (requeue && graph.dailyCapMicros > 0 && deferred < MAX_DEFERRALS) {
        const now = new Date();
        const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        await requeue({ ...job, deferred: deferred + 1 }, midnight - now.getTime() + Math.floor(Math.random() * DEFER_JITTER_MS));
      }
      return;
    }
    if (key.kind === 'thread') {
      const root = await store.message(key.post);
      messages = [...(root ? [root] : []), ...(await store.page(conversationId, MAX_CATCHUP_MESSAGES))];
    }
    // Overlapping thread runs (a reopen and a re-done, or a duplicate task): the last-started one writes, older ones drop.
    const run = key.kind === 'thread' ? await graph.startGraphRun(workspaceId, conversationId) : 0;
    if (!messages?.length) return;
    // Decisions this one may replace: only ones with the same readers (Decision 3), and never the thread's own,
    // which the purge below drops.
    // ponytail: only the channel's MAX_REPLACEABLE newest decisions are offered, so an older one is never marked
    // replaced; "newer" is extraction order, so a reopened old thread can claim to replace a later decision; and a
    // thread rerun's purge drops other conversations' supersedes edges into it; page candidates or keep those edges if that bites.
    const replaceable = (await graph.recentDecisions(workspaceId, key.channelId, MAX_REPLACEABLE))
      .filter((c) => !(key.kind === 'thread' && c.conversationId === conversationId) && sameReaders(conversationId, c.conversationId, channel));
    const out = await generate({ ...llm, prompt: graphPrompt(messages, replaceable), thinkingLevel: 'low', timeoutMs: 30_000, schema: GRAPH_SCHEMA });
    if (out.usage) await graph.recordGraphSpend(workspaceId, costMicros(prices, out.usage));
    if (!out.ok) {
      const msg = `graph: ${llm.model} answered HTTP ${out.status} for ${conversationId}`;
      if (out.status === 429 || out.status >= 500) throw new Error(msg);
      console.error(`${msg}; not retrying`, out.errorText);
      return;
    }
    if (key.kind === 'thread') {
      // ponytail: check-then-write, not a lock; a newer run that starts and finishes its model call within this run's
      // few-ms write window can interleave with it. Serialise per thread (or write under a run tag) if that ever bites.
      if (!(await graph.isLatestGraphRun(workspaceId, conversationId, run))) return;
      await graph.purgeGraphFor({ workspaceId, conversationId });
    }
    // A person the thread knows is keyed on their agent id (titled with their thread name), so a rename or a
    // differently-cased mention is one node. ponytail: names the thread never posted as stay keyed by name.
    const authors = new Map(messages.map((m) => [m.from.toLowerCase(), { id: m.fromId, name: m.from }]));
    const node = (kind: 'decision' | 'person' | 'topic', title: string, extra: { key?: string; text?: string; sourceMessageIds?: string[] } = {}) =>
      graph.upsertNode({ workspaceId, conversationId, kind, title, ...extra });
    const edge = async (kind: string, from: string | undefined, to: Promise<string | undefined>) => {
      const toId = await to;
      if (from && toId) await graph.upsertEdge({ workspaceId, kind, from: { id: from, conversationId }, to: { id: toId, conversationId } });
    };
    for (const d of parseGraphExtraction(out.text)) {
      // Cites only messages from this batch, so never another conversation's: an index the model made up is dropped.
      const cited = [...new Set((d.messages ?? []).map((i) => messages[i - 1]?.id).filter((id): id is string => !!id))];
      const decision = await node('decision', d.title, { text: d.text, ...(cited.length ? { sourceMessageIds: cited } : {}) });
      const old = d.replaces !== undefined ? replaceable[d.replaces - 1] : undefined;
      if (decision && old && old.id !== decision) {
        await graph.upsertEdge({ workspaceId, kind: 'supersedes', from: { id: decision, conversationId }, to: { id: old.id, conversationId: old.conversationId } });
      }
      // TODO(#787): embed the decision nodes once graph embeddings land.
      await Promise.all([
        ...d.people.map((p) => {
          const a = authors.get(p.toLowerCase());
          return edge('involves', decision, node('person', a?.name ?? p, { key: a?.id ?? p }));
        }),
        ...d.topics.map((t) => edge('about', decision, node('topic', t))),
      ]);
    }
    if (key.kind === 'channel') await graph.setChannelWatermark(workspaceId, conversationId, Math.max(...messages.map((m) => m.seq)));
  };
}
