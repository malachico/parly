import { MAX_CATCHUP_MESSAGES, normalizeList, truncateMessageText } from '../chat/catchup.js';
import { type MessageDoc, parseKey } from '../chat/chat.js';
import type { GraphJob } from '../chat/queue.js';
import type { ChatStore } from '../chat/store.js';
import { type LlmPrices, costMicros } from '../lib/llmCost.js';
import { generate } from '../lib/vertex.js';
import { textOf } from '../lib/wire.js';
import type { GraphStore } from './store.js';

export interface ExtractedDecision {
  title: string;
  text: string;
  people: string[];
  topics: string[];
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
    out.push({ title, text: typeof d.text === 'string' ? d.text.trim() : '', people: normalizeList(d.people), topics: normalizeList(d.topics) });
  }
  return out;
}

/** gemini-3.5-flash-lite, USD per million tokens. ponytail: hardcoded; move to config if the extraction model changes. */
const FLASH_LITE_PRICES: LlmPrices = { input: 0.1, output: 0.4 };

/**
 * Builds the GraphJob runner: reads a done thread, or a quiet channel's messages since its watermark, asks the
 * model for its decisions with the people and topics behind them, and upserts them as nodes and edges sourced to
 * the conversation. A thread run first purges the thread's graph, so a rerun replaces rather than accumulates; ids
 * are deterministic. A channel run never purges: it skips when a newer post scheduled a later run, and moves the
 * channel's watermark only after its writes. Skips, with a log line, once the
 * workspace's daily cap is spent; throws (so the queue retries) only on 429, 5xx or a timeout.
 */
export function graphExtractor(deps: {
  graph: GraphStore;
  store: Pick<ChatStore, 'message' | 'page' | 'since' | 'conversation'>;
  /** Channel runs skip archived (or deleted) channels and workspaces. */
  registry: { channelDoc(id: string): Promise<{ archived?: boolean } | undefined>; workspaceDoc(id: string): Promise<{ archived?: boolean } | undefined> };
  llm: { project: string; location: string; model: string; accessToken?: () => Promise<string>; fetchImpl?: typeof fetch };
  prices?: LlmPrices;
  /** Re-schedules a channel job the daily cap skipped. */
  requeue?: (job: GraphJob, delayMs: number) => Promise<void>;
}): (job: GraphJob) => Promise<void> {
  const { graph, store, registry, llm, prices = FLASH_LITE_PRICES, requeue } = deps;
  return async (job) => {
    const { workspaceId, conversationId, seq } = job;
    if (!graph.enabled) return;
    const key = parseKey(conversationId);
    if (key.kind === 'dm') return;
    let messages: MessageDoc[] | undefined;
    if (key.kind === 'channel') {
      // Debounce: a newer post scheduled its own run, which will cover this one's messages.
      if (seq !== undefined && ((await store.conversation(conversationId))?.seq ?? 0) > seq) return;
      const [channel, workspace] = await Promise.all([registry.channelDoc(key.channelId), registry.workspaceDoc(workspaceId)]);
      if (!channel || channel.archived || !workspace || workspace.archived) return;
      // ponytail: a burst over the cap keeps only its newest MAX_CATCHUP_MESSAGES; page from the watermark if big bursts lose facts.
      messages = await store.since(conversationId, await graph.channelWatermark(workspaceId, conversationId), MAX_CATCHUP_MESSAGES);
      if (!messages.length) return;
    }
    if (!(await graph.canSpendOnGraph(workspaceId))) {
      console.log(`graph: daily cap reached for workspace ${workspaceId}, skipping ${conversationId}`);
      // The watermark stays put, so a channel retries the window once the cap resets at the next UTC midnight.
      if (key.kind === 'channel' && requeue) {
        const now = new Date();
        await requeue(job, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime());
      }
      return;
    }
    if (key.kind === 'thread') {
      const root = await store.message(key.post);
      messages = [...(root ? [root] : []), ...(await store.page(conversationId, MAX_CATCHUP_MESSAGES))];
    }
    if (!messages?.length) return;
    const prompt = [
      'Extract the decisions this team conversation reached. For each: a short "title", one sentence of "text" on what was decided and why,',
      'the "people" (by the names shown) who made or own it, and up to three short "topics". No decisions: an empty array.',
      'Write in the conversation\'s language.',
      '',
      ...messages.map((m) => `${m.from}: ${truncateMessageText(textOf(m))}`),
    ].join('\n');
    const out = await generate({
      ...llm,
      prompt,
      thinkingLevel: 'low',
      timeoutMs: 30_000,
      schema: {
        type: 'OBJECT',
        properties: {
          decisions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { title: { type: 'STRING' }, text: { type: 'STRING' }, people: { type: 'ARRAY', items: { type: 'STRING' } }, topics: { type: 'ARRAY', items: { type: 'STRING' } } },
              required: ['title', 'text', 'people', 'topics'],
            },
          },
        },
        required: ['decisions'],
      },
    });
    if (out.usage) await graph.recordGraphSpend(workspaceId, costMicros(prices, out.usage));
    if (!out.ok) {
      const msg = `graph: ${llm.model} answered HTTP ${out.status} for ${conversationId}`;
      if (out.status === 429 || out.status >= 500) throw new Error(msg);
      console.error(`${msg}; not retrying`, out.errorText);
      return;
    }
    if (key.kind === 'thread') await graph.purgeGraphFor({ workspaceId, conversationId });
    // A person the thread knows is keyed on their agent id (titled with their thread name), so a rename or a
    // differently-cased mention is one node. ponytail: names the thread never posted as stay keyed by name.
    const authors = new Map(messages.map((m) => [m.from.toLowerCase(), { id: m.fromId, name: m.from }]));
    const node = (kind: 'decision' | 'person' | 'topic', title: string, extra: { key?: string; text?: string } = {}) =>
      graph.upsertNode({ workspaceId, conversationId, kind, title, ...extra });
    const edge = async (kind: string, from: string | undefined, to: Promise<string | undefined>) => {
      const toId = await to;
      if (from && toId) await graph.upsertEdge({ workspaceId, kind, from: { id: from, conversationId }, to: { id: toId, conversationId } });
    };
    for (const d of parseGraphExtraction(out.text)) {
      const decision = await node('decision', d.title, { text: d.text });
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
