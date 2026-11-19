import type { SlackCopy } from '../lib/bridgeTypes.js';
import type { TelegramCopy } from '../lib/bridgeTypes.js';
import { HubError } from '../lib/errors.js';
import type { WirePart } from '../lib/wire.js';
import type { SkillType } from '../registry/types.js';

/**
 * The chat: one message record per message, one cursor per participant per conversation. One sends, every
 * participant gets it. Nothing is copied per recipient, nothing is claimed, nothing is "working".
 *
 * A conversation is a channel's top-level posts (`channel:<channelId>`), one post's thread
 * (`thread:<channelId>:<postId>`), or a direct conversation between two agents (`dm:<idA>_<idB>`, ids sorted).
 */
export type ConversationKind = 'channel' | 'thread' | 'dm';

/**
 * A commit time as plain fields — seconds since the epoch plus nanoseconds within the second, the public shape of a
 * DB Timestamp. The DB layer (ChatStore) reads these off its Timestamps; nothing outside it needs the class,
 * so the rest of the app stays DB-agnostic. A real Timestamp satisfies this structurally.
 */
export interface CommitTime {
  seconds: number;
  nanoseconds: number;
}

/** Collection `conversations`, doc id = key. Written in the same transaction as each of its messages. */
export interface ConversationDoc {
  id: string;
  kind: ConversationKind;
  channelId?: string;
  workspaceId?: string;
  /** Threads: the post's message id. */
  post?: string;
  /**
   * Who gets its messages. DMs: both sides. Threads: the post's author, everyone who wrote, everyone mentioned.
   * Channels: not stored (the registry's membership is).
   */
  participants: string[];
  /** DMs: both sides' names, so the conversation still shows who it was with once one side is gone. */
  names?: Record<string, string>;
  /** The newest message's seq; 0 before the first. */
  seq: number;
  lastAt: string;
  lastFrom: string;
  /** The newest message's sender's name and the start of its text: a list's preview. */
  lastFromName: string;
  lastText: string;
  /** The last few writers, newest first, for a thread's summary. */
  recent: string[];
  /** Consecutive messages from agents since a person last wrote (see agentRunMax()). */
  agentRun: number;
  /** Commit time of the last message, by the DB: orders the event feed. */
  changedAt: CommitTime;
  createdAt: string;
  /** Threads: ISO timestamp and agent id when marked as done; cleared on reopen. */
  doneAt?: string;
  doneBy?: string;
  /** Channels: set once pre-existing top-level posts have had `done: boolean` backfilled on their `messages` docs. */
  doneBackfilled?: boolean;
  /** Channels: resume point while backfilling `done` — the lowest seq already covered, so a timed-out run picks up at `seq < doneBackfillSeq` instead of re-reading the whole channel. Cleared once doneBackfilled. */
  doneBackfillSeq?: number;
  /** Threads (THREAD_DIGEST): a rolling summary of replies up to digestUpToSeq, served in place of their full text. */
  threadDigest?: string;
  /** The newest reply seq folded into threadDigest; replies past it are served verbatim. */
  digestUpToSeq?: number;
  /** Lease expiry (epoch ms) while a hub instance is folding replies into `threadDigest`. */
  digestFoldUntilMs?: number;
}

/** Collection `messages`, doc id = message id. Never updated. */
interface MessageQuote { id: string; fromId: string; from: string; text: string }

