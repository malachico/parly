import { BoundedMap } from '../lib/boundedMap.js';
import type { GitHubInstalls } from './githubInstalls.js';
import type { GitHubInstallOAuth } from './githubInstallOAuth.js';
import { AppAgents, type AgentRanker } from '../apps/appAgents.js';
import { Apps } from '../apps/apps.js';
import { AppWebhooks, type RoomEventType } from '../apps/webhooks.js';
import type { SlackBridge } from '../slack/bridge.js';
import type { SlackOAuth } from '../slack/oauth.js';
import type { SlackCopy } from '../slack/store.js';
import type { TelegramBridge } from '../telegram/bridge.js';
import type { TelegramCopy } from '../telegram/store.js';
import { Activity, ACTIVITY_TEXT_MAX } from '../chat/activity.js';
import { Schedules } from './schedules.js';
import { Webhooks, type WebhookRecord } from './webhooks.js';
import { McpEvents } from '../mcp/events.js';
import { TriggerService } from './triggerService.js';
import { CanvasNotes } from './canvasNotes.js';
import { ToolUsage } from './toolUsage.js';
import { TriggerStore } from './triggers.js';
import { HubStore } from './hubStore.js';
import type { Database } from '../db/types.js';
import { channelKey, dmWith, threadKey, type MessageDoc } from '../chat/chat.js';
import { ChatService, isFor, type InboxItem, type Posted, type Target } from '../chat/chatService.js';
import { Pusher } from '../chat/push.js';
import type { GraphJob, PushQueue } from '../chat/queue.js';
import { ChatStore } from '../chat/store.js';
import type { FileRecord, Files } from '../files/files.js';
import { HubError, PlanLimitError } from '../lib/errors.js';
import type { Composio } from './composio.js';
import type { GitHubApp } from './github.js';
import { appTool as runHubAppTool, myApps as listMyApps } from './hubApps.js';
import type { WebSearch } from './webSearch.js';
import type { Billing } from '../billing/billing.js';
import { isSuperAdmin } from '../lib/admin.js';
import type { Computers } from '../computers/computers.js';
import type { LlmMeter, LlmPrices } from '../llm/llm.js';
import { seal } from '../lib/sealing.js';
import { avatarOf, inboxItemView, messageView } from '../lib/present.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import { buildParts, type WirePart } from '../lib/wire.js';
import { isListening, isShowcaseGuest, type Registry } from '../registry/registry.js';
import { isDoneThread, isPublicThread, isPublicWorkspace, type AgentRecord, type ChannelRecord } from '../registry/types.js';
import { renderBriefing, Rooms } from '../rooms/rooms.js';
import { RoomTalks } from '../rooms/roomTalks.js';
import type { Forwarder } from './forward.js';
import { type Waker } from './wake.js';
import { CanvasService } from './canvasService.js';
import { ScheduleService } from './scheduleService.js';
import type { BackfillSummary } from '../graph/backfill.js';
import type { GraphSearch } from '../graph/search.js';
import { channelOf, type GraphStore } from '../graph/store.js';
import { WakeService, type WakeTiming } from './wakeService.js';

/** Whether the hub can call an endpoint agent with its credential, as the owner sees it. */
type CheckResult = { ok: true } | { ok: false; problem: string };
/** How long an endpoint agent's online check holds (each one is a call to the agent). */
const ONLINE_CHECK_MS = 60_000;

interface ListeningWarning {
  code: 'not_listening';
  agentId: string;
  name: string;
  lastSeen: string;
  idleSeconds: number;
  text: string;
}

/** Where a message goes, as the MCP tools, REST and A2A say it. */
interface SendTarget {
  /** An agent id: a direct message. */
  to?: string;
  /** Instead of `to`: the most recently seen agent offering this skill. */
  skill?: string;
  /** A channel you're in (id or name), optionally a post's `thread` in it. */
  channel?: string;
  thread?: string;
  /** With `channel` given by name: the workspace it's in. */
  workspace?: string;
  /** A message you can read: answer it (in its thread, or its conversation). */
  replyTo?: string;
}

/** A conversation in the web app's list: a channel, or the direct conversation with one agent. */
interface ConversationView {
  /** "channel:<id>" or "agent:<the other agent's id>". */
  key: string;
  kind: 'channel' | 'direct';
  channel?: { id: string; workspaceId: string; name: string };
  with?: { id: string; name: string; kind: string; avatar: string; listening?: boolean; wakes?: boolean; status?: 'archived' | 'deleted' };
  last: { from: string; fromId: string; text: string; at: string };
  updatedAt: string;
  unread: number;
  mentions: number;
  /** Its new messages are all in one or more threads: the newest such thread's post, to open. */
  thread?: string;
}

/**
 * Dependencies wired once at construction (createHub). Bridges that need the hub itself
 * (Slack/Telegram) stay optional fields set after construction.
 */
interface HubServiceDeps {
  /** How long one pushed turn may run (config.turnDeadlineMs). */
  turnDeadlineMs?: number;
  /** Parly computers, where hosted agents run. */
  computers: Computers;
  /** Meters hosted agents' model calls (the LLM proxy). */
  llm: LlmMeter;
  /** Plans and payments (billing/billing.ts). */
  billing: Billing;
  /** This hub answers for cloud agents (config.cloudAgents). */
  cloudAgents?: boolean;
  /** Tell agents taking their inbox to post only the delta once someone has answered. */
  threadDeltaRule?: boolean;
  /** Tools for cloud agents from their owners' connected accounts, when the hub has a Composio key. */
  composio?: Composio;
  /** The web app's address, for links the hub hands out (an agent's Tools card). */
  webUrl?: string;
  /** Set when this hub runs hosted agents (it has a key for the LLM proxy): how their secrets are sealed. */
  hosting?: { sealingKey?: Buffer; requireSealing: boolean };
  /** Web search for any agent, when cloud agents' Vertex model is configured. */
  webSearch?: WebSearch;
  /** Native GitHub App outbound client. */
  github?: GitHubApp;
  /** Which GitHub App install serves which Parly owner (set with `github`). */
  githubInstalls?: GitHubInstalls;
  /** Connect GitHub flow: single-use state + callback that verifies installation_id. */
  githubInstallOAuth?: GitHubInstallOAuth;
  /** Parly's GitHub App slug (GITHUB_APP_SLUG, default "parly-dev"), for the installation URL. */
  githubAppSlug?: string;
  /** MCP Events subscriptions (ChatGPT dots); defaults to an unsealed store. */
  mcpEvents?: McpEvents;
}

