import { createHmac } from 'node:crypto';
import { sameSecret } from '../lib/sealing.js';
import { INLINE_UPLOAD_MAX } from '../files/files.js';
import type { HubService } from '../hub/hubService.js';
import { bridgeOutboxFailure, bridgeSenderName, isOwnSlackCopy, partText, sweepBridge } from '../lib/bridge.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';
import { dmWith, type MessageDoc } from '../chat/chat.js';
import { INSTALL_GONE, extractSlackUserName, outKey, type SlackCopy, type SlackInstall, type SlackLink, type SlackOut, type SlackStore, type SlackUserPayload } from './store.js';

/**
 * The Slack bridge (PLAN-SLACK.md): people write in Slack, and their messages are posted on Parly as them;
 * what's posted on Parly is mirrored to the linked Slack channels. Parly stays the source of truth.
 */
interface SlackBridgeOptions {
  /** The Slack app's signing secret: every call to /slack/events is signed with it. */
  signingSecret: string;
  /** The web app, where people link their Slack account (`/slack/link?code=`). */
  webUrl: string;
  fetchImpl?: typeof fetch;
}

/** How far a request's timestamp may be from now (Slack's own guidance), so an old one can't be replayed. */
const MAX_SKEW_MS = 5 * 60_000;
/** Slack's limit on a message's text, with room for the note that it was cut. */
const MAX_SLACK_TEXT = 39_000;
/** Slack errors meaning the channel can't be posted to any more: it's unlinked. */
const CHANNEL_GONE = new Set(['channel_not_found', 'not_in_channel']);
/** The Slack channel is archived: the link pauses (an unarchive brings it back, see `resume`), it isn't unlinked. */
const CHANNEL_ARCHIVED = 'is_archived';

