import { sameSecret } from '../lib/sealing.js';
import type { MessageDoc } from '../chat/chat.js';
import type { HubService } from '../hub/hubService.js';
import { isOwner } from '../lib/admin.js';
import { bridgeOutboxFailure, bridgeSenderName, isOwnTelegramCopy, partText, sweepBridge } from '../lib/bridge.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';
import {
  outKey,
  type TelegramCopy,
  type TelegramIdentity,
  type TelegramLink,
  type TelegramLinkCodeView,
  type TelegramOut,
  type TelegramStore,
} from './store.js';

/**
 * The Telegram bridge (mirrors `src/slack/bridge.ts`): Telegram updates hit `POST /telegram/webhook`,
 * verified via `X-Telegram-Bot-Api-Secret-Token`, deduplicated by `update_id`, and relayed into the linked
 * Parly channel/thread; Parly posts are mirrored out via Telegram's `sendMessage` with sender name and
 * `chat_id` / `message_thread_id`.
 */
interface TelegramBridgeOptions {
  botToken: string;
  webhookSecret: string;
  /** The web app URL, where people can approve one-time Telegram identity links (`/telegram/link?code=`). */
  webUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Telegram's 4096-character limit on message text, with room for sender prefix and truncation suffix. */
const MAX_TELEGRAM_TEXT = 4000;
/** Telegram's 128-character limit on `createForumTopic` `name`. */
const MAX_TOPIC_NAME = 128;
/** Cap on forum topics that auto-create Parly channels per Telegram chat (any group member can open a topic). */
export const MAX_AUTO_TOPIC_CHANNELS = 20;

class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Telegram (${status}): ${description}`);
  }
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: { id: number | string; type?: string; title?: string };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number; message_thread_id?: number; forum_topic_created?: { name?: string } };
  forum_topic_created?: { name?: string };
  forum_topic_edited?: { name?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

function formatTelegramSender(u: TelegramUser | undefined): string {
  if (!u) return 'Telegram user';
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (u.username) return `@${u.username}`;
  return `Telegram user ${u.id}`;
}

/** Escapes `<`, `>`, and `&` for Telegram `parse_mode: 'HTML'`. */
function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Formats an outbound Parly message for Telegram `parse_mode: 'HTML'`, with a bold sender header
 * (`<b>Sender</b>\n<body>`) and HTML-escaped body truncated within Telegram's 4096-character limit
 * without splitting surrogate pairs or HTML entities.
 */
function formatTelegramOutbound(body: string, sender?: string, maxLen = MAX_TELEGRAM_TEXT): string {
  const header = sender ? `<b>${escapeTelegramHtml(sender)}</b>\n` : '';
  const budget = Math.max(0, maxLen - header.length);
  let cut = body.length > budget ? body.slice(0, budget) : body;
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  }
  let escaped = escapeTelegramHtml(cut);
  while (escaped.length > budget && cut.length > 0) {
    const overflow = escaped.length - budget;
    const drop = Math.max(1, Math.ceil(overflow / 5));
    cut = Array.from(cut).slice(0, -drop).join('');
    escaped = escapeTelegramHtml(cut);
  }
  return `${header}${escaped}`;
}

/**
 * Parses and validates a Telegram link input: accepts a numeric `chatId` (e.g. `-1001234567890`), a `@username`,
 * `chatId:topicId`, or a pasted Telegram group/topic link (`https://t.me/c/<internalId>/<topicId>` or `https://t.me/<group>/<topicId>`).
 */
export function parseTelegramLinkInput(input: {
  chatId?: string;
  topicId?: number | string;
}): { chatId: string; topicId?: number } {
  let rawChatId = (input.chatId ?? '').trim();
  let rawTopic = input.topicId;

  if (/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i.test(rawChatId)) {
    throw new HubError(
      'invalid',
      'Telegram invite links do not include a chat ID: paste a message/topic link (t.me/c/…) or enter the chat ID (-100…)',
    );
  }

  const privateLink = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/c\/(\d+)(?:\/(\d+)(?:\/\d+)?)?\/?(?:\?.*)?$/i.exec(rawChatId);
  if (privateLink) {
    rawChatId = `-100${privateLink[1]}`;
    if ((rawTopic === undefined || rawTopic === '') && privateLink[2]) {
      rawTopic = privateLink[2];
    }
  } else {
    const publicLink =
      /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})(?:\/(\d+)(?:\/\d+)?)?\/?(?:\?.*)?$/i.exec(
        rawChatId,
      );
    if (publicLink && !['c', 'joinchat', 'addstickers', 'share'].includes(publicLink[1]!.toLowerCase())) {
      rawChatId = `@${publicLink[1]}`;
      if ((rawTopic === undefined || rawTopic === '') && publicLink[2]) {
        rawTopic = publicLink[2];
      }
    } else if ((rawTopic === undefined || rawTopic === '') && rawChatId.includes(':')) {
      const [c, t] = rawChatId.split(':', 2);
      rawChatId = (c ?? '').trim();
      if (t?.trim()) rawTopic = t.trim();
    }
  }

  if (!rawChatId) throw new HubError('invalid', 'Provide a Telegram chatId to link');
  if (!/^-?\d+$/.test(rawChatId) && !/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(rawChatId)) {
    throw new HubError(
      'invalid',
      'Provide a valid Telegram chat ID (e.g. -1001234567890 or @group) or a t.me/c/… topic link',
    );
  }

  let topicId: number | undefined;
  if (rawTopic !== undefined && rawTopic !== '') {
    const parsed = Number(rawTopic);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new HubError('invalid', 'topicId must be a positive integer');
    topicId = parsed;
  }
  return { chatId: rawChatId, ...(topicId !== undefined ? { topicId } : {}) };
}

