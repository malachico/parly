import { HubError } from '../lib/errors.js';
import { newId, nowIso, textOf, type WirePart } from '../lib/wire.js';
import { mentionsIn } from '../hub/mentions.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import { isListening, sharesWorkspace, type Registry } from '../registry/registry.js';
import type { Activity } from './activity.js';
import { changed, watch, type Change } from './notifier.js';
import { isDoneThread, isPublicWorkspace, type AgentRecord, type ChannelRecord, type RoomInfo, type SkillRecord, type WorkspaceRecord } from '../registry/types.js';
import {
  EARLIER_MAX,
  THREAD_READ_MAX,
  HAND_MS,
  agentRunMax,
  agentRunMaxMentioned,
  channelKey,
  dmKey,
  formatFeedCursor,
  parseFeedCursor,
  parseKey,
  threadKey,
  type ConversationDoc,
  type MessageDoc,
} from './chat.js';
import {
  foldDigest,
  summarizeCatchup,
  type CatchupResponse,
  type CatchupSummarizer,
  type ThreadDigestFolder,
} from './catchup.js';
import type { PushQueue } from './queue.js';
import type { Route } from './router.js';
import type { ChatStore, NewConversation } from './store.js';

/** Where a message goes: a channel (its top level, or a post's thread), or a direct conversation. */
export type Target = { channelId: string; thread?: string } | { dm: string };

export interface PostInput {
  /** Quote a message in the same conversation (a thread may also quote its root post). */
  replyTo?: string;
  /** Already trusted (Files.trusted): parts can't grant access to files the sender can't. */
  parts: WirePart[];
  /** A fixed id makes the post idempotent (an endpoint agent's answer). */
  id?: string;
  /** Rooms: who it is handed and pushed to (see MessageDoc.to). */
  to?: string[];
  meta?: MessageDoc['meta'];
  /** Its copy in Slack, when it was written there (the Slack bridge): the bridge doesn't post it back. */
  slack?: MessageDoc['slack'];
  /** Its copy in Telegram, when it was written there (the Telegram bridge): the bridge doesn't post it back. */
  telegram?: MessageDoc['telegram'];
  /** An unlinked Slack participant in a linked channel: stored under their Slack name and id, marked external. */
  external?: { id: string; name: string };
}

export interface Posted {
  conversation: ConversationDoc;
  message: MessageDoc;
  /** Everyone else it went to. */
  recipients: AgentRecord[];
}

/** What a shared room does with a post (RoomTalks). Set on the service once both exist. */
export interface RoomHooks {
  sideOf(room: RoomInfo, agent: AgentRecord): { id: string } | undefined;
  /** Before a post: may change what is stored and who it goes to. */
  prepare(from: AgentRecord, channel: ChannelRecord, workspace: WorkspaceRecord | undefined, input: PostInput, thread?: string): Promise<PostInput>;
  /** After a post is stored. */
  afterPost(from: AgentRecord, channel: ChannelRecord, workspace: WorkspaceRecord | undefined, message: MessageDoc): Promise<void>;
}

/** One conversation's new messages for an agent: the newest one for them, and some of what came before it. */
export interface InboxItem {
  conversation: ConversationDoc;
  message: MessageDoc;
  earlier: MessageDoc[];
  /** Earlier messages not included. */
  earlierMore: number;
  /** THREAD_DIGEST: a rolling summary of the replies folded away before `earlier`, when any were. */
  digest?: string;
}

/** Something waiting for a person's answer (GET /waiting): a mention not answered since, or a DM whose last word isn't theirs. */
interface WaitingItem {
  kind: 'mention' | 'dm';
  /** Where an answer goes, as POST /conversations/:key/messages takes it. */
  replyTo: string;
  /** The conversation to open. */
  open: string;
  messageId?: string;
  channelId?: string;
  from: string;
  fromId: string;
  /** The sender's own avatar and kind, so it looks the same as everywhere else. */
  fromAvatar?: string;
  fromKind?: string;
  text: string;
  at: string;
}

interface ConversationSummary {
  conversation: ConversationDoc;
  unread: number;
  /** Unread messages that mention the viewer. */
  mentions: number;
  /** A channel with nothing new itself, only in threads: the post of the newest such thread (open that). */
  thread?: string;
}

interface ThreadSummary {
  count: number;
  lastAt: string;
  people: string[];
  /** Replies the viewer hasn't seen (none when the last word is theirs). */
  unread?: number;
  /** Whether the thread is marked as done (and when/by whom). */
  done?: boolean;
  doneAt?: string;
  doneBy?: string;
}

interface ChatOptions {
  maxWaitMs: number;
  sendLimiter?: RateLimiter;
  /** A mailbox bot has something new (HubService wakes its Routine). */
  onMailbox?: (agent: AgentRecord, fromName: string) => void;
  /** How often a wait re-reads the store with no change heard on this instance (a post on another instance). */
  pollMs?: number;
}

/** Waits wake at once for a post on this instance; this slow re-read catches the others' (Cloud Run runs several). */
const WAIT_POLL_MS = 10_000;
const EVENTS_LIMIT = 50;
export const SCAN = 50;
/** Pause before the one retry of a push enqueue that failed. */
const PUSH_RETRY_MS = 500;

/** How many of the messages before it the router reads with a post naming no agent. */
const ROUTE_CONTEXT = 3;
/**
 * ponytail: an agent's thread reply the router can't place wakes the thread's agents only while fewer than this many
 * agents' messages in a row precede it, so a router outage can't bounce two agents off each other; tune if real
 * threads need longer guessed chains.
 */
const ROUTE_FALLBACK_RUN = 2;

/**
 * Who a channel post or thread reply wakes: when it @mentions agents, only those (and people, who read on their own);
 * the rest would each spend a model call to pass. They still read it. Naming nobody, or only people: everyone, as before.
 */
function onlyNamed(recipients: AgentRecord[], mentions: string[]): AgentRecord[] {
  const named = new Set(mentions);
  return recipients.some((a) => a.kind !== 'human' && named.has(a.id)) ? recipients.filter((a) => a.kind === 'human' || named.has(a.id)) : recipients;
}

/**
 * What counts as unread for `viewer` in one conversation's messages: past their cursor, for them (isFor), and not in a
 * Done thread (`ch` only for a channel's own messages). One rule for the sidebar, ⌘K, a page and its thread badges.
 */
function unreadOf(viewer: Pick<AgentRecord, 'id' | 'kind'>, messages: MessageDoc[], seenUpTo: number, ch?: Pick<ChannelRecord, 'doneThreads'>): MessageDoc[] {
  return messages.filter((m) => m.seq > seenUpTo && !(ch && isDoneThread(ch, m.id)) && isFor(viewer, m));
}

/** Whether `agent` is handed (and pushed) a message: not its own, never an external Slack message for a bot, addressed to it in a room, and otherwise not past the agents' run. */
export function isFor(agent: Pick<AgentRecord, 'id' | 'kind'>, m: MessageDoc): boolean {
  // A webhook's post in a channel is news to its maker too; a trigger's event in their DM with an agent is for the
  // agent (24 "branch changed" in your own conversation aren't news to you; what the agent says about them is).
  if (m.fromId === agent.id && (!m.meta?.webhook || m.conversationId.startsWith('dm:'))) return false;
  if (m.external && agent.kind !== 'human') return false;
  // Addressed (a room's turn): the room keeps its own count of turns.
  if (m.to) return m.to.includes(agent.id);
  if (m.forAgents && agent.kind !== 'human' && !m.forAgents.includes(agent.id)) return false;
  return agent.kind === 'human' || m.agentRun <= agentRunMax() || (Boolean(m.mentions?.includes(agent.id)) && m.agentRun <= agentRunMaxMentioned());
}

/** A change in one of `agent`'s conversations: a DM or thread it's in, or one of its channels. */
const touches = (agent: AgentRecord) => (c: Change) => Boolean(c.participants?.includes(agent.id) || (c.channelId && agent.channels?.includes(c.channelId)));

/**
 * The chat: one message per message, one cursor per participant (see chat.ts). One sends, every participant
 * gets it: mailbox agents and people read what's past their cursor, endpoint agents are pushed it (Pusher).
 */