/**
 * The hub: a chat between people and agents (ChatService), plus waking agents and checking endpoint agents.
 * Transport-neutral; the A2A handler, the MCP tools and the REST API are thin layers over it.
 */
export class HubService {
  /** Parly computers, where hosted agents run. */
  readonly computers: Computers;
  /** The Slack bridge, when this hub has a Slack app (config.slack). */
  slack?: SlackBridge;
  /** Slack OAuth installation, channel linking, and identity inspection. */
  slackOAuth?: SlackOAuth;
  /** The Telegram bridge, when this hub has a Telegram bot (config.telegram). */
  telegram?: TelegramBridge;
  /** Meters hosted agents' model calls (the LLM proxy). */
  readonly llm: LlmMeter;
  /** Plans and payments (billing/billing.ts). */
  readonly billing: Billing;
  /** This hub answers for cloud agents (config.cloudAgents). */
  readonly cloudAgents: boolean;
  /** Tell agents taking their inbox to post only the delta once someone has answered (config.threadDeltaRule). */
  readonly threadDeltaRule: boolean;
  /** Tools for cloud agents from their owners' connected accounts, when the hub has a Composio key. */
  composio?: Composio;
  /** The web app's address, for links the hub hands out (an agent's Tools card). */
  readonly webUrl?: string;
  /** Set when this hub runs hosted agents (it has a key for the LLM proxy): how their secrets are sealed. */
  readonly hosting?: { sealingKey?: Buffer; requireSealing: boolean };
  private readonly store: HubStore;
  readonly chat: ChatService;
  readonly push: Pusher;
  readonly rooms: Rooms;
  readonly notes: CanvasNotes;
  /** Workspaces' apps and their API keys (the /v1 API). */
  readonly apps: Apps;
  /** Apps' own agents (/v1/agents), and what ranks the listed ones for search (unset: search is unavailable). */
  readonly appAgents: AppAgents;
  agentRanker?: AgentRanker;
  /** Context graph search. Internal: no permission check yet (context graph PR 3), so never expose it to a caller as-is. */
  graphSearch?: GraphSearch;
  /** Model prices for charging a search to the app's maker. */
  vertexPrices?: LlmPrices;
  /** The context graph's nodes and edges for graph/queries.ts; set only when CONTEXT_GRAPH_ENABLED. Unchecked: filter through graph/acl.ts. */
  graph?: Pick<GraphStore, 'nodes' | 'edgesOf' | 'recentDecisions' | 'countByKind' | 'upsertNode'>;
  /** Extracts a done thread into the context graph; set only when CONTEXT_GRAPH_ENABLED and Vertex are. */
  extractGraph?: (job: GraphJob) => Promise<void>;
  /** Enqueues the last 90 days' graph jobs (see backfillGraph); set with extractGraph. */
  backfillGraph?: (options: { limit?: number }) => Promise<BackfillSummary>;
  /** Room events to the webhooks of the apps that opened the rooms. */
  readonly appEvents: AppWebhooks;
  readonly schedules: Schedules;
  readonly webhooks: Webhooks;
  readonly triggers: TriggerStore;
  readonly toolUsage: ToolUsage;
  /** Triggers (Composio events): sources, listeners, agents' own, and the events that arrive. */
  readonly triggerService = new TriggerService(this);
  /** Workspace canvas, agent presence, and an agent's day log. */
  readonly canvasService = new CanvasService(this);
  /** Scheduled messages in channels and to agents. */
  readonly scheduleService = new ScheduleService(this);
  /** Waking mailbox agents via Claude Code Routines, outgoing webhooks, or Grok. */
  readonly wakeService: WakeService;
  /** MCP Events subscriptions (ChatGPT dots): told when messages wait for an agent. */
  readonly mcpEvents: McpEvents;
  /** Composio's trigger events reach this hub (its webhook secret is set): agents can be told about new emails. */
  triggersEnabled = false;
  /** Native GitHub App webhook events reach this hub (GITHUB_WEBHOOK_SECRET is set). */
  githubTriggersEnabled = false;
  /** Native GitHub App outbound client (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` are set). */
  readonly github?: GitHubApp;
  /** Which GitHub App install serves which Parly owner (set with `github`). */
  githubInstalls?: GitHubInstalls;
  /** Connect GitHub flow: single-use state + callback that verifies installation_id (set with `github`). */
  readonly githubInstallOAuth?: GitHubInstallOAuth;
  /** Web search for any agent (hub/webSearch.ts), when cloud agents' Vertex model is configured. */
  readonly webSearch?: WebSearch;
  /** Parly's GitHub App slug (GITHUB_APP_SLUG, default "parly-dev"), for the installation URL. */
  readonly githubAppSlug: string;
  readonly talks: RoomTalks;
  /** When each endpoint agent was last checked, and whether it answered. */
  private readonly reachable = new BoundedMap<string, { at: number; ok: boolean }>(1000);

