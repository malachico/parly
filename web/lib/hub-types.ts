/** Shapes of the hub REST API's responses, as the web app sees them. */

interface Skill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}
export interface Agent {
  id: string;
  name: string;
  description: string;
  kind: 'endpoint' | 'mailbox' | 'human';
  /** Seed for the generated avatar (components/Avatar); older hubs don't send it. */
  avatar?: string;
  url?: string;
  /** A2A agents: the kind of credential the hub holds for it (never the secret). */
  credential?: { type: 'bearer' | 'basic' | 'apiKey' | 'oauth2' };
  /** A2A agents: why the hub can't sign in to it right now. */
  authProblem?: string;
  skills: Skill[];
  public: boolean;
  /** Workspaces this agent is in, and channels (each in one of those workspaces). */
  workspaces: string[];
  channels: string[];
  lastSeen: string;
  /** Mailbox agents: a wait is open right now, so messages reach them immediately. */
  listening?: boolean;
  archived?: boolean;
  /** Bots made from the web: the person who owns it (`owner` adds their name). */
  ownerId?: string;
  owner?: { id: string; name: string };
  /** A person's own coding tool (made on the Connect page). */
  followsOwner?: boolean;
  /** An incoming webhook: the channel it posts into. It can't read messages. */
  webhookChannel?: string;
  /** With webhookChannel: the bot that posts a channel's scheduled messages. */
  scheduler?: boolean;
  /** Mailbox agents a Claude Code Routine, webhook, or Parly computer wakes when a message arrives (and waking works). */
  wakes?: boolean;
  /** Hosted agents hired on Parly: run on their own computer managed by the hub. */
  hosted?: boolean;
  /** A cloud agent: no computer, it thinks and writes, answered on Parly. */
  cloud?: boolean;
  /** Owner only: a cloud agent's toolkits, and whether it may act or only read. */
  tools?: { toolkits: string[]; act?: boolean };
  /** Owner only: the Routine, webhook, or computer that wakes it (never its token/secret), its last fire, and why waking fails right now. */
  wake?: {
    type: 'claude-routine' | 'webhook' | 'computer' | 'xai';
    routineId?: string;
    url?: string;
    hasSecret?: boolean;
    /** A webhook sent with an Authorization header (never shown back). */
    hasAuthorization?: boolean;
    lastFire?: { at: string; ok: boolean; sessionUrl?: string };
    problem?: string;
  };
  /** Owner only: whether this agent has its own Telegram bot token configured (never the token itself). */
  telegramBot?: { configured: boolean };
}
/** Monthly work allowance for hosted agents (GET /me/usage). `used` is 0..1. */
export type UsageAllowance = {
  used: number;
  period: string;
  resetsAt: string;
};
/** How a fire of an agent's Routine went (PUT /agents/bots/:id/wake): the session it started, or why not. */
export type WakeCheck = { ok: true; sessionUrl?: string } | { ok: false; problem: string };
/** Whether the hub could call an A2A agent with its credential (POST/PUT /agents/bots, /agents/:id/check). */
export type EndpointCheck = { ok: true } | { ok: false; problem: string };

/** An agent told about events in its owner's apps (GET /agents/:id/triggers). */
export interface AgentTrigger {
  id: string;
  slug: string;
  toolkit: string;
  /** What it watches for: "New Pull Request Created". */
  label: string;
  config?: Record<string, unknown>;
  /** Posts its events in this channel (mentioning the agent); else in your DM with it. */
  channelId?: string;
  filter: { from?: string; subject?: string; contains?: string };
  task?: string;
  createdAt: string;
  lastFiredAt?: string;
  fired?: number;
}

/** What one connected app can tell an agent about (GET /me/trigger-types). */
export interface TriggerTypeGroup {
  toolkit: string;
  app: string;
  types: {
    slug: string;
    name: string;
    description: string;
    config: { properties?: Record<string, { type?: string; title?: string; description?: string; default?: unknown; enum?: unknown[]; examples?: unknown[] }>; required?: string[] };
  }[];
}

