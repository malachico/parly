import { generate } from '../lib/vertex.js';
import { textOf } from '../lib/wire.js';
import { DIGEST_FOLD_LEASE_MS, DIGEST_FOLD_MAX, DIGEST_FOLD_MIN, EARLIER_MAX, type ConversationDoc } from './chat.js';
import type { ChatService } from './chatService.js';

export const MAX_CATCHUP_MESSAGES = 80;
const MAX_CATCHUP_MESSAGE_CHARS = 600;

export function truncateMessageText(text: string, maxChars = MAX_CATCHUP_MESSAGE_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1)}…`;
}

export function normalizeList(items: unknown, maxItems = 6): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

interface DigestMessage {
  seq: number;
  from: string;
  text: string;
}
export interface DigestFoldInput {
  /** The current rolling digest, if any replies have been folded already. */
  digest?: string;
  /** The thread's root post, cited [#0]; pass only on the first fold (digestUpToSeq === 0). */
  root?: DigestMessage;
  /** The replies to fold into the digest, oldest first. */
  chunk: DigestMessage[];
}
/** Folds a chunk of older thread replies into a rolling digest string. Returns undefined on failure (leaves the digest unchanged). */
export type ThreadDigestFolder = (input: DigestFoldInput) => Promise<string | undefined>;

const MAX_DIGEST_CHARS = 2000;

/**
 * Calls Vertex AI to fold older thread replies into a compact rolling digest (plain text with `[#seq]` citations),
 * served in place of their full history. Returns `undefined` on any error, leaving the stored digest unchanged.
 */
export function vertexThreadDigestFolder(opts: {
  project: string;
  location: string;
  model: string;
  accessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ThreadDigestFolder {
  return async ({ digest, root, chunk }) => {
    if (chunk.length === 0) return undefined;
    const line = (m: DigestMessage) => `[#${m.seq}] ${m.from}: ${truncateMessageText(m.text, MAX_CATCHUP_MESSAGE_CHARS)}`;

    const prompt = [
      'You maintain a rolling digest of an ongoing thread so later readers can skip its older messages.',
      'Fold the new replies below into the existing digest and return the UPDATED digest as plain text.',
      'Write in the same language as the messages. Keep it compact (a short paragraph or a few bullets).',
      'Cite the message each point comes from as [#seq]. Drop points that newer replies resolved or superseded.',
      `Keep it under ${MAX_DIGEST_CHARS} characters. Return only the digest text, no preamble.`,
      '',
      ...(root ? ['Thread root post:', line(root), ''] : []),
      ...(digest ? ['Existing digest:', digest, ''] : ['No digest yet.', '']),
      `New replies (${chunk.length}):`,
      ...chunk.map(line),
    ].join('\n');

    const started = Date.now();
    try {
      const out = await generate({
        project: opts.project,
        location: opts.location,
        model: opts.model,
        prompt,
        thinkingLevel: 'low',
        timeoutMs: opts.timeoutMs ?? 12_000,
        accessToken: opts.accessToken,
        fetchImpl: opts.fetchImpl,
      });
      if (!out.ok) {
        console.error(`digest: ${opts.model} answered HTTP ${out.status} in ${Date.now() - started}ms`);
        return undefined;
      }
      const text = out.text.trim();
      return text ? text.slice(0, MAX_DIGEST_CHARS) : undefined;
    } catch (err) {
      console.error(`digest: failed in ${Date.now() - started}ms (${(err as Error).name})`);
      return undefined;
    }
  };
}


// THREAD_DIGEST: fast in-process guard ahead of the shared DB lease on the conversation doc (`digestFoldUntilMs`).
const foldingNow = new Set<string>();

/**
 * THREAD_DIGEST: folds the oldest un-folded replies — those past digestUpToSeq but before the verbatim tail — into
 * the rolling digest in one background Vertex call. Reads never block on it; on failure digestUpToSeq is left as-is
 * and the next post retries (no gap). Folds only once a whole chunk has built up, so the calls stay rare.
 */
export async function foldDigest(chat: ChatService, conversation: ConversationDoc): Promise<void> {
  if (!chat.fold) return;
  if ((conversation.seq - EARLIER_MAX) - (conversation.digestUpToSeq ?? 0) < DIGEST_FOLD_MIN) return;
  if ((conversation.digestFoldUntilMs ?? 0) > Date.now() || foldingNow.has(conversation.id)) return;
  foldingNow.add(conversation.id);
  let leased = false;
  try {
    const current = await chat.store.leaseDigestFold(conversation.id, DIGEST_FOLD_LEASE_MS);
    if (!current) return;
    leased = true;
    const base = current.digestUpToSeq ?? 0;
    const targetSeq = current.seq - EARLIER_MAX; // keep the last EARLIER_MAX replies verbatim
    if (targetSeq - base < DIGEST_FOLD_MIN) return;
    // page(before = base + DIGEST_FOLD_MAX + 1) is the newest ≤DIGEST_FOLD_MAX replies below that bound, oldest-first;
    // filtering to (base, targetSeq] yields the oldest un-folded chunk with no gap, reusing page's existing seq index.
    const fetched = await chat.store.page(conversation.id, DIGEST_FOLD_MAX, base + DIGEST_FOLD_MAX + 1);
    const chunk = fetched.filter((m) => m.seq > base && m.seq <= targetSeq);
    if (chunk.length < DIGEST_FOLD_MIN) return;
    let root: DigestMessage | undefined;
    if (base === 0 && current.post) {
      const post = await chat.store.message(current.post); // cited [#0] on the first fold only
      if (post) root = { seq: 0, from: post.from, text: textOf(post) };
    }
    const digest = await chat.fold({
      digest: current.threadDigest,
      root,
      chunk: chunk.map((m) => ({ seq: m.seq, from: m.from, text: textOf(m) })),
    });
    if (digest) {
      await chat.store.setDigest(conversation.id, chunk[chunk.length - 1]!.seq, digest);
      leased = false; // setDigest cleared digestFoldUntilMs in the same transaction
    }
  } finally {
    foldingNow.delete(conversation.id);
    if (leased) await chat.store.releaseDigestFold(conversation.id).catch(() => {});
  }
}