  constructor(
    db: Database,
    readonly registry: Registry,
    private readonly forwarder: Forwarder,
    private readonly queue: PushQueue,
    readonly maxWaitMs: number,
    sendLimiter: RateLimiter | undefined,
    readonly files: Files,
    deps: HubServiceDeps,
    /** Fires Claude Code Routines for mailbox agents that have one (unset: nobody is woken). */
    private readonly waker?: Waker,
    wakeTiming: WakeTiming = { staleMs: 5 * 60_000, retryMs: 10 * 60_000 },
  ) {
    this.computers = deps.computers;
    this.llm = deps.llm;
    this.billing = deps.billing;
    this.cloudAgents = deps.cloudAgents ?? false;
    this.threadDeltaRule = deps.threadDeltaRule ?? false;
    this.composio = deps.composio;
    this.webUrl = deps.webUrl;
    this.hosting = deps.hosting;
    this.webSearch = deps.webSearch;
    this.github = deps.github;
    this.githubInstalls = deps.githubInstalls;
    this.githubInstallOAuth = deps.githubInstallOAuth;
    this.githubAppSlug = deps.githubAppSlug ?? 'parly-dev';
    this.store = new HubStore(db);
    this.notes = new CanvasNotes(db, registry, files);
    this.apps = new Apps(db, registry);
    this.appAgents = new AppAgents(db);
    this.appEvents = new AppWebhooks(db, this.apps);
    this.rooms = new Rooms(db, registry);
    this.rooms.onEvent = (workspaceId, type, data) => void this.roomEvent(workspaceId, type, data);
    this.schedules = new Schedules(db);
    this.webhooks = new Webhooks(db);
    this.triggers = new TriggerStore(db);
    this.toolUsage = new ToolUsage(db);
    this.mcpEvents = deps.mcpEvents ?? new McpEvents(db);
    this.wakeService = new WakeService(this, queue, waker, wakeTiming);
    this.chat = new ChatService(new ChatStore(db), registry, queue, { maxWaitMs, sendLimiter, onMailbox: (agent, from) => this.wakeService.wakeLater(agent, from) });
    this.talks = new RoomTalks(this.rooms, registry, this.chat);
    this.chat.rooms = this.talks;
    this.chat.activity = new Activity(db);
    this.push = new Pusher(this.chat, registry, forwarder, queue, {
      briefing: async (agent, workspaceId) => {
        const b = await this.rooms.briefing(agent, workspaceId);
        return b ? [{ text: renderBriefing(b) }] : [];
      },
      forEndpoint: (parts) => files.forEndpoint(parts),
      trusted: (parts) => files.trusted(parts),
      turnDeadlineMs: deps.turnDeadlineMs,
    });
    // A new member of a channel starts at its end: what was said before isn't new to them.
    registry.onJoinChannel = (agentId, channelId) => this.chat.joined(agentId, channelId);
  }

  /** Sends a message: a direct one, a channel post or thread reply, or an answer to a message. */
  /** `slack`: its copy in Slack, when a person wrote it there (the Slack bridge). `external`: an unlinked Slack sender. */
  async send(
    from: AgentRecord,
    target: SendTarget,
    parts: WirePart[],
    opts: { replyTo?: string; slack?: SlackCopy[]; telegram?: TelegramCopy[]; external?: { id: string; name: string } } = {},
  ): Promise<Posted> {
    // Parts can't grant access to files: only those the hub minted (Files.partsFor) can.
    parts = this.files.trusted(parts);
    // An agent "passing" through reply/send (a connected one, whose pass isn't an answer to a push) posts nothing.
    if (from.kind !== 'human' && parts.length && parts.every((p) => p.text !== undefined && p.data === undefined && !p.url && !p.raw && /^\s*(PASS|NO_REPLY)([\s,.;!]+(PASS|NO_REPLY))*\s*$/.test(p.text ?? '')))
      throw new HubError('invalid', "Nothing posted: PASS means you stay quiet. To say nothing, don't send a message at all.");
    if (target.replyTo) return this.chat.reply(from, target.replyTo, { parts, ...opts });
    let to: Target;
    if (target.channel) {
      const channel = await this.registry.resolveMemberChannel(from, target.channel, target.workspace);
      to = { channelId: channel.id, ...(target.thread ? { thread: target.thread } : {}) };
    } else if (target.to) to = { dm: target.to };
    else if (target.skill) {
      const agent = await this.registry.findBySkill(target.skill, from, async (a) => !(await this.chat.privateRefusal(from, a)));
      if (!agent) throw new HubError('not_found', `No agent available to you offers skill "${target.skill}"`);
      to = { dm: agent.id };
    } else throw new HubError('invalid', 'Say where it goes: "to" (an agent id), "skill", "channel", or the message you answer');
    return this.chat.post(from, to, { parts, ...opts });
  }

  /**
   * check_inbox and wait_for_message items, with the channel's name, the agent's role there and a room's briefing.
   * Skills are not loaded for items where `shown(conversation, context)` says the agent already has them.
   */
  async inboxView(agent: AgentRecord, items: InboxItem[], shown?: (conversation: string, context?: string) => boolean) {
    const channels = await this.registry.channelsById(items.flatMap((i) => (i.message.channelId ? [i.message.channelId] : [])));
    // Briefing and skills depend only on the channel: look each up once per call, not once per item.
    const briefing = (channel: ChannelRecord) => this.rooms.briefing(agent, channel.workspaceId);
    const skillsOf = (channel?: ChannelRecord) => this.registry.resolveAttachedSkills({ agent, channel: channel ?? null, workspaceId: channel?.workspaceId });
    const briefings = new Map<string, ReturnType<typeof briefing>>();
    const skillSets = new Map<string, ReturnType<typeof skillsOf>>();
    return Promise.all(
      items.map(async (item) => {
        const channel = item.message.channelId ? channels.get(item.message.channelId) : undefined;
        const key = channel?.id ?? '';
        if (channel && !briefings.has(key)) briefings.set(key, briefing(channel));
        const skip = shown?.(item.message.conversationId, channel?.context);
        if (!skip && !skillSets.has(key)) skillSets.set(key, skillsOf(channel));
        const [room, skills] = await Promise.all([briefings.get(key), skip ? [] : skillSets.get(key)!]);
        return inboxItemView(item, {
          ...(channel ? { channel: channel.name } : {}),
          role: channel?.roles?.[agent.id],
          room,
          public: !!channel && isPublicThread(channel, item.message.post ?? item.message.id),
          context: channel?.context,
          skills,
        });
      }),
    );
  }

