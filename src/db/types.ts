import type { MongoDatabase, MongoDocRef, MongoQuery, MongoTransaction } from './mongo.js';

export type Database = MongoDatabase;
export type Transaction = MongoTransaction;
export type Query = MongoQuery;
export type DocumentReference = MongoDocRef;
export type UpdateData<_T = Record<string, unknown>> = Record<string, unknown>;

/** A write transform the adapter turns into a Mongo update operator. */
export class FieldValue {
  private constructor(
    readonly kind: 'delete' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'serverTimestamp',
    readonly operand?: number,
    readonly elements?: unknown[],
  ) {}
  static delete() { return new FieldValue('delete'); }
  static serverTimestamp() { return new FieldValue('serverTimestamp'); }
  static increment(n: number) { return new FieldValue('increment', n); }
  static arrayUnion(...elements: unknown[]) { return new FieldValue('arrayUnion', undefined, elements); }
  static arrayRemove(...elements: unknown[]) { return new FieldValue('arrayRemove', undefined, elements); }
}

/** A field path; only the doc id is ever addressed this way. */
export class FieldPath {
  private constructor(readonly name: string) {}
  static documentId() { return new FieldPath('__name__'); }
}

export type Op = '==' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains' | 'array-contains-any';

/** A composite query filter for `where()`. */
export class Filter {
  private constructor(
    readonly op: Op | 'AND' | 'OR',
    readonly field?: string | FieldPath,
    readonly value?: unknown,
    readonly filters?: Filter[],
  ) {}
  static where(field: string | FieldPath, op: Op, value: unknown) { return new Filter(op, field, value); }
  static or(...filters: Filter[]) { return new Filter('OR', undefined, undefined, filters); }
  static and(...filters: Filter[]) { return new Filter('AND', undefined, undefined, filters); }
}

/** Seconds + nanoseconds since the epoch; stored as a BSON Date (ms precision). Same arithmetic and JSON shape as the old SDK class. */
export class Timestamp {
  constructor(
    private readonly _seconds: number,
    private readonly _nanoseconds: number,
  ) {}
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromDate(date: Date) { return Timestamp.fromMillis(date.getTime()); }
  static fromMillis(ms: number) {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.floor((ms - seconds * 1000) * 1e6));
  }
  get seconds() { return this._seconds; }
  get nanoseconds() { return this._nanoseconds; }
  toDate() { return new Date(this._seconds * 1000 + Math.round(this._nanoseconds / 1e6)); }
  toMillis() { return this._seconds * 1000 + Math.floor(this._nanoseconds / 1e6); }
}

export const COLLECTIONS = {
  /** What each agent loaded with get_skill and hasn't shown yet: one doc per agent. */
  skillLoads: 'skill_loads',
  agents: 'agents',
  workspaces: 'workspaces',
  channels: 'channels',
  skills: 'skills',
  conversations: 'conversations',
  messages: 'messages',
  cursors: 'cursors',
  /** One push at a time per agent and conversation: `${agentId}|${conversationId}` → {untilMs}. */
  pushLeases: 'push_leases',
  invites: 'invites',
  files: 'files',
  pairings: 'pairings',
  oauthClients: 'oauth_clients',
  oauthRequests: 'oauth_requests',
  oauthTokens: 'oauth_tokens',
  adminLog: 'admin_log',
  clientRequests: 'client_requests',
  schedules: 'schedules',
  webhooks: 'webhooks',
  /** What Composio watches for a person (one per app event + settings), and who hears each one (see hub/triggers.ts). */
  triggerSources: 'triggerSources',
  triggerListeners: 'triggerListeners',
  /** How each agent used each of its owner's apps (count, last time and tool). */
  toolUsage: 'toolUsage',
  toolMemory: 'toolMemory',
  mcpEventSubs: 'mcpEventSubs',
  settings: 'settings',
  githubInstalls: 'github_installs',
  /** Single-use OAuth `state` docs for GET /github/install → /github/callback. */
  githubOauthStates: 'github_oauth_states',
  slackInstalls: 'slack_installs',
  slackIdentities: 'slack_identities',
  slackEvents: 'slack_events',
  slackTs: 'slack_ts',
  slackLinks: 'slack_links',
  slackLinkCodes: 'slack_link_codes',
  slackOutbox: 'slack_outbox',
  slackDms: 'slack_dms',
  telegramLinks: 'telegram_links',
  telegramChats: 'telegram_chats',
  telegramIdentities: 'telegram_identities',
  telegramLinkCodes: 'telegram_link_codes',
  telegramEvents: 'telegram_events',
  telegramMsgIds: 'telegram_msg_ids',
  telegramOutbox: 'telegram_outbox',
  statusLog: 'status_log',
  /** Self-hosted password sign-in: `owner` (set up once) and `email:<address>` (one account per email). */
  passwordClaims: 'password_claims',
  /** Shared fixed-window counters across hub instances (sign-in, registration and pairing redeem). */
  rateLimits: 'rate_limits',
} as const;

/** A stored time as milliseconds: the DB returns the Dates it was given as Timestamps. */
export function toMillis(v: Date | { toMillis(): number } | undefined): number {
  if (!v) return 0;
  return v instanceof Date ? v.getTime() : v.toMillis();
}