export class ChatService {
  /** Set by HubService once RoomTalks exists. */
  rooms?: RoomHooks;
  /** Live agent activity (waking, reading, working), when the hub keeps it. */
  activity?: Activity;
  /** Told of each new message once it's stored (the Slack bridge mirrors it). Never awaited: it can't fail a post. */
  onPosted?: (message: MessageDoc) => void;
  /** Writes an agent's message into its day (HubService.logPosted). Never awaited either. */
  logPosted?: (message: MessageDoc) => void;
  /** Picks who a person's channel post that names no agent is for (a cheap model), so not every agent spends a call to pass. */
  route?: Route;
  /** Summarizes unread messages in a conversation for "Catch me up" (Vertex Flash model, with heuristic fallback). */
  catchup?: CatchupSummarizer;
  /** Per-user rate limiter for "Catch me up" LLM summarizations. */
  catchupLimiter?: RateLimiter;
  /** Context graph: how long after a channel's last post to extract it; unset, channels are never extracted. */
  graphChannelDelayMs?: number;
  /** Quiet period before a thread reply's graph run; a later reply supersedes it. Unset: threads run on done/reopen only. */
  graphThreadDelayMs?: number;
  /** THREAD_DIGEST: folds a thread's older replies into a rolling digest so wakes carry a recap, not the whole history. */
  fold?: ThreadDigestFolder;

  constructor(
    readonly store: ChatStore,
    readonly registry: Registry,
    private readonly queue: PushQueue,
    private readonly opts: ChatOptions,
  ) {}

  /** Stores a message and hands it to the conversation's participants. */
  async post(from: AgentRecord, target: Target, input: PostInput): Promise<Posted> {
    if (input.parts.length === 0) throw new HubError('invalid', 'Message must contain text or data');
    // Posted already (a retried push): nothing to do, and running the room's hooks again would spend a turn.
    const existing = input.id ? await this.store.message(input.id) : undefined;
    const posted = existing && (await this.store.conversation(existing.conversationId));
    if (existing && posted) return { conversation: posted, message: existing, recipients: [] };
    const senderId = input.external?.id ?? from.id;
    // Every attempt counts, sent or refused, so probing for agents costs the same as messaging them. A webhook has its own budget.
    this.opts.sendLimiter?.hit(input.meta?.webhook ? `webhook:${input.meta.webhook.id}` : senderId);
    if ('dm' in target) return this.postDm(from, target.dm, input);

    const channel = await this.registry.requireChannelMembership(from, target.channelId);
    if (channel.archived) throw new HubError('invalid', `Channel "${channel.name}" is archived; an owner can restore it`);
    const workspace = await this.registry.workspaceById(channel.workspaceId);
    if (workspace?.archived) throw new HubError('invalid', "This channel's workspace is archived; an owner can restore it");
    if (this.rooms) input = await this.rooms.prepare(from, channel, workspace ?? undefined, input, target.thread);

    // A room's moderator only speaks; nothing is sent to it.
    const members = (await this.registry.search(from, { channel: channel.id })).filter((a) => !a.archived && a.id !== workspace?.room?.moderator);
    // A webhook can @mention (and notify) its maker; anyone else doesn't hear their own post.
    const others = members.filter((a) => a.id !== senderId || input.meta?.webhook);
    const mentions = mentionsIn(input.parts.map((p) => p.text ?? '').join('\n'), others);

    let conversation: NewConversation;
    let recipients: AgentRecord[];
    let join: string[] = [];
    // Who hears it when it names no agent: the router may narrow those down.
    let heard: AgentRecord[];
    let post: MessageDoc | undefined;
    let quote: MessageDoc['replyTo'];
    // An agent's thread reply the router can't place: who was in the thread before it (see ROUTE_FALLBACK_RUN).
    let fallback: string[] = [];
    let reopened = false;
    if (target.thread) {
      post = await this.store.message(target.thread);
      if (!post || post.conversationId !== channelKey(channel.id)) throw new HubError('not_found', `No post ${target.thread} in this channel to reply to`);
      const key = threadKey(channel.id, post.id);
      quote = await this.quote(input.replyTo, key, post.id);
      const existing = await this.store.conversation(key);
      if (isDoneThread(channel, post.id) || existing?.doneAt) {
        if ((from.kind !== 'human' && !input.external) || Boolean(input.meta?.webhook)) {
          await this.activity?.clear(from.id, key).catch(() => {});
          throw new HubError('invalid', 'Thread is marked as done');
        }
        await Promise.all([this.registry.clearThreadDone(channel.id, post.id), this.store.setThreadDone(channel.id, post.id, null)]);
        channel.doneThreads = (channel.doneThreads ?? []).filter((p) => p !== post!.id);
        reopened = true;
      }
      // Those it's addressed to (in a room) and those it mentions join the thread.
      join = [...mentions, ...(input.to ?? [])];
      if ((existing?.agentRun ?? 0) < ROUTE_FALLBACK_RUN) fallback = (existing?.participants ?? [post.fromId]).filter((id) => id !== senderId);
      const participants = new Set([...(existing?.participants ?? [post.fromId]), ...join]);
      // The first reply to your own post, with nobody mentioned: the channel hears it and joins the thread.
      if ([...participants].every((id) => id === senderId)) {
        join = others.map((a) => a.id);
        join.forEach((id) => participants.add(id));
      }
      conversation = { id: key, kind: 'thread', channelId: channel.id, workspaceId: channel.workspaceId, post: post.id, participants: [...participants] };
      heard = others.filter((a) => participants.has(a.id));
    } else {
      conversation = { id: channelKey(channel.id), kind: 'channel', channelId: channel.id, workspaceId: channel.workspaceId, participants: [] };
      heard = others;
      quote = await this.quote(input.replyTo, conversation.id);
    }
    recipients = onlyNamed(heard, mentions);
    // A post or thread reply naming no agent: wake only the agents it's for (all of them if it can't tell). A person's
    // with one agent there is for that one; an agent's may be for nobody ("Thanks!" doesn't wake the other).
    const agents = recipients.filter((a) => a.kind !== 'human' && !a.webhookChannel);
    const text = input.parts.map((p) => p.text ?? '').join('\n').trim();
    // A person's top-level post in a channel that runs a process is a kickoff (e.g. a showcase pitch): the process's
    // first-step agent must always engage, even if the router below reads the post as chatter and picks nobody.
    // Computed now, while recipients still == heard; re-added after the router narrows them.
    const kickoff =
      conversation.kind === 'channel' && from.kind === 'human' && !input.to && recipients === heard && text && channel.attachedSkills?.length && isPublicWorkspace(workspace)
        ? await this.firstStepAgent(channel, agents)
        : undefined;
    // Nothing to read (just a file): no pick to make, so everyone, as before. A room's turn is addressed already.
    if (this.route && agents.length > (from.kind === 'human' ? 1 : 0) && recipients === heard && text && !input.to) {
      // What was said just before: "2" or "yes" is an answer to whoever asked.
      const before = await this.store.page(conversation.id, ROUTE_CONTEXT);
      const recent = [...(post && before.length < ROUTE_CONTEXT ? [post] : []), ...before].map((m) => ({ name: m.from, text: m.parts.map((p) => p.text ?? '').join(' ') }));
      if (quote) recent.push({ name: quote.from, text: `Quoted message: ${quote.text}` });
      const picked = await this.route(text, agents.map((a) => ({ id: a.id, name: a.name, description: a.description, role: channel.roles?.[a.id] })), { name: from.name, agent: from.kind !== 'human' }, recent);
      // A router failure wakes everyone for a person. An agent's wakes the agents already in its thread (a short run
      // only), and none for a top-level post: chains stay narrow.
      let wake = picked ?? (from.kind === 'human' ? undefined : fallback);
      // A person is never left unheard: if the router picks nobody, one agent gets it (theirs if they have one here).
      // A kickoff already covers it.
      if (wake?.length === 0 && from.kind === 'human' && !kickoff) wake = [(agents.find((a) => a.ownerId === from.id) ?? agents[0]!).id];
      if (wake) recipients = recipients.filter((a) => a.kind === 'human' || a.webhookChannel || wake.includes(a.id));
    }
    // Kickoff always wins: a pitch into a process channel starts the process even if the router dropped everyone.
    if (kickoff && !recipients.includes(kickoff)) recipients = [...recipients, kickoff];
    // ...and it's addressed to the first-step agent, so it answers instead of being told it "may pass".
    const addressed = kickoff && !mentions.includes(kickoff.id) ? [...mentions, kickoff.id] : mentions;

    // Narrowed (by its mentions or the router): it's only in the inbox of the agents it's for.
    const forAgents = recipients !== heard ? recipients.filter((a) => a.kind !== 'human').map((a) => a.id) : undefined;
    const stored = await this.store.append(conversation, this.newMessage(from, input, addressed, forAgents, quote), join, await this.showableSkills(from, input, channel, workspace));
    if (stored.created) {
      changed({ conversationId: stored.message.conversationId, channelId: stored.conversation.channelId, participants: stored.conversation.participants });
      await this.handOut(stored.message, recipients, from);
      if (this.rooms) await this.rooms.afterPost(from, channel, workspace ?? undefined, stored.message);
      this.onPosted?.(stored.message);
      this.logPosted?.(stored.message);
      // Context graph: each top-level channel post (and, with graphThreadDelayMs, each thread reply) schedules a run after
      // the quiet period; the run skips if a newer post came (debounce).
      const { kind, workspaceId, id: conversationId } = stored.conversation;
      const { seq } = stored.message;
      const threadReply = kind === 'thread' && !reopened && this.graphThreadDelayMs !== undefined;
      // A reopened done thread is re-extracted now (the same job as marking it done; a thread run replaces its graph).
      if (this.graphChannelDelayMs !== undefined && (kind === 'channel' || reopened || threadReply) && workspaceId) {
        const job = { kind: 'graph' as const, workspaceId, conversationId, ...(reopened ? {} : { seq }) };
        const delay = reopened ? 0 : threadReply ? this.graphThreadDelayMs! : this.graphChannelDelayMs;
        void this.queue.enqueue(job, delay)
          .catch(() => new Promise((ok) => setTimeout(ok, PUSH_RETRY_MS)).then(() => this.queue.enqueue(job, delay)))
          .catch((err) => console.error(`graph job for ${conversationId}`, err));
      }
      // THREAD_DIGEST: fold older replies in the background; reads never block on it, a failed fold retries next post.
      if (this.fold && stored.conversation.kind === 'thread' && !stored.conversation.doneAt) {
        void this.foldDigest(stored.conversation).catch((err) => console.error(`digest: fold failed for ${stored.conversation.id}`, err));
      }
    }
    return { conversation: stored.conversation, message: stored.message, recipients };
  }

