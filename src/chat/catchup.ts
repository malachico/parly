import { HubError } from '../lib/errors.js';
import { generate } from '../lib/vertex.js';
import { textOf } from '../lib/wire.js';
import { isDoneThread, type AgentRecord, type ChannelRecord } from '../registry/types.js';
import { DIGEST_FOLD_LEASE_MS, DIGEST_FOLD_MAX, DIGEST_FOLD_MIN, EARLIER_MAX, channelKey, parseKey, threadKey, type ConversationDoc } from './chat.js';
import { SCAN, isFor, type ChatService } from './chatService.js';

export const MAX_CATCHUP_MESSAGES = 80;
const CATCHUP_CONTEXT_BEFORE = 3;
const MAX_CATCHUP_MESSAGE_CHARS = 600;
export const ALL_CAUGHT_UP_TLDR = "You're all caught up ✨";

interface CatchupSummary {
  tldr: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
}

export interface CatchupResponse extends CatchupSummary {
  caughtUp: boolean;
  messageCount: number;
  capped?: boolean;
}

interface CatchupMessageInput {
  id?: string;
  seq: number;
  from: string;
  fromId: string;
  text: string;
  at: string;
  mentions?: string[];
}

interface CatchupSummarizerInput {
  viewer: { id: string; name: string };
  contextBefore: CatchupMessageInput[];
  unread: CatchupMessageInput[];
  capped: boolean;
}

export type CatchupSummarizer = (input: CatchupSummarizerInput) => Promise<CatchupSummary | undefined>;

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