export interface MessageDoc {
  replyTo?: MessageQuote;
  id: string;
  conversationId: string;
  kind: ConversationKind;
  channelId?: string;
  workspaceId?: string;
  /** Thread messages: the post. */
  post?: string;
  /** 1, 2, 3… within the conversation, with no gaps. */
  seq: number;
  from: string;
  fromId: string;
  at: string;
  /** Commit time, same as the conversation's changedAt when this was its newest message. */
  createdAt: CommitTime;
  parts: WirePart[];
  /** Agent ids it mentions ("@Name"). */
  mentions?: string[];
  /** Rooms only: the agents it is handed and pushed to. Absent: every participant. Everyone in the channel can still read it. */
  to?: string[];
  /**
   * The agents it's for, when its @mentions or the router narrowed who hears it: the others in the conversation don't
   * get it in their inbox (they still read it, and see it before what's next for them). Absent: every participant.
   */
  forAgents?: string[];
  /** Ids of uploaded files in `parts`, for download checks. */
  files?: string[];
  /** The conversation's agentRun with this message. */
  agentRun: number;
  /** Written in Slack by someone without a linked Parly account: shown in the thread, never wakes an agent on its own. */
  external?: boolean;
  /** Channel posts: whether the thread is marked as done, so `page()` can filter `threads=open|done` in the query. */
  done?: boolean;
  /** `webhook`: posted by a channel's incoming webhook (an outside service) as the person who made it. */
  meta?: { roomThread?: string; agent?: string; webhook?: { id: string; name: string }; scheduled?: boolean; skills?: SkillShown[] };
  /** Its copies in Slack (the Slack bridge): where it was written, or where the bridge posted it. */
  slack?: SlackCopy[];
  /** Its copies in Telegram (the Telegram bridge): where it was written, or where the bridge posted it. */
  telegram?: TelegramCopy[];
}

/** Collection `cursors`, doc id = `${agentId}_${conversationId}`. */
export interface CursorDoc {
  agentId: string;
  conversationId: string;
  /** Everything up to this seq is seen: answered, pushed, read on a page, or written by them (or handed out, then the next check_inbox). */
  seenUpTo: number;
  updatedAt: string;
  /** Endpoint agents: their own A2A conversation for this one, sent back with each push. */
  downstream?: { contextId?: string; taskId?: string };
  /** Endpoint agents: the seq a push is asking about, until it's seen. Can be alone on a first push, with no `seenUpTo` yet. */
  sending?: number;
  /** Mailbox agents: handed out up to this seq by check_inbox / wait_for_message, not acked yet. Hidden until `handedUntilMs`, then offered again. */
  handedUpTo?: number;
  handedUntilMs?: number;
}

/** How long an inbox item handed out and not answered stays hidden before it's offered again. */
export const HAND_MS = 10 * 60_000;

/** Past this many agents' messages in a row, agents aren't handed or pushed new ones there until a person writes. Override via AGENT_RUN_MAX. */
export const agentRunMax = () => Number(process.env.AGENT_RUN_MAX) || 1000;
/** Past agentRunMax(), a direct @mention still wakes/hands the message to that agent up to this higher cap. */
export const agentRunMaxMentioned = () => Number(process.env.AGENT_RUN_MAX_MENTIONED) || 4000;
/** Most earlier messages that come with an inbox item or a push. */
export const EARLIER_MAX = 10;
/** THREAD_DIGEST: fold once at least this many replies sit between the digest and the verbatim tail (keeps fold calls rare). */
export const DIGEST_FOLD_MIN = 5;
/** THREAD_DIGEST: most replies folded in one call; the rest wait for the next post. */
export const DIGEST_FOLD_MAX = 50;
/** THREAD_DIGEST: shared DB fold lease TTL (covers the 12s Vertex call with slack). */
export const DIGEST_FOLD_LEASE_MS = 30_000;
/** Most characters of each of those earlier messages: one long paste shouldn't ride along with every wake. */
const EARLIER_TEXT_MAX = 2000;
/** Replies read_thread returns unless asked for more: a wake shouldn't pull a whole long thread into every session. */
export const THREAD_READ_DEFAULT = 20;
export const THREAD_READ_MAX = 200;

export const clipEarlier = (text: string) => (text.length > EARLIER_TEXT_MAX ? `${text.slice(0, EARLIER_TEXT_MAX)}… (cut)` : text);

export const channelKey = (channelId: string) => `channel:${channelId}`;
export const threadKey = (channelId: string, post: string) => `thread:${channelId}:${post}`;
/** How long a load waits for a message to show it. */
const SKILL_LOAD_TTL_MS = 30 * 60_000;