  /**
   * Who may message an agent in private: its owner and the owner's other agents. Anyone else could draw out what it knows
   * unseen, also a teammate, so they talk to it in a channel. An agent listed for everyone (public) takes messages from
   * anyone, and one with no owner from other ownerless agents. Nor can an agent carry what it knows to someone other than
   * its owner in private, unless it's public or has no owner (the hub's own). The two sides of a shared room talk in its shared channel
   * only: neither side's agents have a private line to the other side, public or not.
   */
  async privateRefusal(from: AgentRecord, other: AgentRecord): Promise<string | undefined> {
    const theirs = from.id === other.ownerId || (from.kind !== 'human' && from.ownerId === other.ownerId);
    if (other.kind !== 'human' && !other.public && !theirs) return `Only ${other.name}'s owner can message it in private. Talk to it in a channel you share.`;
    if (other.kind === 'human' && from.kind !== 'human' && from.ownerId && from.ownerId !== other.id && !from.public) return `An agent messages only its owner in private. Talk to ${other.name} in a channel you share.`;
    if (!this.rooms || (from.kind === 'human' && other.kind === 'human')) return undefined;
    const mine = new Set(from.workspaces ?? []);
    const shared = await Promise.all((other.workspaces ?? []).filter((w) => mine.has(w)).map((w) => this.registry.workspaceById(w)));
    for (const w of shared) {
      const [a, b] = w?.room ? [this.rooms.sideOf(w.room, from), this.rooms.sideOf(w.room, other)] : [];
      if (a && b && a.id !== b.id) return `${other.name} is on the other side of a shared room. Talk in the room.`;
    }
    return undefined;
  }

  async refusePrivate(from: AgentRecord, other: AgentRecord): Promise<void> {
    const refusal = await this.privateRefusal(from, other);
    if (refusal) throw new HubError('forbidden', refusal);
  }

  /** The agent holding the first step's role of a process attached to `channel` (the pitch kickoff), if any. */
  private async firstStepAgent(channel: ChannelRecord, agents: AgentRecord[]): Promise<AgentRecord | undefined> {
    const ids = channel.attachedSkills ?? [];
    if (!ids.length) return undefined;
    const procs = (await this.registry.skillsById(ids)).filter((s) => s.type === 'process' && (s.steps?.length ?? 0) > 0);
    const role = procs.map((p) => [...(p.steps ?? [])].sort((a, b) => a.order - b.order)[0]?.role).find((r): r is string => Boolean(r));
    return role ? agents.find((a) => channel.roles?.[a.id] === role) : undefined;
  }

  private async postDm(from: AgentRecord, withId: string, input: PostInput): Promise<Posted> {
    const key = dmKey(from.id, withId);
    const existing = await this.store.conversation(key);
    // Already talking: the conversation is proof you can see them. Whether you may still write is refusePrivate's call.
    const other = existing?.participants.includes(from.id) ? await this.registry.get(withId) : await this.registry.requireVisible(withId, from);
    if (!other || other.archived) throw new HubError('not_found', `No agent "${withId}" is available to you.`);
    if (other.id === from.id) throw new HubError('invalid', "You can't message yourself");
    await this.refusePrivate(from, other);
    if (other.webhookChannel) throw new HubError('invalid', `${other.name} is an incoming webhook: it posts into a channel and can't read messages`);
    const quote = await this.quote(input.replyTo, key);
    const stored = await this.store.append({ id: key, kind: 'dm', participants: [from.id, other.id], names: { [from.id]: from.name, [other.id]: other.name } }, this.newMessage(from, input, [], undefined, quote), [], await this.showableSkills(from, input));
    if (stored.created) {
      changed({ conversationId: stored.message.conversationId, participants: stored.conversation.participants });
      await this.handOut(stored.message, [other], from);
      this.onPosted?.(stored.message);
      this.logPosted?.(stored.message);
    }
    return { conversation: stored.conversation, message: stored.message, recipients: [other] };
  }

  private async quote(id: unknown, conversationId: string, root?: string): Promise<MessageDoc['replyTo']> {
    if (id === undefined) return undefined;
    if (typeof id !== 'string' || !id || id.length > 200 || id.includes('/') || id === '.' || id === '..') throw new HubError('invalid', 'Invalid replyTo message id');
    const original = await this.store.message(id);
    if (!original || (original.conversationId !== conversationId && !(root === original.id && original.kind === 'channel' && original.channelId && conversationId === threadKey(original.channelId, root)))) {
      throw new HubError('not_found', 'Original message unavailable');
    }
    const text = textOf(original).trim() || (original.parts.some((p) => p.url) ? `Attachment: ${original.parts.find((p) => p.url)?.filename ?? 'Attachment'}` : 'Structured message');
    return { id: original.id, fromId: original.fromId, from: original.from, text: text.replace(/\s+/g, ' ').slice(0, 180) };
  }

  /** A public response never exposes a cached quote of a private or missing original. */
  private async publicQuotes(messages: MessageDoc[], channel: ChannelRecord): Promise<MessageDoc[]> {
    const originals = new Map(await Promise.all([...new Set(messages.flatMap((m) => m.replyTo ? [m.replyTo.id] : []))].map(async (id) => [id, await this.store.message(id)] as const)));
    const roots = new Map(await Promise.all([...new Set([...originals.values()].flatMap((m) => m?.post ? [m.post] : []))].map(async (id) => [id, await this.store.message(id)] as const)));
    return messages.map((m) => {
      if (!m.replyTo) return m;
      const original = originals.get(m.replyTo.id);
      const root = original?.post ? roots.get(original.post) : undefined;
      const visible = original?.channelId === channel.id && (original.kind === 'channel'
        ? this.threadIsPublic(channel, original)
        : original.kind === 'thread' && root?.conversationId === channelKey(channel.id) && this.threadIsPublic(channel, root));
      if (visible) return m;
      const { replyTo, ...redacted } = m;
      return redacted;
    });
  }