const DECISION_RE =
  /\b(decided|agreed|approved|merged|shipped|resolved|confirmed|let's go with|going with)\b|החלטנו|אושר|מוזג|סוכם|מאשר|סגור|✅/i;

/**
 * Deterministic fallback summary when Vertex AI is unavailable or returns an invalid payload,
 * ensuring "Catch me up" never crashes and always returns a structured summary.
 */
function heuristicCatchupSummary(
  unread: CatchupMessageInput[],
  viewer: { id: string; name: string },
): CatchupSummary {
  if (unread.length === 0) {
    return {
      tldr: ALL_CAUGHT_UP_TLDR,
      decisions: [],
      actionItems: [],
      openQuestions: [],
    };
  }

  const authors = [...new Set(unread.map((m) => m.from).filter(Boolean))];
  const last = unread.at(-1)!;
  const lastSnippet = truncateMessageText(last.text, 160);
  const countLabel = unread.length === 1 ? '1 unread message' : `${unread.length} unread messages`;
  const fromLabel =
    authors.length > 0
      ? ` from ${authors.slice(0, 4).join(', ')}${authors.length > 4 ? ` and ${authors.length - 4} others` : ''}`
      : '';
  const tldr = `${countLabel}${fromLabel}. Latest from ${last.from}: "${lastSnippet}"`;

  const decisions: string[] = [];
  const actionItems: string[] = [];
  const openQuestions: string[] = [];

  const viewerNameLower = viewer.name.toLowerCase();

  for (const m of unread) {
    const snippet = truncateMessageText(m.text, 200);
    if (!snippet) continue;
    const formatted = `${m.from}: ${snippet}`;

    const mentionsViewer =
      Boolean(m.mentions?.includes(viewer.id)) ||
      (viewerNameLower.length > 1 && snippet.toLowerCase().includes(`@${viewerNameLower}`));

    // Action items are what's directed at the viewer: a mention of them.
    if (mentionsViewer) {
      if (actionItems.length < 5 && !actionItems.includes(formatted)) {
        actionItems.push(formatted);
      }
    }

    if (DECISION_RE.test(snippet)) {
      if (decisions.length < 5 && !decisions.includes(formatted)) {
        decisions.push(formatted);
      }
    }

    if (snippet.includes('?') || snippet.includes('؟')) {
      if (openQuestions.length < 5 && !openQuestions.includes(formatted)) {
        openQuestions.push(formatted);
      }
    }
  }

  return {
    tldr,
    decisions,
    actionItems,
    openQuestions,
  };
}

/**
 * Calls Vertex AI (using the Hub's service account) to produce a structured JSON catch-up summary
 * (`{ tldr, decisions, actionItems, openQuestions }`). Returns `undefined` if Vertex cannot be reached
 * or returns malformed JSON so the caller can fall back to `heuristicCatchupSummary`.
 */
export function vertexCatchupSummarizer(opts: {
  project: string;
  location: string;
  model: string;
  accessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CatchupSummarizer {
  return async ({ viewer, contextBefore, unread, capped }) => {
    if (unread.length === 0) {
      return {
        tldr: ALL_CAUGHT_UP_TLDR,
        decisions: [],
        actionItems: [],
        openQuestions: [],
      };
    }

    const formatLine = (m: CatchupMessageInput) => {
      const tagged = m.mentions?.includes(viewer.id) ? ` [mentions @${viewer.name}]` : '';
      return `[#${m.seq}] ${m.from}${tagged}: ${truncateMessageText(m.text, MAX_CATCHUP_MESSAGE_CHARS)}`;
    };

    const prompt = [
      `Summarize what ${viewer.name} (id: ${viewer.id}) missed in this conversation since their last read message.`,
      'Write the summary in the same language as the unread messages (Hebrew if primarily Hebrew, English if English).',
      'Return a structured JSON object with:',
      '- "tldr": A concise 1-3 sentence summary of what happened in the unread messages.',
      '- "decisions": Concrete decisions, approvals, or agreements reached in the unread messages (empty array if none).',
      `- "actionItems": Specific tasks, requests, or @mentions directed at ${viewer.name} (empty array if none).`,
      '- "openQuestions": Unanswered questions or blockers still waiting for a reply or decision (empty array if none).',
      ...(capped ? [`Note: Only the most recent ${unread.length} unread messages are included below.`] : []),
      '',
      ...(contextBefore.length
        ? [
            'Prior context before the unread messages (for background only — do not summarize as new unless referenced):',
            ...contextBefore.map(formatLine),
            '',
          ]
        : []),
      `Unread messages (${unread.length}):`,
      ...unread.map(formatLine),
    ].join('\n');

    const started = Date.now();
    try {
      const out = await generate({
        project: opts.project,
        location: opts.location,
        model: opts.model,
        prompt,
        thinkingLevel: 'low',
        schema: {
          type: 'OBJECT',
          properties: {
            tldr: { type: 'STRING' },
            decisions: { type: 'ARRAY', items: { type: 'STRING' } },
            actionItems: { type: 'ARRAY', items: { type: 'STRING' } },
            openQuestions: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['tldr', 'decisions', 'actionItems', 'openQuestions'],
        },
        timeoutMs: opts.timeoutMs ?? 12_000,
        accessToken: opts.accessToken,
        fetchImpl: opts.fetchImpl,
      });

      if (!out.ok) {
        console.error(`catchup: ${opts.model} answered HTTP ${out.status} in ${Date.now() - started}ms`);
        return undefined;
      }

      const parsed = JSON.parse(out.text || '') as Partial<CatchupSummary>;
      const tldr = typeof parsed.tldr === 'string' && parsed.tldr.trim() ? parsed.tldr.trim() : undefined;
      if (!tldr) return undefined;

      return {
        tldr,
        decisions: normalizeList(parsed.decisions),
        actionItems: normalizeList(parsed.actionItems),
        openQuestions: normalizeList(parsed.openQuestions),
      };
    } catch (err) {
      console.error(`catchup: failed in ${Date.now() - started}ms (${(err as Error).name}), using fallback`);
      return undefined;
    }
  };
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

/**
 * Builds the `CatchupResponse` from a conversation's messages and effective read cursor (`effectiveSeenSeq`).
 */
async function buildCatchupResponse(input: {
  messages: CatchupMessageInput[];
  older?: boolean;
  effectiveSeenSeq: number;
  viewer: { id: string; name: string };
  rootPost?: CatchupMessageInput;
  summarize?: CatchupSummarizer;
  onWillSummarize?: () => void;
}): Promise<CatchupResponse> {
  const { messages, older, effectiveSeenSeq, viewer, rootPost, summarize, onWillSummarize } = input;
  const unreadAll = messages.filter((m) => m.seq > effectiveSeenSeq && m.fromId !== viewer.id && m.text.trim().length > 0);

  if (unreadAll.length === 0) {
    return {
      caughtUp: true,
      messageCount: 0,
      tldr: ALL_CAUGHT_UP_TLDR,
      decisions: [],
      actionItems: [],
      openQuestions: [],
    };
  }

  onWillSummarize?.();

  const capped =
    unreadAll.length > MAX_CATCHUP_MESSAGES ||
    (Boolean(older) && messages.length > 0 && messages[0]!.seq > effectiveSeenSeq && unreadAll.length >= MAX_CATCHUP_MESSAGES);
  const unreadWindow = unreadAll.slice(-MAX_CATCHUP_MESSAGES);
  const firstUnreadSeq = unreadWindow[0]!.seq;

  const priorMessages = messages.filter((m) => m.seq < firstUnreadSeq && m.text.trim().length > 0);
  const contextBefore = [
    ...(rootPost && rootPost.text.trim().length > 0 ? [rootPost] : []),
    ...priorMessages,
  ].slice(-CATCHUP_CONTEXT_BEFORE);

  const llmSummary = summarize
    ? await summarize({
        viewer,
        contextBefore,
        unread: unreadWindow,
        capped,
      })
    : undefined;

  const summary = llmSummary ?? heuristicCatchupSummary(unreadWindow, viewer);

  return {
    caughtUp: false,
    messageCount: unreadWindow.length,
    ...(capped ? { capped: true } : {}),
    tldr: summary.tldr,
    decisions: summary.decisions,
    actionItems: summary.actionItems,
    openQuestions: summary.openQuestions,
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

/**
 * Generates a structured "Catch me up" summary of unread messages in `key` since `viewer`'s read cursor
 * (or optional `opts.sinceSeq` captured before `<MarkRead />` ran). Never advances the read cursor.
 */
export async function summarizeCatchup(chat: ChatService, viewer: AgentRecord, key: string, opts?: { sinceSeq?: number }): Promise<CatchupResponse> {
  const id = chat.keyFor(viewer, key);
  if (!(await chat.canRead(viewer, id))) throw new HubError('not_found', `No conversation "${key}"`);
  const p = parseKey(id);

  let rootPostInput: CatchupMessageInput | undefined;
  if (p.kind === 'thread') {
    const first = await chat.store.message(p.post).catch(() => undefined);
    if (!first || first.conversationId !== channelKey(p.channelId)) {
      throw new HubError('not_found', `No thread ${p.post} in this channel`);
    }
    rootPostInput = {
      id: first.id,
      seq: 0,
      from: first.from,
      fromId: first.fromId,
      text: textOf(first),
      at: first.at,
      ...(first.mentions?.length ? { mentions: first.mentions } : {}),
    };
  }

  const conv = await chat.store.conversation(id);
  if (!conv) {
    return buildCatchupResponse({
      messages: [],
      older: false,
      effectiveSeenSeq: 0,
      viewer: { id: viewer.id, name: viewer.name },
    });
  }

  const [messages, seen, chMap] = await Promise.all([
    chat.store.page(conv.id, MAX_CATCHUP_MESSAGES + 20),
    opts?.sinceSeq !== undefined ? Promise.resolve({} as Record<string, number>) : chat.store.seenIn(conv.id, [viewer.id]),
    conv.kind === 'channel' ? chat.registry.channelsById([conv.channelId!]) : Promise.resolve(new Map<string, ChannelRecord>()),
  ]);
  const ch = conv.kind === 'channel' ? chMap.get(conv.channelId!) : undefined;
  const effectiveSeenSeq =
    opts?.sinceSeq !== undefined && Number.isInteger(opts.sinceSeq) && opts.sinceSeq >= 0
      ? opts.sinceSeq
      : (seen[viewer.id] ?? 0);

  const visible = messages.filter(
    (m) => (conv.kind !== 'channel' || !ch || !isDoneThread(ch, m.id)) && (m.fromId === viewer.id || isFor(viewer, m)),
  );
  const older = (messages[0]?.seq ?? 1) > 1;

  const channelInputs: CatchupMessageInput[] = visible.map((m) => ({
    id: m.id,
    seq: m.seq,
    from: m.from,
    fromId: m.fromId,
    text: textOf(m),
    at: m.at,
    ...(m.mentions?.length ? { mentions: m.mentions } : {}),
  }));

  // For a channel-level catchup, also gather unread replies from active (non-done) threads in this channel
  // so channels whose new activity is inside threads don't falsely return caughtUp: true.
  if (conv.kind === 'channel' && conv.channelId) {
    const channelId = conv.channelId;
    const postById = new Map(visible.map((m) => [m.id, m]));
    const candidateThreadIds = new Set<string>(visible.map((m) => threadKey(channelId, m.id)));
    const [postThreadConvs, mineConvs] = await Promise.all([
      chat.store.conversations([...candidateThreadIds]),
      chat.store.mine(viewer.id),
    ]);
    const threadConvs = new Map<string, ConversationDoc>(postThreadConvs);
    for (const mc of mineConvs) {
      if (mc.kind === 'thread' && mc.channelId === channelId) {
        threadConvs.set(mc.id, mc);
      }
    }
    const activeThreads = [...threadConvs.values()].filter(
      (tc) =>
        tc.seq > 0 &&
        !tc.doneAt &&
        (!ch || !isDoneThread(ch, tc.post)) &&
        (tc.participants?.includes(viewer.id) || postById.get(tc.post ?? '')?.fromId === viewer.id),
    );
    if (activeThreads.length > 0) {
      const threadCursors = await chat.store.cursorsOf(
        viewer.id,
        activeThreads.map((tc) => tc.id),
      );
      const unreadThreadBatches = await Promise.all(
        activeThreads.map(async (tc) => {
          const seenThread = threadCursors.get(tc.id)?.seenUpTo ?? 0;
          if (tc.seq <= seenThread) return [];
          const replies = await chat.store.since(tc.id, seenThread, SCAN);
          const rootPost = tc.post ? postById.get(tc.post) ?? (await chat.store.message(tc.post).catch(() => undefined)) : undefined;
          const rootPreview = rootPost ? textOf(rootPost).replace(/\s+/g, ' ').trim().slice(0, 80) : undefined;
          return replies
            .filter((r) => r.fromId !== viewer.id && isFor(viewer, r))
            .map((r) => ({
              id: r.id,
              from: r.from,
              fromId: r.fromId,
              text: rootPreview ? `[Thread "${rootPreview}"] ${textOf(r)}` : textOf(r),
              at: r.at,
              ...(r.mentions?.length ? { mentions: r.mentions } : {}),
            }));
        }),
      );
      const flatThreadReplies = unreadThreadBatches.flat().sort((a, b) => a.at.localeCompare(b.at));
      let nextSyntheticSeq = Math.max(effectiveSeenSeq, channelInputs.at(-1)?.seq ?? 0) + 1;
      for (const tr of flatThreadReplies) {
        channelInputs.push({
          ...tr,
          seq: nextSyntheticSeq++,
        });
      }
    }
  }

  return buildCatchupResponse({
    messages: channelInputs,
    older,
    effectiveSeenSeq,
    viewer: { id: viewer.id, name: viewer.name },
    rootPost: rootPostInput,
    summarize: chat.catchup,
    onWillSummarize: () => chat.catchupLimiter?.hit(viewer.id),
  });
}