export interface WorkspaceTelegramStatus {
  configured: boolean;
  canManage: boolean;
  chats: Array<{
    chatId: string;
    title?: string;
    topics?: Record<string, string>;
    updatedAt: string;
  }>;
  links: Array<{
    channelId: string;
    channelName: string;
    chatId: string;
    topicId?: number;
    paused?: boolean;
  }>;
}

export class TelegramBridge {
  private readonly fetchImpl: typeof fetch;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly autoLinking = new Map<string, Promise<(TelegramLink & { parlyChannelId: string }) | undefined>>();
  private readonly autoThreadTopics = new Map<string, Promise<(TelegramLink & { parlyChannelId: string }) | undefined>>();

  constructor(
    readonly store: TelegramStore,
    private readonly hub: HubService,
    private readonly opts: TelegramBridgeOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Waits for any in-flight webhook updates and outbound `sendMessage` calls to finish. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * `GET /workspaces/:id/telegram`: workspace-level Telegram status (connected supergroups + channel-to-topic mappings).
   */
  async workspaceStatus(caller: AgentRecord, workspaceId: string): Promise<WorkspaceTelegramStatus> {
    const workspace = await this.hub.registry.requireWorkspaceMembership(caller, workspaceId);
    const canManage = isOwner(workspace, caller);
    const owner = await this.hub.registry.get(workspace.ownerId);
    const [storedChats, channels] = await Promise.all([
      this.store.chatsForWorkspace(workspace.id),
      this.hub.registry.channelsOf(owner ?? caller, workspace.id),
    ]);
    const chatMap = new Map<string, { chatId: string; title?: string; topics?: Record<string, string>; updatedAt: string }>();
    for (const c of storedChats) {
      chatMap.set(c.chatId, {
        chatId: c.chatId,
        ...(c.title ? { title: c.title } : {}),
        ...(c.topics ? { topics: c.topics } : {}),
        updatedAt: c.updatedAt,
      });
    }
    const links: WorkspaceTelegramStatus['links'] = [];
    for (const ch of channels) {
      for (const l of ch.telegram ?? []) {
        if (l.threadId) continue;
        links.push({
          channelId: ch.id,
          channelName: ch.name,
          chatId: l.chatId,
          ...(l.topicId !== undefined ? { topicId: l.topicId } : {}),
          ...(l.paused ? { paused: true } : {}),
        });
        if (!chatMap.has(l.chatId)) {
          const doc = await this.store.chat(l.chatId);
          chatMap.set(l.chatId, {
            chatId: l.chatId,
            ...(doc?.title ? { title: doc.title } : {}),
            ...(doc?.topics ? { topics: doc.topics } : {}),
            updatedAt: doc?.updatedAt ?? ch.createdAt,
          });
        }
      }
    }
    return {
      configured: true,
      canManage,
      chats: [...chatMap.values()],
      links,
    };
  }

  /**
   * `POST /workspaces/:id/telegram`: connects a Telegram supergroup (`chatId` or `t.me/c/…` link) to the workspace.
   * Only a workspace owner may connect.
   */
  async connectWorkspaceForOwner(
    caller: AgentRecord,
    workspaceId: string,
    input: { chatId?: string; title?: string },
  ): Promise<WorkspaceTelegramStatus> {
    const workspace = await this.hub.registry.requireWorkspaceMembership(caller, workspaceId);
    if (!isOwner(workspace, caller)) {
      throw new HubError('forbidden', 'Only a workspace owner can connect a Telegram group');
    }
    const { chatId } = parseTelegramLinkInput({ chatId: input.chatId });
    const title = input.title?.trim();
    await this.store.saveChat(chatId, {
      workspaceId: workspace.id,
      ...(title ? { title } : {}),
    });
    return this.workspaceStatus(caller, workspace.id);
  }

  /**
   * `DELETE /workspaces/:id/telegram`: disconnects a Telegram supergroup (`chatId`, or all connected chats when omitted)
   * from the workspace and unlinks its channels in that workspace.
   */
  async disconnectWorkspaceForOwner(
    caller: AgentRecord,
    workspaceId: string,
    input: { chatId?: string } = {},
  ): Promise<WorkspaceTelegramStatus> {
    const workspace = await this.hub.registry.requireWorkspaceMembership(caller, workspaceId);
    if (!isOwner(workspace, caller)) {
      throw new HubError('forbidden', 'Only a workspace owner can disconnect a Telegram group');
    }
    const parsed = input.chatId?.trim() ? parseTelegramLinkInput({ chatId: input.chatId }) : undefined;
    const targetChatId = parsed?.chatId;
    const owner = await this.hub.registry.get(workspace.ownerId);
    const [storedChats, channels] = await Promise.all([
      this.store.chatsForWorkspace(workspace.id),
      this.hub.registry.channelsOf(owner ?? caller, workspace.id),
    ]);
    const chatIdsToDisconnect = targetChatId
      ? [targetChatId]
      : [...new Set([...storedChats.map((c) => c.chatId), ...channels.flatMap((ch) => (ch.telegram ?? []).map((l) => l.chatId))])];

    for (const ch of channels) {
      for (const prev of ch.telegram ?? []) {
        if (!targetChatId || prev.chatId === targetChatId) {
          await this.store.unlinkChannel(ch.id, prev);
        }
      }
    }
    for (const cId of chatIdsToDisconnect) {
      await this.store.disconnectWorkspaceChat(workspace.id, cId);
    }
    return this.workspaceStatus(caller, workspace.id);
  }

  /**
   * `POST /channels/:id/telegram`: links a Parly channel to a Telegram `chatId` (and optional forum `topicId`).
   * If `chatId` is omitted, defaults to the workspace's connected Telegram supergroup (or the channel's existing chatId).
   * Only a channel or workspace owner may link. Also records the chat's `workspaceId` for future topic `autoLink`.
   */
  async linkChannelForOwner(
    caller: AgentRecord,
    parlyChannelId: string,
    input: { chatId?: string; topicId?: number | string },
  ): Promise<{ telegram: TelegramLink[] }> {
    const channel = await this.hub.registry.resolveMemberChannel(caller, parlyChannelId);
    const workspace = await this.hub.registry.workspaceById(channel.workspaceId);
    if (!workspace) throw new HubError('not_found', 'Workspace not found');
    if (!isOwner(channel, caller) && !isOwner(workspace, caller)) {
      throw new HubError('forbidden', 'Only a channel or workspace owner can link a Telegram chat');
    }

    let fallbackChatId = input.chatId?.trim();
    if (!fallbackChatId) {
      fallbackChatId = (channel.telegram ?? []).find((l) => !l.threadId)?.chatId;
    }
    if (!fallbackChatId) {
      const wsChats = await this.store.chatsForWorkspace(workspace.id);
      fallbackChatId = wsChats[0]?.chatId;
    }
    if (!fallbackChatId) {
      throw new HubError('invalid', 'Connect a Telegram group in workspace settings first, or provide a chatId');
    }

    const { chatId: rawChatId, topicId } = parseTelegramLinkInput({
      chatId: fallbackChatId,
      topicId: input.topicId,
    });

    for (const prev of channel.telegram ?? []) {
      if (prev.chatId === rawChatId && !prev.threadId && (prev.topicId ?? undefined) !== topicId) {
        await this.store.unlinkChannel(channel.id, prev);
      }
    }
    const link: TelegramLink = { chatId: rawChatId, ...(topicId !== undefined ? { topicId } : {}) };
    await this.store.linkChannel(channel.id, link);
    if (!workspace.room) {
      await this.store.saveChat(rawChatId, { workspaceId: workspace.id });
    }
    const updated = (await this.hub.registry.channelsById([channel.id])).get(channel.id);
    return { telegram: updated?.telegram ?? [] };
  }

  /**
   * `DELETE /channels/:id/telegram`: unlinks a Parly channel from a Telegram `chatId`/`topicId` (or all links on the channel).
   */
  async unlinkChannelForOwner(
    caller: AgentRecord,
    parlyChannelId: string,
    input: { chatId?: string; topicId?: number | string } = {},
  ): Promise<{ telegram: TelegramLink[] }> {
    const channel = await this.hub.registry.resolveMemberChannel(caller, parlyChannelId);
    const workspace = await this.hub.registry.workspaceById(channel.workspaceId);
    if (!workspace) throw new HubError('not_found', 'Workspace not found');
    if (!isOwner(channel, caller) && !isOwner(workspace, caller)) {
      throw new HubError('forbidden', 'Only a channel or workspace owner can unlink a Telegram chat');
    }

    const parsed = input.chatId?.trim() ? parseTelegramLinkInput(input) : undefined;
    const rawChatId = parsed?.chatId;
    const topicId = parsed?.topicId ?? (input.topicId !== undefined && input.topicId !== '' ? Number(input.topicId) : undefined);
    for (const prev of channel.telegram ?? []) {
      if (!rawChatId || (prev.chatId === rawChatId && (topicId === undefined || prev.topicId === topicId))) {
        await this.store.unlinkChannel(channel.id, prev);
      }
    }
    const updated = (await this.hub.registry.channelsById([channel.id])).get(channel.id);
    return { telegram: updated?.telegram ?? [] };
  }

  /** Issues a one-time 10-minute code for `caller` to confirm in a DM with the Telegram bot (`/start <code>`). */
  async issueLinkCode(caller: AgentRecord, now = Date.now()): Promise<{ code: string; expiresAt: string; command: string }> {
    const { code, expiresAt } = await this.store.createAgentLinkCode(caller.id, now);
    return { code, expiresAt, command: `/start ${code}` };
  }

  /** Inspects a bot-issued one-time identity code without spending it (`GET /telegram/link?code=`). */
  async inspectLinkCode(_caller: AgentRecord, code: string, now = Date.now()): Promise<TelegramLinkCodeView> {
    const info = await this.store.inspectLinkCode(code, now);
    if (!info) {
      throw new HubError(
        'not_found',
        'That link has expired or was already used: send /start to the Parly bot in Telegram for a new one',
      );
    }
    return {
      telegramUserId: info.telegramUserId,
      ...(info.name ? { telegramUserName: info.name } : {}),
      ...(info.username ? { telegramUsername: info.username } : {}),
    };
  }

  /** Spends a bot-issued one-time identity code and binds `telegramUserId` to `caller` (`POST /telegram/link`). */
  async link(caller: AgentRecord, code: string, now = Date.now()): Promise<TelegramIdentity> {
    const who = await this.store.spendLinkCode(code, now);
    if (!who) {
      throw new HubError(
        'invalid',
        'That link has expired or was already used: send /start to the Parly bot in Telegram for a new one',
      );
    }
    return this.store.linkIdentity(who.telegramUserId, caller.id, {
      username: who.username,
      name: who.name,
    });
  }

  async identitiesOf(caller: AgentRecord): Promise<TelegramIdentity[]> {
    return this.store.identitiesOf(caller.id);
  }

  async unlinkMyIdentity(caller: AgentRecord, telegramUserId?: string): Promise<void> {
    await this.store.unlinkMyIdentity(caller.id, telegramUserId);
  }

  /**
   * Verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header against `webhookSecret` in constant time.
   * Fail-closed when either secret or header is missing/empty.
   */
  verified(secretHeader: string | undefined): boolean {
    const expected = this.opts.webhookSecret;
    if (!expected || !secretHeader) return false;
    return sameSecret(expected, secretHeader);
  }

  /**
   * `POST /telegram/webhook`: verifies the secret header, deduplicates by `update_id`, and relays the message.
   */
  async receive(raw: Buffer, secretHeader?: string): Promise<{ status: number; body: unknown }> {
    if (!this.verified(secretHeader)) return { status: 401, body: { error: 'Bad secret token' } };
    let update: TelegramUpdate;
    try {
      update = JSON.parse(raw.toString('utf8')) as TelegramUpdate;
    } catch {
      return { status: 400, body: { error: 'Not JSON' } };
    }
    if (typeof update?.update_id !== 'number') return { status: 200, body: { ok: true } };
    const updateId = String(update.update_id);
    const kept = await this.store.keepEvent(updateId, update);
    if (kept) this.track(this.process(updateId).catch((err) => console.error(`Telegram update ${updateId}`, err)));
    return { status: 200, body: { ok: true } };
  }

  /** Handles a kept Telegram update once; failures are recorded for `/tick` sweep retry. */
  async process(updateId: string): Promise<void> {
    const kept = await this.store.claimEvent(updateId);
    if (!kept) return;
    try {
      await this.handle(kept.update as TelegramUpdate);
      await this.store.eventDone(updateId);
    } catch (err) {
      await this.store.eventFailed(updateId, (err as Error).message);
      throw err;
    }
  }

  /** The `/tick` sweep: retries unhandled inbound updates and due outbound Telegram messages. */
  async sweep(): Promise<number> {
    return sweepBridge(this.store, (id) => this.process(id), (key) => this.send(key), {
      event: 'Telegram update',
      post: 'Telegram post',
    });
  }

  /** Mirrors a newly posted Parly message to every linked Telegram chat/topic, except the one it came from. */
  onPosted(message: MessageDoc): Promise<void> {
    const run = this.enqueuePosted(message);
    this.track(run);
    return run;
  }

  private async enqueuePosted(message: MessageDoc): Promise<void> {
    if (!message.channelId) return;
    const channel = (await this.hub.registry.channelsById([message.channelId])).get(message.channelId);
    const allLinks = channel?.telegram ?? [];
    const baseLinks = allLinks.filter((l) => !l.threadId);
    for (const baseLink of baseLinks) {
      if (baseLink.paused) continue;
      let targetLink: TelegramLink = baseLink;
      if (message.post) {
        let threadLink: TelegramLink | undefined = allLinks.find(
          (l) => l.chatId === baseLink.chatId && l.threadId === message.post,
        );
        if (!threadLink) {
          const root = await this.store.message(message.post);
          const rootCopy = root?.telegram?.find((c) => c.chatId === baseLink.chatId);
          const alreadyInTopic = baseLink.topicId === undefined && rootCopy?.topicId !== undefined;
          if (!alreadyInTopic) {
            threadLink = await this.ensureThreadTopic(message.channelId, baseLink.chatId, message.post);
          }
        }
        if (threadLink) targetLink = threadLink;
      }
      if (targetLink.paused) continue;
      if (message.telegram?.some((c) => isOwnTelegramCopy(c, targetLink))) {
        continue;
      }
      const job: TelegramOut = {
        messageId: message.id,
        chatId: targetLink.chatId,
        ...(targetLink.topicId !== undefined ? { topicId: targetLink.topicId } : {}),
        parlyChannelId: message.channelId,
      };
      if (await this.store.queueOut(job)) {
        this.track(this.send(outKey(job)).catch((err) => console.error(`Telegram post ${job.messageId}`, err)));
      }
    }
  }

  /** Posts one queued Parly message to Telegram via `sendMessage`. */
  async send(key: string): Promise<void> {
    const job = await this.store.claimOut(key);
    if (!job) return;
    const message = await this.store.message(job.messageId);
    if (!message || message.telegram?.some((c) => isOwnTelegramCopy(c, job))) {
      return this.store.doneOut(key);
    }
    try {
      const body = this.telegramText(message);
      const threadFields = await this.threadFields(message, job);
      const senderAgent = await this.hub.registry.get(message.fromId);
      const agentBotToken = senderAgent ? this.hub.registry.telegramBotTokenOf(senderAgent) : undefined;
      let posted: { message_id: number; message_thread_id?: number } | undefined;
      if (agentBotToken) {
        try {
          posted = await this.api<{ message_id: number; message_thread_id?: number }>(
            'sendMessage',
            {
              chat_id: job.chatId,
              text: formatTelegramOutbound(body),
              parse_mode: 'HTML',
              ...threadFields,
            },
            agentBotToken,
          );
        } catch (err) {
          if (err instanceof TelegramApiError && err.retryAfterMs !== undefined) throw err;
          // Graceful fallback: if the agent's bot isn't a member of the group (or lacks send rights / token revoked),
          // fall back to the shared @ParlyBot with the bold HTML sender header.
        }
      }
      if (!posted) {
        const sender = await bridgeSenderName(this.hub, message, job.parlyChannelId);
        const text = formatTelegramOutbound(body, sender);
        posted = await this.api<{ message_id: number; message_thread_id?: number }>('sendMessage', {
          chat_id: job.chatId,
          text,
          parse_mode: 'HTML',
          ...threadFields,
        });
      }
      const resolvedTopicId = job.topicId ?? threadFields.message_thread_id ?? posted.message_thread_id;
      await this.store.addCopy(message.id, {
        chatId: job.chatId,
        messageId: Number(posted.message_id),
        ...(resolvedTopicId !== undefined ? { topicId: Number(resolvedTopicId) } : {}),
      });
      await this.store.doneOut(key);
    } catch (err) {
      return bridgeOutboxFailure(this.store, key, job, err, {
        label: 'Telegram post',
        retryAfterMs: err instanceof TelegramApiError ? err.retryAfterMs : undefined,
      });
    }
  }

  /**
   * Resolves `message_thread_id` (and `reply_to_message_id` when replying in a thread) for an outbound post.
   */
  private async threadFields(
    message: MessageDoc,
    job: Pick<TelegramOut, 'chatId' | 'topicId'>,
  ): Promise<{ message_thread_id?: number; reply_to_message_id?: number }> {
    if (!message.post) {
      return job.topicId !== undefined ? { message_thread_id: job.topicId } : {};
    }
    const post = await this.store.message(message.post);
    const copy = post?.telegram?.find((c) => isOwnTelegramCopy(c, job));
    if (!copy) {
      return job.topicId !== undefined ? { message_thread_id: job.topicId } : {};
    }
    const threadId = job.topicId ?? copy.topicId ?? copy.messageId;
    return {
      message_thread_id: threadId,
      reply_to_message_id: copy.messageId,
    };
  }

  private topicNameForThread(root: MessageDoc | undefined, channelName?: string): string {
    const raw = (root?.parts.map((p) => p.text ?? '').join(' ') ?? '').replace(/\s+/g, ' ').trim();
    const title = raw || 'Thread';
    const prefix = channelName?.replace(/\s+/g, ' ').trim();
    const combined = prefix ? `${prefix}: ${title}` : title;
    return combined.slice(0, MAX_TOPIC_NAME).trim() || 'Thread';
  }

  /**
   * Ensures a dedicated Telegram forum topic exists and is linked for a Parly thread `(parlyChannelId, chatId, threadId)`.
   * Coalesces concurrent in-process calls per `(chatId, threadId)` and recovers from cross-instance `linkChannel` conflicts.
   * Returns `undefined` when `createForumTopic` fails so outbound messages fall back to relaying in the channel's topic.
   */
  async ensureThreadTopic(
    parlyChannelId: string,
    chatId: string,
    threadId: string,
  ): Promise<(TelegramLink & { parlyChannelId: string }) | undefined> {
    const key = `${chatId}:${threadId}`;
    const pending = this.autoThreadTopics.get(key);
    if (pending) return pending;
    const run = this.ensureThreadTopicOnce(parlyChannelId, chatId, threadId).finally(() => {
      if (this.autoThreadTopics.get(key) === run) this.autoThreadTopics.delete(key);
    });
    this.autoThreadTopics.set(key, run);
    return run;
  }

  private async ensureThreadTopicOnce(
    parlyChannelId: string,
    chatId: string,
    threadId: string,
  ): Promise<(TelegramLink & { parlyChannelId: string }) | undefined> {
    const existing = await this.store.linkedThread(parlyChannelId, chatId, threadId);
    if (existing) return existing;

    const [root, channels] = await Promise.all([
      this.store.message(threadId),
      this.hub.registry.channelsById([parlyChannelId]),
    ]);
    const name = this.topicNameForThread(root, channels.get(parlyChannelId)?.name);

    let topicId: number | undefined;
    try {
      const created = await this.api<{ message_thread_id?: number }>('createForumTopic', {
        chat_id: chatId,
        name,
      });
      if (
        typeof created?.message_thread_id === 'number' &&
        Number.isInteger(created.message_thread_id) &&
        created.message_thread_id > 0
      ) {
        topicId = created.message_thread_id;
      }
    } catch {
      return undefined;
    }
    if (topicId === undefined) return undefined;

    const link: TelegramLink = { chatId, topicId, threadId };
    try {
      await this.store.linkChannel(parlyChannelId, link);
    } catch (err) {
      if (err instanceof HubError && err.code === 'conflict') {
        await this.api('deleteForumTopic', { chat_id: chatId, message_thread_id: topicId }).catch(() => undefined);
        return this.store.linkedThread(parlyChannelId, chatId, threadId);
      }
      throw err;
    }
    return { ...link, parlyChannelId };
  }

  private telegramText(message: MessageDoc): string {
    const chunks: string[] = [];
    for (const p of message.parts) {
      const chunk = partText(p, '');
      if (chunk) chunks.push(chunk);
    }
    const joined = chunks.join('\n').trim();
    return joined || '(no text)';
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || msg.from?.is_bot || !msg.chat || typeof msg.message_id !== 'number') return;

    const chatId = String(msg.chat.id);
    const topicId = typeof msg.message_thread_id === 'number' ? msg.message_thread_id : undefined;
    const topicName =
      msg.forum_topic_created?.name?.trim() ||
      msg.forum_topic_edited?.name?.trim() ||
      msg.reply_to_message?.forum_topic_created?.name?.trim();
    if (msg.chat.title || (topicId !== undefined && topicName)) {
      await this.store.saveChat(chatId, {
        ...(msg.chat.title ? { title: msg.chat.title } : {}),
        ...(topicId !== undefined && topicName ? { topic: { topicId, name: topicName } } : {}),
      });
    }

    // Forum topic creation event: auto-link the new topic to a matching or newly created Parly channel in the chat's workspace.
    if (msg.forum_topic_created?.name && topicId !== undefined) {
      await this.autoLink(chatId, topicId, msg.forum_topic_created.name);
    }

    const text = (msg.text ?? msg.caption ?? '').trim();
    if (!text) return;

    const cmdMatch = /^\/(?:start|link)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/i.exec(text);
    if (cmdMatch && msg.from) {
      const codeArg = cmdMatch[1]?.trim();
      if (codeArg && msg.chat.type !== 'private') {
        // The code is now visible to the whole group: burn it so no member can replay it in a DM.
        await this.store.spendAgentLinkCode(codeArg);
        await this.reply(
          chatId,
          topicId,
          'Link codes only work in a private chat with me. Generate a new code on Parly and send /start <code> to me directly.',
        );
        return;
      }
      if (codeArg) {
        const spent = await this.store.spendAgentLinkCode(codeArg);
        const targetAgent = spent ? await this.hub.registry.get(spent.agentId) : undefined;
        if (!targetAgent || targetAgent.archived) {
          await this.reply(
            chatId,
            topicId,
            'That link code has expired or was already used. Generate a new code on Parly and send /start <code>.',
          );
          return;
        }
        await this.store.linkIdentity(String(msg.from.id), targetAgent.id, {
          username: msg.from.username,
          name: formatTelegramSender(msg.from),
        });
        await this.reply(
          chatId,
          topicId,
          `Connected! Your Telegram account is now linked to ${targetAgent.name} on Parly.`,
        );
        return;
      }
      if (msg.chat.type === 'private') {
        // Honour the hourly throttle (`force` would let /start mint a fresh code every time).
        const code = await this.store.linkCode(
          String(msg.from.id),
          { username: msg.from.username, name: formatTelegramSender(msg.from) },
        );
        if (!code) {
          await this.reply(
            chatId,
            undefined,
            'You already requested a link recently. Wait up to an hour, or generate a code on Parly (Account) and send /start <code> here.',
          );
          return;
        }
        const base = (this.opts.webUrl ?? 'https://parly.dev').replace(/\/+$/, '');
        const url = `${base}/telegram/link?${new URLSearchParams({ code })}`;
        await this.reply(
          chatId,
          undefined,
          `To post on Parly as yourself, open this one-time link: ${url}\nOr generate a code on Parly (Account) and send /start <code> here.`,
        );
        return;
      }
    }

    const origin: TelegramCopy = { chatId, messageId: msg.message_id, ...(topicId !== undefined ? { topicId } : {}) };
    if (await this.store.messageAt(origin)) return;

    let link = await this.store.linkedChannel(chatId, topicId);
    // If a message arrives in a named topic of a workspace-bound supergroup that doesn't have its own topic link yet
    // (or in an unlinked chat with a known workspace), auto-link it to a matching/new Parly channel.
    if (!link || (topicId !== undefined && link.topicId === undefined && topicName)) {
      const chatDoc = await this.store.chat(chatId);
      const desired = topicId !== undefined ? (topicName ?? chatDoc?.topics?.[String(topicId)]) : msg.chat.title ?? chatDoc?.title;
      if (desired) {
        const auto = await this.autoLink(chatId, topicId, desired);
        if (auto) link = auto;
      }
    }
    if (!link || link.paused) return;

    const channel = (await this.hub.registry.channelsById([link.parlyChannelId])).get(link.parlyChannelId);
    if (!channel) return;

    const fromUserId = msg.from ? String(msg.from.id) : undefined;
    const identity = fromUserId ? await this.store.identity(fromUserId) : undefined;
    const linkedAgent = identity ? await this.hub.registry.get(identity.agentId) : undefined;
    const linked = linkedAgent && !linkedAgent.archived ? linkedAgent : undefined;
    const channelOwner = await this.hub.registry.get(channel.ownerId);
    let author = linked ?? channelOwner;
    if (!author) return;

    if (linked && !(linked.channels ?? []).includes(channel.id)) {
      if ((linked.workspaces ?? []).includes(channel.workspaceId) && channelOwner) {
        const added = await this.hub.registry.addToChannel(channelOwner, channel.id, linked.id).catch(() => undefined);
        if (added) author = added.agent;
      }
    }

    // Not a channel member (and not addable): post as the channel owner with external attribution, never bypassing hub.send.
    if (linked && !(author.channels ?? []).includes(channel.id)) {
      if (!channelOwner) return;
      author = channelOwner;
    }
    const external = linked && author.id === linked.id
      ? undefined
      : { id: `telegram:${fromUserId ?? chatId}`, name: formatTelegramSender(msg.from) };

    // Resolve Parly thread from a thread-bound topic (`link.threadId`), `message_thread_id` (group topic on a whole-chat link), or `reply_to_message`.
    let thread: string | undefined = link.threadId;
    if (!thread) {
      let mappedMsgId: string | undefined;
      if (link.topicId === undefined && topicId !== undefined && topicId !== msg.message_id) {
        mappedMsgId = await this.store.messageAt({ chatId, messageId: topicId });
      }
      if (
        !mappedMsgId &&
        typeof msg.reply_to_message?.message_id === 'number' &&
        msg.reply_to_message.message_id !== msg.message_id &&
        msg.reply_to_message.message_id !== topicId
      ) {
        mappedMsgId = await this.store.messageAt({ chatId, messageId: msg.reply_to_message.message_id });
      }
      if (mappedMsgId) {
        const targetMsg = await this.store.message(mappedMsgId);
        if (targetMsg && targetMsg.channelId === link.parlyChannelId) {
          thread = targetMsg.post ?? targetMsg.id;
        }
      }
    }

    // If the resolved author has left the channel, hub.send would refuse and the inbound update would retry
    // fruitlessly until MAX_ATTEMPTS. Skip with a reason instead (the gated check at 827 only covers linked senders).
    if (!(author.channels ?? []).includes(channel.id)) {
      console.warn(`Telegram ${chatId}: skipped, ${author.id} left channel ${channel.id}`);
      return;
    }
    const parts = await this.hub.parts(author, text, undefined, undefined);
    const posted = await this.hub.send(
      author,
      { channel: link.parlyChannelId, ...(thread ? { thread } : {}) },
      parts,
      { telegram: [origin], ...(external ? { external } : {}) },
    );
    await this.store.rememberCopy(origin, posted.message.id);
    if (link.topicId === undefined && topicId !== undefined && !thread) {
      await this.store.rememberCopy({ chatId, messageId: topicId, topicId }, posted.message.id);
    }
    if (external && fromUserId && posted.message.mentions?.length) {
      const workspace = await this.hub.registry.workspaceById(channel.workspaceId);
      if (!workspace?.room) {
        const code = await this.store.linkCode(fromUserId, {
          username: msg.from?.username,
          name: formatTelegramSender(msg.from),
        });
        if (code) {
          const base = (this.opts.webUrl ?? 'https://parly.dev').replace(/\/+$/, '');
          const url = `${base}/telegram/link?${new URLSearchParams({ code })}`;
          await this.api('sendMessage', {
            chat_id: chatId,
            ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
            reply_to_message_id: msg.message_id,
            text: `To wake agents here, connect your Telegram account to Parly (once): ${url}`,
          }).catch(() => undefined);
        }
      }
    }
  }