  /** Notes that an agent loaded a skill, for its next message to show. Never fails the load. */
  async recordSkillLoad(caller: AgentRecord, skill: SkillRecord, turn?: { conversationId?: string; messageId?: string }): Promise<void> {
    if (caller.kind === 'human') return; // someone reading a skill page, not an agent loading it
    try {
      await this.store.addSkillLoad(caller.id, {
        id: skill.id,
        name: skill.name,
        type: skill.type ?? 'skill',
        ...(turn?.conversationId ? { conversation: turn.conversationId, ...(turn.messageId ? { messageId: turn.messageId } : {}) } : {}),
        at: nowIso(),
      });
    } catch (err) {
      console.error(`Skill load of ${caller.id} not recorded:`, err);
    }
  }

  /**
   * The skills an agent's message here may show, if it has loads pending: its [Skills] list here, i.e. what this
   * conversation offers plus the agent's own attachments, minus what the agent detached. Only names show, never instructions.
   */
  private async showableSkills(from: AgentRecord, input: PostInput, channel?: ChannelRecord, workspace?: WorkspaceRecord | null): Promise<Set<string> | undefined> {
    if (from.kind === 'human' || input.external || input.meta?.webhook) return undefined;
    try {
      if (!(await this.store.hasSkillLoads(from.id))) return undefined;
      return new Set((await this.registry.resolveAttachedSkills({ agent: from, channel, workspace, workspaceId: channel?.workspaceId })).map((s) => s.id));
    } catch (err) {
      console.error(`Skill loads of ${from.id} not checked:`, err);
      return undefined;
    }
  }

