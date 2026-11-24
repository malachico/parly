import type { SlackLink } from '../lib/bridgeTypes.js';
import type { TelegramLink } from '../lib/bridgeTypes.js';
import type { CardAuth, StoredCredential } from '../hub/agentAuth.js';
/** `human` is a person using the web UI: delivered like a mailbox, but never picked by skill routing. */
export type AgentKind = 'endpoint' | 'mailbox' | 'human';

export interface AgentSkillInfo {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export type SkillScope = 'agent' | 'channel' | 'workspace';
export type SkillType = 'skill' | 'process';
export type SkillAttachmentSource = 'direct' | 'channel' | 'workspace' | 'builtin';

/** Where a skill or process is currently attached across scopes visible to the viewer. */
export interface SkillWhereUsed {
  agents: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string; workspaceId: string }>;
  workspaces: Array<{ id: string; name: string }>;
  counts: { agents: number; channels: number; workspaces: number; total: number };
}

/** One step in a multi-agent team process template. */
export interface ProcessStep {
  order: number;
  role: string;
  action: string;
  output?: string;
  transition?: string;
  skillId?: string;
}

/** A process step as surfaced to a viewer: `skillId` is resolved to `skillName` ("unavailable" if deleted/inaccessible; never inlines instructions). */
export interface SurfacedProcessStep extends ProcessStep {
  skillName?: string;
}

/** Compact skill/process metadata surfaced in briefings, inbox items, and thread views. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  type?: SkillType;
  /** True for system built-in skills (`builtin:skill-writer`, `builtin:process-writer`), which are read-only. */
  builtin?: boolean;
  /** Present on surfaced processes: bounded inline steps (with skillName reference, never instructions). */
  steps?: SurfacedProcessStep[];
  /** True when inline steps were truncated to fit the surfacing cap (load full via get_skill). */
  stepsTruncated?: boolean;
}

/** First-class reusable instruction/playbook (`skill`) or team workflow template (`process`) stored in COLLECTIONS.skills. */
export interface SkillRecord extends Omit<SkillSummary, 'steps' | 'stepsTruncated'> {
  /** Record kind: `'skill'` (default, single-agent how-to with `instructions`) or `'process'` (multi-agent workflow template with `steps`). */
  type?: SkillType;
  /** Markdown instructions for `type: 'skill'`, loaded on demand via get_skill(id) (capped at 8,000 chars). */
  instructions: string;
  /** The previous instructions before the last update, so an accidental overwrite can be recovered. */
  instructionsPrev?: string;
  /** Display name of whoever last updated instructions or steps. */
  instructionsBy?: string;
  /** ISO timestamp of the last instructions or steps update. */
  instructionsAt?: string;
  /** Ordered workflow steps for `type: 'process'` (each has order, role, action, optional output, transition, skillId). */
  steps?: ProcessStep[];
  /** Creator agent id (or their human owner). */
  ownerId: string;
  /** Additional co-owner agent ids. */
  ownerIds?: string[];
  /** True for system built-in skills (`builtin:skill-writer`, `builtin:process-writer`), which are read-only. */
  builtin?: boolean;
  /** Optional primary scope this skill/process was created for (its owners can also update/delete it). */
  scope?: { kind: SkillScope; id: string };
  createdAt: string;
  updatedAt: string;
}

/** Stored agent document (collection `agents`, doc id = agent id). */
export interface AgentStatus {
  text: string;
  at: string;
  /** The conversation it said it about. */
  conversationId: string;
}