  /**
   * Auto-links a Telegram chat or forum topic to the Parly channel of the same name in the chat's bound workspace,
   * creating the Parly channel if none exists yet (mirrors `SlackBridge.autoLink`).
   */
  async autoLink(
    chatId: string,
    topicId: number | undefined,
    rawName: string | undefined,
  ): Promise<(TelegramLink & { parlyChannelId: string }) | undefined> {
    const name = (rawName ?? '').trim();
    if (!name) return undefined;
    const key = `${chatId}:${topicId ?? 'root'}`;
    const pending = this.autoLinking.get(key);
    if (pending) return pending;
    const run = this.autoLinkOnce(chatId, topicId, name).finally(() => {
      if (this.autoLinking.get(key) === run) this.autoLinking.delete(key);
    });
    this.autoLinking.set(key, run);
    return run;
  }

  private async autoLinkOnce(
    chatId: string,
    topicId: number | undefined,
    name: string,
  ): Promise<(TelegramLink & { parlyChannelId: string }) | undefined> {
    const existing = await this.store.linkedChannel(chatId, topicId);
    if (existing && (topicId === undefined || existing.topicId === topicId)) return existing;

    let workspaceId = (await this.store.chat(chatId))?.workspaceId;
    if (!workspaceId) {
      const siblingLinks = await this.store.linksForChat(chatId);
      if (siblingLinks.length) {
        const ch = (await this.hub.registry.channelsById([siblingLinks[0]!.parlyChannelId])).get(siblingLinks[0]!.parlyChannelId);
        if (ch) {
          workspaceId = ch.workspaceId;
          await this.store.saveChat(chatId, { workspaceId });
        }
      }
    }
    if (!workspaceId) return undefined;

    const workspace = await this.hub.registry.workspaceById(workspaceId);
    if (!workspace || workspace.room) return undefined;
    const owner = await this.hub.registry.get(workspace.ownerId);
    if (!owner) return undefined;

    const loose = (n: string) => n.toLowerCase().replace(/^#/, '').replace(/[\s_-]+/g, '');
    const canUse = (c: { archived?: boolean; telegram?: TelegramLink[]; name: string }) =>
      !c.archived &&
      (!c.telegram?.length || c.telegram.some((l) => l.chatId === chatId && l.topicId === topicId)) &&
      loose(c.name) === loose(name);
    const mine = await this.hub.registry.channelsOf(owner, workspace.id);
    let channel = mine.find(canUse);
    let created = false;
    if (!channel) {
      if (topicId !== undefined) {
        const topicLinks = (await this.store.linksForChat(chatId)).filter((l) => l.topicId !== undefined && !l.threadId);
        if (topicLinks.length >= MAX_AUTO_TOPIC_CHANNELS) return undefined;
      }
      try {
        channel = await this.hub.registry.createChannel(owner, workspace.id, name);
        created = true;
      } catch (err) {
        if (err instanceof HubError && err.code === 'conflict') {
          const freshOwner = await this.hub.registry.get(workspace.ownerId);
          const freshMine = freshOwner ? await this.hub.registry.channelsOf(freshOwner, workspace.id) : [];
          channel = freshMine.find(canUse);
          if (!channel) {
            const raced = await this.store.linkedChannel(chatId, topicId);
            return raced && (topicId === undefined || raced.topicId === topicId) ? raced : undefined;
          }
        } else {
          throw err;
        }
      }
    }
    const link: TelegramLink = { chatId, ...(topicId !== undefined ? { topicId } : {}) };
    let newlyLinked = false;
    try {
      newlyLinked = await this.store.linkChannel(channel.id, link);
    } catch (err) {
      if (err instanceof HubError && err.code === 'conflict') {
        if (created) {
          await this.hub.registry.updateChannel(owner, channel.id, { archived: true }).catch(() => undefined);
        }
        const winner = await this.store.linkedChannel(chatId, topicId);
        return winner && (topicId === undefined || winner.topicId === topicId) ? winner : undefined;
      }
      throw err;
    }
    if (newlyLinked) {
      await this.reply(
        chatId,
        topicId,
        `This ${topicId !== undefined ? 'topic' : 'chat'} is now linked to #${channel.name} on Parly: messages here and there show up in both.`,
      );
    }
    return { ...link, parlyChannelId: channel.id };
  }

  /** Sends a bot notice to a chat (in `topicId`'s topic when given). Best effort: a failed send is ignored. */
  private async reply(chatId: string, topicId: number | undefined, text: string): Promise<void> {
    await this.api('sendMessage', {
      chat_id: chatId,
      ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
      text,
    }).catch(() => undefined);
  }

  private async api<T>(method: string, body: Record<string, unknown>, tokenOverride?: string): Promise<T> {
    const token = tokenOverride ?? this.opts.botToken;
    const res = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!res.ok || !data.ok || !data.result) {
      const retryAfter = data.parameters?.retry_after ? Number(data.parameters.retry_after) * 1000 : undefined;
      throw new TelegramApiError(res.status, data.description ?? `HTTP ${res.status}`, retryAfter);
    }
    return data.result;
  }
}