  private newMessage(from: AgentRecord, input: PostInput, mentions: string[], forAgents?: string[], quote?: MessageDoc['replyTo']) {
    return {
      id: input.id ?? newId(),
      from: input.external?.name ?? from.name,
      fromId: input.external?.id ?? from.id,
      human: Boolean(input.external) || from.kind === 'human',
      ...(input.external ? { external: true } : {}),
      parts: input.parts,
      ...(quote ? { replyTo: quote } : {}),
      mentions,
      ...(input.to ? { to: input.to } : {}),
      ...(forAgents ? { forAgents } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      ...(input.slack ? { slack: input.slack } : {}),
      ...(input.telegram ? { telegram: input.telegram } : {}),
    };
  }

  /** Endpoint agents are pushed it; mailbox agents with a Routine are woken. Everyone else reads it when they look. */
  private async handOut(message: MessageDoc, recipients: AgentRecord[], from: AgentRecord): Promise<void> {
    // People read on their own; an incoming webhook only posts, so nothing is pushed to it or wakes it.
    const due = recipients.filter((r) => r.kind !== 'human' && !r.webhookChannel && isFor(r, message));
    // Live activity: its author is done with this conversation; a Routine-woken agent that isn't listening is being woken.
    if (this.activity) {
      const act = this.activity;
      const live = [
        // Its card on the canvas stops saying it's working there too (the status log keeps what it said).
        ...(from.kind !== 'human' && !message.external ? [act.clear(from.id, message.conversationId), this.registry.clearStatusIf(from.id, message.conversationId, true)] : []),
        ...due.filter((r) => r.kind === 'mailbox' && r.wake && !r.wake.problem && !isListening(r)).map((r) => act.set(r.id, message.conversationId, 'waking')),
      ];
      await Promise.all(live).catch((err) => console.error('activity not recorded', err));
    }
    await Promise.all(
      due.map(async (r) => {
        if (r.kind === 'endpoint')
          // Can't rethrow: the message is already stored, the Pusher posts answers through post(), and throwing here
          // would fail that push job and make Cloud Tasks re-deliver the whole turn. Loud log so the stall is greppable.
          // One retry after a short pause; if that fails too, wakeSweep re-pushes it within a couple of minutes.
          await this.queue
            .enqueue({ agentId: r.id, conversationId: message.conversationId })
            .catch(() => new Promise((ok) => setTimeout(ok, PUSH_RETRY_MS)).then(() => this.queue.enqueue({ agentId: r.id, conversationId: message.conversationId })))
            .catch((err) =>
              console.error(`PUSH_DROPPED: endpoint ${r.id} not scheduled for conversation ${message.conversationId} (message ${message.id}) after a retry; the wake sweep will re-push it`, err),
            );
        else this.opts.onMailbox?.(r, from.name);
      }),
    );
  }

  /** Where a reply to `message` goes: its thread for a channel post, else its own conversation. */
  async replyTarget(agent: AgentRecord, message: MessageDoc): Promise<Target> {
    if (message.kind === 'channel') return { channelId: message.channelId!, thread: message.id };
    if (message.kind === 'thread') return { channelId: message.channelId!, thread: message.post! };
    const p = parseKey(message.conversationId);
    const other = p.kind === 'dm' && p.ids.includes(agent.id) ? p.ids.find((id) => id !== agent.id) : undefined;
    if (!other) throw new HubError('not_found', `Message ${message.id} not found`);
    return { dm: other };
  }

  /** Answers `messageId` (a message `agent` can read): in its thread, or its conversation. */
  async reply(agent: AgentRecord, messageId: string, input: PostInput): Promise<Posted> {
    const { message } = await this.readable(agent, messageId);
    const posted = await this.post(agent, await this.replyTarget(agent, message), input);
    // Answering a message is having read it (a channel post's answer goes to its thread, another conversation).
    await this.store.see(agent.id, message.conversationId, message.seq);
    return posted;
  }

  /** A message `agent` may read, or not found. */
  async readable(agent: AgentRecord, messageId: string): Promise<{ message: MessageDoc }> {
    const message = await this.store.message(messageId).catch(() => undefined);
    if (!message || !(await this.canRead(agent, message.conversationId))) throw new HubError('not_found', `Message ${messageId} not found`);
    return { message };
  }

  /**
   * Who may read a conversation: a channel's or thread's channel members, a DM's two sides, and the owner of
   * a bot in a DM (an owner sees all its bot's conversations).
   */
  async canRead(agent: AgentRecord, conversationId: string): Promise<boolean> {
    parseKey(conversationId); // an unknown key is invalid, not merely unreadable
    return (await this.readableConversations(agent, [conversationId])).has(conversationId);
  }

  /** The `ids` `agent` may read (canRead's rule), with one registry lookup for all of them. Anything that isn't a conversation key is unreadable. */
  async readableConversations(agent: AgentRecord, ids: Iterable<string>): Promise<Set<string>> {
    const readable = new Set<string>();
    const othersDms = new Map<string, string[]>();
    for (const id of new Set(ids)) {
      let p: ReturnType<typeof parseKey>;
      try { p = parseKey(id); } catch { continue; }
      if (p.kind !== 'dm') { if ((agent.channels ?? []).includes(p.channelId)) readable.add(id); }
      else if (p.ids.includes(agent.id)) readable.add(id);
      else if (agent.kind === 'human') othersDms.set(id, p.ids);
    }
    if (othersDms.size === 0) return readable;
    const mine = new Set((await this.registry.getMany([...othersDms.values()].flat())).filter((a) => a.kind !== 'human' && a.ownerId === agent.id).map((a) => a.id));
    for (const [id, pair] of othersDms) if (pair.some((x) => mine.has(x))) readable.add(id);
    return readable;
  }

  /** Whether `agent` can read a message a file is attached to. */
  async canReadFile(agent: AgentRecord, fileId: string): Promise<boolean> {
    for (const id of await this.store.conversationsWithFile(fileId)) if (await this.canRead(agent, id)) return true;
    return false;
  }

  /** A conversation key as the web and API give it: "agent:<id>" is the DM with that agent. */
  keyFor(viewer: AgentRecord, key: string): string {
    return key.startsWith('agent:') ? dmKey(viewer.id, key.slice('agent:'.length)) : (parseKey(key), key);
  }

  /** The conversations `agent` is in: its channels' and those it takes part in (DMs, threads). */
  private async conversationsOf(agent: AgentRecord): Promise<ConversationDoc[]> {
    const [channels, mine] = await Promise.all([this.store.conversations((agent.channels ?? []).map(channelKey)), this.store.mine(agent.id)]);
    return [...channels.values(), ...stillIn(agent, mine)];
  }

  /**
   * What's new for `agent`: per conversation, the newest message past its cursor that is for it, with what
   * came before it. Nothing is claimed: reading doesn't change it (take does).
   * With `only`, only that conversation is scanned (session-per-conversation waits) — avoids the N+1 over every
   * membership on each wait_for_* / check_inbox poll.
   */
  async newFor(agent: AgentRecord, only?: string): Promise<InboxItem[]> {
    const convs = only ? await this.oneConversation(agent, only) : await this.conversationsOf(agent);
    if (convs.length === 0) return [];
    const [cursors, channels] = await Promise.all([
      this.store.cursorsOf(agent.id, convs.map((c) => c.id)),
      this.registry.channelsById(agent.channels ?? []),
    ]);
    const candidates: { conversation: ConversationDoc; ch?: ChannelRecord; seen: number; digestUpTo: number; base: number }[] = [];
    for (const conversation of convs) {
      const ch = conversation.channelId ? channels.get(conversation.channelId) : undefined;
      if (conversation.kind === 'thread' && (conversation.doneAt || (ch && isDoneThread(ch, conversation.post)))) continue;
      const cursor = cursors.get(conversation.id);
      // A live hand-out counts as seen until it expires (then it's offered again).
      const seen = Math.max(cursor?.seenUpTo ?? 0, (cursor?.handedUntilMs ?? 0) > Date.now() ? (cursor?.handedUpTo ?? 0) : 0);
      if (conversation.seq <= seen) continue;
      // THREAD_DIGEST: skip past replies folded into the digest; it stands in for them as the earlier context.
      // THREAD_DIGEST=off (no fold) ignores stored digests on reads too, so the kill switch is a full rollback.
      const digestUpTo = this.fold ? (conversation.digestUpToSeq ?? 0) : 0;
      candidates.push({ conversation, ch, seen, digestUpTo, base: Math.max(seen, digestUpTo) });
    }
    if (candidates.length === 0) return [];
    const windows = await this.store.sinceMany(
      candidates.map(({ conversation, base }) => ({ id: conversation.id, seen: base, seq: conversation.seq })),
      EARLIER_MAX + 1,
    );
    const items = candidates.map(({ conversation, ch, seen, digestUpTo, base }): InboxItem | undefined => {
      const window = windows.get(conversation.id) ?? [];
      const at = window.findLastIndex((m) => (conversation.kind !== 'channel' || !ch || !isDoneThread(ch, m.id)) && isFor(agent, m));
      if (at < 0) return undefined;
      const message = window[at]!;
      const earlier = window.slice(0, at).filter((m) => m.fromId !== agent.id);
      const digest = digestUpTo > seen ? conversation.threadDigest : undefined;
      return { conversation, message, earlier, earlierMore: Math.max(0, message.seq - base - 1 - at), ...(digest ? { digest } : {}) };
    });
    return items.filter((i): i is InboxItem => !!i).sort((a, b) => a.message.at.localeCompare(b.message.at));
  }

  /** One conversation `agent` may take from, or none (wrong id / left the channel / never joined the thread or DM). */
  private async oneConversation(agent: AgentRecord, id: string): Promise<ConversationDoc[]> {
    if (!(await this.canRead(agent, id))) return [];
    const c = await this.store.conversation(id);
    if (!c) return [];
    // ponytail: take() must not drain a thread/DM the agent never joined — channel membership (canRead) isn't enough; missing participants fails closed.
    if (c.kind !== 'channel' && !c.participants?.includes(agent.id)) return [];
    return stillIn(agent, [c]);
  }

  /** THREAD_DIGEST: see foldDigest in catchup.ts. */
  foldDigest(conversation: ConversationDoc): Promise<void> {
    return foldDigest(this, conversation);
  }

  /**
   * What waits for `me` to answer, newest first: each thread where someone @mentioned me and I haven't written
   * since (a mention in a channel post is answered in its thread), and each DM whose last word isn't mine.
   * ponytail: the newest 50 mentions, and 50 messages after each; a per-person "waiting" doc if that falls short.
   */
  async waitingFor(me: AgentRecord): Promise<WaitingItem[]> {
    const [mentions, mine, channels] = await Promise.all([
      this.store.mentioning(me.id, 50),
      this.store.mine(me.id).then((c) => stillIn(me, c)),
      this.registry.channelsById(me.channels ?? []),
    ]);
    const doneThreads = new Set(mine.filter((c) => c.kind === 'thread' && c.doneAt).map((c) => c.id));
    const latestMention = new Map<string, MessageDoc>();
    for (const m of mentions) {
      if ((m.fromId === me.id && !m.meta?.webhook) || !m.channelId || !(me.channels ?? []).includes(m.channelId)) continue;
      const postId = m.kind === 'channel' ? m.id : m.post!;
      const open = m.kind === 'channel' ? threadKey(m.channelId, m.id) : m.conversationId;
      const ch = channels.get(m.channelId);
      if (doneThreads.has(open) || (ch && isDoneThread(ch, postId))) continue;
      if (!latestMention.has(open)) latestMention.set(open, m); // newest first: only the thread's latest mention counts
    }
    const dms = mine.filter((c) => c.kind === 'dm' && c.seq > 0 && c.lastFrom !== me.id);
    const channelsOfPosts = [...latestMention.values()].filter((m) => m.kind === 'channel').map((m) => channelKey(m.channelId!));
    const cursors = await this.store.cursorsOf(me.id, [...latestMention.keys(), ...dms.map((c) => c.id), ...channelsOfPosts]);
    const items = new Map<string, WaitingItem>();
    // Answered: I wrote there myself (a webhook or schedule posting as me isn't me answering).
    const byMe = (x: MessageDoc) => x.fromId === me.id && !x.meta?.webhook && !x.meta?.scheduled;
    // Handled without reading: seen, like Slack (its thread opened or read past it, or, for a channel post, the
    // channel read past it).
    const handled = [...latestMention].map(([open, m]) => {
      const mentionSeq = m.kind === 'channel' ? 0 : m.seq;
      const seen = cursors.get(open)?.seenUpTo;
      if (seen !== undefined && seen >= mentionSeq) return true;
      return m.kind === 'channel' && (cursors.get(channelKey(m.channelId!))?.seenUpTo ?? 0) >= m.seq;
    });
    // The rest: what came after it in its thread and, for a channel post, in the channel (an answer there counts
    // too), all read in one batch.
    // ponytail: the newest 50 channel messages after it; a reply buried under more than that is missed
    const reads = [...latestMention].flatMap(([open, m], i) =>
      handled[i] ? [] : [{ id: open, after: m.kind === 'channel' ? 0 : m.seq }, ...(m.kind === 'channel' ? [{ id: channelKey(m.channelId!), after: m.seq }] : [])],
    );
    const after = await this.store.sinceEach(reads, 50);
    let r = 0;
    const answered = [...latestMention].map(([, m], i) => {
      if (handled[i]) return true;
      const read = m.kind === 'channel' ? [...after[r++]!, ...after[r++]!] : after[r++]!;
      return read.some(byMe);
    });
    [...latestMention].forEach(([open, m], i) => {
      if (!answered[i]) items.set(open, { kind: 'mention', replyTo: open, open, messageId: m.id, channelId: m.channelId, from: m.from, fromId: m.fromId, text: textOf(m), at: m.at });
    });
    // Seen is handled: a DM leaves Needs you once it's opened.
    const waitingDms = dms.filter((c) => c.seq > (cursors.get(c.id)?.seenUpTo ?? 0));
    // The whole last message, as for a mention (the conversation's preview is cut at 200 characters).
    const lasts = await Promise.all(waitingDms.map(async (c) => (c.lastText.length >= 200 ? (await this.store.page(c.id, 1))[0] : undefined)));
    waitingDms.forEach((c, i) => {
      const last = lasts[i];
      items.set(c.id, { kind: 'dm', replyTo: `agent:${c.lastFrom}`, open: c.id, from: c.lastFromName, fromId: c.lastFrom, text: last ? textOf(last) : c.lastText, at: c.lastAt });
    });
    const senders = new Map((await this.registry.getMany([...new Set([...items.values()].map((i) => i.fromId))])).map((a) => [a.id, a]));
    return [...items.values()]
      .map((i) => {
        const a = senders.get(i.fromId);
        return a ? { ...i, ...(a.avatar ? { fromAvatar: a.avatar } : {}), fromKind: a.kind } : i;
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * check_inbox: what's new, handed out for HAND_MS. A reply there, or this reader's next take, acks it (seen);
   * one never acked is offered again. A concurrent reader doesn't get the same item. `conversation` takes (and
   * acks) only that one (a session per conversation), and leaves the rest new. `ack` false skips acking (a wait's re-polls).
   */
  async take(agent: AgentRecord, max = 20, conversation?: string, ack = true): Promise<InboxItem[]> {
    if (ack) {
      const held = (await this.store.handedOut(agent.id)).filter((c) => !conversation || c.conversationId === conversation);
      await Promise.all(held.map((c) => this.store.see(agent.id, c.conversationId, c.handedUpTo!)));
    }
    const found = (await this.newFor(agent, conversation)).slice(0, max);
    const handed = await Promise.all(found.map((i) => this.store.hand(agent.id, i.conversation.id, i.message.seq, HAND_MS)));
    const items = found.filter((_, n) => handed[n]);
    // It has them now: reading, until it answers (or the state fades).
    if (agent.kind !== 'human' && this.activity) {
      await Promise.all(items.map((i) => this.activity!.set(agent.id, i.conversation.id, 'reading'))).catch((err) => console.error('activity not recorded', err));
    }
    return items;
  }

  /** wait_for_message: takes what's new, waiting up to `timeoutMs` for something to arrive. */
  async waitAndTake(agent: AgentRecord, timeoutMs: number, conversation?: string): Promise<InboxItem[]> {
    const deadline = Date.now() + Math.min(timeoutMs, this.opts.maxWaitMs);
    const posted = watch(touches(agent));
    let first = true;
    try {
      for (;;) {
        const items = await this.take(agent, 20, conversation, first);
        first = false;
        const remaining = deadline - Date.now();
        if (items.length || remaining <= 0) return items;
        await posted.next(Math.min(this.opts.pollMs ?? WAIT_POLL_MS, remaining));
      }
    } finally {
      posted.close();
    }
  }

  /** Since when each conversation with something new for `agent` has had it waiting (wake: how long it's been). */
  async waitingSince(agent: AgentRecord): Promise<string[]> {
    return (await this.newFor(agent)).map((i) => (i.earlier[0] ?? i.message).at);
  }

  /** The same per conversation, oldest first, with who wrote last (a wake per conversation). */
  async waitingIn(agent: AgentRecord): Promise<{ conversation: string; since: string; from: string }[]> {
    const items = (await this.newFor(agent)).map((i) => ({ conversation: i.conversation.id, since: (i.earlier[0] ?? i.message).at, from: i.message.from }));
    return items.sort((a, b) => a.since.localeCompare(b.since));
  }

  /** The first message after `messageId` from someone else (in a channel post's thread), waiting up to `timeoutMs`. */
  async waitForReply(agent: AgentRecord, messageId: string, timeoutMs: number): Promise<{ message: MessageDoc; reply?: MessageDoc }> {
    const { message } = await this.readable(agent, messageId);
    const deadline = Date.now() + Math.min(timeoutMs, this.opts.maxWaitMs);
    const where = message.kind === 'channel' ? threadKey(message.channelId!, message.id) : message.conversationId;
    const after = message.kind === 'channel' ? 0 : message.seq;
    const posted = watch((c) => !c.activity && c.conversationId === where);
    try {
      for (;;) {
        const reply = (await this.store.since(where, after, 20)).find((m) => m.fromId !== message.fromId);
        const remaining = deadline - Date.now();
        if (reply || remaining <= 0) return { message, ...(reply ? { reply } : {}) };
        await posted.next(Math.min(this.opts.pollMs ?? WAIT_POLL_MS, remaining));
      }
    } finally {
      posted.close();
    }
  }

  /**
   * The event feed: messages in `agent`'s conversations committed after `cursor`, oldest first, without
   * moving any cursor. Long-polls up to `timeoutMs` while there is nothing new.
   */
  async events(agent: AgentRecord, cursor: string | undefined, timeoutMs: number, withActivity = false, allThreads = false): Promise<{ events: MessageDoc[]; activity: number; activityIn: string[]; reads: string[]; cursor: string }> {
    // "<message cursor>~<activity ms>~<read ISO>": live activity and reads have their own clocks, so a state change or a
    // read in another tab wakes the feed without a message.
    // Only for whoever asks (the web app, to redraw); an agent's wait_for_events wakes for messages alone.
    const [messagePart, activityPart, readPart] = (cursor ?? '').split('~');
    let after = parseFeedCursor(messagePart || undefined);
    let activityAfter = Number(activityPart) || Date.now();
    let readAfter = readPart || nowIso();
    const out = (events: MessageDoc[], activity: number, activityIn: string[], reads: string[]) => ({
      events,
      activity,
      activityIn,
      reads,
      cursor: `${formatFeedCursor(after)}~${activityAfter}~${readAfter}`,
    });
    const deadline = Date.now() + Math.min(timeoutMs, this.opts.maxWaitMs);
    const isAfter = (m: MessageDoc) => {
      const d = m.createdAt.seconds - after.at.seconds || m.createdAt.nanoseconds - after.at.nanoseconds;
      return d > 0 || (d === 0 && !!after.id && m.id > after.id);
    };
    // The web app's stream (withActivity) also redraws when someone's live activity changes.
    const mine = touches(agent);
    const posted = watch((c) => (withActivity || !c.activity) && mine(c));
    try {
      for (;;) {
        // `allThreads` (a person's live stream): every thread in their channels, not only the ones they're in; an agent's wait wakes for its own.
        const [own, threads] = await Promise.all([this.store.changedSince(agent.id, agent.channels ?? [], after.at), allThreads ? this.store.channelThreadsChangedSince(agent.channels ?? [], after.at) : []]);
        const convs = stillIn(agent, [...new Map([...own, ...threads].map((c) => [c.id, c])).values()]);
        const batches = await Promise.all(convs.map((c) => this.store.after(c.id, after.at, EVENTS_LIMIT + 1)));
        const messages = batches
          .flat()
          .filter(isAfter)
          .sort((a, b) => a.createdAt.seconds - b.createdAt.seconds || a.createdAt.nanoseconds - b.createdAt.nanoseconds || a.id.localeCompare(b.id))
          .slice(0, EVENTS_LIMIT);
        const last = messages.at(-1);
        if (last) after = { at: last.createdAt, id: last.id };
        const live = this.activity && withActivity ? await this.activity.since(agent, activityAfter) : { count: 0, latestMs: activityAfter, conversations: [] };
        activityAfter = live.latestMs;
        const read = withActivity ? await this.store.readSince(agent.id, readAfter) : [];
        readAfter = read.at(-1)?.updatedAt ?? readAfter;
        const reads = [...new Set(read.map((c) => c.conversationId))];
        const remaining = deadline - Date.now();
        if (messages.length || live.count || reads.length || remaining <= 0) return out(messages, live.count, live.conversations, reads);
        await posted.next(Math.min(this.opts.pollMs ?? WAIT_POLL_MS, remaining));
      }
    } finally {
      posted.close();
    }
  }

  /**
   * A page of a conversation `viewer` may read, oldest first: the `limit` messages before seq `before` (default:
   * the newest), where each participant has seen up to, and for a channel each post's thread summary.
   * `threads`: channel open feed (`open`) skips Done posts so a busy channel still fills the page; `done` is only
   * completed threads; omit/`all` returns every post (compat).
   */
  async page(viewer: AgentRecord, key: string, limit: number, before?: number, opts?: { threads?: 'open' | 'done' | 'all' }) {
    const id = this.keyFor(viewer, key);
    // Reads only, started alongside the access check; nothing is returned (or written) until it passes.
    const convP = this.store.conversation(id);
    const activityP = this.activityOf(id);
    // A channel's record too: it's known from the key, so it needn't wait for the conversation.
    const pk = parseKey(id);
    const chP = pk.kind === 'channel' ? this.registry.channelsById([pk.channelId]).then((m) => m.get(pk.channelId)) : Promise.resolve(undefined);
    convP.catch(() => {});
    activityP.catch(() => {});
    chP.catch(() => {});
    if (!(await this.canRead(viewer, id))) throw new HubError('not_found', `No conversation "${key}"`);
    const conv = await convP;
    // Nothing said yet (a thread nobody has answered): still say whether the viewer has opened it.
    if (!conv) {
      const [seen, activity] = await Promise.all([this.store.seenIn(id, [viewer.id]), activityP]);
      return { conversation: id, messages: [] as MessageDoc[], seen, threads: {} as Record<string, ThreadSummary>, older: false, unread: 0, activity };
    }
    const threadsFilter = opts?.threads ?? 'all';
    // Members, live activity and the messages don't depend on each other: one wait for the slowest, not three in a row.
    const [people, activity, { ch, messages, older }] = await Promise.all([
      conv.kind === 'channel' ? this.registry.search(viewer, { channel: conv.channelId! }).then((all) => all.map((a) => a.id)) : conv.participants,
      activityP,
      (async () => {
        const ch = conv.kind === 'channel' ? await chP : undefined;
        // For open/done filters, `older` means more *matching* posts may exist — not raw seq>1 (a Done-only tail would leave LoadOlder armed forever).
        if (conv.kind === 'channel' && ch && (threadsFilter === 'open' || threadsFilter === 'done')) {
          if (!conv.doneBackfilled) await this.store.ensureDoneBackfilled(conv.id, ch.doneThreads, conv.doneBackfillSeq);
          const batch = await this.store.page(conv.id, limit + 1, before, threadsFilter === 'done');
          return { ch, older: batch.length > limit, messages: batch.length > limit ? batch.slice(1) : batch };
        }
        const messages = await this.store.page(conv.id, limit, before);
        return { ch, messages, older: (messages[0]?.seq ?? 1) > 1 };
      })(),
    ]);
    const [seen, threads] = await Promise.all([
      this.store.seenIn(conv.id, [...people, viewer.id]),
      conv.kind === 'channel' ? this.threadSummaries(conv.channelId!, messages.map((m) => m.id), viewer, ch?.doneThreads) : Promise.resolve({} as Record<string, ThreadSummary>),
    ]);
    // The viewer's own unread for this conversation, from what we already loaded, so the web needn't scan all its
    // conversations (GET /conversations) just for this one number. Only on the newest page (`before` unset); counted
    // from the loaded window, so capped at `limit` like the sidebar's SCAN cap — enough for the badge.
    const mySeen = seen[viewer.id] ?? 0;
    const unread = before === undefined ? unreadOf(viewer, messages, mySeen, conv.kind === 'channel' ? ch : undefined).length : undefined;
    return { conversation: id, messages, seen, threads, older, ...(unread !== undefined ? { unread } : {}), activity };
  }

  /**
   * Who's doing what about a conversation now: for a channel, also in its threads (`thread` says which); for a
   * thread or a DM, just there.
   */
  async activityOf(conversationId: string) {
    if (!this.activity) return [];
    const p = parseKey(conversationId);
    let live = (await this.activity.of(conversationId)).filter((a) => p.kind === 'channel' || a.conversationId === conversationId);
    // In a channel (and its threads), only its members: one removed while it was reading isn't still "reading" there.
    if (p.kind !== 'dm' && live.length) {
      const stillIn = new Set((await this.registry.getMany(live.map((a) => a.agentId))).filter((a) => (a.channels ?? []).includes(p.channelId)).map((a) => a.id));
      live = live.filter((a) => stillIn.has(a.agentId));
    }
    return live.map((a) => {
      const q = parseKey(a.conversationId);
      return { agentId: a.agentId, state: a.state, ...(a.text ? { text: a.text } : {}), at: new Date(a.atMs).toISOString(), ...(q.kind === 'thread' ? { thread: q.post } : {}) };
    });
  }

  private async threadSummaries(channelId: string, posts: string[], viewer?: AgentRecord, doneThreads?: string[]): Promise<Record<string, ThreadSummary>> {
    const convs = await this.store.conversations(posts.map((p) => threadKey(channelId, p)));
    const doneSet = new Set(doneThreads ?? []);
    // As in the sidebar's count: only threads the viewer is in (wrote in, started, was mentioned in), not every old one,
    // counted by the same rule (unreadOf) over the same window, so a thread's "N new" matches the sidebar.
    const mine = viewer ? [...convs.values()].filter((c) => !c.doneAt && !doneSet.has(c.post!) && c.participants?.includes(viewer.id)) : [];
    const cursors = viewer && mine.length ? await this.store.cursorsOf(viewer.id, mine.map((c) => c.id)) : undefined;
    const windows = cursors ? await this.store.sinceMany(mine.map((c) => ({ id: c.id, seen: cursors.get(c.id)?.seenUpTo ?? 0, seq: c.seq })), SCAN) : undefined;
    return Object.fromEntries(
      [...convs.values()].map((c) => {
        const done = Boolean(c.doneAt || doneSet.has(c.post!));
        const unread = viewer && windows ? unreadOf(viewer, windows.get(c.id) ?? [], cursors?.get(c.id)?.seenUpTo ?? 0).length : 0;
        return [
          c.post!,
          {
            count: c.seq,
            lastAt: c.lastAt,
            people: c.recent,
            ...(unread ? { unread } : {}),
            ...(done ? { done: true, ...(c.doneAt ? { doneAt: c.doneAt } : {}), ...(c.doneBy ? { doneBy: c.doneBy } : {}) } : {}),
          },
        ];
      }),
    );
  }

  /** The channel's newest seq: where it starts being public when an owner makes it so. */
  async channelSeq(channelId: string): Promise<number> {
    return (await this.store.conversation(channelKey(channelId)))?.seq ?? 0;
  }

  /** A public channel as anyone sees it, signed in or not: a page of its posts since it went public. */
  async publicPage(channelId: string, limit: number, before?: number) {
    const channel = await this.publicChannel(channelId);
    const from = channel.publicFromSeq!;
    const messages = (await this.store.page(channelKey(channel.id), limit, before)).filter((m) => m.seq > from);
    const threads = await this.threadSummaries(channel.id, messages.map((m) => m.id));
    return { channel, messages: await this.publicQuotes(messages, channel), threads, older: (messages[0]?.seq ?? from + 1) > from + 1 };
  }

  /** A thread anyone can read: shared on its own, or in a public channel with its post made after it went public. */
  async publicThread(channelId: string, post: string) {
    const channel = (await this.registry.channelsById([channelId])).get(channelId);
    const first = channel && !channel.archived ? await this.store.message(post).catch(() => undefined) : undefined;
    if (!channel || !first || first.conversationId !== channelKey(channel.id) || !this.threadIsPublic(channel, first)) throw new HubError('not_found', `No public thread ${post} here`);
    const [safePost] = await this.publicQuotes([first], channel);
    return { channel, post: safePost!, replies: await this.publicQuotes(await this.store.page(threadKey(channel.id, post), 200), channel) };
  }

  private threadIsPublic(channel: ChannelRecord, post: Pick<MessageDoc, 'id' | 'seq'>): boolean {
    return !!channel.publicThreads?.includes(post.id) || (channel.publicFromSeq !== undefined && post.seq > channel.publicFromSeq);
  }

  /** Whether a file is attached to something anyone can read here: a public post, or a reply in a public thread. */
  async isPublicFile(channelId: string, fileId: string): Promise<boolean> {
    const channel = (await this.registry.channelsById([channelId])).get(channelId);
    if (!channel || channel.archived) return false;
    for (const m of await this.store.attachmentsOf(fileId)) {
      if (m.conversationId === channelKey(channel.id) && this.threadIsPublic(channel, m)) return true;
      if (m.post && m.conversationId === threadKey(channel.id, m.post)) {
        const post = await this.store.message(m.post);
        if (post && this.threadIsPublic(channel, post)) return true;
      }
    }
    return false;
  }

  private async publicChannel(id: string): Promise<ChannelRecord> {
    const channel = (await this.registry.channelsById([id])).get(id);
    if (!channel || channel.publicFromSeq === undefined || channel.archived) throw new HubError('not_found', `No public channel "${id}"`);
    return channel;
  }

  /** A channel thread from its post on, for a member of the channel (id or name). */
  async readThread(viewer: AgentRecord, channel: string, post: string, limit = THREAD_READ_MAX): Promise<MessageDoc[]> {
    const record = await this.registry.resolveMemberChannel(viewer, channel);
    const first = await this.store.message(post).catch(() => undefined);
    if (!first || first.conversationId !== channelKey(record.id)) throw new HubError('not_found', `No thread ${post} in this channel`);
    return [first, ...(await this.store.page(threadKey(record.id, post), Math.min(limit, THREAD_READ_MAX)))];
  }

  /** "Catch me up" for `key`: see summarizeCatchup in catchup.ts. */
  summarizeCatchup(viewer: AgentRecord, key: string, opts?: { sinceSeq?: number }): Promise<CatchupResponse> {
    return summarizeCatchup(this, viewer, key, opts);
  }

  /** `viewer` has read the conversation to its end (for a channel, its threads without an unseen @mention too). */
  async markRead(viewer: AgentRecord, key: string): Promise<{ key: string; seenUpTo: number }> {
    const id = this.keyFor(viewer, key);
    if (!(await this.canRead(viewer, id))) throw new HubError('not_found', `No conversation "${key}"`);
    const p = parseKey(id);
    const [conv, mine, mentions] = await Promise.all([
      this.store.conversation(id),
      p.kind === 'channel' ? this.store.mine(viewer.id) : Promise.resolve([]),
      p.kind === 'channel' ? this.store.mentioning(viewer.id, 50) : Promise.resolve([]),
    ]);
    const threads = p.kind === 'channel' ? mine.filter((c) => c.kind === 'thread' && c.channelId === p.channelId) : [];
    const cursors = await this.store.cursorsOf(viewer.id, threads.map((t) => t.id));
    // A thread with an unseen @mention waits for the viewer to open the thread itself (Needs you).
    const mentioned = new Set(
      mentions.filter((m) => m.kind === 'thread' && isFor(viewer, m) && m.seq > (cursors.get(m.conversationId)?.seenUpTo ?? 0)).map((m) => m.conversationId),
    );
    // Also a thread nobody has answered yet: that it was opened is what clears its mention from Needs you.
    await Promise.all([
      this.store.see(viewer.id, id, conv?.seq ?? 0),
      ...threads.filter((t) => (cursors.get(t.id)?.seenUpTo ?? 0) < t.seq && !mentioned.has(t.id)).map((t) => this.store.see(viewer.id, t.id, t.seq)),
    ]);
    // Wakes the viewer's other tabs on this instance (another instance's catch up at their next poll).
    changed({ conversationId: id, participants: [viewer.id], activity: true });
    return { key, seenUpTo: conv?.seq ?? 0 };
  }

  /**
   * Channels and DMs `viewer` is in, most recent first, with unread counts (a channel's include its threads
   * the viewer is in). With `workspace`: that workspace's channels, and DMs with its members (or with someone
   * who shares no workspace with the viewer, so those are never lost).
   */
  async conversations(viewer: AgentRecord, opts: { workspace?: string; limit?: number } = {}): Promise<ConversationSummary[]> {
    const all = await this.conversationsOf(viewer);
    const [cursors, channels] = await Promise.all([
      this.store.cursorsOf(viewer.id, all.map((c) => c.id)),
      this.registry.channelsById(viewer.channels ?? []),
    ]);
    const active = all.filter((c) => {
      const ch = c.channelId ? channels.get(c.channelId) : undefined;
      return c.kind !== 'thread' || (!c.doneAt && !(ch && isDoneThread(ch, c.post)));
    });
    const windows = await this.store.sinceMany(active.map((c) => ({ id: c.id, seen: cursors.get(c.id)?.seenUpTo ?? 0, seq: c.seq })), SCAN);
    const counted = all.map((c) => {
      const ch = c.channelId ? channels.get(c.channelId) : undefined;
      if (c.kind === 'thread' && (c.doneAt || (ch && isDoneThread(ch, c.post)))) return { c, unread: 0, mentions: 0, done: true };
      const unread = unreadOf(viewer, windows.get(c.id) ?? [], cursors.get(c.id)?.seenUpTo ?? 0, c.kind === 'channel' ? ch : undefined);
      return { c, unread: unread.length, mentions: unread.filter((m) => m.mentions?.includes(viewer.id)).length, done: false };
    });
    const byChannel = new Map<string, ConversationSummary>();
    const out: ConversationSummary[] = [];
    for (const { c, unread, mentions } of counted) {
      if (c.kind === 'thread') continue;
      const s = { conversation: c, unread, mentions };
      if (c.channelId) byChannel.set(c.channelId, s);
      out.push(s);
    }
    const ownUnread = new Map([...byChannel].map(([id, s]) => [id, s.unread]));
    const ownLastAt = new Map([...byChannel].map(([id, s]) => [id, s.conversation.lastAt]));
    // Newest threads first, so a channel's `thread` is its newest one with something new.
    for (const { c, unread, mentions } of counted.filter((x) => x.c.kind === 'thread' && !x.done).sort((a, b) => b.c.lastAt.localeCompare(a.c.lastAt))) {
      const s = byChannel.get(c.channelId!);
      if (s) {
        s.unread += unread;
        s.mentions += mentions;
        // A reply in a thread is activity in its channel too (the phone's team list and ⌘K's Recent go by it).
        if (c.lastAt > s.conversation.lastAt) s.conversation = { ...s.conversation, lastAt: c.lastAt };
        if (unread && !ownUnread.get(c.channelId!) && c.lastAt >= (ownLastAt.get(c.channelId!) ?? '') && !s.thread) {
          s.thread = c.post;
          // The preview must describe the thread this row opens, not an unrelated channel post.
          s.conversation = { ...s.conversation, lastText: c.lastText, lastFrom: c.lastFrom, lastFromName: c.lastFromName };
        }
      }
    }
    let shown = out;
    if (opts.workspace) {
      const others = await this.registry.getMany(out.flatMap((s) => (s.conversation.kind === 'dm' ? s.conversation.participants : [])).filter((id) => id !== viewer.id));
      const byId = new Map(others.map((a) => [a.id, a]));
      shown = out.filter((s) => {
        if (s.conversation.kind === 'channel') return s.conversation.workspaceId === opts.workspace;
        const other = byId.get(s.conversation.participants.find((id) => id !== viewer.id) ?? '');
        return !other || (other.workspaces ?? []).includes(opts.workspace!) || !sharesWorkspace(viewer, other);
      });
    }
    return shown.sort((a, b) => b.conversation.lastAt.localeCompare(a.conversation.lastAt)).slice(0, opts.limit ?? 100);
  }

  /** Messages with `query` in them (case-insensitive) from `viewer`'s recent conversations, newest first. */
  async search(viewer: AgentRecord, query: string, limit = 30): Promise<MessageDoc[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) throw new HubError('invalid', 'Search for at least 2 characters');
    // ponytail: scans the latest messages of the 30 most recent conversations; a search index if people need more
    const convs = (await this.conversationsOf(viewer)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 30);
    const pages = await Promise.all(convs.map((c) => this.store.page(c.id, SCAN)));
    return pages
      .flat()
      .filter((m) => textOf({ parts: m.parts }).toLowerCase().includes(q))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  /** A new member of a channel: what was said there before isn't new to them. */
  async joined(agentId: string, channelId: string): Promise<void> {
    await this.store.start(agentId, channelKey(channelId));
  }
}

/** A thread of a channel `agent` was removed from (or left) isn't theirs any more, though they once wrote in it. */
function stillIn(agent: AgentRecord, convs: ConversationDoc[]): ConversationDoc[] {
  return convs.filter((c) => c.kind === 'dm' || !c.channelId || (agent.channels ?? []).includes(c.channelId));
}
