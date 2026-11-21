import { MAX_CATCHUP_MESSAGES, normalizeList, truncateMessageText } from '../chat/catchup.js';
import { parseKey } from '../chat/chat.js';
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
 * Builds the GraphJob runner: reads a done thread, asks the model for its decisions with the people and topics
 * behind them, and upserts them as nodes and edges sourced to the thread. Each run first purges the thread's
 * graph, so a rerun replaces rather than accumulates; ids are deterministic. Skips, with a log line, once the
 * workspace's daily cap is spent; throws (so the queue retries) only on 429, 5xx or a timeout.
 */
export function graphExtractor(deps: {
  graph: GraphStore;
  store: Pick<ChatStore, 'message' | 'page'>;
  llm: { project: string; location: string; model: string; accessToken?: () => Promise<string>; fetchImpl?: typeof fetch };
  prices?: LlmPrices;
}): (job: GraphJob) => Promise<void> {
  const { graph, store, llm, prices = FLASH_LITE_PRICES } = deps;
  return async ({ workspaceId, conversationId }) => {
    if (!graph.enabled) return;
    const key = parseKey(conversationId);
    if (key.kind !== 'thread') return;
    if (!(await graph.canSpendOnGraph(workspaceId))) {
      console.log(`graph: daily cap reached for workspace ${workspaceId}, skipping ${conversationId}`);
      return;
    }
    const root = await store.message(key.post);
    const messages = [...(root ? [root] : []), ...(await store.page(conversationId, MAX_CATCHUP_MESSAGES))];
    if (!messages.length) return;
    const prompt = [
      'Extract the decisions this team thread reached. For each: a short "title", one sentence of "text" on what was decided and why,',
      'the "people" (by the names shown) who made or own it, and up to three short "topics". No decisions: an empty array.',
      'Write in the thread\'s language.',
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
    await graph.purgeGraphFor({ workspaceId, conversationId });
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
  };
}
