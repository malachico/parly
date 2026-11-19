import type { Database } from '../db/types.js';
import { parseKey } from './chat.js';
import { changed } from './notifier.js';
import { ChatStore } from './store.js';

/** What an agent is doing about a conversation right now: woken for it, reading it, or working on an answer. */
type ActivityState = 'waking' | 'reading' | 'working';

/** Collection `activity`, doc id `${agentId}|${scope}` (the DM, or the channel): one live state per agent there, threads included. */
export interface ActivityDoc {
  agentId: string;
  conversationId: string;
  /** Channel and thread conversations: the channel, so a channel's page finds its threads' activity too. */
  channelId?: string;
  /** DMs: both sides, so either one's feed hears of it. */
  participants?: string[];
  state: ActivityState;
  /** The agent's own words (set_status): "running the tests". */
  text?: string;
  /** When it was set (ms), and until when it counts: a state that isn't renewed fades on its own. */
  atMs: number;
  untilMs: number;
}

/** How long each state lasts unless renewed. A Routine can take a while to start; reading is quick. */
const TTL_MS: Record<ActivityState, number> = { waking: 5 * 60_000, reading: 2 * 60_000, working: 5 * 60_000 };
export const ACTIVITY_TEXT_MAX = 120;

/** Live agent activity: set from what the hub already sees (wakes, check_inbox, pushes, set_status), cleared when the agent posts. */
export class Activity {
  private readonly store: ChatStore;

  constructor(dbOrStore: Database | ChatStore) {
    this.store = dbOrStore instanceof ChatStore ? dbOrStore : new ChatStore(dbOrStore);
  }

  /** A channel and its threads share one doc per agent: what it does in a thread replaces what it did in the channel. */
  private docId(agentId: string, conversationId: string): string {
    const p = parseKey(conversationId);
    return `${agentId}|${p.kind === 'dm' ? conversationId : `channel:${p.channelId}`}`;
  }

  async set(agentId: string, conversationId: string, state: ActivityState, text?: string): Promise<void> {
    const p = parseKey(conversationId);
    const now = Date.now();
    const doc: ActivityDoc = {
      agentId,
      conversationId,
      ...(p.kind === 'dm' ? { participants: p.ids } : { channelId: p.channelId }),
      state,
      ...(text ? { text: text.slice(0, ACTIVITY_TEXT_MAX) } : {}),
      atMs: now,
      untilMs: now + TTL_MS[state],
    };
    await this.store.setActivity(this.docId(agentId, conversationId), doc);
    changed({ ...doc, activity: true });
  }

  /** The agent answered: whatever it was doing about this conversation (or, in a channel, any of its threads) is done. */
  /** Still at it (a long task being polled): keeps the state and its words alive longer, if it's still live. */
  async renew(agentId: string, conversationId: string): Promise<void> {
    const id = this.docId(agentId, conversationId);
    const a = await this.store.getActivity(id);
    if (a && a.untilMs > Date.now()) await this.store.updateActivityUntil(id, Date.now() + TTL_MS[a.state]);
  }

  // Kept as an expired doc stamped now, not deleted, so the live feed (since) hears that it stopped.
  async clear(agentId: string, conversationId: string): Promise<void> {
    const id = this.docId(agentId, conversationId);
    const a = await this.store.getActivity(id);
    if (a && a.untilMs > Date.now()) {
      await this.store.setActivity(id, { ...a, atMs: Date.now(), untilMs: 0 });
      changed({ ...a, activity: true });
    }
  }

  /** Clears live activity for all agents working on a specific thread (and waking/reading on the channel itself when `clearChannel` is true). */
  async clearThread(channelId: string, post: string, clearChannel = false): Promise<void> {
    const target = `thread:${channelId}:${post}`;
    const chKey = `channel:${channelId}`;
    const active = await this.of(chKey);
    await Promise.all(
      active
        .filter((a) => a.conversationId === target || (clearChannel && a.conversationId === chKey && a.state !== 'working'))
        .map((a) => this.clear(a.agentId, a.conversationId)),
    );
  }

  /** What one agent is live on now, anywhere. */
  async ofAgent(agentId: string): Promise<ActivityDoc[]> {
    const now = Date.now();
    return (await this.store.listActivityByAgent(agentId)).filter((a) => a.untilMs > now);
  }

  /** What's live in a channel (and its threads) or a DM now. */
  async of(conversationId: string): Promise<ActivityDoc[]> {
    const p = parseKey(conversationId);
    const docs = p.kind === 'dm' ? await this.store.listActivityByConversation(conversationId) : await this.store.listActivityByChannel(p.channelId);
    const now = Date.now();
    return docs.filter((a) => a.untilMs > now);
  }

  /**
   * Activity set since `afterMs` that `viewer` can see (its channels, its DMs), for the live feed; and the newest
   * time among them, the feed's next activity cursor.
   */
  // ponytail: reads up to 500 activity changes since the cursor (oldest first, so the cursor resumes past them) and filters in memory; an index on (channelId, atMs) when it's busy
  async since(viewer: { id: string; channels?: string[] }, afterMs: number): Promise<{ count: number; latestMs: number; conversations: string[] }> {
    const docs = await this.store.listActivitySince(afterMs, 500);
    const channels = new Set(viewer.channels ?? []);
    const mine = docs.filter((a) => (a.channelId ? channels.has(a.channelId) : a.participants?.includes(viewer.id)));
    // Which conversations changed, by the key a page shows: a channel for itself and its threads, else the DM.
    const conversations = [...new Set(mine.map((a) => (a.channelId ? `channel:${a.channelId}` : a.conversationId)))];
    return { count: mine.length, latestMs: Math.max(afterMs, ...docs.map((a) => a.atMs)), conversations };
  }
}