/** A skill or process as a message shows it was loaded. */
export type SkillShown = { id: string; name: string; type: SkillType };

/** A get_skill not shown yet: tagged with the turn it was made in, for an agent Parly runs. */
export type SkillLoad = SkillShown & { conversation?: string; messageId?: string; at: string };

export const keptSkillLoads = (loads: SkillLoad[], now: number) => loads.filter((l) => now - Date.parse(l.at) < SKILL_LOAD_TTL_MS);

/** A load from a channel wake counts in that channel and in the thread of the message that woke it, where the answer lands. */
function skillLoadMatches(load: SkillLoad, conversationId: string): boolean {
  if (!load.conversation || load.conversation === conversationId) return true;
  if (!load.messageId || !load.conversation.startsWith('channel:')) return false;
  return conversationId === threadKey(load.conversation.slice('channel:'.length), load.messageId);
}

/** Splits pending loads: what a message in `conversationId` shows, once per id, and what stays. Expired ones are dropped. */
export function takeSkillLoads(pending: SkillLoad[], conversationId: string, showable: Set<string>, now: number): { shown: SkillShown[]; left: SkillLoad[] } {
  const shown = new Map<string, SkillShown>();
  const left: SkillLoad[] = [];
  for (const load of keptSkillLoads(pending, now)) {
    if (showable.has(load.id) && skillLoadMatches(load, conversationId)) shown.set(load.id, { id: load.id, name: load.name, type: load.type });
    else left.push(load);
  }
  return { shown: [...shown.values()], left };
}

export const dmKey = (a: string, b: string) => `dm:${[a, b].sort().join('_')}`;
export const cursorId = (agentId: string, conversationId: string) => `${agentId}_${conversationId}`;

type ParsedKey =
  | { kind: 'channel'; channelId: string }
  | { kind: 'thread'; channelId: string; post: string }
  | { kind: 'dm'; ids: [string, string] };

export function parseKey(key: string): ParsedKey {
  const [kind, a, b, ...more] = key.split(':');
  if (more.length === 0) {
    if (kind === 'channel' && a && b === undefined) return { kind: 'channel', channelId: a };
    if (kind === 'thread' && a && b) return { kind: 'thread', channelId: a, post: b };
    const ids = kind === 'dm' && a && b === undefined ? a.split('_') : [];
    const [x, y] = ids;
    if (ids.length === 2 && x && y) return { kind: 'dm', ids: [x, y] };
  }
  throw new HubError('invalid', `No conversation "${key}"`);
}

/** The other side of a DM, as the web names it: "agent:<id>". */
export function dmWith(key: string, me: string): string | undefined {
  const p = parseKey(key);
  return p.kind === 'dm' ? (p.ids[0] === me ? p.ids[1] : p.ids[0]) : undefined;
}

/** A position in the event feed: after message `id`, committed at `at` ("" = after everything at `at`). */
interface FeedCursor {
  at: CommitTime;
  id: string;
}

const commitFromMillis = (ms: number): CommitTime => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });

/** Cursor text: "<seconds>.<nanos>|<id>". A bare ISO time means "after that time"; none means now. */
export function parseFeedCursor(cursor: string | undefined): FeedCursor {
  if (!cursor) return { at: commitFromMillis(Date.now()), id: '' };
  const m = /^(\d+)\.(\d{9})\|(.*)$/.exec(cursor);
  if (m) return { at: { seconds: Number(m[1]), nanoseconds: Number(m[2]) }, id: m[3]! };
  const time = Date.parse(cursor);
  if (Number.isNaN(time)) throw new HubError('invalid', 'cursor must be a cursor returned by the feed, or since an ISO time');
  return { at: commitFromMillis(time), id: '' };
}

export function formatFeedCursor(c: FeedCursor): string {
  return `${c.at.seconds}.${String(c.at.nanoseconds).padStart(9, '0')}|${c.id}`;
}