/** A Slack Web API call that failed: Slack's error code, and how long Slack asked us to wait (a 429). */
class SlackError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Slack: ${code}`);
  }
}

interface SlackEnvelope {
  type: string;
  team_id?: string;
  event_id?: string;
  challenge?: string;
  event?: SlackEvent;
}

interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  mode?: string;
}

interface SlackAttachment {
  fallback: string;
  title?: string;
  title_link?: string;
  image_url?: string;
}

/** Image media types Slack renders inline via `image_url` in message attachments. */
const SLACK_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SLACK_FILE_LINK_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_SLACK_FILES = 10;

interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFile[];
}

/** The picker's view (`/parly`). */
const ASK = 'parly_ask';
const option = (a: AgentRecord) => ({ text: { type: 'plain_text', text: a.name.slice(0, 75) }, value: a.id });

interface SlackInteraction {
  type?: string;
  team?: { id?: string };
  user?: { id?: string; team_id?: string };
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string; selected_option?: { value?: string } }>> };
  };
}

/**
 * Markdown (what agents write) in Slack's mrkdwn: **bold** → *bold*, *italic* → _italic_, ~~x~~ → ~x~, [t](u) → <u|t>,
 * headings bold, list dashes as bullets. Code (``` and `) is left alone. Run on already-escaped text.
 */
export function mrkdwn(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
            .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '**$1**')
            .replace(/(?<![*\w])\*(?!\*|\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '_$1_')
            .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '*$1*')
            .replace(/__(?!\s)(.+?)(?<!\s)__/g, '*$1*')
            .replace(/~~(.+?)~~/g, '~$1~')
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>'),
    )
    .join('');
}


export class SlackBridge {
  private readonly fetchImpl: typeof fetch;
  /** Refusals already told to a Slack user today ("Not posted on Parly: …"), by channel, user and reason. */
  // ponytail: per instance and in memory; a few repeats across instances or restarts are fine
  private readonly told = new Map<string, string>();

  constructor(
    private readonly store: SlackStore,
    private readonly hub: HubService,
    private readonly opts: SlackBridgeOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Whether a request carries Slack's signature over exactly this raw body, made within the last few minutes. */
  verified(raw: Buffer, timestamp: string | undefined, signature: string | undefined, now = Date.now()): boolean {
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
    if (Math.abs(now - Number(timestamp) * 1000) > MAX_SKEW_MS) return false;
    const expected = `v0=${createHmac('sha256', this.opts.signingSecret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
    return sameSecret(expected, signature);
  }

  /**
   * POST /slack/events. The event is kept before Slack is answered (so a crash after the answer loses nothing),
   * then handled; a 5xx makes Slack deliver it again. Returns the HTTP answer.
   */
  async receive(raw: Buffer, timestamp?: string, signature?: string): Promise<{ status: number; body: unknown }> {
    if (!this.verified(raw, timestamp, signature)) return { status: 401, body: { error: 'Bad signature' } };
    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(raw.toString('utf8')) as SlackEnvelope;
    } catch {
      return { status: 400, body: { error: 'Not JSON' } };
    }
    if (envelope.type === 'url_verification') return { status: 200, body: { challenge: envelope.challenge } };
    if (envelope.type !== 'event_callback' || !envelope.event_id) return { status: 200, body: {} };
    const kept = await this.store.keepEvent(envelope.event_id, envelope);
    if (kept) void this.process(envelope.event_id).catch((err) => console.error(`Slack event ${envelope.event_id}`, err));
    return { status: 200, body: {} };
  }

  /**
   * POST /slack/commands: `/parly [message]` in a linked channel opens a picker of the channel's agents with the
   * message box, since Slack's own @ list can't show agents. Answers within Slack's 3 seconds.
   */
  async command(raw: Buffer, timestamp?: string, signature?: string): Promise<{ status: number; body: unknown }> {
    if (!this.verified(raw, timestamp, signature)) return { status: 401, body: { error: 'Bad signature' } };
    const f = new URLSearchParams(raw.toString('utf8'));
    const [teamId, channel, user] = [f.get('team_id') ?? '', f.get('channel_id') ?? '', f.get('user_id') ?? ''];
    const tell = (text: string) => ({ status: 200, body: { response_type: 'ephemeral', text } });
    const install = await this.store.install(teamId);
    if (!install || install.problem) return tell("Parly isn't connected to this Slack workspace: connect it from Parly.");
    const asker = await this.asker(install, channel, user);
    if (typeof asker === 'string') return tell(asker);
    await this.api(install, 'views.open', {
      trigger_id: f.get('trigger_id'),
      view: {
        type: 'modal',
        callback_id: ASK,
        private_metadata: JSON.stringify({ channel }),
        title: { type: 'plain_text', text: 'Ask an agent' },
        submit: { type: 'plain_text', text: 'Send' },
        blocks: [
          {
            type: 'input',
            block_id: 'agent',
            label: { type: 'plain_text', text: 'Agent' },
            element: {
              type: 'static_select',
              action_id: 'pick',
              ...(asker.agents.length === 1 ? { initial_option: option(asker.agents[0]!) } : {}),
              options: asker.agents.slice(0, 100).map(option),
            },
          },
          {
            type: 'input',
            block_id: 'text',
            label: { type: 'plain_text', text: 'Message' },
            element: { type: 'plain_text_input', action_id: 'msg', multiline: true, ...(f.get('text')?.trim() ? { initial_value: f.get('text')!.trim() } : {}) },
          },
        ],
      },
    });
    return { status: 200, body: '' };
  }

  /** POST /slack/interactions: the picker sent. Posted on Parly as the person, to the agent they picked. */
  async interaction(raw: Buffer, timestamp?: string, signature?: string): Promise<{ status: number; body: unknown }> {
    if (!this.verified(raw, timestamp, signature)) return { status: 401, body: { error: 'Bad signature' } };
    let p: SlackInteraction;
    try {
      p = JSON.parse(new URLSearchParams(raw.toString('utf8')).get('payload') ?? '{}') as SlackInteraction;
    } catch {
      return { status: 400, body: { error: 'Invalid payload' } };
    }
    if (p.type !== 'view_submission' || p.view?.callback_id !== ASK) return { status: 200, body: '' };
    const values = p.view.state?.values ?? {};
    const agentId = values.agent?.pick?.selected_option?.value;
    const text = values.text?.msg?.value?.trim();
    let channel: string | undefined;
    try {
      ({ channel } = JSON.parse(p.view.private_metadata ?? '{}') as { channel?: string });
    } catch {
      return { status: 400, body: { error: 'Invalid private_metadata' } };
    }
    const install = await this.store.install(p.team?.id ?? p.user?.team_id ?? '');
    if (!install || !channel || !agentId || !text) return { status: 200, body: '' };
    // Everything is checked again: who they are, the channel's link, and that the agent is in it.
    const asker = await this.asker(install, channel, p.user?.id ?? '');
    const agent = typeof asker === 'string' ? undefined : asker.agents.find((a) => a.id === agentId);
    if (typeof asker === 'string' || !agent) {
      return { status: 200, body: { response_action: 'errors', errors: { agent: typeof asker === 'string' ? asker : 'That agent is no longer in this channel' } } };
    }
    try {
      await this.hub.send(asker.person, { channel: asker.parlyChannelId }, [{ text: `@${agent.name} ${text}` }]);
    } catch (err) {
      if (err instanceof HubError) return { status: 200, body: { response_action: 'errors', errors: { text: err.message } } };
      throw err;
    }
    return { status: 200, body: '' };
  }

  /** Who is asking from this Slack channel, its Parly channel, and the agents in it; or why they can't. */
  private async asker(install: SlackInstall, channel: string, user: string): Promise<{ person: AgentRecord; parlyChannelId: string; agents: AgentRecord[] } | string> {
    const identity = await this.store.identity(install.teamId, user);
    if (!identity) {
      const code = await this.store.linkCode(install.teamId, user);
      return code
        ? `Connect your Slack account to Parly first (once): ${this.opts.webUrl}/slack/link?${new URLSearchParams({ code })}`
        : 'Connect your Slack account to Parly first, with the link Parly sent you.';
    }
    const person = await this.hub.registry.get(identity.agentId);
    if (!person || person.kind !== 'human') return 'Your Parly account is not available.';
    const link = await this.store.linkedChannel(install.teamId, channel);
    if (!link) return "This channel isn't linked to Parly yet: type /invite @Parly here first.";
    const agents = (await this.hub.registry.search(person, { channel: link.parlyChannelId })).filter((a) => a.kind !== 'human' && !a.webhookChannel && !a.archived);
    if (!agents.length) return 'No agents are in this channel yet. Add one from Parly (the channel panel).';
    return { person, parlyChannelId: link.parlyChannelId, agents };
  }

  /** Handles a kept event once. A failure is counted, and the sweep tries it again. */
  async process(eventId: string): Promise<void> {
    const kept = await this.store.claimEvent(eventId);
    if (!kept) return;
    try {
      await this.handle(kept.envelope as SlackEnvelope);
      await this.store.eventDone(eventId);
    } catch (err) {
      await this.store.eventFailed(eventId, (err as Error).message);
      throw err;
    }
  }

  /** The /tick sweep: events kept but never handled, and posts to Slack that are due. Returns how many it did. */
  async sweep(): Promise<number> {
    return sweepBridge(this.store, (id) => this.process(id), (key) => this.send(key), {
      event: 'Slack event',
      post: 'Slack post',
    });
  }

  /**
   * A message was posted on Parly: it goes to every Slack channel its Parly channel is linked to, except the one
   * it came from. Each post is kept until it's in Slack, so a failure is retried (send, sweep).
   */
  private avatarUrl(a: AgentRecord): string {
    return `${this.opts.webUrl}/avatar/${encodeURIComponent(a.avatar ?? a.id)}?kind=${a.kind === 'human' ? 'human' : 'bot'}`;
  }

  async onPosted(message: MessageDoc): Promise<void> {
    if (message.conversationId.startsWith('dm:')) return this.onDm(message);
    if (!message.channelId) return;
    const channel = (await this.hub.registry.channelsById([message.channelId])).get(message.channelId);
    for (const link of channel?.slack ?? []) {
      if (message.slack?.some((c) => isOwnSlackCopy(c, link))) continue;
      const job: SlackOut = { messageId: message.id, teamId: link.teamId, channelId: link.channelId, parlyChannelId: message.channelId };
      if (await this.store.queueOut(job)) void this.send(outKey(job)).catch((err) => console.error(`Slack post ${job.messageId}`, err));
    }
  }

  /** An agent's DM to a person who talks with it from Slack: it goes to that Slack DM (their own messages don't). */
  private async onDm(message: MessageDoc): Promise<void> {
    const to = dmWith(message.conversationId, message.fromId);
    if (!to) return;
    for (const dm of await this.store.dmsWith(to, message.fromId)) {
      if (message.slack?.some((c) => isOwnSlackCopy(c, dm))) continue;
      const job: SlackOut = { messageId: message.id, teamId: dm.teamId, channelId: dm.channelId, parlyChannelId: '', dm: { slackUserId: dm.slackUserId, personId: to } };
      if (await this.store.queueOut(job)) void this.send(outKey(job)).catch((err) => console.error(`Slack DM ${job.messageId}`, err));
    }
  }

  /** A post went through to a paused link's Slack channel: it's back (unarchived), so the link is too. */
  private async resume(teamId: string, channelId: string): Promise<void> {
    const link = await this.store.linkedChannel(teamId, channelId);
    if (link?.paused) await this.store.setPaused(link.parlyChannelId, link, false);
  }

  /** Posts one waiting message in Slack (as its sender, in its thread), or schedules another try. */
  async send(key: string): Promise<void> {
    const job = await this.store.claimOut(key);
    if (!job) return;
    const install = await this.store.install(job.teamId);
    const message = await this.store.message(job.messageId);
    if (!install || install.problem || !message || message.slack?.some((c) => isOwnSlackCopy(c, job))) {
      return this.store.doneOut(key);
    }
    if (job.dm && (await this.store.identity(job.teamId, job.dm.slackUserId))?.agentId !== job.dm.personId) return this.store.doneOut(key); // unlinked since
    try {
      const sender = await this.hub.registry.get(message.fromId);
      const { text, attachments } = await this.slackPayload(job.teamId, message);
      const posted = await this.api(install, 'chat.postMessage', {
        channel: job.channelId,
        text,
        ...(attachments.length ? { attachments } : {}),
        username: await bridgeSenderName(this.hub, message, job.parlyChannelId),
        // Their own Slack picture for a linked person; otherwise their Parly avatar, drawn as a PNG by the web app.
        icon_url:
          (sender?.kind === 'human' && (await this.slackFace(install, message.fromId))) ||
          (sender ? this.avatarUrl(sender) : `${this.opts.webUrl}/avatar/${encodeURIComponent(message.fromId)}?kind=${message.external ? 'human' : 'bot'}`),
        ...(await this.threadTs(message, job)),
        unfurl_links: false,
      });
      await this.store.addCopy(message.id, { teamId: job.teamId, channelId: job.channelId, ts: String(posted.ts) });
      await this.resume(job.teamId, job.channelId);
      await this.store.doneOut(key);
    } catch (err) {
      const code = err instanceof SlackError ? err.code : 'unreachable';
      if (INSTALL_GONE.has(code)) {
        await this.store.setProblem(job.teamId, `Slack refused the Parly app (${code}): reconnect Slack`);
        return this.store.doneOut(key);
      }
      if (CHANNEL_GONE.has(code)) {
        if (job.parlyChannelId) await this.store.unlinkChannel(job.parlyChannelId, job);
        return this.store.doneOut(key);
      }
      if (code === CHANNEL_ARCHIVED) {
        if (job.parlyChannelId) await this.store.setPaused(job.parlyChannelId, job, true);
        return this.store.doneOut(key);
      }
      return bridgeOutboxFailure(this.store, key, job, err, {
        label: 'Slack post',
        retryAfterMs: err instanceof SlackError ? err.retryAfterMs : undefined,
        dropDetail: code,
      });
    }
  }

  /** In a thread: Slack's thread is the post's copy in that same Slack channel. A post that never got there: none. */
  private async threadTs(message: MessageDoc, job: Pick<SlackOut, 'teamId' | 'channelId'>): Promise<{ thread_ts?: string }> {
    if (!message.post) return {};
    const post = await this.store.message(message.post);
    const copy = post?.slack?.find((c) => isOwnSlackCopy(c, job));
    return copy ? { thread_ts: copy.ts } : {};
  }

  /**
   * Parly's message in Slack's markup: entities escaped, @mentions of linked people as Slack mentions, cut to Slack's limit,
   * plus signed GCS URLs for attached Parly files (inline `image_url` attachments for images; clickable download links for other files).
   */
  private async slackPayload(teamId: string, message: MessageDoc): Promise<{ text: string; attachments: SlackAttachment[] }> {
    const bodyParts: string[] = [];
    const fileLinks: string[] = [];
    const attachments: SlackAttachment[] = [];

    for (const p of message.parts) {
      const fileId = typeof p.metadata?.fileId === 'string' ? p.metadata.fileId : undefined;
      if (fileId) {
        const file = await this.hub.files.get(fileId);
        const signedUrl = file ? await this.hub.files.downloadUrl(file, { ttlMs: SLACK_FILE_LINK_TTL_MS }).catch(() => undefined) : undefined;
        if (file && signedUrl) {
          if (SLACK_IMAGE_TYPES.has(file.mediaType)) {
            attachments.push({
              fallback: file.name,
              title: file.name,
              title_link: signedUrl,
              image_url: signedUrl,
            });
          } else {
            const label = file.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '·');
            fileLinks.push(`<${signedUrl}|${label}>`);
          }
          continue;
        }
      }
      const chunk = partText(p, '```');
      if (chunk) bodyParts.push(chunk);
    }

    let text = bodyParts
      .join('\n')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    text = mrkdwn(text);
    const ids = message.mentions ?? [];
    if (ids.length) {
      const slackUsers = await this.store.slackUsersOf(teamId, ids);
      for (const id of ids) {
        const person = slackUsers.get(id) && (await this.hub.registry.get(id));
        if (person) text = text.split(`@${person.name}`).join(`<@${slackUsers.get(id)}>`);
      }
    }
    if (fileLinks.length) {
      text = [text, ...fileLinks].filter(Boolean).join('\n');
    }
    if (text.length > MAX_SLACK_TEXT) {
      text = `${text.slice(0, MAX_SLACK_TEXT)}… (the rest is on Parly)`;
    } else if (!text && !attachments.length) {
      text = '(no text)';
    }
    return { text, attachments };
  }

  /** Downloads Slack file attachments (`ev.files`) with the bot token and stores them in Parly's `Files`. */
  private async ingestSlackFiles(
    install: SlackInstall,
    uploader: AgentRecord,
    files: SlackFile[] | undefined,
  ): Promise<{ fileIds: string[]; skippedReason?: string }> {
    if (!files?.length) return { fileIds: [] };
    const candidates = files.filter((f) => f && f.mode !== 'tombstone').slice(0, MAX_SLACK_FILES);
    const fileIds: string[] = [];
    let skippedReason: string | undefined;

    for (const f of candidates) {
      const downloadUrl = f.url_private_download || f.url_private;
      const name = (f.name || f.title || 'slack-file').trim();
      if (!downloadUrl) continue;
      if (typeof f.size === 'number' && f.size > INLINE_UPLOAD_MAX) {
        skippedReason ??= `"${name}" is over the 5MB Slack attachment limit.`;
        continue;
      }
      try {
        const res = await this.fetchImpl(downloadUrl, {
          method: 'GET',
          headers: { authorization: `Bearer ${this.store.botToken(install)}` },
          signal: AbortSignal.timeout(15_000),
        });
        const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        const declaredType = f.mimetype?.trim().toLowerCase();
        // When an older Slack install lacks `files:read`, Slack 200-redirects `url_private` to an HTML sign-in page.
        if (!res.ok || (contentType === 'text/html' && declaredType !== 'text/html')) {
          skippedReason ??= `Slack did not allow downloading "${name}" — reconnect Slack in workspace settings to grant file access.`;
          continue;
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!bytes.byteLength) continue;
        if (bytes.byteLength > INLINE_UPLOAD_MAX) {
          skippedReason ??= `"${name}" is over the 5MB Slack attachment limit.`;
          continue;
        }
        const mediaType = declaredType || contentType || 'application/octet-stream';
        const uploaded = await this.hub.files.uploadInline(uploader, {
          name,
          mediaType,
          contentBase64: bytes.toString('base64'),
        });
        fileIds.push(uploaded.id);
      } catch (err) {
        if (err instanceof HubError) {
          skippedReason ??= err.message;
        } else {
          skippedReason ??= `Could not download "${name}" from Slack.`;
        }
      }
    }
    return { fileIds, ...(skippedReason ? { skippedReason } : {}) };
  }

  private async handle(envelope: SlackEnvelope): Promise<void> {
    const ev = envelope.event;
    const teamId = envelope.team_id;
    if (!ev || !teamId) return;
    if (ev.type === 'app_uninstalled' || ev.type === 'tokens_revoked') {
      await this.store.setProblem(teamId, 'The Parly app was removed from Slack (or its access revoked): reconnect Slack');
      return;
    }
    // The app invited to a Slack channel (`/invite @Parly`): that channel gets its Parly channel, linked.
    if (ev.type === 'message' && ev.subtype === 'channel_join' && ev.channel && !ev.channel.startsWith('D')) {
      const install = await this.store.install(teamId);
      if (install && !install.problem && ev.user === install.botUserId) await this.autoLink(install, ev.channel);
      return;
    }
    // Plain messages and file_share uploads from people only: the bridge's own posts (agents, people from the web, other sides)
    // come back as bot messages, and edits, deletes and joins are other subtypes.
    if (ev.type !== 'message' || (ev.subtype && ev.subtype !== 'file_share') || ev.bot_id || !ev.user || !ev.channel || !ev.ts) return;
    const install = await this.store.install(teamId);
    if (!install || install.problem || ev.user === install.botUserId) return;
    const origin: SlackCopy = { teamId, channelId: ev.channel, ts: ev.ts };
    if (await this.store.messageAt(origin)) return; // a copy the bridge posted, or a message already taken in
    // A DM with the app (Slack's DM channels start with D): the person talks with one of their agents.
    if (ev.channel.startsWith('D')) return this.handleDm(install, ev as SlackEvent & { user: string; channel: string; ts: string }, origin);
    const link = await this.store.linkedChannel(teamId, ev.channel);
    if (!link) return;
    // Someone wrote there: the Slack channel isn't archived (any more).
    if (link.paused) await this.store.setPaused(link.parlyChannelId, link, false);

    const identity = await this.store.identity(teamId, ev.user);
    const person = identity ? await this.hub.registry.get(identity.agentId) : undefined;
    if (identity && (!person || person.kind !== 'human')) return;

    const rawTrimmed = (ev.text ?? '').trim();
    const botCmd = !ev.files?.length ? new RegExp(`^(?:<@${install.botUserId}(?:\\|[^>]*)?>|@parly)(?:\\s+(.*))?$`, 'i').exec(rawTrimmed) : null;
    if (botCmd) {
      const rest = (botCmd[1] ?? '').trim();
      const addMatch = /^add(?:\s+(.*))?$/i.exec(rest);
      const isCmd = Boolean(addMatch || /^(?:help|agents|list|link)?$/i.test(rest));
      if (isCmd && !person) return this.askToLink(install, ev.channel, ev.user);
      if (person && addMatch) {
        const target = (addMatch[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return this.addAgent(install, ev.channel, ev.user, person, link.parlyChannelId, target);
      }
      if (person && isCmd) {
        return this.channelHelp(install, ev.channel, ev.user, person, link.parlyChannelId);
      }
    }

    const channel = (await this.hub.registry.channelsById([link.parlyChannelId])).get(link.parlyChannelId);
    if (!channel) return;
    const room = (await this.hub.registry.workspaceById(channel.workspaceId))?.room;

    // A room side's Slack speaks only for that side: Parly, not Slack, says which side someone is on.
    if (link.sideId) {
      if (person && (!room || this.hub.rooms.sideOf(room, person)?.id !== link.sideId)) {
        return this.ephemeral(install, ev.channel, ev.user, "This channel speaks for one side of a Parly room, and you're not on that side there.");
      }
      // In a side's private corner, only that side's linked person speaks; in the shared channel, unlinked Slack participants are external.
      if (!person && channel.id !== room?.shared) return this.askToLink(install, ev.channel, ev.user);
    }

    const author = person ?? (await this.hub.registry.get(channel.ownerId)) ?? (await this.hub.registry.get(install.installedBy));
    if (!author) return;
    const external = person
      ? undefined
      : { id: `slack:${teamId}:${ev.user}`, name: (await this.slackName(install, ev.user)) ?? 'Slack user' };

    const thread = ev.thread_ts && ev.thread_ts !== ev.ts ? await this.store.messageAt({ teamId, channelId: ev.channel, ts: ev.thread_ts }) : undefined;
    const text = await this.parlyText(install, ev.text ?? '');
    const { fileIds, skippedReason } = await this.ingestSlackFiles(install, author, ev.files);
    if (!text.trim() && !fileIds.length) {
      if (skippedReason) {
        await this.ephemeralOncePerDay(install, ev.channel, ev.user, skippedReason);
      }
      return;
    }
    let posted;
    try {
      const parts = await this.hub.parts(author, text.trim() ? text : undefined, undefined, fileIds.length ? fileIds : undefined);
      posted = await this.hub.send(
        author,
        { channel: link.parlyChannelId, ...(thread ? { thread } : {}) },
        parts,
        { slack: [origin], ...(external ? { external } : {}) },
      );
    } catch (err) {
      if (err instanceof HubError) {
        // The same refusal (an archived channel, mostly) once a day per person, not after every message.
        return this.ephemeralOncePerDay(install, ev.channel, ev.user, err.message);
      }
      throw err;
    }
    await this.store.rememberCopy(origin, posted.message.id);
    if (external && !room && posted.message.mentions?.length) {
      await this.askToLink(install, ev.channel, ev.user);
    }
  }

  /**
   * `@Parly add <agent>` in a linked Slack channel: adds a bot visible to `person` (by name, unique `<Owner>'s <Name>`
   * short name, or id) to the Parly channel (and its workspace first if needed), enforcing channel membership and
   * shared-room side boundaries.
   */
  private async addAgent(
    install: SlackInstall,
    slackChannel: string,
    slackUser: string,
    person: AgentRecord,
    parlyChannelId: string,
    rawTarget: string,
  ): Promise<void> {
    const wanted = rawTarget.trim().replace(/^@+/, '').trim();
    if (!wanted) return this.ephemeral(install, slackChannel, slackUser, 'Use @Parly add <agent> to add an agent to this channel.');
    let channel;
    try {
      channel = await this.hub.registry.resolveMemberChannel(person, parlyChannelId);
    } catch (err) {
      if (err instanceof HubError) return this.ephemeral(install, slackChannel, slackUser, `Not added: ${err.message}`);
      throw err;
    }
    const workspace = await this.hub.registry.workspaceById(channel.workspaceId);
    const side = workspace?.room ? this.hub.rooms.sideOf(workspace.room, person) : undefined;
    if (workspace?.room && (!side || (channel.id !== workspace.room.shared && channel.id !== side.corner))) {
      return this.ephemeral(install, slackChannel, slackUser, "You can only add agents to your side's channels in this room.");
    }
    const lower = wanted.toLowerCase();
    const short = (name: string) => /^.+?['’]s\s+(.+)$/u.exec(name)?.[1]?.toLowerCase();
    const candidates = (await this.hub.registry.search(person, { query: wanted })).filter(
      (a) => a.kind !== 'human' && !a.webhookChannel,
    );
    const exact = candidates.filter((a) => a.id === wanted || a.name.toLowerCase() === lower);
    const matches = exact.length ? exact : candidates.filter((a) => short(a.name) === lower);
    if (matches.length === 0) {
      return this.ephemeral(install, slackChannel, slackUser, `No agent "${wanted}" is available to you.`);
    }
    if (matches.length > 1) {
      const options = matches.map((a) => `${a.name} (${a.id})`).join(', ');
      return this.ephemeral(install, slackChannel, slackUser, `Several agents match "${wanted}". Use @Parly add <id>: ${options}`);
    }
    const agent = matches[0]!;
    if (workspace?.room && agent.ownerId !== side!.id) {
      return this.ephemeral(install, slackChannel, slackUser, "In a shared room, you can only add your own side's agents.");
    }
    try {
      if (!(agent.workspaces ?? []).includes(channel.workspaceId)) {
        await this.hub.registry.addToWorkspace(person, channel.workspaceId, agent.id);
      }
      await this.hub.registry.addToChannel(person, channel.id, agent.id);
      if (workspace?.room && side && channel.id === workspace.room.shared) {
        await this.hub.registry.setRoomRole(workspace.room.shared, agent.id, side.name);
      }
    } catch (err) {
      if (err instanceof HubError) return this.ephemeral(install, slackChannel, slackUser, `Not added: ${err.message}`);
      throw err;
    }
    await this.say(install, slackChannel, `${agent.name} is in #${channel.name} now.`);
  }

  /** `@Parly` / `@Parly help` in a linked Slack channel: shows which agents are here and which can be added. */
  private async channelHelp(
    install: SlackInstall,
    slackChannel: string,
    slackUser: string,
    person: AgentRecord,
    parlyChannelId: string,
  ): Promise<void> {
    let channel;
    try {
      channel = await this.hub.registry.resolveMemberChannel(person, parlyChannelId);
    } catch (err) {
      if (err instanceof HubError) return this.ephemeral(install, slackChannel, slackUser, err.message);
      throw err;
    }
    const [workspace, inChannel, allVisible] = await Promise.all([
      this.hub.registry.workspaceById(channel.workspaceId),
      this.hub.registry.search(person, { channel: channel.id }),
      this.hub.registry.search(person),
    ]);
    const side = workspace?.room ? this.hub.rooms.sideOf(workspace.room, person) : undefined;
    const botsHere = inChannel.filter((a) => a.kind !== 'human' && !a.webhookChannel);
    const hereIds = new Set(botsHere.map((a) => a.id));
    const available = allVisible.filter(
      (a) => a.kind !== 'human' && !a.webhookChannel && !hereIds.has(a.id) && (!workspace?.room || a.ownerId === side?.id),
    );
    const lines = [
      botsHere.length
        ? `Agents in #${channel.name}: ${botsHere.map((a) => `@${a.name}`).join(', ')}. Mention one by name (like "@${botsHere[0]!.name} hello") to talk to it.`
        : `No agents are in #${channel.name} yet.`,
      available.length
        ? `To add an agent here, write \`@Parly add <name>\` — available: ${available.map((a) => a.name).join(', ')}.`
        : `Connect or hire agents at ${this.opts.webUrl}/connect, then write \`@Parly add <name>\` here.`,
    ];
    await this.say(install, slackChannel, lines.join('\n'));
  }

  /**
   * Links a Slack channel the app is in to the Parly channel of the same name in the install's workspace, made by
   * the person who connected Slack if there's none. A private Slack channel gets a closed Parly channel. Not for a
   * room's side: there the side picks which channel is shared and which is its corner (a wrong guess leaks the corner).
   */
  private async autoLink(install: SlackInstall, slackChannel: string): Promise<(SlackLink & { parlyChannelId: string }) | undefined> {
    if (install.sideId) return undefined;
    const existing = await this.store.linkedChannel(install.teamId, slackChannel);
    if (existing) return existing;
    const owner = await this.hub.registry.get(install.installedBy);
    if (!owner) return undefined;
    const info = (await this.api(install, 'conversations.info', { channel: slackChannel }, true)).channel as { name?: string; is_private?: boolean } | undefined;
    if (!info?.name) return undefined;
    const mine = await this.hub.registry.channelsOf(owner, install.workspaceId);
    let channel = mine.find((c) => !c.archived && !c.slack?.length && c.name.toLowerCase() === info.name!.toLowerCase());
    if (!channel) {
      channel = await this.hub.registry.createChannel(owner, install.workspaceId, info.name);
      if (info.is_private) channel = await this.hub.registry.updateChannel(owner, channel.id, { open: false });
    }
    await this.store.linkChannel(channel.id, { teamId: install.teamId, channelId: slackChannel });
    await this.say(install, slackChannel, `This channel is now linked to #${channel.name} on Parly: messages here and there show up in both.`).catch(() => undefined);
    return { teamId: install.teamId, channelId: slackChannel, parlyChannelId: channel.id };
  }

  /**
   * A person's DM with the app: `@Name …` picks the agent (and keeps it for what follows), a reply in an agent's
   * Slack thread goes to that agent, anything else to the agent the DM is talking to. Posted on Parly as a DM.
   */
  private async handleDm(install: SlackInstall, ev: SlackEvent & { user: string; channel: string; ts: string }, origin: SlackCopy): Promise<void> {
    const identity = await this.store.identity(install.teamId, ev.user);
    if (!identity) return this.askToLink(install, ev.channel, ev.user);
    const person = await this.hub.registry.get(identity.agentId);
    if (!person || person.kind !== 'human') return;
    let text = await this.parlyText(install, ev.text ?? '');
    let agent: AgentRecord | undefined;
    if (ev.thread_ts && ev.thread_ts !== ev.ts) {
      const id = await this.store.messageAt({ teamId: install.teamId, channelId: ev.channel, ts: ev.thread_ts });
      const dm = id ? (await this.store.message(id))?.conversationId : undefined;
      const other = dm?.startsWith('dm:') ? dmWith(dm, person.id) : undefined;
      agent = other ? await this.hub.registry.get(other) : undefined;
    }
    if (!agent && text.startsWith('@')) {
      const named = await this.agentNamed(person, text.slice(1));
      if (named) {
        agent = named;
        text = text.slice(1 + named.name.length).replace(/^[\s,:]+/, '');
      }
    }
    if (!agent) {
      const current = await this.store.currentDm(install.teamId, ev.user);
      agent = current ? await this.hub.registry.get(current) : undefined;
    }
    if (!agent) return this.say(install, ev.channel, 'Start with @ and an agent\'s name to talk to one of your agents here, like "@Atlas what\'s new?"');
    const { fileIds, skippedReason } = await this.ingestSlackFiles(install, person, ev.files);
    if (!text.trim() && !fileIds.length) {
      if (skippedReason) return this.say(install, ev.channel, `Not sent: ${skippedReason}`);
      await this.store.useDm(install.teamId, ev.user, person.id, agent.id, ev.channel); // a bare @Name: found among those they can see
      return this.say(install, ev.channel, `Now talking to ${agent.name}.`);
    }
    let posted;
    try {
      const parts = await this.hub.parts(person, text.trim() ? text : undefined, undefined, fileIds.length ? fileIds : undefined);
      posted = await this.hub.send(person, { to: agent.id }, parts, { slack: [origin] });
    } catch (err) {
      if (err instanceof HubError) return this.say(install, ev.channel, `Not sent: ${err.message}`);
      throw err;
    }
    await this.store.rememberCopy(origin, posted.message.id);
    await this.store.useDm(install.teamId, ev.user, person.id, agent.id, ev.channel); // only once Parly took it
  }

  /** The agent a person can see whose name `text` starts with (the longest such name), for `@Name` in a DM. */
  private async agentNamed(person: AgentRecord, text: string): Promise<AgentRecord | undefined> {
    const first = text.split(/\s+/)[0] ?? '';
    if (!first) return undefined;
    const lower = text.toLowerCase();
    const fits = (await this.hub.registry.search(person, { query: first })).filter((a) => {
      if (a.id === person.id || a.kind === 'human') return false;
      const name = a.name.toLowerCase();
      return lower.startsWith(name) && (lower.length === name.length || /[\s,:]/.test(lower[name.length]!));
    });
    return fits.sort((a, b) => b.name.length - a.name.length)[0];
  }

  /** A message from the app itself, in a DM. */
  private async say(install: SlackInstall, channel: string, text: string): Promise<void> {
    await this.api(install, 'chat.postMessage', { channel, text });
  }

  /** Tells a Slack user, privately, to link their Slack account to Parly before what they write is posted there. */
  private async askToLink(install: SlackInstall, channel: string, user: string): Promise<void> {
    const code = await this.store.linkCode(install.teamId, user);
    if (!code) return;
    const url = `${this.opts.webUrl}/slack/link?${new URLSearchParams({ code })}`;
    await this.ephemeral(install, channel, user, `To post here, connect your Slack account to Parly (once): ${url}\nUntil then, what you write here stays in Slack.`);
  }

  private async ephemeralOncePerDay(install: SlackInstall, channel: string, user: string, reason: string): Promise<void> {
    const nag = `${install.teamId}:${channel}:${user}:${reason}`;
    const today = new Date().toISOString().slice(0, 10);
    if (this.told.get(nag) === today) return;
    this.told.set(nag, today);
    await this.ephemeral(install, channel, user, `Not posted on Parly: ${reason}`);
  }

  private async ephemeral(install: SlackInstall, channel: string, user: string, text: string): Promise<void> {
    await this.api(install, 'chat.postEphemeral', { channel, user, text });
  }

  /** Slack's message markup in Parly's words: mentions by name, links as text, entities decoded. */
  private async parlyText(install: SlackInstall, text: string): Promise<string> {
    // "@Parly …" is said to the app, not about anyone: dropped.
    const names = new Map<string, string>([[install.botUserId, '']]);
    for (const [, id] of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
      if (names.has(id!)) continue;
      const linked = await this.store.identity(install.teamId, id!);
      const person: AgentRecord | undefined = linked ? await this.hub.registry.get(linked.agentId) : undefined;
      names.set(id!, `@${person?.name ?? (await this.slackName(install, id!)) ?? 'someone'}`);
    }
    return text
      .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>\s?/g, (m, id: string) => (names.get(id) === '' ? '' : `${names.get(id) ?? '@someone'}${m.endsWith(' ') ? ' ' : ''}`))
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
      .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<([^>]+)>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /** A linked person's own Slack picture in this Slack workspace, so what they write on Parly shows with their face. */
  private async slackFace(install: SlackInstall, personId: string): Promise<string | undefined> {
    const slackUser = (await this.store.slackUsersOf(install.teamId, [personId])).get(personId);
    const out = slackUser ? await this.api(install, 'users.info', { user: slackUser }, true).catch(() => undefined) : undefined;
    const profile = (out?.user as SlackUserPayload | undefined)?.profile;
    return profile?.image_192 || profile?.image_72 || undefined;
  }

  /** A Slack user's display name (users.info), for someone who hasn't linked their account. */
  private async slackName(install: SlackInstall, user: string): Promise<string | undefined> {
    const out = await this.api(install, 'users.info', { user }, true).catch(() => undefined);
    return extractSlackUserName(out?.user as SlackUserPayload | undefined);
  }

  /** One Slack Web API call with the installation's bot token. Throws Slack's error code. */
  /** `form`: for Slack's read methods (conversations.info…), which take form fields, not JSON. */
  private async api(install: SlackInstall, method: string, body: Record<string, unknown>, form = false): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.store.botToken(install)}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) throw new SlackError('ratelimited', (Number(res.headers.get('retry-after')) || 30) * 1000);
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || out.ok !== true) throw new SlackError(String(out.error ?? `http_${res.status}`));
    return out;
  }

  /** A person on Parly spends the one-time code their Slack prompt gave them: from now on, that Slack user is them. */
  async link(person: AgentRecord, code: string): Promise<{ teamName: string }> {
    if (person.kind !== 'human') throw new HubError('forbidden', 'People link their Slack accounts');
    const who = await this.store.spendLinkCode(code);
    if (!who) throw new HubError('invalid', 'That link has expired or was already used: write in Slack again for a new one');
    const install = await this.store.install(who.teamId);
    if (!install) throw new HubError('not_found', 'That Slack workspace is no longer connected');
    await this.store.linkIdentity(who.teamId, who.slackUserId, person.id);
    return { teamName: install.teamName };
  }
}