export interface CanvasBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AgentRecord {
  id: string;
  /** Unique, lowercase handle used for addressing (`to: "echo"`). */
  name: string;
  description: string;
  kind: AgentKind;
  /** Endpoint agents: base URL the agent card was fetched from. */
  url?: string;
  /** Endpoint agents: path of the agent card relative to `url`. */
  cardPath?: string;
  /** Endpoint agents: what their card says callers must authenticate with (public; from the card). */
  auth?: CardAuth;
  /** Endpoint agents: what the hub authenticates with, bound to the card scheme it was given for. Never shown back. */
  credential?: CredentialRecord;
  /** Endpoint agents: why the hub can't authenticate to it right now, for its owner (cleared when calls work again). */
  authProblem?: string;
  skills: AgentSkillInfo[];
  /** Listed in the open directory and addressable by anyone. Private agents are visible only inside their workspaces. */
  public: boolean;
  /** Ids of workspaces this agent belongs to. Everyone in a workspace sees and can message each other. */
  workspaces: string[];
  /** Ids of channels this agent is in; each lives in one of its `workspaces`. */
  channels: string[];
  /** Ids of first-class skills attached to this agent. */
  attachedSkills?: string[];
  /** Ids of inherited workspace/channel/built-in skills explicitly detached on this agent. */
  detachedSkills?: string[];
  tokenHash: string;
  createdAt: string;
  lastSeen: string;
  /** Mailbox agents: listening (a wait is open) until this server time. See Registry.markListening. */
  listeningUntil?: string;
  /** People (who sign in with Google): verified email (lowercased) and Google account id. */
  email?: string;
  /** A person: who invited them (their first invite, when they signed up), for the referral credits. */
  referredBy?: string;
  /** Their referral was rewarded (both sides), once. */
  referralRewarded?: boolean;
  googleSub?: string;
  /** Pays for an ownerless room agent's model calls (the person who opened the room). Ignored when the agent has an owner: the owner always pays. */
  payerId?: string;
  /** Company credit pool: the workspace id whose billing record pays for this person (set by accepting a company invite at `POST /companies/:id/accept`). */
  billingAccountId?: string;
  /** When an owner started removing this member from billingAccountId (a claim against duplicate removals). */
  removingAt?: string;
  githubId?: string;
  /** Self-hosted password sign-in (registry/password.ts): never leaves the hub. */
  passwordHash?: string;
  /** Extra tokens from web sign-ins (hashes), newest last, so signing in never revokes the main token. */
  sessionHashes?: string[];
  /** Seed for the generated avatar (the web draws it). Set on creation; older agents get one from the migration or on re-registration. */
  avatar?: string;
  /**
   * What the agent itself last said it's working on (set_status), and where: it stays until the agent changes or clears
   * it. The canvas shows it with its age, faded when old: never inferred.
   */
  status?: AgentStatus;
  /** Archived bots are hidden everywhere (except to the owners of their workspaces), get no messages, and can't authenticate. */
  archived?: boolean;
  /** Bots: the person who owns it (every bot has one). The owner can archive, rotate and delete it, and always sees it. Unset on people. */
  ownerId?: string;
  /** The owner's display name when the bot was made. */
  ownerName?: string;
  /**
   * Set on a bot that is a person's own coding tool (their Claude Code, their Codex), made from the
   * web's Connect page. It starts in no workspace; a member adds it to one like any bot.
   */
  /**
   * Hosted agents (hired on Parly, run on their owner's Parly computer): the agent's own hub token and its LLM proxy
   * key, as JSON sealed with CREDENTIALS_KEY (`secrets`, as given on a hub without one), handed to the computer to start it.
   */
  hosted?: { sealed?: string; secrets?: string };
  followsOwner?: boolean;
  /** A cloud agent (kind `endpoint`): it has no computer; the hub answers for it with Gemini (hub/cloudAgent.ts). */
  cloud?: boolean;
  /** A cloud agent's tools (hub/composio.ts): the owner's toolkits it may use, and whether it may act (send, create, delete) or only read. */
  tools?: { toolkits: string[]; act?: boolean };
  /** An incoming webhook (POST /hooks/:channelId/:token): the channel it posts into. It only posts; nothing is delivered to it. */
  webhookChannel?: string;
  /** With webhookChannel: the bot that posts the channel's scheduled messages (drawn with a clock). */
  scheduler?: boolean;
  /** Mailbox bots: how the hub wakes the agent when a message arrives while it isn't listening (see src/hub/wake.ts). */
  wake?: WakeRecord;
  /**
   * Optional per-agent Telegram bot token (from @BotFather): when set, outbound messages from this agent in linked
   * Telegram chats are sent via this bot token (native name + avatar, no sender header), falling back to the shared
   * @ParlyBot if the agent's bot isn't in the group. Sealed with CREDENTIALS_KEY at rest; never shown back.
   */
  telegramBot?: AgentTelegramBot;
  /** People: a Routine pasted on Connect, waiting for its session to say which agent it is (whoami with the code). */
  routineSetup?: RoutineSetup;
}

/** Stored per-agent Telegram bot token (sealed when CREDENTIALS_KEY is set). */
export interface AgentTelegramBot {
  sealed?: string;
  token?: string;
}

/**
 * How the hub wakes a mailbox agent when a message arrives while it isn't listening:
 * - `claude-routine`: fires its Claude Code Routine's API trigger (`POST .../routines/{id}/fire`).
 * - `xai`: asks Grok (xAI's Responses API, the owner's API key) to read and answer the inbox, with the hub as its
 *   remote MCP server.
 * - `webhook`: POSTs a JSON wake notice (`{event: "parly.wake", agentId, agentName, text, at}`, and `conversation` when the fire is for one) to `url`,
 *   signed with `X-Parly-Signature: sha256=<hex>` when a secret is set.
 * The token/secret is sealed like endpoint credentials and never shown back.
 */