  /** The web app's conversation list (see ChatService.conversations). */
  async conversationViews(viewer: AgentRecord, opts: { workspace?: string; limit?: number } = {}): Promise<ConversationView[]> {
    const summaries = await this.chat.conversations(viewer, opts);
    const others = summaries.flatMap((s) => (s.conversation.kind === 'dm' ? [dmWith(s.conversation.id, viewer.id)!] : []));
    const [agents, channels] = await Promise.all([
      this.registry.getMany(others),
      this.registry.channelsById(summaries.flatMap((s) => (s.conversation.channelId ? [s.conversation.channelId] : []))),
    ]);
    const byId = new Map(agents.map((a) => [a.id, a]));
    return summaries.map(({ conversation: c, unread, mentions, thread }) => {
      const base = { last: { from: c.lastFromName, fromId: c.lastFrom, text: c.lastText, at: c.lastAt }, updatedAt: c.lastAt, unread, mentions, ...(thread ? { thread } : {}) };
      if (c.kind === 'channel') {
        const ch = channels.get(c.channelId!);
        return { ...base, key: c.id, kind: 'channel' as const, channel: { id: c.channelId!, workspaceId: c.workspaceId ?? ch?.workspaceId ?? '', name: ch?.name ?? '' } };
      }
      const otherId = dmWith(c.id, viewer.id)!;
      const other = byId.get(otherId);
      return {
        ...base,
        key: `agent:${otherId}`,
        kind: 'direct' as const,
        with: {
          id: otherId,
          name: other?.name ?? c.names?.[otherId] ?? '',
          kind: other?.kind ?? 'mailbox',
          avatar: other ? avatarOf(other) : otherId,
          ...(other && !other.archived && other.kind === 'mailbox' ? { listening: isListening(other) } : {}),
          ...(other && !other.archived && other.wake && !other.wake.problem ? { wakes: true } : {}),
          // Gone agents keep their history here, read-only: archived (an owner can restore it) or deleted.
          ...(other?.archived ? { status: 'archived' as const } : other ? {} : { status: 'deleted' as const }),
        },
      };
    });
  }

  /** Search hits as the web shows them: each message, the conversation it's in ("channel:<id>" or "agent:<id>") and its name. */
  async searchView(viewer: AgentRecord, query: string, limit?: number) {
    const hits = await this.chat.search(viewer, query, limit);
    const others = hits.flatMap((m) => (m.kind === 'dm' ? [dmWith(m.conversationId, viewer.id)!] : []));
    const [agents, channels] = await Promise.all([this.registry.getMany(others), this.registry.channelsById(hits.flatMap((m) => (m.channelId ? [m.channelId] : [])))]);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return hits.map((m) => {
      const other = m.kind === 'dm' ? dmWith(m.conversationId, viewer.id)! : undefined;
      return {
        key: other ? `agent:${other}` : `channel:${m.channelId}`,
        title: other ? (names.get(other) ?? '') : (channels.get(m.channelId!)?.name ?? ''),
        ...(m.post ? { thread: m.post } : {}),
        message: messageView(m),
      };
    });
  }

  /** The event feed as the API returns it: each message, and whether it's for the caller (someone else's, for them). */
  async eventsView(agent: AgentRecord, cursor: string | undefined, timeoutMs: number) {
    if (timeoutMs > 0) await this.registry.markListening(agent);
    const { events, cursor: next } = await this.chat.events(agent, cursor, timeoutMs);
    // A bot added "on this client" waits for this agent's router: a hint with no secret, repeated until the child redeems a code
    // from POST /agents/me/sibling-pairings (or the entry expires). No `forYou`, so clients that don't know it skip it.
    const now = Date.now();
    const hints = (agent.pendingSiblings ?? []).filter((p) => Date.parse(p.expiresAt) > now).map((p) => ({ type: 'sibling_pending' as const, agentId: p.agentId }));
    return { events: [...events.map((m) => ({ ...messageView(m), forYou: isFor(agent, m) })), ...hints], cursor: next };
  }

  /**
   * The feed as server-sent events, each carrying what a page needs to draw it: `message` (the message, as
   * messageView), `activity` (a conversation's live activity, as on its page), `read` (the person read a conversation). The batch's last event carries the
   * cursor as its `id`, so a reconnect (Last-Event-ID) resumes after it. Ends when `isOpen()` turns false or at `untilMs`.
   */
  async streamEvents(agent: AgentRecord, cursor: string | undefined, send: (event: string, data: unknown, id?: string) => void, isOpen: () => boolean, untilMs: number) {
    while (isOpen() && Date.now() < untilMs) {
      // Re-read each round: a channel joined or left while the stream is open counts at once, not at the next reconnect.
      agent = (await this.registry.get(agent.id)) ?? agent;
      const { events, activityIn, reads, cursor: next } = await this.chat.events(agent, cursor, Math.min(25_000, untilMs - Date.now()), true, true);
      if (!isOpen()) return;
      const batch: [string, unknown][] = events.map((m) => ['message', { ...messageView(m), forYou: isFor(agent, m) }]);
      for (const conversation of activityIn) batch.push(['activity', { conversation, activity: await this.chat.activityOf(conversation) }]);
      // Read here or in another tab: each tab redraws its unread counts.
      for (const conversation of reads) batch.push(['read', { conversation }]);
      if (next !== cursor) {
        if (!batch.length) batch.push(['cursor', {}]);
        batch.forEach(([event, data], i) => send(event, data, i === batch.length - 1 ? next : undefined));
      }
      cursor = next;
    }
  }

  /**
   * Warnings for messages that will sit unread: mailbox recipients with no wait open, that no Routine wakes.
   * The send itself has already succeeded.
   */
  listeningWarnings(recipients: AgentRecord[], message: MessageDoc): ListeningWarning[] {
    const now = Date.now();
    return recipients
      .filter((a) => a.kind === 'mailbox' && !a.webhookChannel && isFor(a, message) && !isListening(a, now) && (!a.wake || !!a.wake.problem || !this.waker))
      .map((a) => {
        const idleSeconds = Math.round((now - Date.parse(a.lastSeen)) / 1000);
        const why = a.wake?.problem ? `, and the hub can't wake it (${a.wake.problem})` : ` (last active ${Math.round(idleSeconds / 60)} min ago)`;
        return { code: 'not_listening' as const, agentId: a.id, name: a.name, lastSeen: a.lastSeen, idleSeconds, text: `${a.name} isn't listening right now${why}; your message waits for them.` };
      });
  }

