import type { TelegramLink, TelegramCopy } from '../lib/bridgeTypes.js';
export type { TelegramLink, TelegramCopy } from '../lib/bridgeTypes.js';
import { randomBytes } from 'node:crypto';
import type { MessageDoc } from '../chat/chat.js';
import { COLLECTIONS, FieldValue, toMillis, type Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import {
  BridgeQueue,
  LINK_CODE_RE,
  claimBridgeEvent,
  keepBridgeEvent,
  queueBridgeOut,
} from '../lib/bridge.js';

/**
 * The Telegram bridge's records, mirroring `src/slack/store.ts`. Parly stays the source of truth:
 * these map which Telegram chat (and optional forum topic `message_thread_id`) mirrors which Parly channel,
 * who a Telegram user is on Parly, and where each message's copies live in Telegram.
 */



/** `telegram_identities/{telegramUserId}`: who a Telegram user is on Parly, once they confirmed a one-time link code. */
export interface TelegramIdentity {
  telegramUserId: string;
  agentId: string;
  username?: string;
  name?: string;
  at: string;
}

export interface TelegramLinkCodeView {
  telegramUserId: string;
  telegramUserName?: string;
  telegramUsername?: string;
}

/** `telegram_chats/{chatId}`: metadata for a Telegram supergroup/chat (workspace binding + forum topic names for auto-link). */
interface TelegramChat {
  chatId: string;
  title?: string;
  workspaceId?: string;
  topics?: Record<string, string>;
  updatedAt: string;
}

/** A Parly message to post in one linked Telegram chat/topic (the outbox). */
export interface TelegramOut {
  messageId: string;
  chatId: string;
  topicId?: number;
  parlyChannelId: string;
}

export const telegramLinkKey = (link: Pick<TelegramLink, 'chatId' | 'topicId'>) =>
  `${link.chatId}:${link.topicId ?? 'root'}`;

export const outKey = (j: Pick<TelegramOut, 'messageId' | 'chatId' | 'topicId'>) =>
  `${j.messageId}:${j.chatId}:${j.topicId ?? 'root'}`;

/** The key of a Telegram message, unique across Telegram (`chatId:messageId`). */
export const telegramKey = (c: Pick<TelegramCopy, 'chatId' | 'messageId'>) => `${c.chatId}:${c.messageId}`;

function sameLink(a: Pick<TelegramLink, 'chatId' | 'topicId'>, b: Pick<TelegramLink, 'chatId' | 'topicId'>): boolean {
  return a.chatId === b.chatId && (a.topicId ?? undefined) === (b.topicId ?? undefined);
}

export class TelegramStore extends BridgeQueue<TelegramOut> {
  constructor(db: Database) {
    super(db, COLLECTIONS.telegramEvents, COLLECTIONS.telegramOutbox);
  }

  async identity(telegramUserId: string): Promise<TelegramIdentity | undefined> {
    return (await this.db.collection(COLLECTIONS.telegramIdentities).doc(telegramUserId).get()).data() as TelegramIdentity | undefined;
  }

  async linkIdentity(
    telegramUserId: string,
    agentId: string,
    meta?: { username?: string; name?: string },
  ): Promise<TelegramIdentity> {
    const identity: TelegramIdentity = {
      telegramUserId,
      agentId,
      ...(meta?.username ? { username: meta.username } : {}),
      ...(meta?.name ? { name: meta.name } : {}),
      at: new Date().toISOString(),
    };
    await this.db.collection(COLLECTIONS.telegramIdentities).doc(telegramUserId).set(identity);
    return identity;
  }

  async identitiesOf(agentId: string): Promise<TelegramIdentity[]> {
    const snap = await this.db.collection(COLLECTIONS.telegramIdentities).where('agentId', '==', agentId).get();
    return snap.docs.map((d) => d.data() as TelegramIdentity);
  }

  async unlinkMyIdentity(agentId: string, telegramUserId?: string): Promise<void> {
    const snap = await this.db.collection(COLLECTIONS.telegramIdentities).where('agentId', '==', agentId).get();
    const docs = telegramUserId
      ? snap.docs.filter((d) => (d.data() as TelegramIdentity).telegramUserId === telegramUserId || d.id === telegramUserId)
      : snap.docs;
    await Promise.all(docs.map((d) => d.ref.delete()));
  }

  /** Issues a one-time 10-minute code bound to `agentId` (web-generated) confirmed via DM `/start <code>`. */
  async createAgentLinkCode(agentId: string, now = Date.now()): Promise<{ code: string; expiresAt: string }> {
    const code = randomBytes(18).toString('base64url');
    const expiresDate = new Date(now + 10 * 60_000);
    await this.db.collection(COLLECTIONS.telegramLinkCodes).doc(code).set({
      kind: 'agent',
      agentId,
      expiresAt: expiresDate,
    });
    return { code, expiresAt: expiresDate.toISOString() };
  }

  /** Spends a web-generated one-time code when the Telegram user confirms `/start <code>` to the bot. */
  async spendAgentLinkCode(code: string, now = Date.now()): Promise<{ agentId: string } | undefined> {
    if (!LINK_CODE_RE.test(code)) return undefined;
    const ref = this.db.collection(COLLECTIONS.telegramLinkCodes).doc(code);
    return this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as
        | { kind?: string; agentId?: string; expiresAt?: Date | { toMillis(): number } }
        | undefined;
      if (!data || data.kind !== 'agent' || !data.agentId) return undefined;
      tx.delete(ref);
      return toMillis(data.expiresAt) > now ? { agentId: data.agentId } : undefined;
    });
  }

  /** Issues a one-time 10-minute code bound to `telegramUserId` (bot-generated, mirroring `SlackStore.linkCode`). */
  async linkCode(
    telegramUserId: string,
    meta?: { username?: string; name?: string },
    force = false,
    now = Date.now(),
  ): Promise<string | undefined> {
    const prompted = this.db.collection(COLLECTIONS.telegramLinkCodes).doc(`prompt:${telegramUserId}`);
    if (!force) {
      const last = (await prompted.get()).data() as { at?: number } | undefined;
      if (last?.at && now - last.at < 60 * 60_000) return undefined;
    }
    const code = randomBytes(18).toString('base64url');
    await this.db.collection(COLLECTIONS.telegramLinkCodes).doc(code).set({
      kind: 'telegram',
      telegramUserId,
      ...(meta?.username ? { username: meta.username } : {}),
      ...(meta?.name ? { name: meta.name } : {}),
      expiresAt: new Date(now + 10 * 60_000),
    });
    await prompted.set({ at: now, expiresAt: new Date(now + 60 * 60_000) });
    return code;
  }

  /** Inspects a bot-generated link code without spending it (`GET /telegram/link?code=`). */
  async inspectLinkCode(
    code: string,
    now = Date.now(),
  ): Promise<{ telegramUserId: string; username?: string; name?: string } | undefined> {
    if (!LINK_CODE_RE.test(code)) return undefined;
    const data = (await this.db.collection(COLLECTIONS.telegramLinkCodes).doc(code).get()).data() as
      | { kind?: string; telegramUserId?: string; username?: string; name?: string; expiresAt?: Date | { toMillis(): number } }
      | undefined;
    if (!data || data.kind !== 'telegram' || !data.telegramUserId || toMillis(data.expiresAt) <= now) return undefined;
    return {
      telegramUserId: data.telegramUserId,
      ...(data.username ? { username: data.username } : {}),
      ...(data.name ? { name: data.name } : {}),
    };
  }

  /** Spends a bot-generated link code (`POST /telegram/link`). */
  async spendLinkCode(
    code: string,
    now = Date.now(),
  ): Promise<{ telegramUserId: string; username?: string; name?: string } | undefined> {
    if (!LINK_CODE_RE.test(code)) return undefined;
    const ref = this.db.collection(COLLECTIONS.telegramLinkCodes).doc(code);
    return this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as
        | { kind?: string; telegramUserId?: string; username?: string; name?: string; expiresAt?: Date | { toMillis(): number } }
        | undefined;
      if (!data || data.kind !== 'telegram' || !data.telegramUserId) return undefined;
      tx.delete(ref);
      if (toMillis(data.expiresAt) <= now) return undefined;
      return {
        telegramUserId: data.telegramUserId,
        ...(data.username ? { username: data.username } : {}),
        ...(data.name ? { name: data.name } : {}),
      };
    });
  }

  /**
   * Mirrors a Parly channel to a Telegram chat (and optional topic): `channel.telegram` gets the link, and
   * `telegram_links/{chatId}:{topicId ?? 'root'}` says which Parly channel that chat/topic feeds.
   */
  async linkChannel(parlyChannelId: string, link: TelegramLink): Promise<boolean> {
    const ref = this.db.collection(COLLECTIONS.telegramLinks).doc(telegramLinkKey(link));
    const channel = this.db.collection(COLLECTIONS.channels).doc(parlyChannelId);
    return this.db.runTransaction(async (tx) => {
      const [taken, current] = await tx.getAll(ref, channel);
      const takenData = taken!.data() as (TelegramLink & { parlyChannelId?: string }) | undefined;
      const other = takenData?.parlyChannelId;
      if (other && other !== parlyChannelId) {
        throw new HubError('conflict', 'That Telegram chat is already linked to another Parly channel');
      }
      if (other === parlyChannelId && (takenData?.threadId ?? undefined) !== (link.threadId ?? undefined)) {
        throw new HubError('conflict', 'That Telegram topic is already linked to another Parly thread or channel');
      }
      const existingLinks = (current!.data()?.telegram as TelegramLink[] | undefined) ?? [];
      if (link.threadId) {
        const otherTopic = existingLinks.find(
          (l) => l.chatId === link.chatId && l.threadId === link.threadId && (l.topicId ?? undefined) !== (link.topicId ?? undefined),
        );
        if (otherTopic) {
          throw new HubError('conflict', 'That Parly thread is already linked to a Telegram topic');
        }
      }
      const alreadyLinked =
        other === parlyChannelId &&
        existingLinks.some((l) => sameLink(l, link) && (l.threadId ?? undefined) === (link.threadId ?? undefined));
      const links = existingLinks.filter((l) => !sameLink(l, link));
      tx.update(channel, { telegram: [...links, link] });
      tx.set(ref, { ...link, parlyChannelId });
      return !alreadyLinked;
    });
  }

  /** Finds the link bound to a specific Parly thread `(parlyChannelId, chatId, threadId)`, if any. */
  async linkedThread(
    parlyChannelId: string,
    chatId: string,
    threadId: string,
  ): Promise<(TelegramLink & { parlyChannelId: string }) | undefined> {
    const ch = (await this.db.collection(COLLECTIONS.channels).doc(parlyChannelId).get()).data() as
      | { telegram?: TelegramLink[] }
      | undefined;
    const found = ch?.telegram?.find((l) => l.chatId === chatId && l.threadId === threadId && l.topicId !== undefined);
    return found ? { ...found, parlyChannelId } : undefined;
  }

  async unlinkChannel(parlyChannelId: string, link: Pick<TelegramLink, 'chatId' | 'topicId'>): Promise<void> {
    const channel = this.db.collection(COLLECTIONS.channels).doc(parlyChannelId);
    const ref = this.db.collection(COLLECTIONS.telegramLinks).doc(telegramLinkKey(link));
    await this.db.runTransaction(async (tx) => {
      const links = (((await tx.get(channel)).data()?.telegram as TelegramLink[] | undefined) ?? []).filter((l) => !sameLink(l, link));
      tx.update(channel, { telegram: links });
      tx.delete(ref);
    });
  }

  /**
   * The Parly channel a Telegram chat/topic feeds: checks an exact `(chatId, topicId)` binding first, then falls back
   * to the chat-level `(chatId, undefined)` binding so a whole-chat link also receives topic messages as threads.
   */
  async linkedChannel(chatId: string, topicId?: number): Promise<(TelegramLink & { parlyChannelId: string }) | undefined> {
    if (topicId !== undefined) {
      const exact = (await this.db.collection(COLLECTIONS.telegramLinks).doc(telegramLinkKey({ chatId, topicId })).get()).data() as
        | (TelegramLink & { parlyChannelId: string })
        | undefined;
      if (exact) return exact;
    }
    return (await this.db.collection(COLLECTIONS.telegramLinks).doc(telegramLinkKey({ chatId })).get()).data() as
      | (TelegramLink & { parlyChannelId: string })
      | undefined;
  }

  /** Deduplicates a Telegram webhook delivery by `update_id`: false when already seen. */
  async keepEvent(updateId: string, update: unknown): Promise<boolean> {
    return keepBridgeEvent(this.db, COLLECTIONS.telegramEvents, updateId, { update });
  }

  async claimEvent(updateId: string, now = Date.now()): Promise<{ update: unknown; attempts: number } | undefined> {
    const data = await claimBridgeEvent<{ update: unknown }>(this.db, COLLECTIONS.telegramEvents, updateId, now);
    return data ? { update: data.update, attempts: data.attempts } : undefined;
  }

  async message(messageId: string): Promise<MessageDoc | undefined> {
    return (await this.db.collection(COLLECTIONS.messages).doc(messageId).get()).data() as MessageDoc | undefined;
  }

  /** Records a copy the bridge posted in Telegram, on the message and in the `(chatId, messageId)` lookup. */
  async addCopy(messageId: string, copy: TelegramCopy): Promise<void> {
    await Promise.all([
      this.db.collection(COLLECTIONS.messages).doc(messageId).update({ telegram: FieldValue.arrayUnion(copy) }),
      this.rememberCopy(copy, messageId),
    ]);
  }

  async queueOut(job: TelegramOut): Promise<boolean> {
    return queueBridgeOut(this.db, COLLECTIONS.telegramOutbox, outKey(job), job);
  }

  /** The Parly message a Telegram message is (or is a copy of), by `(chatId, messageId)`. */
  async messageAt(copy: Pick<TelegramCopy, 'chatId' | 'messageId'>): Promise<string | undefined> {
    return ((await this.db.collection(COLLECTIONS.telegramMsgIds).doc(telegramKey(copy)).get()).data() as { messageId?: string } | undefined)?.messageId;
  }

  /** Remembers that this Telegram `(chatId, messageId)` corresponds to that Parly message id. */
  async rememberCopy(copy: TelegramCopy, parlyMessageId: string): Promise<void> {
    await this.db.collection(COLLECTIONS.telegramMsgIds).doc(telegramKey(copy)).set({ ...copy, messageId: parlyMessageId });
  }

  async chat(chatId: string): Promise<TelegramChat | undefined> {
    return (await this.db.collection(COLLECTIONS.telegramChats).doc(chatId).get()).data() as TelegramChat | undefined;
  }

  /** Records a Telegram chat's title, Parly workspace binding, or forum topic name for `autoLink`. */
  async saveChat(
    chatId: string,
    patch: { title?: string; workspaceId?: string; topic?: { topicId: number; name: string } },
  ): Promise<TelegramChat> {
    const ref = this.db.collection(COLLECTIONS.telegramChats).doc(chatId);
    return this.db.runTransaction(async (tx) => {
      const prev = ((await tx.get(ref)).data() as TelegramChat | undefined) ?? { chatId, updatedAt: new Date().toISOString() };
      const topics = { ...(prev.topics ?? {}), ...(patch.topic ? { [String(patch.topic.topicId)]: patch.topic.name } : {}) };
      const next: TelegramChat = {
        ...prev,
        chatId,
        ...(patch.title ? { title: patch.title } : {}),
        ...(patch.workspaceId ? { workspaceId: patch.workspaceId } : {}),
        ...(Object.keys(topics).length ? { topics } : {}),
        updatedAt: new Date().toISOString(),
      };
      tx.set(ref, next);
      return next;
    });
  }

  /** All links currently stored for a given Telegram `chatId`. */
  async linksForChat(chatId: string): Promise<(TelegramLink & { parlyChannelId: string })[]> {
    const snap = await this.db.collection(COLLECTIONS.telegramLinks).where('chatId', '==', chatId).get();
    return snap.docs.map((d) => d.data() as TelegramLink & { parlyChannelId: string });
  }

  /** All Telegram chats bound to a given Parly `workspaceId`. */
  async chatsForWorkspace(workspaceId: string): Promise<TelegramChat[]> {
    const snap = await this.db.collection(COLLECTIONS.telegramChats).where('workspaceId', '==', workspaceId).get();
    return snap.docs
      .map((d) => d.data() as TelegramChat)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Removes the workspace binding from a Telegram `chatId`. */
  async disconnectWorkspaceChat(workspaceId: string, chatId: string): Promise<void> {
    const ref = this.db.collection(COLLECTIONS.telegramChats).doc(chatId);
    await this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as TelegramChat | undefined;
      if (!data || data.workspaceId !== workspaceId) return;
      tx.delete(ref);
    });
  }
}