export interface WakeRecord {
  /** `computer`: a hosted agent; its owner's Parly computer starts it (HubService.hire). */
  type: 'claude-routine' | 'webhook' | 'computer' | 'xai';
  /** Claude Code Routine id (`type: 'claude-routine'`). */
  routineId?: string;
  /** Outgoing webhook URL (`type: 'webhook'`). */
  url?: string;
  /**
   * The trigger token or webhook signing secret, sealed with CREDENTIALS_KEY; `token` only on a hub without one.
   * For `xai`: `{"apiKey", "token"}` as JSON, the owner's xAI API key and the bot's own Parly token for Grok to call MCP with.
   */
  sealed?: string;
  token?: string;
  /** `webhook`: an Authorization header value to send (a Grok Bot routine's, say), sealed like the secret; `auth` only on a hub without CREDENTIALS_KEY. */
  authSealed?: string;
  auth?: string;
  /**
   * `webhook`: each run answers one conversation (a Grok Bot routine, whose saved prompt says so): a fire per
   * conversation with mail, naming it. Off, one fire for all of them: a routine's older saved prompt empties the inbox.
   */
  perConversation?: boolean;
  /** `perConversation`: the last fire for each conversation with mail waiting. */
  lastFires?: Record<string, { at: string; ok: boolean }>;
  /** The last fire: when, whether it succeeded, and the session it started. */
  lastFire?: { at: string; ok: boolean; sessionUrl?: string };
  /** Why firing fails right now, for the owner; cleared by the next fire that works. */
  problem?: string;
}

/**
 * A Routine waiting to learn which agent it is. Its sessions sign in through Claude's Parly connector, so the hub
 * can't tell in advance: it fires the Routine with a one-time code, and the agent that calls whoami with it gets
 * the Routine (Registry.attachRoutine). Kept on its owner's record; the code is `${ownerId}.${secret}`.
 */
export interface RoutineSetup {
  routineId: string;
  sealed?: string;
  token?: string;
  secret: string;
  at: string;
  /** The session the setup fire started. */
  sessionUrl?: string;
  /** Why it can't finish: the fire was refused, or the session signed in as someone else's agent. */
  problem?: string;
}

/** Stored pending invite (collection `invites`, doc id = `${workspaceId}:${email}`). Applied on the invitee's first Google sign-in. */
export interface InviteRecord {
  workspaceId: string;
  email: string;
  invitedBy: string;
  invitedByName: string;
  createdAt: string;
  /** A TTL index deletes unused invites after this. */
  expiresAt: Date;
}

/** Something with a creator and co-owners: a workspace or a channel. See `isOwner`. */
export interface Owned {
  ownerId: string;
  /** Co-owners appointed by an owner: same rights as `ownerId`, but they may leave. */
  ownerIds?: string[];
}

/**
 * Stored workspace document (collection `workspaces`, doc id = workspace id): a Slack-like org of
 * people and their agents. Membership lives on the agents (`workspaces`).
 */
export interface WorkspaceRecord extends Owned {
  id: string;
  name: string;
  createdAt: string;
  /** Ids of first-class skills attached to this workspace. */
  attachedSkills?: string[];
  /** Ids of default built-in workspace skills explicitly detached by a workspace owner. */
  detachedSkills?: string[];
  /** Lowercased email domains whose Google sign-ins join automatically. Set by owners; never a public mail provider. */
  domains?: string[];
  /** A shared room between organizations (see src/rooms/rooms.ts). */
  room?: RoomInfo;
  /** Archived workspaces keep their history and members but take no new channel posts. An owner restores them. */
  archived?: boolean;
  /**
   * When true (`public` or `publicShowcase`), signed-in visitors can self-join public + open channels as
   * participate-only guests, and non-owner workspace members are restricted to their joined channels only.
   */
  public?: boolean;
  publicShowcase?: boolean;
  /** Agent ids removed/banned by an owner from this public workspace so they cannot self-join again. */
  bannedAgents?: string[];
}