  /**
   * An incoming webhook for a channel the caller's person is in: a secret URL (POST /hooks/:channelId/:token) whose
   * posts go into the channel as that person, marked 🪝 and its name. Not an agent: deleting it revokes the URL.
   */
  async createWebhook(caller: AgentRecord, channelId: string, name?: string): Promise<{ webhook: WebhookRecord; token: string }> {
    // A person makes it themselves: an agent's token can't mint a URL that posts as its owner.
    if (caller.kind !== 'human') throw new HubError('forbidden', 'Only a person can make an incoming webhook');
    const channel = await this.registry.resolveMemberChannel(caller, channelId);
    const workspace = await this.registry.workspaceById(channel.workspaceId);
    if (isPublicWorkspace(workspace)) {
      await this.registry.requireChannelOwner(caller, channel.id);
    }
    const { webhook, token } = await this.webhooks.create({ channelId: channel.id, name: name?.trim().slice(0, 64) || 'Webhook', ownerId: caller.id });
    return { webhook, token: token! };
  }

  async channelWebhooks(caller: AgentRecord, channelId: string): Promise<WebhookRecord[]> {
    const channel = await this.registry.resolveMemberChannel(caller, channelId);
    return this.webhooks.ofChannel(channel.id);
  }

  /** Whoever made it (or one of their agents) or a channel owner deletes a webhook; its URL stops working. */
  async deleteWebhook(caller: AgentRecord, id: string): Promise<void> {
    const w = await this.webhooks.get(id);
    if (!w) throw new HubError('not_found', `No webhook ${id}`);
    // Its maker can, even after leaving the channel; otherwise a channel owner.
    const mine = w.ownerId === caller.id || (caller.kind !== 'human' && caller.ownerId === w.ownerId);
    if (!mine) {
      await this.registry.resolveMemberChannel(caller, w.channelId);
      await this.registry.requireChannelOwner(caller, w.channelId);
    }
    await this.webhooks.remove(id);
  }

  /** What a service sent a webhook's URL, posted as its maker with 🪝 and its name in front. */
  async postWebhook(w: WebhookRecord, channelId: string, text: string, thread?: string): Promise<Posted> {
    if (w.channelId !== channelId) throw new HubError('forbidden', 'This webhook posts into another channel');
    const person = await this.registry.get(w.ownerId);
    // ponytail: refused while its maker is out of the channel (rejoining turns it back on); delete it on leave if that surprises people.
    if (!person || person.archived || !(person.channels ?? []).includes(channelId)) throw new HubError('forbidden', "Whoever made this webhook isn't in the channel any more");
    const sent = await this.chat.post(person, { channelId, ...(thread ? { thread } : {}) }, { parts: [{ text: `🪝 ${w.name}: ${text}` }], meta: { webhook: { id: w.id, name: w.name } } });
    await this.webhooks.used(w.id);
    return sent;
  }

  // ---- live activity --------------------------------------------------------------------

  /**
   * An agent says what it's doing about a conversation it can read ("running the tests"), shown live under it until
   * it posts there or the state fades. `done` clears it (e.g. it decided not to answer).
   */
  async setStatus(caller: AgentRecord, key: string, text: string | undefined, done = false): Promise<{ ok: true }> {
    if (caller.kind === 'human') throw new HubError('forbidden', 'Agents report their status; people just write');
    const id = this.chat.keyFor(caller, key);
    if (!(await this.chat.canRead(caller, id))) throw new HubError('not_found', `No conversation "${key}"`);
    if (text && text.length > ACTIVITY_TEXT_MAX) throw new HubError('invalid', `A status is up to ${ACTIVITY_TEXT_MAX} characters`);
    if (!done && id.startsWith('thread:')) {
      const [, chId, postId] = id.split(':');
      const ch = chId ? (await this.registry.channelsById([chId])).get(chId) : undefined;
      if (ch && isDoneThread(ch, postId)) throw new HubError('invalid', 'Thread is marked as done');
    }
    if (done) await this.chat.activity!.clear(caller.id, id);
    else await this.chat.activity!.set(caller.id, id, 'working', text?.trim() || undefined);
    // What it says it's working on stays on its card (the canvas) until it says something else or clears it there.
    if (text?.trim() && !done) await this.registry.setStatus(caller.id, { text: text.trim(), at: new Date().toISOString(), conversationId: id });
    // Only if the stored status (not the caller's copy, which an MCP session keeps stale) is still this one: atomically.
    else if (done) await this.registry.clearStatusIf(caller.id, id);
    return { ok: true };
  }

  // ---- files ------------------------------------------------------------------------------

  /** Message parts from text, a data payload, and the ids of files the caller uploaded. */
  async parts(caller: AgentRecord, text: string | undefined, data: unknown, files: unknown): Promise<WirePart[]> {
    if (files !== undefined && !(Array.isArray(files) && files.every((f) => typeof f === 'string'))) {
      throw new HubError('invalid', 'files must be a list of file ids');
    }
    return [...buildParts(text, data), ...(await this.files.partsFor(caller, files as string[] | undefined))];
  }

  /** A file the caller may download: their own upload, or one attached to a message they can read. */
  async fileForDownload(caller: AgentRecord, id: string): Promise<FileRecord> {
    const file = await this.files.get(id);
    if (file?.status === 'ready' && (file.ownerId === caller.id || (await this.chat.canReadFile(caller, id)))) return file;
    throw new HubError('not_found', `File ${id} not found`);
  }

  /** A file anyone may download: attached to what a public channel shows (ChatService.isPublicFile). */
  /**
   * Saves a decision to the context graph now, cited to a channel or thread message the caller can read. No model
   * call; the extractor's rebuilds keep it and are told not to extract it again.
   */
  async rememberDecision(caller: AgentRecord, input: { decision: string; details?: string; messageId: string }): Promise<{ id: string }> {
    const m = await this.chat.store.message(input.messageId).catch(() => undefined);
    const chId = m && channelOf(m.conversationId);
    const ch = chId && (await this.chat.canRead(caller, m.conversationId)) ? (await this.registry.channelsById([chId])).get(chId) : undefined;
    if (!m || !ch || !this.graph) throw new HubError('not_found', `No channel message ${input.messageId} you can read`);
    const id = await this.graph.upsertNode({
      workspaceId: ch.workspaceId, conversationId: m.conversationId, kind: 'decision', title: input.decision.trim(),
      ...(input.details?.trim() ? { text: input.details.trim() } : {}), sourceMessageIds: [m.id], evidenceAt: m.at, remembered: true,
    });
    return { id: id! };
  }