/** A channel's incoming webhook (GET /channels/:id/webhooks): its posts go in as `ownerId`, marked 🪝 and its name. */
export interface Webhook {
  id: string;
  channelId: string;
  name: string;
  ownerId: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** A scheduled message in a channel (GET /channels/:id/schedules). */
export interface Schedule {
  id: string;
  /** A channel post, or else a direct message `to` this agent. */
  channelId?: string;
  to?: string;
  thread?: string;
  text: string;
  repeat: 'once' | 'daily' | 'weekdays' | 'weekly' | 'interval';
  time?: string;
  date?: string;
  day?: number;
  minutes?: number;
  tz: string;
  /** In words: "Weekdays at 09:00 (Asia/Bangkok)". */
  when: string;
  nextAt?: string;
  active: boolean;
  ownerId: string;
  lastRunAt?: string;
  problem?: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  /** I have owner rights: a channel owner, or an owner of its workspace. */
  owner: boolean;
  /** Agent ids with owner rights (creator first). */
  owners?: string[];
  /** GET /workspaces/:id/channels only (not /me): how many agents are in it. */
  memberCount?: number;
  /** Read-only: history stays, no new posts. */
  archived?: boolean;
  /** Anyone in the workspace can find and join it. */
  open?: boolean;
  /** What it's for (its owners set it; its agents get it with every message), who last edited it, when, and the one before. */
  context?: string;
  /** Example first posts, shown as one-tap chips above an empty message box. */
  starters?: string[];
  /** Anyone, signed in or not, can read it at /p/<id> (from when it went public). */
  public?: boolean;
  /** Threads anyone can read on their own (/p/<id>?thread=<post>), by post id. */
  publicThreads?: string[];
  /** Threads marked as done, by post id. */
  doneThreads?: string[];
  /** Members' roles here by agent id ("reviewer", ...), and mine. */
  roles?: Record<string, string>;
  myRole?: string;
  /** Mirrored Slack channel(s); in a room, only the viewer's side is shown. */
  slack?: { teamId: string; channelId: string; sideId?: string }[];
  /** Mirrored Telegram chat(s)/topic(s); in a room, only the viewer's side is shown. */
  telegram?: TelegramLinkView[];
}

interface TelegramLinkView {
  chatId: string;
  topicId?: number;
  threadId?: string;
  sideId?: string;
  paused?: boolean;
}
export interface Workspace {
  id: string;
  name: string;
  owner: boolean;
  owners?: string[];
  /** Keeps its history and members; its channels take no new posts until an owner restores it. */
  archived?: boolean;
  /** Public workspace: visitors can self-join public + open channels as participate-only guests. */
  public?: boolean;
  publicShowcase?: boolean;
  /** Email domains that join automatically; owners only. */
  domains?: string[];
  /** GET /workspaces only (not /me). */
  memberCount?: number;
  /** Humans + agents + pending invites vs the owner's plan cap; max null on self-host. */
  participants?: { count: number; max: number | null };
  /** GET /me only: the channels I am in there. */
  channels?: Channel[];
  /** A shared room between organizations: its goal and sides, and mine once I've set it up. */
  room?: {
    goal: string; shared: string; sides: { id: string; name: string }[]; mySide?: { id: string; name: string; corner: string };
    /** Opened by an app over /v1; /me also names the app. */
    appId?: string; app?: { id: string; name: string; workspaceId: string };
  };
}
export interface Me extends Omit<Agent, 'workspaces'> {
  workspaces: Workspace[];
  /** Set for people who signed in with Google. Only ever returned to the person themselves. */
  email?: string;
  /** Conversations with something new for me. */
  pending?: number;
  /** A super admin: may open /admin. */
  admin?: boolean;
  /** May hire agents that run on Parly (the hub hosts them, and hiring is switched on). */
  hire?: boolean;
  /** May make cloud agents (the hub runs them). */
  cloud?: boolean;
  /** The hub's knowledge graph is on: show Knowledge. */
  graph?: boolean;
}
export interface Invite {
  email: string;
  invitedBy: string;
  createdAt: string;
}
export interface MessageView {
  replyTo?: { id: string; fromId: string; from: string; text: string };
  /** The message id; a channel post's id is also its thread's. */
  id: string;
  /** "channel:<id>", "thread:<channelId>:<postId>" or "dm:<idA>_<idB>". */
  conversation: string;
  /** Its place in the conversation: 1, 2, 3… */
  seq: number;
  from: string;
  fromId: string;
  text: string;
  data?: unknown[];
  at: string;
  /** Agent ids this channel message mentions ("@Name"). */
  mentions?: string[];
  /** Attached files. Uploaded ones have an `id` (open them via /api/files/<id>); others are just a link. */
  files?: { id?: string; name?: string; mediaType?: string; size?: number; url: string }[];
  channelId?: string;
  /** Thread replies: the post whose thread it is in. */
  thread?: string;
  /** Posted by an incoming webhook or an app trigger (as its maker): its name, shown instead of theirs. */
  webhook?: string;
  /** Posted automatically (a schedule or a room's reminder) as its author: a clock on their avatar. */
  scheduled?: boolean;
  /** The skills and processes its author loaded for it. */
  skills?: { id: string; name: string; type: SkillType }[];
}
/** What an agent is doing about a conversation right now: woken for it, reading it, or working on an answer. */
type ActivityState = 'waking' | 'reading' | 'working';
export interface ActivityItem {
  agentId: string;
  state: ActivityState;
  text?: string;
  at: string;
  /** On a channel page: the post id when the activity is in a thread. */
  thread?: string;
}
/** A page of a conversation (GET /conversations/:key/messages), oldest first. */
export interface ConversationPage {
  conversation: string;
  messages: MessageView[];
  /** How far each participant has read, by message seq. */
  seen: Record<string, number>;
  /** A channel's threads at a glance, by post id. */
  threads: Record<string, { count: number; lastAt: string; people: string[]; unread?: number; done?: boolean; doneAt?: string; doneBy?: string }>;
  /** There are older messages. */
  older: boolean;
  /** Messages from others since I last read this conversation (returned on the newest page). */
  unread?: number;
  /** Agents active in this conversation right now (or in a channel's threads). */
  activity?: ActivityItem[];
}
/** One row of GET /conversations: a channel (its threads counted in), or everything with one agent. */
export interface Conversation {
  /** "agent:<agentId>" or "channel:<channelId>"; also the URL: /w/<workspace>/c/<key>. */
  key: string;
  kind: 'direct' | 'channel';
  /** `status` is set when the other side is gone: the conversation stays, read-only. */
  with?: { id: string; name: string; kind: Agent['kind']; avatar?: string; listening?: boolean; wakes?: boolean; status?: 'archived' | 'deleted' };
  channel?: { id: string; workspaceId: string; name: string };
  last: { from: string; fromId: string; text: string; at: string };
  updatedAt: string;
  /** Messages from others since I last read it. */
  unread: number;
  /** Of those, the ones that mention me. */
  mentions: number;
  /** Its new messages are all in threads: the newest such thread's post, to open. */
  thread?: string;
}
/** A mention or DM waiting on my answer (GET /waiting). */
export interface WaitingItem {
  kind: 'mention' | 'dm';
  /** Conversation key for POST /conversations/:key/messages ("thread:<ch>:<postId>" or "agent:<id>"). */
  replyTo: string;
  /** Conversation key to open ("thread:<ch>:<postId>" or "dm:<a>_<b>"). */
  open: string;
  messageId?: string;
  channelId?: string;
  from: string;
  fromId: string;
  /** The sender's own avatar and kind. */
  fromAvatar?: string;
  fromKind?: string;
  text: string;
  at: string;
}
export interface AgentStatus {
  text: string;
  at: string;
  conversationId: string;
}

export interface CanvasBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Presence =
  | { state: 'listening'; source: string; checkedAt: string }
  | { state: 'wakes'; source: string; lastSeen: string }
  | { state: 'quiet'; lastSeen: string }
  | { state: 'person'; lastSeen: string }
  | { state: 'posts'; source: 'webhook' | 'schedule' };

export interface CanvasTeam {
  channelId: string;
  name: string;
  canvas: CanvasBox;
  slack?: boolean;
  /** Opens the channel in Slack; missing from hubs older than this field. */
  slackUrl?: string;
  /** Its Slack channel is archived: the link waits until the channel is back. */
  slackPaused?: boolean;
  roles?: Record<string, string>;
  members: string[];
  needsYou: number;
}

export interface CanvasAgent {
  id: string;
  name: string;
  kind: Agent['kind'] | string;
  avatar: string;
  presence: Presence;
  status?: AgentStatus;
  /** A Scheduled bot's messages: when, in words, and what it posts. */
  schedules?: { text: string; when: string; nextAt?: string; active: boolean }[];
  teams: string[];
  /** Parly runs it: a cloud agent (thinks and writes) or one with its own computer. */
  runs?: 'cloud' | 'computer';
  /** The avatar's corner mark: a cloud agent, one with its own computer, an incoming webhook or a Scheduled bot. */
  cloud?: boolean;
  hosted?: boolean;
  webhookChannel?: string;
  scheduler?: boolean;
  /** The viewer's own cloud agent: it can be given tools. */
  myCloud?: boolean;
}

export interface CanvasNote {
  id: string;
  workspaceId: string;
  authorId: string;
  text: string;
  files: { id: string; name: string; mediaType: string }[];
  canvas: CanvasBox;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CanvasView {
  workspaceId: string;
  teams: CanvasTeam[];
  agents: CanvasAgent[];
  /** Your own agents that aren't in this workspace yet: the bench offers to add them. */
  elsewhere?: { id: string; name: string; kind: string; avatar: string; cloud?: boolean; hosted?: boolean }[];
  needsYou: number;
  /** Same as GET /waiting; absent from a hub that predates it. */
  waiting?: WaitingItem[];
}

export interface AgentDayView {
  agentId: string;
  status?: AgentStatus;
  updates: AgentStatus[];
  /** More, older updates: pass it as `before` for the next page. */
  next?: string;
}

/** A sign-in waiting on the consent page (GET /oauth/requests/:id): an agent asking to act as one of your connections. */
export interface OAuthRequestView {
  id: string;
  /** "code": a browser sign-in that returns to the agent; "device": a code typed on /link. */
  kind: 'code' | 'device';
  /** The name the client registered with. Self-declared: anyone can call their client anything. */
  client: { id: string; name: string; uri?: string };
  /** Code flow: the host the browser returns to ("localhost" for a tool on this computer). */
  redirectTo?: string;
  scopes: string[];
  expiresAt: string;
}

export interface SlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface WorkspaceSlackStatus {
  configured: boolean;
  canManage: boolean;
  install?: {
    teamId: string;
    teamName: string;
    sideId?: string;
    problem?: string;
    at: string;
  };
  channels?: SlackChannelOption[];
  roomLinks?: {
    sharedChannelId?: string;
    cornerChannelId?: string;
    cornerParlyId: string;
    sharedParlyId: string;
  };
}

export interface SlackLinkCodeView {
  teamId: string;
  teamName: string;
  slackUserId: string;
  slackUserName?: string;
  slackEmail?: string;
  emailMatches?: boolean;
}

export interface SlackIdentityView {
  teamId: string;
  teamName: string;
  slackUserId: string;
  at: string;
}

export interface TelegramLinkCodeView {
  telegramUserId: string;
  telegramUserName?: string;
  telegramUsername?: string;
}

export interface TelegramIdentityView {
  telegramUserId: string;
  agentId: string;
  username?: string;
  name?: string;
  at: string;
}

export interface WorkspaceTelegramStatus {
  configured: boolean;
  canManage: boolean;
  chats: {
    chatId: string;
    title?: string;
    topics?: Record<string, string>;
    updatedAt: string;
  }[];
  links: {
    channelId: string;
    channelName: string;
    chatId: string;
    topicId?: number;
    paused?: boolean;
  }[];
}

/** GET /me/tools: the toolkits cloud agents can use, and the caller's connected account for each. */
/** `keyed`: connected with your own key, typed on Composio's page (never in Parly). `native`: Parly's own GitHub App (`installUrl`). */
export type MyApp = {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  tools: number;
  connectable: boolean;
  keyed?: boolean;
  native?: boolean;
  installUrl?: string;
  account?: { id: string; status: string };
};
export type MyTools = { available: boolean; searchable?: boolean; triggers?: boolean; connected: MyApp[]; popular: MyApp[]; results?: MyApp[] };

/** GET /me/billing: your plan, what it gives you and what you've used; with `paddle`, the hub takes payments. */
export type BillingView = {
  plan: 'free' | 'pro' | 'team';
  /** Your own dollars; absent when a company pays (its balance is on GET /companies/:id, for its owners). */
  monthlyUsd?: number;
  extraUsd?: number;
  used: number;
  /** Dollars of AI use left: this month's allowance plus top-ups, less what's been spent. Absent when a company pays. */
  leftUsd?: number;
  /** Workspaces you own vs plan cap; max null on self-host / unlimited. */
  workspaces?: { count: number; max: number | null };
  /** @deprecated Prefer `workspaces`. Kept one release for older hubs. */
  hired: number;
  /** @deprecated Prefer `workspaces`. Kept one release for older hubs. */
  maxHired: number;
  /** @deprecated Prefer participants on the workspace. Kept one release for older hubs. */
  connected: number;
  /** @deprecated Prefer participants on the workspace. Kept one release for older hubs. */
  maxConnected: number;
  /** People you invited whose referral earned you credits (of at most 10). */
  referrals?: number;
  periodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  canManage: boolean;
  /** Your company pays: you are linked to it, so your agents spend its credit pool. */
  /** `owner`: you own that workspace, so you set its budget. */
  billedTo?: { workspaceId: string; name: string; owner?: boolean };
  /** Your own plan when a company pays (`plan` is then the company's). */
  ownPlan?: 'free' | 'pro' | 'team';
  /** The company that pays for you (Team); `owner`: you own it. */
  company?: { id: string; name: string; owner?: boolean };
  /** Why work stops when `used` reaches 1: the pool's monthly budget, or credits ran out. */
  blockedBy?: 'budget' | 'credits';
  paddle?: { clientToken: string; environment: 'sandbox' | 'production'; prices: { pro?: string; proYearly?: string; team?: string; topups?: Record<string, string> } };
};

/** GET /me/apps: a connected app with each of your agents, whether it may use it, and how it has. */
export interface MyAppView {
  toolkit: string;
  name: string;
  logo?: string;
  native?: boolean;
  installUrl?: string;
  account: { id: string; status: string };
  agents: { id: string; name: string; avatar?: string; enabled: boolean; act: boolean; use?: { uses: number; failures?: number; lastAt: string; lastTool: string } }[];
}

/** GET /me/triggers: one of your triggers (a source) with who listens to it. */
export interface TriggerSourceView {
  id: string;
  slug: string;
  toolkit: string;
  label: string;
  config?: Record<string, unknown>;
  archivedAt?: string;
  fired?: number;
  lastFiredAt?: string;
  createdAt: string;
  listeners: {
    id: string;
    agentId?: string;
    channelId?: string;
    filter: { from?: string; subject?: string; contains?: string };
    task?: string;
    enabled: boolean;
    detachedAt?: string;
    delivered?: number;
    lastDeliveredAt?: string;
  }[];
}

export type SkillType = 'skill' | 'process';
export type SkillScope = 'agent' | 'channel' | 'workspace';
export type SkillAttachmentSource = 'direct' | 'channel' | 'workspace' | 'builtin';

export interface ProcessStepView {
  order: number;
  role: string;
  action: string;
  output: string;
  transition: string;
  skillId?: string;
  skillName?: string;
}

interface SkillWhereUsed {
  agents: { id: string; name: string }[];
  channels: { id: string; name: string; workspaceId: string }[];
  workspaces: { id: string; name: string }[];
  counts: { agents: number; channels: number; workspaces: number; total: number };
}

/** GET /me/skills: summary of a reusable skill or process in the library, with ownership readOnly flag, whereUsed targets, and process steps. */
export interface SkillSummaryView {
  id: string;
  name: string;
  description: string;
  type: SkillType;
  builtin?: boolean;
  readOnly: boolean;
  whereUsed: SkillWhereUsed;
  steps?: ProcessStepView[];
}

/** GET /me/skills/:id: full skill or process record with resolved step skillNames, readOnly, and whereUsed. */
export interface SkillDetailView extends SkillSummaryView {
  instructions?: string;
  steps?: ProcessStepView[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /agents|channels|workspaces/:id/skills: effective skill/process on a scope with inheritance source and enabled state. */
export interface ScopedSkillView {
  skill: {
    id: string;
    name: string;
    description: string;
    type: SkillType;
  };
  source: SkillAttachmentSource;
  enabled: boolean;
}


/** GET /me/company: the company you're a member of (null if none, or you own it) and every company you own. */
export type CompanyView = { member: CompanyMemberView | null; owned: CompanyOwnerView[] };
export type CompanyOwnerView = {
  id: string;
  name: string;
  plan: 'free' | 'pro' | 'team';
  /** Owners and members (each once) plus pending invites, against the plan's seats (max null: unlimited). */
  seats: { used: number; max: number | null };
  managed: boolean;
  monthlyUsd: number;
  extraUsd: number;
  leftUsd: number;
  budgetCredits: number | null;
  spentCredits: number;
  blockedBy?: 'budget' | 'credits';
  members: { id: string; name: string; email?: string; owner: boolean; spentUsd: number }[];
  invites: { email: string; createdAt: number }[];
};
export type CompanyMemberView = { id: string; name: string; plan: 'free' | 'pro' | 'team'; active: boolean; owners: string[] };

/** GET /me/company/invites: companies that invited your verified email. */
export type CompanyInviteView = { companyId: string; companyName: string; invitedByName: string | null; createdAt: number };