/** A shared room: a goal, one channel everyone is in, and the sides taking part. */
export interface RoomInfo {
  goal: string;
  /** The channel every side is in. */
  shared: string;
  sides: RoomSide[];
  /** The room's moderator (Rooms.moderator): the member that opens the talks and hands each side its decisions. */
  moderator?: string;
  /** Opened by an app over /v1 (Rooms.openForApp): only that app's keys reach it there. */
  appId?: string;
  /** The app's own labels for the room (its user ids, say), to find it again: GET /v1/rooms?metadata.<k>=<v>. */
  metadata?: Record<string, string>;
  /** Closed by its app: the talks stop. */
  closed?: boolean;
}

/**
 * One organization in a room: the person who set it up (its id is theirs), a name shown on its
 * members, and its corner, a closed channel only that side is in. Its private brief is stored apart
 * (room_briefs) so nothing the other side can read carries it.
 */
export interface RoomSide {
  id: string;
  name: string;
  corner: string;
  /** The opening app's own id for this side (opaque to Parly, unique in the room). */
  ref?: string;
  /** Agents on this side that no one owns (an app room's agents): matched by id, since they have no ownerId. */
  agents?: string[];
}

/** Stored channel document (collection `channels`, doc id = channel id): a conversation among some members of one workspace. Membership lives on the agents (`channels`). */
export interface ChannelRecord extends Owned {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  /** Ids of first-class skills attached to this channel. */
  attachedSkills?: string[];
  /** Ids of inherited workspace/built-in skills explicitly detached on this channel. */
  detachedSkills?: string[];
  /** Archived channels keep their history and members but take no new posts. An owner restores them. */
  archived?: boolean;
  /**
   * Members' roles here, by agent id ("reviewer", "architect", ...): free text an owner sets, a label
   * telling everyone (bots included) what's expected of whom. Grants and blocks nothing.
   */
  roles?: Record<string, string>;
  /**
   * Anyone in the workspace can find it and join on their own (like Slack's public channels).
   * Unset on channels made before this existed: only one named "general" counts as open (see isOpenChannel).
   */
  open?: boolean;
  /**
   * Anyone, signed in or not, can read it (GET /public/channels/:id): its posts after this seq, and their
   * threads. What was said before it went public stays private. Unset: private.
   */
  publicFromSeq?: number;
  /** Slack channels it is mirrored to (the Slack bridge, PLAN-SLACK.md): one, or one per side for a room. */
  slack?: SlackLink[];
  /** Telegram chats (and optional forum topics) it is mirrored to. */
  telegram?: TelegramLink[];
  /** Threads anyone can read (GET /public/channels/:id/threads/:post), by post id, in a channel that isn't otherwise public. */
  publicThreads?: string[];
  /** Threads marked as done (work finished, hidden from the open channel feed and Needs you), by post id. */
  doneThreads?: string[];
  /** Where it sits on the workspace's canvas (PLAN-CANVAS.md), in canvas pixels. Layout only. */
  canvas?: CanvasBox;
  /**
   * What the channel is for, set by its owners: purpose, links, standing rules. Shown at the top, and handed to its
   * agents with every message as background (not as instructions that outrank the person they work for).
   */
  context?: string;
  /** Example first posts shown as one-tap chips above an empty message box (e.g. a showcase table's prompts). */
  starters?: string[];
  /** Agent ids removed/banned by an owner from this channel in a public workspace so they cannot self-join again. */
  bannedAgents?: string[];
}

/** True when a workspace is a public / public-showcase workspace. */
export function isPublicWorkspace(w: Pick<WorkspaceRecord, 'public' | 'publicShowcase'> | undefined): boolean {
  return Boolean(w?.public || w?.publicShowcase);
}

/** Whether anyone on the internet can read a post's thread here: the channel is public, or that thread was shared. */
export function isPublicThread(c: Pick<ChannelRecord, 'publicFromSeq' | 'publicThreads'>, post?: string): boolean {
  return c.publicFromSeq !== undefined || (!!post && !!c.publicThreads?.includes(post));
}

/** Whether a post's thread is marked as done in this channel. */
export function isDoneThread(c: Pick<ChannelRecord, 'doneThreads'>, post?: string): boolean {
  return !!post && !!c.doneThreads?.includes(post);
}

/** Whether workspace members can join on their own. Older channels didn't say; of those only #general is open. */
export function isOpenChannel(c: Pick<ChannelRecord, 'open' | 'name'>): boolean {
  return c.open ?? c.name.toLowerCase() === 'general';
}

/** A credential at rest: the secret sealed (lib/sealing), its type and scheme readable for views and checks. */
type SealedCredential = { type: StoredCredential['type']; for: string; sealed: string };
/** As stored on an agent: sealed when the hub has a CREDENTIALS_KEY, plain otherwise. */
type CredentialRecord = StoredCredential | SealedCredential;