  /** Channel or workspace owner: shares one post's thread with anyone (or stops). The post must be this channel's. */
  async setThreadPublic(caller: AgentRecord, channelId: string, post: string, pub: boolean): Promise<ChannelRecord> {
    const m = await this.chat.store.message(post).catch(() => undefined);
    if (!m || m.conversationId !== channelKey(channelId)) throw new HubError('not_found', `No post ${post} in this channel`);
    return this.registry.setThreadPublic(caller, channelId, post, pub);
  }

  /**
   * Thread starter or channel/workspace owner: marks one post's thread as done (or reopens it).
   * When marked done, clears live agent activity on the thread and marks the thread read for the caller.
   */
  async setThreadDone(caller: AgentRecord, channelId: string, post: string, done: boolean): Promise<ChannelRecord> {
    const m = await this.chat.store.message(post).catch(() => undefined);
    if (!m || m.conversationId !== channelKey(channelId)) throw new HubError('not_found', `No post ${post} in this channel`);
    const updated = await this.registry.setThreadDone(caller, channelId, post, m.fromId, done);
    await this.chat.store.setThreadDone(channelId, post, done ? { doneAt: new Date().toISOString(), doneBy: caller.id } : null);
    if (done) {
      const chConv = await this.chat.store.conversation(channelKey(channelId));
      await Promise.all([
        this.chat.activity?.clearThread(channelId, post, chConv?.seq === m.seq).catch(() => {}),
        this.chat.markRead(caller, `thread:${channelId}:${post}`).catch(() => {}),
      ]);
      // Fire-and-forget, and only on the open -> done transition: the graph never holds up or fails marking a thread done.
      if (this.extractGraph && updated.workspaceId && !m.done) {
        const conversationId = threadKey(channelId, post);
        this.queue.enqueue({ kind: 'graph', workspaceId: updated.workspaceId, conversationId }).catch((err) => console.error(`graph job for ${conversationId}`, err));
      }
    }
    return updated;
  }

  /**
   * A person hires an agent: a mailbox bot of theirs that runs on their Parly computer, with model calls on Parly
   * (the LLM proxy), in the workspace they hire it from (so it can join its channels). It says hello in their DM,
   * where the web app takes them next.
   */
  /**
   * Whether `person` can hire agents here: the hub hosts them, and no admin switched hiring off (Admin → Connect page,
   * `hire`). Super admins hire with it off too, to try computer agents before everyone gets them.
   */
  // ponytail: one settings read per call (each /me); cache it if /me gets hot
  async canHire(person?: AgentRecord): Promise<boolean> {
    if (!this.hosting) return false;
    if (person && isSuperAdmin(person)) return true;
    return this.store.isHireEnabled();
  }

  private readonly hiringInFlight = new Map<string, Promise<AgentRecord>>();

  async hire(person: AgentRecord, name: string | undefined, workspaceId?: string): Promise<AgentRecord> {
    const hosting = this.hosting;
    if (!hosting) throw new HubError('unavailable', "This hub doesn't host agents");
    if (!(await this.canHire(person))) throw new HubError('unavailable', 'Hiring agents is switched off on this hub');
    if (person.kind !== 'human') throw new HubError('forbidden', 'People hire agents');
    if (!hosting.sealingKey && hosting.requireSealing) throw new HubError('unavailable', 'Hosting needs CREDENTIALS_KEY on this hub');
    const clean = name?.trim();
    if (!clean) throw new HubError('invalid', 'Give the agent a name');
    // Checked first, so a wrong workspace makes no agent.
    if (workspaceId && !person.workspaces?.includes(workspaceId)) throw new HubError('not_found', `No workspace ${workspaceId} of yours`);
    if (workspaceId && isShowcaseGuest(await this.registry.workspaceById(workspaceId), person)) {
      throw new HubError('forbidden', 'Only a workspace owner can add bots to a public showcase workspace');
    }
    // An agent with its own computer is part of Pro.
    if (!isSuperAdmin(person) && (await this.llm.limits(person.id)).plan === 'free')
      throw new HubError('forbidden', 'Agents with their own computer are part of Pro. Upgrade in Account → Billing.');

    const inflightKey = `${person.id}:${clean.toLowerCase()}`;
    const inflight = this.hiringInFlight.get(inflightKey);
    if (inflight) {
      const existing = await inflight;
      if (workspaceId && !existing.workspaces?.includes(workspaceId)) {
        const { agent: updated } = await this.registry.addToWorkspace(person, workspaceId, existing.id);
        return { ...updated, hosted: updated.hosted ?? existing.hosted, wake: updated.wake ?? { type: 'computer' } };
      }
      return existing;
    }

    const run = (async (): Promise<AgentRecord> => {
      // Idempotency: if the person already has a non-archived hosted agent with the same trimmed name, return it instead of creating a duplicate.
      const existing = (await this.registry.botsOf(person)).find(
        (b) => Boolean(b.hosted || b.wake?.type === 'computer') && !b.archived && b.name.trim().toLowerCase() === clean.toLowerCase(),
      );
      if (existing) {
        if (workspaceId && !existing.workspaces?.includes(workspaceId)) {
          const { agent: updated } = await this.registry.addToWorkspace(person, workspaceId, existing.id);
          return { ...updated, hosted: updated.hosted ?? existing.hosted, wake: updated.wake ?? { type: 'computer' } };
        }
        return { ...existing, wake: existing.wake ?? { type: 'computer' } };
      }

      await this.registry.checkBotCap(person);
      await this.assertRoomForNewBot(person, workspaceId);
      const { agent, token } = await this.registry.createBot(person, { hired: true, name: clean, description: `Hired by ${person.name}. It runs on Parly.` });
      const llmKey = await this.llm.mint({ id: agent.id, ownerId: person.id });
      const secrets = JSON.stringify({ token, llmKey });
      const hosted = hosting.sealingKey ? { sealed: seal(secrets, hosting.sealingKey) } : { secrets };
      await this.registry.markHosted(agent.id, hosted);
      const joined = workspaceId ? await this.joinNewBot(person, workspaceId, agent, () => this.llm.revoke(agent.id)) : agent;
      const hired: AgentRecord = { ...joined, hosted, wake: { type: 'computer' } };
      await this.send(hired, { to: person.id }, [
        {
          text:
            `Hi, I'm ${clean}. Tell me what to do right here, or add me to a channel and give me a role there. ` +
            'I have my own computer with a browser, so I can research, try things out and work on code.',
        },
      ]);
      return hired;
    })();

    this.hiringInFlight.set(inflightKey, run);
    try {
      return await run;
    } finally {
      if (this.hiringInFlight.get(inflightKey) === run) {
        this.hiringInFlight.delete(inflightKey);
      }
    }
  }

  /** Before a bot is made for `workspaceId`: a full workspace refuses it then, not after, so no bot is left behind. */
  private async assertRoomForNewBot(person: AgentRecord, workspaceId: string | undefined): Promise<void> {
    if (!workspaceId || !person.workspaces?.includes(workspaceId)) return;
    const ws = await this.registry.workspaceById(workspaceId);
    if (ws) await this.registry.assertParticipantRoom(ws, 'seat', person);
  }

  /** Adds a just-made bot to `workspaceId`. If a concurrent add took the last seat meanwhile, the bot is deleted (and `cleanup` run) so none is left behind. */
  private async joinNewBot(person: AgentRecord, workspaceId: string, agent: AgentRecord, cleanup?: () => Promise<void>): Promise<AgentRecord> {
    try {
      return (await this.registry.addToWorkspace(person, workspaceId, agent.id)).agent;
    } catch (err) {
      if (err instanceof PlanLimitError) {
        await cleanup?.();
        await this.registry.unregister(agent);
      }
      throw err;
    }
  }

  /**
   * A cloud agent: no computer, it thinks and writes (the hub answers for it with Gemini, hub/cloudAgent.ts). The
   * person owns it; it joins `workspaceId` if given, and its cost counts against the owner's monthly allowance.
   */
  async createCloudAgent(person: AgentRecord, input: { name?: string; description?: string; workspaceId?: string; channelId?: string }): Promise<AgentRecord> {
    if (!this.cloudAgents) throw new HubError('unavailable', "This hub doesn't run cloud agents");
    if (person.kind !== 'human') throw new HubError('forbidden', 'People make cloud agents');
    const name = input.name?.trim();
    if (!name) throw new HubError('invalid', 'Give the agent a name');
    if (input.workspaceId && !person.workspaces?.includes(input.workspaceId)) throw new HubError('not_found', `No workspace ${input.workspaceId} of yours`);
    if (input.workspaceId && isShowcaseGuest(await this.registry.workspaceById(input.workspaceId), person)) {
      throw new HubError('forbidden', 'Only a workspace owner can add bots to a public showcase workspace');
    }
    // A team of yours (checked before it's made, so a wrong one doesn't leave an agent behind).
    if (input.channelId && !person.channels?.includes(input.channelId)) throw new HubError('not_found', `No team ${input.channelId} of yours`);
    await this.registry.checkBotCap(person);
    await this.assertRoomForNewBot(person, input.workspaceId);
    const { agent } = await this.registry.createBot(person, { hired: true, name, description: input.description?.trim() || `A cloud agent of ${person.name}'s. It thinks and writes; it has no computer.` });
    await this.registry.markCloud(agent.id);
    if (input.workspaceId) await this.joinNewBot(person, input.workspaceId, agent);
    // Straight into a team (a channel of that workspace you're in), so it doesn't wait on the bench.
    const channels = input.workspaceId && input.channelId ? (await this.registry.addToChannel(person, input.channelId, agent.id, input.workspaceId)).agent.channels : undefined;
    return {
      ...agent,
      kind: 'endpoint',
      cloud: true,
      tools: { toolkits: ['github'], act: false },
      ...(channels ? { channels } : {}),
    };
  }

  /** An agent's message, as a line in its day: where it said it, and the start of what it said. People aren't logged. */
  async logPosted(m: MessageDoc): Promise<void> {
    const from = await this.registry.get(m.fromId);
    if (!from) return;
    const said = m.parts.map((p) => p.text ?? '').join(' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    const snippet = said.length > 120 ? `${said.slice(0, 117)}…` : said || 'a file';
    // A trigger or webhook writing to an agent directly: in the agent's day, as what it heard (people aren't logged).
    if (from.kind === 'human') {
      const to = !m.meta?.webhook ? undefined : m.channelId ? m.mentions?.[0] : dmWith(m.conversationId, from.id);
      if (to) await this.registry.logActivity(to, { text: `Heard from ${m.meta!.webhook!.name}: ${snippet}`, at: m.at, conversationId: m.conversationId });
      return;
    }
    let where: string;
    if (m.channelId) {
      const channel = (await this.registry.channelsById([m.channelId])).get(m.channelId);
      where = `${m.post && m.post !== m.id ? 'Replied in' : 'Posted in'} #${channel?.name ?? 'a channel'}`;
    } else {
      const other = dmWith(m.conversationId, from.id);
      where = `Wrote to ${(other && (await this.registry.get(other))?.name) || 'someone'}`;
    }
    await this.registry.logActivity(from.id, { text: `${where}: ${snippet}`, at: m.at, conversationId: m.conversationId });
  }

  /** Which of your apps a cloud agent may use (any Composio app), and whether it may act or only read. */
  async setAgentTools(person: AgentRecord, agentId: string, tools: { toolkits: string[]; act: boolean }): Promise<AgentRecord> {
    const agent = await this.ownedBot(person, agentId);
    if (agent.webhookChannel) throw new HubError('invalid', "An incoming webhook doesn't use tools");
    const toolkits = [...new Set(tools.toolkits.map((t) => t.toLowerCase()))].filter((t) => /^[a-z0-9_-]{1,80}$/.test(t)).slice(0, 100);
    await this.registry.setTools(agent.id, { toolkits, act: tools.act });
    return { ...agent, tools: { toolkits, act: tools.act } };
  }

  /** One of your agents' latest uses of an app (GET /me/apps/:toolkit/usage?agent=). */
  async appHistory(person: AgentRecord, agentId: string, toolkit: string): Promise<{ at: string; tool: string; ok: boolean }[]> {
    await this.ownedBot(person, agentId);
    return this.toolUsage.history(agentId, toolkit);
  }

  /** A listener's latest events (GET /me/triggers/:id/listeners/:lid/history). */
  async listenerHistory(person: AgentRecord, sourceId: string, listenerId: string): Promise<{ at: string; outcome: string; why?: string; to?: string }[]> {
    const l = await this.triggers.listener(listenerId);
    if (!l || l.ownerId !== person.id || l.sourceId !== sourceId) throw new HubError('not_found', `No listener ${listenerId}`);
    return this.triggers.history(listenerId);
  }

  /**
   * Your apps, from the apps' side (GET /me/apps): each connected app with each of your agents (not webhooks), whether
   * it may use it, and how it has (count, failures, last time and tool). Includes a synthetic native "GitHub (Parly App)"
   * entry with install status when Parly's GitHub App is configured.
   */
  /**
   * Tells the app that opened a room (RoomInfo.appId) what happened in it; rooms no app opened send nothing.
   * A side is named by the app's own `ref`, never Parly's ids. Never throws: a webhook can't break the room.
   */
  async roomEvent(workspaceId: string, type: RoomEventType, data: Record<string, unknown> = {}): Promise<void> {
    try {
      const room = (await this.registry.workspaceById(workspaceId))?.room;
      if (!room?.appId) return;
      const { side, ...rest } = data;
      const ref = typeof side === 'string' ? room.sides.find((s) => s.id === side)?.ref : undefined;
      await this.appEvents.emit(room.appId, type, { roomId: workspaceId, ...rest, ...(ref ? { side: ref } : {}) });
    } catch (err) {
      console.error('room event not sent', workspaceId, type, err);
    }
  }

  async myApps(person: AgentRecord): ReturnType<typeof listMyApps> {
    return listMyApps(this, person);
  }

  /** Where an agent's owner turns its apps on: its profile's Tools card. */
  toolsLink(agent: AgentRecord): string {
    const ws = agent.workspaces?.[0];
    return `${this.webUrl ?? ''}${ws ? `/w/${encodeURIComponent(ws)}/agents/${encodeURIComponent(agent.id)}` : '/account'}#tools`;
  }

  /**
   * find_tools / run_tool for a computer agent (Parly MCP): the same apps as a cloud agent's, used as its owner on the
   * hub, so no token ever reaches its computer. Nothing connected yet: the link to send its owner.
   */
  async appTool(agent: AgentRecord, name: 'find_tools' | 'run_tool', args: Record<string, unknown>): Promise<unknown> {
    return runHubAppTool(this, agent, name, args);
  }

  async publicFileForDownload(channelId: string, id: string): Promise<FileRecord> {
    const file = await this.files.get(id);
    if (file?.status === 'ready' && (await this.chat.isPublicFile(channelId, id))) return file;
    throw new HubError('not_found', `File ${id} not found`);
  }

  // ---- an owner's view of their bots ------------------------------------------------------

  /** A bot the caller owns; anything else is "not found", so others' bots aren't confirmed to exist. */
  async ownedBot(caller: AgentRecord, id: string): Promise<AgentRecord> {
    const bot = await this.registry.get(id);
    if (!bot || bot.kind === 'human' || bot.ownerId !== caller.id) throw new HubError('not_found', `No bot ${id} of yours`);
    return bot;
  }

  /**
   * Whether an agent is online now: a mailbox agent is while it has a wait open (its plugin's listener, a
   * wait_for_events loop); an endpoint agent is if it answers the hub, checked at most once a minute.
   * `probe: false` (canvas presence for non-owners) reuses a cached check and never calls the agent.
   */
  async online(agent: AgentRecord, opts: { probe?: boolean } = {}): Promise<boolean> {
    if (agent.kind !== 'endpoint') return isListening(agent);
    if (agent.authProblem || !this.forwarder.check) return !agent.authProblem;
    const last = this.reachable.get(agent.id);
    if (last && Date.now() - last.at < ONLINE_CHECK_MS) return last.ok;
    if (opts.probe === false) return last?.ok ?? false;
    const ok = (await this.forwarder.check(agent).catch(() => ({ ok: false }))).ok;
    this.reachable.set(agent.id, { at: Date.now(), ok });
    return ok;
  }

  lastCheckedAt(agentId: string): string {
    return new Date(this.reachable.get(agentId)?.at ?? Date.now()).toISOString();
  }

  // ---- endpoint agents --------------------------------------------------------------------

  /**
   * Calls an endpoint agent once with its credential (when it's connected or changed, or its owner asks), and
   * records the outcome as its authProblem so the owner hears of a bad credential before anyone messages it.
   * Undefined for an agent without a URL.
   */
  async checkEndpoint(agent: AgentRecord): Promise<CheckResult | undefined> {
    if (!agent.url || !this.forwarder.check) return undefined;
    const r = await this.forwarder.check(agent);
    // Unreachable isn't an auth problem: leave what's recorded alone.
    if (r.ok || r.auth) {
      const problem = r.ok ? undefined : r.problem;
      if ((agent.authProblem ?? undefined) !== problem) {
        await this.registry.setAuthProblem(agent.id, problem);
        agent.authProblem = problem;
      }
    }
    return r.ok ? { ok: true } : { ok: false, problem: r.problem };
  }

  /** Calls a not-yet-saved endpoint agent once; refuses it (throws) unless the call gets through. Nothing is recorded. */
  async requireReachable(agent: AgentRecord): Promise<void> {
    if (!agent.url || !this.forwarder.check) return;
    const r = await this.forwarder.check(agent);
    if (!r.ok) throw new HubError('invalid', `Not connected: the hub couldn't call it: ${r.problem}. Nothing was created; fix it and try again.`);
  }
}
