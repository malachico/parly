import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { Database } from '../db/types.js';
import type { GraphSourceChange } from '../graph/sources.js';
import { BoundedMap } from '../lib/boundedMap.js';
import { HubError } from '../lib/errors.js';
import type { Plan } from '../lib/plans.js';
import type { HitLimiter, RateLimiter } from '../lib/rateLimit.js';
import type { InviteMailer } from '../lib/mail.js';
import { isPublicWorkspace, type RoomInfo, type AgentKind, type AgentStatus, type AgentTelegramBot, type CanvasBox, type AgentRecord, type AgentSkillInfo, type ChannelRecord, type InviteRecord, type RoutineSetup, type SkillRecord, type SkillScope, type SkillSummary, type SkillType, type SurfacedProcessStep, type WakeRecord, type WorkspaceRecord } from './types.js';
import type { GoogleProfile, GoogleVerifier } from './google.js';
import { cleanName, validDocId } from './fields.js';
import { canManageChannel, isOwner, isSuperAdmin } from '../lib/admin.js';
import { bindCredential, parseCardAuth, parseCredentialInput, type CardAuth, type CredentialInput, type StoredCredential } from '../hub/agentAuth.js';
import { seal, unseal } from '../lib/sealing.js';
import { publicFetch } from '../lib/publicFetch.js';
import {
  withDefaultWorkspaceSkills,
} from './defaultSkills.js';
import * as registryAuth from './auth.js';
import { isSignedInPerson, newAgentToken } from './auth.js';
import * as registryChannels from './channels.js';
import * as registrySkillResolve from './skillResolve.js';
import * as registrySkills from './skills.js';
import { AgentStore } from './agentStore.js';
import { AuthStore } from './authStore.js';
import { ChannelStore } from './channelStore.js';
import { SkillStore } from './skillStore.js';
import * as registryWorkspaces from './workspaces.js';
import { WorkspaceStore } from './workspaceStore.js';

export { isSignedInPerson };

const AGENT_CARD_PATH = '.well-known/agent-card.json';
export const MAX_NAME = 64;
/** Don't write lastSeen more often than this per agent. */
const TOUCH_INTERVAL_MS = 60_000;
/** An open wait counts as listening for this long (longer than one ~25s wait, so a loop stays listening). */
const LISTEN_GRACE_MS = 90_000;
/** Rewrite listeningUntil only once less than this much of it is left. */
const LISTEN_REFRESH_MS = 60_000;

/** A mailbox agent with a wait open now (wait_for_events / wait_for_message), by server time. */
export function isListening(agent: AgentRecord, now = Date.now()): boolean {
  return !!agent.listeningUntil && Date.parse(agent.listeningUntil) > now;
}

interface FetchedCard {
  name: string;
  description: string;
  skills: AgentSkillInfo[];
  /** What the card says a caller must authenticate with; undefined when it declares nothing. */
  auth?: CardAuth;
}

/** Fetches and minimally validates an agent card. Injectable for tests. */
export type CardFetcher = (baseUrl: string, cardPath: string, fetchImpl?: typeof fetch) => Promise<FetchedCard>;

const fetchAgentCard: CardFetcher = async (baseUrl, cardPath, fetchImpl = fetch) => {
  const url = `${baseUrl}/${cardPath}`;
  let res: Response;
  try {
    // No redirects: one could lead to a private address after the URL check.
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  } catch (err) {
    throw new HubError('invalid', `Could not reach agent card at ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new HubError('invalid', `Agent card at ${url} returned HTTP ${res.status}`);
  const card = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!card || typeof card.name !== 'string') throw new HubError('invalid', `${url} is not a valid A2A agent card`);
  const skills = Array.isArray(card.skills) ? card.skills : [];
  const auth = parseCardAuth(card);
  return {
    name: card.name,
    description: typeof card.description === 'string' ? card.description : '',
    ...(auth ? { auth } : {}),
    skills: skills.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? s.name ?? ''),
      name: String(s.name ?? s.id ?? ''),
      description: typeof s.description === 'string' ? s.description : undefined,
      tags: Array.isArray(s.tags) ? s.tags.map(String) : undefined,
    })),
  };
};

export interface RegisterInput {
  name?: string;
  description?: string;
  skills?: AgentSkillInfo[];
  /** Base URL of an A2A agent (or the full URL of its agent card). Omit for a mailbox agent. */
  url?: string;
  /** What the hub authenticates to `url` with, if its server requires auth (checked against its card). null removes it. */
  credential?: CredentialInput | unknown;
  /** List in the open directory. New agents default to private; re-registering without it keeps the current setting. */
  public?: boolean;
  /** Register a person (web UI) rather than a bot. Mailbox delivery; excluded from skill routing. */
  kind?: 'human';
}

export function sharesWorkspace(a: AgentRecord, b: AgentRecord): boolean {
  const mine = new Set(a.workspaces ?? []);
  return (b.workspaces ?? []).some((w) => mine.has(w));
}

/**
 * In a public / `publicShowcase` workspace, non-owner members are participate-only guests:
 * they cannot mutate workspace/channel state or enumerate workspace-wide members/invites.
 */
export function isShowcaseGuest(workspace: WorkspaceRecord | undefined, agent: AgentRecord): boolean {
  return Boolean(isPublicWorkspace(workspace) && !isOwner(workspace!, agent));
}

/** A fresh avatar seed: the web draws a different face for each. */
function newAvatarSeed(): string {
  return randomBytes(6).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Splits "https://x/y/.well-known/agent-card.json" into base + card path; plain URLs get the default path. */
export function splitAgentUrl(raw: string): { url: string; cardPath: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HubError('invalid', `"${raw}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HubError('invalid', 'Agent URL must be http(s)');
  }
  const href = parsed.href.replace(/\/+$/, '');
  const idx = href.indexOf('/.well-known/');
  if (idx >= 0) return { url: href.slice(0, idx), cardPath: href.slice(idx + 1) };
  return { url: href, cardPath: AGENT_CARD_PATH };
}

const PRIVATE_RANGES = new BlockList();
for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']) {
  const [net = '', bits] = cidr.split('/');
  PRIVATE_RANGES.addSubnet(net, Number(bits), 'ipv4');
}
// ::/96 covers :: and ::1. IPv4-mapped (::ffff:a.b.c.d) is matched by BlockList against the IPv4 ranges above;
// an ::ffff:0:0/96 entry here would match every IPv4 address. NAT64 prefixes are refused whole.
for (const cidr of ['::/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8']) {
  const [net = '', bits] = cidr.split('/');
  PRIVATE_RANGES.addSubnet(net, Number(bits), 'ipv6');
}

/**
 * True for hosts that point inside the hub's own network: loopback, private ranges,
 * link-local (incl. the cloud metadata server), and internal names. Registration is open, so
 * on a deployed hub these are refused to avoid using the hub as an SSRF proxy.
 * (Literal checks only; DNS names resolving to private IPs are not caught.)
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  const v = isIP(host);
  return v !== 0 && PRIVATE_RANGES.check(host, v === 4 ? 'ipv4' : 'ipv6');
}

interface RegistryOptions {
  /** This hub sells plans, so their workspace and participant limits apply. A self-hosted hub has no plans to upgrade to. */
  plans?: boolean;
  fetchCard?: CardFetcher;
  /** Allow agent URLs on loopback/private networks (local development). Off (deny private) unless set. */
  allowPrivateUrls?: boolean;
  /** Seals endpoint credentials at rest (CREDENTIALS_KEY). Without it they're stored as given. */
  sealingKey?: Buffer;
  /** Refuse to store a credential when there's no sealingKey (a deployed hub), rather than store it in the clear. */
  requireSealing?: boolean;
  /** Limits new registrations per client IP. */
  registerLimiter?: HitLimiter;
  /** Verifies Google sign-in credentials. Without it, Google sign-in is unavailable. */
  verifyGoogle?: GoogleVerifier;
  /** Limits Google sign-in attempts per client IP. */
  googleLimiter?: HitLimiter;
  /** Limits invites per inviting agent. */
  inviteLimiter?: RateLimiter;
  /** Emails the invitee. Without it, invites are only applied on sign-in. */
  mailInvite?: InviteMailer;
  /** Ends every OAuth sign-in acting as these agents (they were deleted, or their token rotated). */
  revokeTokens?: (agentIds: string[]) => Promise<void>;
  /**
   * Drops the context graph of an archived workspace or channel conversation. Must not throw (app.ts logs errors).
   * Archive is the only removal path: workspaces, channels and conversations have no hard delete, and DMs can't be
   * removed at all. Restoring an archive does not bring messages' nodes back; they fill again as messages are re-extracted.
   * A restored channel's skills and room doc come back through syncGraph.
   */
  purgeGraph?: (scope: { workspaceId: string; conversationId?: string; channelId?: string }) => Promise<void>;
  /** Mirrors a room document or skill write into the context graph (the registry logs a failure, never fails the write). */
  syncGraph?: (change: GraphSourceChange) => Promise<void>;
  /** An agent joined a channel that may already have messages (the chat starts its cursor at the end). */
  onJoinChannel?: (agentId: string, channelId: string) => Promise<void>;
  /** Self-hosted email + password sign-in (PASSWORD_LOGIN=1); the installer's secret creates the first owner. */
  passwordLogin?: { setupSecret: string };
}

/** Live bots one person may own, on any plan: a guard against scripts and runaway agents, not a plan limit. */
export const MAX_LIVE_BOTS = 200;

/** Pairing codes: 8 characters without look-alikes (no 0/O, 1/I/L), typed as XXXX-XXXX, good for 10 minutes. */
const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAIRING_TTL_MS = 10 * 60_000;
/** How long a bot added "on this client" waits for that client to pick it up (Registry.createSibling). */
const SIBLING_TTL_MS = 24 * 3_600_000;
const normalizePairing = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');
const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

export function normalizeEmail(raw: string, invalid = `"${raw}" is not a valid email address`): string {
  const email = String(raw ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HubError('invalid', invalid);
  return email;
}

export class Registry {
  private readonly fetchCard: CardFetcher;
  private readonly allowPrivateUrls: boolean;
  private readonly sealingKey?: Buffer;
  private readonly requireSealing: boolean;
  private readonly registerLimiter?: HitLimiter;
  readonly verifyGoogle?: GoogleVerifier;
  readonly googleLimiter?: HitLimiter;
  readonly inviteLimiter?: RateLimiter;
  readonly mailInvite?: InviteMailer;
  readonly plans: boolean;
  readonly passwordLogin?: { setupSecret: string };
  /** Set after construction too: the chat that needs it is made with the registry. */
  onJoinChannel?: (agentId: string, channelId: string) => Promise<void>;
  readonly revokeTokens?: (agentIds: string[]) => Promise<void>;
  readonly purgeGraph?: RegistryOptions['purgeGraph'];
  readonly syncGraph?: RegistryOptions['syncGraph'];
  readonly agentStore: AgentStore;
  readonly authStore: AuthStore;
  readonly channelStore: ChannelStore;
  readonly skillStore: SkillStore;
  readonly workspaceStore: WorkspaceStore;

  constructor(
    readonly db: Database,
    options: RegistryOptions = {},
  ) {
    this.agentStore = new AgentStore(db);
    this.authStore = new AuthStore(db);
    this.channelStore = new ChannelStore(db);
    this.skillStore = new SkillStore(db);
    this.workspaceStore = new WorkspaceStore(db);
    this.plans = options.plans ?? false;
    this.fetchCard = options.fetchCard ?? fetchAgentCard;
    this.allowPrivateUrls = options.allowPrivateUrls ?? false;
    this.sealingKey = options.sealingKey;
    this.requireSealing = options.requireSealing ?? false;
    this.registerLimiter = options.registerLimiter;
    this.verifyGoogle = options.verifyGoogle;
    this.googleLimiter = options.googleLimiter;
    this.inviteLimiter = options.inviteLimiter;
    this.mailInvite = options.mailInvite;
    this.passwordLogin = options.passwordLogin;
    this.revokeTokens = options.revokeTokens;
    const purge = options.purgeGraph;
    // A failed purge must not fail the archive that triggered it.
    this.purgeGraph = purge && ((scope) => purge(scope).catch((err) => console.error('context graph purge failed', err)));
    const sync = options.syncGraph;
    this.syncGraph = sync && ((change) => sync(change).catch((err) => console.error('context graph sync failed', err)));
    this.onJoinChannel = options.onJoinChannel;
  }


  get col() {
    return this.agentStore.col;
  }

  /**
   * Updates `caller`'s registration, or creates an agent: a bot for its owner (`ownerId`, see
   * createBot) or a person on their first Google sign-in (`viaGoogle`). Every agent belongs to
   * a person; there is no anonymous registration. Names are display names, not identifiers:
   * several agents may share one; the id is what's unique. Returns the token only for new agents.
   */
  async register(
    input: RegisterInput,
    caller?: AgentRecord,
    clientIp?: string,
    ownerId?: string,
    viaGoogle = false,
    verify?: (agent: AgentRecord) => Promise<void>,
  ): Promise<{ agent: AgentRecord; token?: string }> {
    if (!caller && !ownerId && !viaGoogle) {
      throw new HubError('forbidden', 'Agents belong to a person: sign in with Google, then connect one with OAuth or make one on the Connect page (POST /agents/bots).');
    }
    // Only new identities count against the per-IP limit; updating yourself is free.
    if (!caller && clientIp) await this.registerLimiter?.hit(clientIp);
    if (input.kind !== undefined && input.kind !== 'human') throw new HubError('invalid', 'kind can only be "human"');
    // People are made by Google sign-in only; a person may keep re-registering as one.
    if (input.kind === 'human' && !viaGoogle && caller?.kind !== 'human') throw new HubError('forbidden', 'People sign in with Google');
    if (input.credential && !input.url) throw new HubError('invalid', 'A credential needs a url');
    if (input.kind === 'human' && input.url) throw new HubError('invalid', 'A human agent cannot have a url');
    let kind: AgentKind = input.kind ?? (caller?.kind === 'human' && !input.url ? 'human' : 'mailbox');
    let url: string | undefined;
    let cardPath: string | undefined;
    let card: FetchedCard | undefined;
    if (input.url) {
      ({ url, cardPath } = splitAgentUrl(input.url));
      if (this.refusesPrivate(url)) {
        throw new HubError('invalid', 'Agent URL must be publicly reachable; private and loopback addresses are not allowed');
      }
      card = await this.fetchCard(url, cardPath, this.outbound);
      kind = 'endpoint';
    }
    // A credential given now is checked against the card; null removes it; otherwise one only ever stays with the URL it was given for.
    let credential: AgentRecord['credential'];
    const given = input.credential;
    if (given !== undefined && given !== null) {
      if (this.requireSealing && !this.sealingKey) {
        throw new HubError('unavailable', "This hub can't store credentials safely yet (no CREDENTIALS_KEY is set). Ask its operator to set one.");
      }
      let bound: StoredCredential;
      try {
        bound = bindCredential(parseCredentialInput(given), card?.auth);
      } catch (err) {
        throw new HubError('invalid', (err as Error).message);
      }
      // The token URL comes from the card: hold it to the same rules as the agent's own URL.
      if (bound.type === 'oauth2') {
        const tokenUrl = new URL(bound.tokenUrl);
        if (!this.allowPrivateUrls && (tokenUrl.protocol !== 'https:' || isPrivateHost(tokenUrl.hostname))) {
          throw new HubError('invalid', "The card's OAuth2 token URL must be https and publicly reachable");
        }
      }
      credential = this.sealingKey ? { type: bound.type, for: bound.for, sealed: seal(JSON.stringify(bound), this.sealingKey) } : bound;
    } else if (given === undefined && caller && url && url === caller.url) {
      credential = caller.credential;
    }

    const name = cleanName(input.name ?? card?.name ?? '');
    if (!name || name.length > MAX_NAME) {
      throw new HubError('invalid', `name is required: 1-${MAX_NAME} characters`);
    }
    const description = input.description ?? card?.description ?? '';
    const skills = input.skills?.length ? input.skills : (card?.skills ?? []);
    const now = new Date().toISOString();

    if (caller) {
      // Re-registration by an authenticated agent: update in place, keep id and token.
      const updated: AgentRecord = {
        ...caller,
        name,
        description,
        kind,
        url,
        cardPath,
        auth: card?.auth,
        credential,
        // A Routine wakes a mailbox: an agent that becomes an endpoint is called at its URL instead.
        wake: url ? undefined : caller.wake,
        skills,
        public: input.public ?? caller.public ?? false,
        workspaces: caller.workspaces ?? [],
        channels: caller.channels ?? [],
        avatar: caller.avatar ?? newAvatarSeed(),
        lastSeen: now,
      };
      // Write only what registration owns: a whole-doc set from the stale `caller` would revert
      // concurrent writes (channel joins, listeningUntil, wake.lastFire, sessionHashes, ...).
      await this.agentStore.saveRegistration(
        caller.id,
        {
          name, description, kind, skills, lastSeen: now, public: updated.public,
          ...(caller.workspaces ? {} : { workspaces: [] }),
          ...(caller.channels ? {} : { channels: [] }),
          ...(caller.avatar ? {} : { avatar: updated.avatar }),
        },
        { url, cardPath, auth: card?.auth, credential },
        !!url,
      );
      return { agent: updated };
    }

    return this.createAgent(
      { name, description, kind, url, cardPath, ...(card?.auth ? { auth: card.auth } : {}), ...(credential ? { credential } : {}), skills, public: input.public ?? false, workspaces: [], channels: [], ...(ownerId ? { ownerId } : {}) },
      verify,
    );
  }

  /**
   * Writes a new agent with a fresh id and token. Returns the token, the only time it is known. `verify` sees the
   * agent before it's written and can refuse it by throwing, so a refused agent never exists.
   */
  private async createAgent(
    fields: Pick<AgentRecord, 'name' | 'description' | 'kind' | 'url' | 'cardPath' | 'auth' | 'credential' | 'skills' | 'public' | 'workspaces' | 'channels' | 'ownerId'>,
    verify?: (agent: AgentRecord) => Promise<void>,
  ): Promise<{ agent: AgentRecord; token: string }> {
    const now = new Date().toISOString();
    const token = newAgentToken();
    const agent: AgentRecord = {
      id: randomUUID(),
      ...fields,
      avatar: newAvatarSeed(),
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeen: now,
    };
    await verify?.(agent);
    await this.agentStore.create(agent);
    return { agent, token };
  }

  /**
   * A room's moderator: the hub's own member of the room, in `channels`, that opens the talks and hands each side
   * its decisions. No one owns it or signs in as it: its token is never kept.
   */
  async createModerator(workspaceId: string, channels: string[]): Promise<AgentRecord> {
    const description = 'Opens the talks in this room and hands each side its decisions.';
    return (await this.createAgent({ name: 'Moderator', description, kind: 'mailbox', skills: [], public: false, workspaces: [workspaceId], channels })).agent;
  }

  /**
   * One side's agent in one app room (Rooms.openForApp), made from the app's template: a cloud agent no one owns, told
   * the template's instructions, whose model calls `payerId` pays (the app's maker). One per room side, in that room's
   * shared channel and that side's corner only, so it can never read or act in another room.
   */
  async createAppRoomAgent(input: { workspaceId: string; channels: string[]; name: string; description: string; payerId: string }): Promise<AgentRecord> {
    const { agent } = await this.createAgent({ name: cleanName(input.name), description: input.description, kind: 'endpoint', skills: [], public: false, workspaces: [input.workspaceId], channels: input.channels });
    const extra = { cloud: true, payerId: input.payerId, tools: { toolkits: [], act: false } } as const;
    await this.agentStore.update(agent.id, extra);
    return { ...agent, ...extra, tools: { toolkits: [], act: false } };
  }

  /** One room agent that won't be used, archived so it never answers. */
  async archiveRoomAgent(id: string): Promise<void> {
    await this.agentStore.update(id, { archived: true });
  }

  /** A closed room's own agents (no owner) are archived, so they never answer again. */
  async archiveRoomAgents(workspaceId: string): Promise<void> {
    return this.agentStore.archiveRoomAgents(workspaceId);
  }

  /**
   * Undoes a room that failed to open: every member leaves it (its workspace and channels drop off their lists), its
   * agents no one owns (the representative) are archived so they never answer, and the workspace is archived.
   */
  async discardRoom(workspaceId: string): Promise<void> {
    await this.agentStore.discardRoom(workspaceId);
    await this.purgeGraph?.({ workspaceId });
  }

  /** Puts a room's moderator in a channel of its room made after it (a later side's corner). */
  async addModerator(moderatorId: string, channelId: string): Promise<void> {
    await this.agentStore.addChannel(moderatorId, channelId);
  }

  // ---- owned bots ------------------------------------------------------------------------

  /**
   * A signed-in person makes a bot they own. Returns its token, shown once. Bots never expire,
   * are always visible to their owner, and the owner can rotate, archive and delete them.
   * With `follow`, the bot is the person's own tool (their Claude Code, their Codex, their A2A agent):
   * private and in no workspace until a member adds it. A `url` makes it an A2A endpoint the hub pushes
   * to; without one it is a mailbox.
   */
  async createBot(
    owner: AgentRecord,
    input: RegisterInput & { follow?: boolean; hired?: boolean },
    clientIp?: string,
    verify?: (agent: AgentRecord) => Promise<void>,
  ): Promise<{ agent: AgentRecord; token: string }> {
    if (!isSignedInPerson(owner)) throw new HubError('forbidden', 'Sign in to own bots');
    if (input.kind === 'human') throw new HubError('invalid', 'A bot cannot be a human');
    // Hired agents were checked by HubService before it got here.
    if (!input.hired) await this.checkBotCap(owner);
    const { follow, hired: _hired, ...fields } = input;
    const { agent, token } = await this.register(
      follow
        ? {
            name: fields.name,
            url: fields.url,
            credential: fields.credential,
            description:
              fields.description ?? (fields.url ? `A2A agent owned by ${owner.name}.` : `Coding agent owned by ${owner.name}. Messages reach it at its next prompt.`),
          }
        : fields,
      undefined,
      clientIp,
      owner.id,
      false,
      verify,
    );
    const extra: Partial<AgentRecord> = { ownerName: owner.name, ...(follow ? { followsOwner: true } : {}) };
    await this.agentStore.update(agent.id, extra);
    return { agent: { ...agent, ...extra }, token: token! };
  }

  /** A cloud agent's tools (HubService.setAgentTools). */
  async setTools(agentId: string, tools: { toolkits: string[]; act: boolean }): Promise<void> {
    await this.agentStore.update(agentId, { tools });
  }

  /** Makes a bot a cloud agent (HubService.createCloudAgent): an endpoint the hub answers for itself, with GitHub read tools on by default. */
  async markCloud(agentId: string): Promise<void> {
    await this.agentStore.update(agentId, {
      kind: 'endpoint',
      cloud: true,
      tools: { toolkits: ['github'], act: false },
    });
  }

  /** Makes a bot hosted: its computer wakes it, with the secrets it starts with (HubService.hire). */
  async markHosted(id: string, hosted: NonNullable<AgentRecord['hosted']>): Promise<void> {
    await this.agentStore.update(id, { hosted, wake: { type: 'computer' } satisfies WakeRecord });
  }

  /**
   * A one-time code that connects a tool as a new bot of `owner` (see redeemPairing): the person
   * makes it on the Connect page and gives it to their agent. Only its hash is stored, and it holds
   * no token, so a code left in a chat transcript is useless once used or after PAIRING_TTL_MS.
   */
  async createPairing(owner: AgentRecord, name?: string, agentId?: string): Promise<{ code: string; expiresAt: string }> {
    if (!isSignedInPerson(owner)) throw new HubError('forbidden', 'Sign in to connect tools');
    // For one of the owner's existing bots: spending the code gives that bot a new token instead of making one.
    const bot = agentId ? await this.requireSelfOrOwned(owner, agentId) : undefined;
    if (bot && bot.id === owner.id) throw new HubError('invalid', 'A pairing code is for a bot of yours, not for you');
    if (!bot) await this.checkBotCap(owner);
    return this.makePairing(owner.id, name, bot?.id);
  }

  /** Stores a new pairing code's hash and returns the code. Callers check who may make it. */
  private async makePairing(ownerId: string, name?: string, agentId?: string, siblingOf?: string): Promise<{ code: string; expiresAt: string }> {
    const raw = Array.from(randomBytes(8), (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await this.agentStore.createPairing(hashToken(normalizePairing(code)), { ownerId, expiresAt, ...(name?.trim() ? { name: name.trim() } : {}), ...(agentId ? { agentId } : {}), ...(siblingOf ? { siblingOf } : {}) });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /**
   * "Add agent on this client": the owner makes a new bot next to `parentId` (one of their bots), and
   * the parent's own client (its router) picks it up with siblingPairings and connects it there.
   * Nothing secret is stored on the parent: only the child's id, until the child is paired or SIBLING_TTL_MS passes.
   */
  async createSibling(owner: AgentRecord, parentId: string, name?: string): Promise<AgentRecord> {
    if (!isSignedInPerson(owner)) throw new HubError('forbidden', 'Sign in to add agents');
    const parent = await this.requireSelfOrOwned(owner, parentId);
    if (parent.id === owner.id) throw new HubError('invalid', 'Add an agent next to one of your bots, not next to you');
    if (parent.archived) throw new HubError('invalid', `${parent.name} is archived. Restore it first.`);
    if (parent.cloud || parent.hosted || parent.kind === 'endpoint') throw new HubError('invalid', `${parent.name} doesn't run on a client of yours, so there is nothing to add an agent to.`);
    const { agent } = await this.createBot(owner, { name: name?.trim() || `${cleanName(parent.name).slice(0, MAX_NAME - 2)} 2`, follow: true });
    try {
      await this.agentStore.addPendingSibling(parent.id, { agentId: agent.id, expiresAt: new Date(Date.now() + SIBLING_TTL_MS).toISOString() });
    } catch (err) {
      await this.agentStore.deleteAgent(agent.id, false);
      throw err;
    }
    return agent;
  }

  /**
   * The parent bot's own call: a fresh pairing code for each sibling still waiting for it. Entries stay until the
   * child redeems one (any earlier code for it then stops working) or SIBLING_TTL_MS passes, so a lost answer is retried.
   */
  async siblingPairings(parentRecord: AgentRecord): Promise<{ agentId: string; name: string; code: string }[]> {
    const parent = await this.get(parentRecord.id);
    if (!parent?.ownerId) return [];
    const now = Date.now();
    const out: { agentId: string; name: string; code: string }[] = [];
    for (const p of parent.pendingSiblings ?? []) {
      if (Date.parse(p.expiresAt) <= now) continue;
      const child = await this.get(p.agentId);
      if (!child || child.ownerId !== parent.ownerId || child.archived) {
        await this.agentStore.removePendingSibling(parent.id, p.agentId);
        continue;
      }
      out.push({ agentId: child.id, name: child.name, code: (await this.makePairing(parent.ownerId, undefined, child.id, parent.id)).code });
    }
    return out;
  }

  /**
   * Spends a pairing code (once, before it expires): makes the owner's new `follow` bot and returns its token,
   * or, for a code made for an existing bot, gives that bot a new token (which ends its old token and sign-ins).
   */
  async redeemPairing(code: string, clientIp?: string): Promise<{ agent: AgentRecord; token: string }> {
    if (clientIp) await this.googleLimiter?.hit(clientIp);
    const pairing = await this.agentStore.takePairing(hashToken(normalizePairing(code)));
    if (!pairing || pairing.expiresMs < Date.now()) throw new HubError('unauthorized', 'That code is wrong, used or expired. Make a new one on the Connect page.');
    const owner = await this.get(pairing.ownerId);
    if (!owner) throw new HubError('unauthorized', 'The person who made this code no longer exists.');
    if (pairing.agentId) {
      const bot = await this.get(pairing.agentId);
      if (!bot || bot.ownerId !== owner.id) throw new HubError('unauthorized', 'The connection this code was for no longer exists.');
      if (bot.archived) throw new HubError('forbidden', 'This bot is archived. Its owner can restore it.');
      // A code from siblingPairings: only the first one redeemed for that child counts, so a second can't end its token.
      if (pairing.siblingOf && !(await this.agentStore.removePendingSibling(pairing.siblingOf, bot.id).catch(() => false))) {
        throw new HubError('unauthorized', 'That code is wrong, used or expired. Make a new one on the Connect page.');
      }
      return { agent: bot, token: await this.rotateToken(bot) };
    }
    return this.createBot(owner, { name: pairing.name, follow: true }, clientIp);
  }

  /** How many agents `owner` has of one sort, archived ones aside: hired (Parly runs them: cloud, hosted) or connected. */
  async agentCount(owner: AgentRecord, hired: boolean): Promise<number> {
    return (await this.botsOf(owner)).filter((b) => !b.archived && !!(b.cloud || b.hosted) === hired).length;
  }

  /** Refuses a bot past MAX_LIVE_BOTS live ones per owner: plans cap participants per workspace, this only stops scripts or a runaway agent. */
  // ponytail: count then create, so two at once can land one over; harmless, the next one is refused.
  async checkBotCap(owner: AgentRecord): Promise<void> {
    if (isSuperAdmin(owner)) return;
    const count = (await this.botsOf(owner)).filter((b) => !b.archived).length;
    if (count >= MAX_LIVE_BOTS) throw new HubError('conflict', `You have ${count} agents, the most one person can have. Archive one you don't use, or ask us for more.`);
  }

  /** Bots `owner` made, archived ones included, oldest first. */
  async botsOf(owner: AgentRecord): Promise<AgentRecord[]> {
    return (await this.agentStore.ownedBy(owner.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** `agentId` if it's `caller` or a bot `caller` owns; otherwise not_found. */
  async requireSelfOrOwned(caller: AgentRecord, agentId: string): Promise<AgentRecord> {
    if (agentId === caller.id || agentId === 'me') return caller;
    const target = await this.get(agentId);
    if (!target || target.ownerId !== caller.id) throw new HubError('not_found', `No bot "${agentId}" of yours.`);
    return target;
  }

  /** Agents by id, skipping ids that don't exist. */
  async getMany(ids: string[]): Promise<AgentRecord[]> {
    const valid = [...new Set(ids)].filter((id) => id && !id.includes('/'));
    if (valid.length === 0) return [];
    return this.agentStore.getMany(valid);
  }

  async get(id: string): Promise<AgentRecord | undefined> {
    if (!id || id.includes('/')) return undefined;
    return this.agentStore.get(id);
  }

  /**
   * For a lookup that missed: if `value` is the name of some of `candidates`, a hint naming
   * their ids, since agents are addressed by id only (names are free text and not unique).
   */
  idHint(value: string, candidates: AgentRecord[]): string {
    const wanted = cleanName(value).toLowerCase();
    const named = candidates.filter((a) => a.name.toLowerCase() === wanted);
    if (named.length === 0) return '';
    const ids = named.map((a) => `${a.id}${a.description ? ` (${a.description})` : ''}`).join(', ');
    return ` Agents are addressed by id; "${value}" is a name. Ids of agents named "${value}": ${ids}`;
  }

  async list(): Promise<AgentRecord[]> {
    return this.agentStore.listByName();
  }

  /**
   * Resolves which workspaces grant `viewer` full roster visibility (non-showcase workspaces, or
   * showcase workspaces where `viewer` is an owner) vs channel-only guest visibility.
   */
  private async visibilityScope(viewer: AgentRecord | undefined): Promise<{
    fullWorkspaceIds: Set<string>;
    joinedChannelIds: Set<string>;
  }> {
    if (!viewer) return { fullWorkspaceIds: new Set(), joinedChannelIds: new Set() };
    const workspaces = await this.workspacesOf(viewer);
    const fullWorkspaceIds = new Set(
      workspaces.filter((w) => !isPublicWorkspace(w) || isOwner(w, viewer)).map((w) => w.id),
    );
    const joinedChannelIds = new Set(viewer.channels ?? []);
    return { fullWorkspaceIds, joinedChannelIds };
  }

  private canSeeInScope(
    viewer: AgentRecord | undefined,
    target: AgentRecord,
    scope: { fullWorkspaceIds: Set<string>; joinedChannelIds: Set<string> },
  ): boolean {
    if (target.public) return true;
    if (!viewer) return false;
    if (viewer.id === target.id || viewer.id === target.ownerId || viewer.ownerId === target.id) return true;
    if ((target.workspaces ?? []).some((w) => scope.fullWorkspaceIds.has(w))) return true;
    if ((target.channels ?? []).some((c) => scope.joinedChannelIds.has(c))) return true;
    return false;
  }

  /** Every agent `viewer` may see (see `canSeeInScope`), by name: one single-field query per rule instead of the whole directory. */
  private async visibleAgents(viewer: AgentRecord | undefined, scope: { fullWorkspaceIds: Set<string>; joinedChannelIds: Set<string> }): Promise<AgentRecord[]> {
    const anyOf = (field: string, ids: Set<string>) => {
      const all = [...ids];
      return Array.from({ length: Math.ceil(all.length / 30) }, (_, i) => this.agentStore.withAny(field, all.slice(i * 30, i * 30 + 30)));
    };
    const parts = await Promise.all([
      this.agentStore.publicAgents(),
      ...(viewer
        ? [
            ...anyOf('workspaces', scope.fullWorkspaceIds),
            ...anyOf('channels', scope.joinedChannelIds),
            this.agentStore.ownedBy(viewer.id),
            this.getMany([viewer.id, ...(viewer.ownerId ? [viewer.ownerId] : [])]),
          ]
        : []),
    ]);
    const byId = new Map(parts.flat().map((a) => [a.id, a]));
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The agent with this id, but only if `viewer` may see it (see `canSeeInScope`). */
  async getVisible(id: string, viewer: AgentRecord | undefined): Promise<AgentRecord | undefined> {
    const agent = await this.get(id);
    if (!agent || (agent.archived && agent.id !== viewer?.id)) return undefined;
    const scope = await this.visibilityScope(viewer);
    return this.canSeeInScope(viewer, agent, scope) ? agent : undefined;
  }

  /** Like getVisible, but throws not_found, with ids to use when `id` was actually a name. */
  async requireVisible(id: string, viewer: AgentRecord | undefined): Promise<AgentRecord> {
    const agent = await this.getVisible(id, viewer);
    if (agent) return agent;
    // ponytail: the name hint reads the viewer's whole directory, like search(); only on a miss
    const hint = this.idHint(id, await this.search(viewer));
    // Private agents outside the viewer's workspaces look exactly like unknown ids.
    throw new HubError('not_found', `No agent "${id}" is available to you.${hint || ' Use list_agents to see who you can message, and their ids.'}`);
  }

  /**
   * The directory as `viewer` sees it: public agents plus everyone in the viewer's workspaces,
   * optionally only the members of one workspace or channel (ids).
   * Case-insensitive match over name, description, and skill ids/names/descriptions/tags.
   */
  // ponytail: the whole directory reads every public agent plus the viewer's workspaces, channels and owned agents, unpaged; page it when public agents number thousands
  async search(viewer: AgentRecord | undefined, opts: { query?: string; skill?: string; workspace?: string; channel?: string } = {}): Promise<AgentRecord[]> {
    let guestWorkspaceChannelIds: Set<string> | undefined;
    if (opts.channel) {
      const channel = await this.channelDoc(opts.channel);
      const channelWs = channel ? await this.workspaceDoc(channel.workspaceId) : undefined;
      if (channel && isPublicWorkspace(channelWs)) {
        if (!viewer || (!canManageChannel(channel, channelWs, viewer) && !(viewer.channels ?? []).includes(channel.id))) {
          return [];
        }
      }
    } else if (opts.workspace) {
      const workspace = await this.workspaceDoc(opts.workspace);
      if (isPublicWorkspace(workspace)) {
        if (!viewer) return [];
        if (!isOwner(workspace!, viewer)) {
          if (!(viewer.workspaces ?? []).includes(workspace!.id)) return [];
          const joinedInWs = await this.channelsOf(viewer, workspace!.id);
          guestWorkspaceChannelIds = new Set(joinedInWs.map((c) => c.id));
        }
      }
    }
    const scoped = opts.channel ? (['channels', opts.channel] as const) : opts.workspace ? (['workspaces', opts.workspace] as const) : undefined;
    const scope = await this.visibilityScope(viewer);
    const [all, showArchived] = await Promise.all([
      scoped ? this.agentStore.membersOf(scoped[0], scoped[1]).then((agents) => agents.sort((a, b) => a.name.localeCompare(b.name))) : this.visibleAgents(viewer, scope),
      // Archived bots appear only in a workspace or channel listing, to someone who can manage it, so they can restore them.
      viewer ? this.canManage(viewer, opts) : Promise.resolve(false),
    ]);
    const q = opts.query?.toLowerCase().trim();
    const s = opts.skill?.toLowerCase().trim();
    return all.filter((a) => {
      if (!this.canSeeInScope(viewer, a, scope)) return false;
      if (a.archived && !showArchived) return false;
      if (opts.workspace && !(a.workspaces ?? []).includes(opts.workspace)) return false;
      if (guestWorkspaceChannelIds && a.id !== viewer?.id && a.ownerId !== viewer?.id && !(a.channels ?? []).some((c) => guestWorkspaceChannelIds.has(c))) {
        return false;
      }
      if (opts.channel && !(a.channels ?? []).includes(opts.channel)) return false;
      if (s && !a.skills.some((k) => matchesSkill(k, s))) return false;
      if (!q) return true;
      const hay = [a.name, a.description, ...a.skills.flatMap((k) => [k.id, k.name, k.description ?? '', ...(k.tags ?? [])])]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  /**
   * `search(viewer, { channel })` for each of `channels`, in one read of their members (array-contains-any, 30 at a
   * time) plus each workspace once, instead of four reads per channel.
   */
  async channelMembers(viewer: AgentRecord, channels: ChannelRecord[]): Promise<AgentRecord[][]> {
    const ids = channels.map((c) => c.id);
    const wsIds = [...new Set(channels.map((c) => c.workspaceId))];
    const [scope, wss, ...chunks] = await Promise.all([
      this.visibilityScope(viewer),
      Promise.all(wsIds.map((id) => this.workspaceDoc(id))),
      ...Array.from({ length: Math.ceil(ids.length / 30) }, (_, i) => this.agentStore.withAny('channels', ids.slice(i * 30, i * 30 + 30))),
    ]);
    const wsById = new Map(wsIds.map((id, i) => [id, wss[i]]));
    const all = [...new Map(chunks.flat().map((a) => [a.id, a])).values()].sort((a, b) => a.name.localeCompare(b.name));
    return channels.map((c) => {
      const ws = wsById.get(c.workspaceId);
      const manages = canManageChannel(c, ws, viewer);
      if (isPublicWorkspace(ws) && !manages && !(viewer.channels ?? []).includes(c.id)) return [];
      return all.filter((a) => (a.channels ?? []).includes(c.id) && this.canSeeInScope(viewer, a, scope) && !(a.archived && !manages));
    });
  }

  /** Whether `viewer` has owner rights on the workspace or channel a listing is scoped to. */
  private async canManage(viewer: AgentRecord, opts: { workspace?: string; channel?: string }): Promise<boolean> {
    if (opts.channel) {
      const channel = await this.channelDoc(opts.channel);
      return !!channel && canManageChannel(channel, await this.workspaceDoc(channel.workspaceId), viewer);
    }
    if (opts.workspace) {
      const workspace = await this.workspaceDoc(opts.workspace);
      return !!workspace && isOwner(workspace, viewer);
    }
    return false;
  }

  /** Picks the agent advertising `skill`, visible to `viewer` and other than it, that was seen most recently. */
  async findBySkill(skill: string, viewer: AgentRecord | undefined, reachable: (agent: AgentRecord) => Promise<boolean>): Promise<AgentRecord | undefined> {
    const candidates = (await this.search(viewer, { skill })).filter((a) => a.id !== viewer?.id && a.kind !== 'human' && !a.archived);
    candidates.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    for (const agent of candidates) if (await reachable(agent)) return agent;
    return undefined;
  }

  /** Records (or clears) why the hub can't authenticate to an endpoint agent; called by the forwarder on a change. */
  async setAuthProblem(agentId: string, problem: string | undefined): Promise<void> {
    await this.agentStore.setAuthProblem(agentId, problem);
  }

  /**
   * The owner connects their mailbox bot to a Claude Code Routine's API trigger or an outgoing webhook URL
   * (null disconnects it). The token or signing secret is sealed like an endpoint credential; a new one starts
   * with no fire history.
   */
  async setWake(
    bot: AgentRecord,
    wake:
      | { type?: 'claude-routine'; routineId: string; token: string }
      | { type: 'webhook'; url: string; secret?: string; authorization?: string; perConversation?: boolean }
      | { type: 'xai'; apiKey: string; token: string }
      | null,
  ): Promise<AgentRecord> {
    if (wake === null) {
      await this.agentStore.clearWake(bot.id);
      const { wake: _gone, ...rest } = bot;
      return rest;
    }
    if (bot.kind !== 'mailbox') throw new HubError('invalid', 'Only an agent without its own URL can be woken by a Routine; an A2A agent is called at its URL');
    let record: WakeRecord;
    if (wake.type === 'webhook') {
      const url = this.validateWebhookUrl(wake.url);
      const keepExistingSecret = wake.secret === undefined && bot.wake?.type === 'webhook';
      record = {
        type: 'webhook',
        url,
        ...(wake.secret
          ? this.sealedToken(wake.secret)
          : keepExistingSecret
            ? {
                ...(bot.wake?.sealed ? { sealed: bot.wake.sealed } : {}),
                ...(bot.wake?.token ? { token: bot.wake.token } : {}),
              }
            : {}),
        // The Authorization header: a new one, or the one it had (`authorization: ''` drops it).
        ...(wake.authorization
          ? (({ sealed, token }) => (sealed ? { authSealed: sealed } : { auth: token }))(this.sealedToken(wake.authorization))
          : wake.authorization === undefined && bot.wake?.type === 'webhook'
            ? { ...(bot.wake.authSealed ? { authSealed: bot.wake.authSealed } : {}), ...(bot.wake.auth ? { auth: bot.wake.auth } : {}) }
            : {}),
        // Changing the URL or header doesn't change what the routine's saved prompt does.
        ...((wake.perConversation ?? (bot.wake?.type === 'webhook' && bot.wake.perConversation)) ? { perConversation: true } : {}),
      };
    } else if (wake.type === 'xai') {
      record = { type: 'xai', ...this.sealedToken(JSON.stringify({ apiKey: wake.apiKey, token: wake.token })) };
    } else {
      record = { type: 'claude-routine', routineId: wake.routineId, ...this.sealedToken(wake.token) };
    }
    await this.agentStore.update(bot.id, { wake: record });
    return { ...bot, wake: record };
  }

  private validateWebhookUrl(raw: string): string {
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new HubError('invalid', `"${raw}" is not a valid webhook URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HubError('invalid', 'Webhook URL must be http(s)');
    }
    if (this.refusesPrivate(parsed.href)) {
      throw new HubError('invalid', 'Webhook URL must be publicly reachable; private and loopback addresses are not allowed');
    }
    return parsed.href;
  }

  /** A Routine's trigger token as stored: sealed, or as is on a hub that doesn't require sealing. */
  private sealedToken(token: string): Pick<WakeRecord, 'sealed' | 'token'> {
    if (this.requireSealing && !this.sealingKey) {
      throw new HubError('unavailable', "This hub can't store the Routine's token safely yet (no CREDENTIALS_KEY is set). Ask its operator to set one.");
    }
    return this.sealingKey ? { sealed: seal(token, this.sealingKey) } : { token };
  }

  /**
   * Sets or removes (`null`) an agent's optional Telegram bot token (owner-only). Sealed with `CREDENTIALS_KEY` like
   * endpoint credentials and wake tokens; never returned in views.
   */
  async setTelegramBot(caller: AgentRecord, agentId: string, rawToken: string | null): Promise<AgentRecord> {
    const id = agentId === 'me' ? caller.id : agentId;
    const target = id === caller.id ? (await this.get(caller.id)) ?? caller : await this.get(id);
    if (!target) throw new HubError('not_found', `No agent "${agentId}" found`);
    if (target.id !== caller.id && target.ownerId !== caller.id) {
      throw new HubError('forbidden', "Only an agent's owner can manage its Telegram bot token");
    }
    if (rawToken === null) {
      await this.agentStore.clearTelegramBot(target.id);
      const { telegramBot: _gone, ...rest } = target;
      return rest;
    }
    const token = rawToken.trim();
    if (!/^\d+:[A-Za-z0-9_-]{8,200}$/.test(token)) {
      throw new HubError('invalid', 'Telegram bot token must look like 123456789:ABC-DEF… (from @BotFather)');
    }
    if (this.requireSealing && !this.sealingKey) {
      throw new HubError(
        'unavailable',
        "This hub can't store the Telegram bot token safely yet (no CREDENTIALS_KEY is set). Ask its operator to set one.",
      );
    }
    const telegramBot: AgentTelegramBot = this.sealingKey ? { sealed: seal(token, this.sealingKey) } : { token };
    await this.agentStore.update(target.id, { telegramBot });
    return { ...target, telegramBot };
  }

  /** Unseals an agent's optional Telegram bot token for outbound relay, or `undefined` if none is set. */
  telegramBotTokenOf(agent: Pick<AgentRecord, 'telegramBot'>): string | undefined {
    const tb = agent.telegramBot;
    if (!tb) return undefined;
    if (tb.token) return tb.token;
    if (tb.sealed && this.sealingKey) {
      try {
        return unseal(tb.sealed, this.sealingKey);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** A person starts connecting a Routine (see RoutineSetup): replaces one they started before. */
  async startRoutineSetup(owner: AgentRecord, routineId: string, token: string): Promise<RoutineSetup> {
    const setup: RoutineSetup = { routineId, ...this.sealedToken(token), secret: randomBytes(24).toString('base64url'), at: new Date().toISOString() };
    await this.agentStore.update(owner.id, { routineSetup: setup });
    return setup;
  }

  /** How the setup fire went, or why the setup can't finish; ignored once that setup is gone or replaced. */
  async noteRoutineSetup(ownerId: string, at: string, note: { sessionUrl?: string; problem?: string }): Promise<void> {
    await this.agentStore.noteRoutineSetup(ownerId, at, note);
  }

  /**
   * The setup's session signed in as `agent`, one of its owner's: `agent` gets the Routine (the setup fire counts
   * as its last), the setup ends, and any other agent of theirs this Routine woke stops being woken by it.
   */
  async attachRoutine(agent: AgentRecord, setup: RoutineSetup): Promise<AgentRecord> {
    const { secret: _s, at, sessionUrl, problem: _p, ...trigger } = setup;
    const wake: WakeRecord = { type: 'claude-routine', ...trigger, lastFire: { at, ok: true, ...(sessionUrl ? { sessionUrl } : {}) } };
    await this.agentStore.attachRoutine(agent.id, agent.ownerId!, setup.routineId, wake);
    return { ...agent, wake };
  }

  /** Mailbox agents with a Routine or webhook to wake: the sweep's list (wakeSweep). */
  async wakeable(limit = 500): Promise<AgentRecord[]> {
    // 'computer' included so the /tick sweep recovers hosted (computer) agents whose on-message wake was missed
    // (e.g. the instance scaled to zero before the fire-and-forget wake ran); wake() still skips any with no waiting mail.
    return this.agentStore.wakeable(limit);
  }

  /** Endpoint (and cloud) agents: the sweep re-pushes what a dropped enqueue left waiting (wakeSweep). */
  async endpoints(limit = 500): Promise<AgentRecord[]> {
    return (await this.agentStore.endpoints(limit)).filter((a) => !a.archived);
  }

  /**
   * Takes the right to fire `agent`'s Routine now, if its last fire is still `seenAt` (the one the caller decided
   * on): two hub instances, or a send and the sweep, never fire for the same messages twice.
   */
  async claimFire(agentId: string, seenAt: string | undefined): Promise<WakeRecord | undefined> {
    return this.agentStore.claimFire(agentId, seenAt);
  }

  /**
   * `claimFire` for a fire per conversation: `due` picks from each conversation's last fire, and those are taken
   * together, so two hub instances never fire for the same conversation twice. Conversations no longer waiting are
   * dropped: a new message there is newer than any fire.
   */
  async claimConversationFires(agentId: string, waiting: string[], due: (lastFires: Record<string, { at: string; ok: boolean }>) => string[]): Promise<{ wake: WakeRecord; conversations: string[] } | undefined> {
    return this.agentStore.claimConversationFires(agentId, waiting, due);
  }

  /** Those conversations' fires, claimed at `at`, didn't go out: they wait for the retry. */
  async failConversationFires(agentId: string, at: string, conversations: string[]): Promise<void> {
    return this.agentStore.failConversationFires(agentId, at, conversations);
  }

  /** How a fire went: its session, or why it failed (shown to the owner until a fire works). */
  async recordFire(agentId: string, at: string, result: { sessionUrl?: string } | { problem: string }): Promise<void> {
    return this.agentStore.recordFire(agentId, at, result);
  }

  /** How the hub calls agents: on a deployed hub, only public addresses as DNS resolves them. */
  private get outbound(): typeof fetch {
    return this.allowPrivateUrls ? fetch : publicFetch;
  }

  /** A private or loopback agent URL this hub won't call (all of them, unless private URLs are allowed). */
  private refusesPrivate(url: string): boolean {
    return !this.allowPrivateUrls && isPrivateHost(new URL(url).hostname);
  }

  /** Short-lived agent-card responses so /agents/:id/card is not a live unauthenticated proxy. */
  private readonly cardCache = new BoundedMap<string, { at: number; body: unknown }>(200);

  /** The live agent card of an endpoint agent, fetched from its URL (raw JSON, not trimmed). */
  async liveCard(agent: AgentRecord): Promise<unknown> {
    if (agent.kind !== 'endpoint' || !agent.url) throw new HubError('not_found', `${agent.name} has no agent card (it is not an A2A endpoint)`);
    if (this.refusesPrivate(agent.url)) throw new HubError('not_found', `${agent.name} has no reachable agent card`);
    // Cache key includes URL/cardPath so a URL change is not served stale for up to 60s.
    const cacheKey = `${agent.id}\0${agent.url}\0${agent.cardPath ?? ''}`;
    const cached = this.cardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.body;
    const url = `${agent.url}/${agent.cardPath ?? AGENT_CARD_PATH}`;
    const res = await this.outbound(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' }).catch((err: Error) => {
      throw new HubError('unavailable', `Could not reach agent card at ${url}: ${err.message}`);
    });
    if (!res.ok) throw new HubError('unavailable', `Agent card at ${url} returned HTTP ${res.status}`);
    const body = await res.json().catch(() => {
      throw new HubError('unavailable', `${url} did not return JSON`);
    });
    this.cardCache.set(cacheKey, { at: Date.now(), body });
    return body;
  }

  /** Resolves a token to its agent: the main token, or a web sign-in session token. */
  async authenticate(token: string): Promise<AgentRecord | undefined> {
    return registryAuth.authenticate(this, token);
  }

  // ---- Google sign-in -------------------------------------------------------------------

  /**
   * Signs a person in with a Google credential: finds their human agent by Google account or
   * verified email, or creates one; applies pending invites and the workspaces that take their
   * email domain; makes them a workspace of their own if they still have none; and returns a new
   * session token. The main token is untouched, so MCP clients using it stay signed in.
   */
  async signInWithGoogle(
    idToken: string,
    clientIp?: string,
  ): Promise<{ agent: AgentRecord; token: string; created: boolean }> {
    return registryAuth.signInWithGoogle(this, idToken, clientIp);
  }

  /**
   * The person a verified Google profile belongs to: found by Google account or verified email,
   * or created. Pending invites are applied by the caller (sign-in).
   */
  async personFor(verified: GoogleProfile, clientIp?: string): Promise<{ agent: AgentRecord; created: boolean }> {
    return registryAuth.personFor(this, verified, clientIp);
  }

  /** Self-hosted: signs in with email + password. Wrong email and wrong password get the same answer. */
  async signInWithPassword(rawEmail: string, password: string, clientIp?: string): Promise<{ agent: AgentRecord; token: string; created: boolean }> {
    return registryAuth.signInWithPassword(this, rawEmail, password, clientIp);
  }

  /** Self-hosted: the first owner, once, with the setup secret the installer printed. */
  async setupOwner(input: { setupSecret?: string; email?: string; name?: string; password?: string }, clientIp?: string) {
    return registryAuth.setupOwner(this, input, clientIp);
  }

  /** Self-hosted: anyone signs up with email + password. */
  async signUpWithPassword(input: { email?: string; name?: string; password?: string }, clientIp?: string) {
    return registryAuth.signUpWithPassword(this, input, clientIp);
  }

  /** Sets a person's password from the host (`npm run reset-password`): there is no email to reset it by. */
  async resetPassword(rawEmail: string, password: string): Promise<void> {
    return registryAuth.resetPassword(this, rawEmail, password);
  }

  /** Revokes a web sign-in session token (the main token is revoked with rotateToken instead). */
  async revokeSession(agent: AgentRecord, token: string): Promise<void> {
    return registryAuth.revokeSession(this, agent, token);
  }

  /** Bumps lastSeen, throttled so a polling agent doesn't write on every call. */
  async touch(agent: AgentRecord): Promise<void> {
    const now = Date.now();
    if (now - Date.parse(agent.lastSeen) < TOUCH_INTERVAL_MS) return;
    agent.lastSeen = new Date(now).toISOString();
    await this.agentStore.update(agent.id, { lastSeen: agent.lastSeen });
  }

  /** touch() off the request path: the caller doesn't wait for the write, and a failed write is only logged. */
  touchInBackground(agent: AgentRecord): void {
    this.touch(agent).catch((err) => console.error('lastSeen update failed', agent.id, err));
  }

  /**
   * The agent opened a wait: it counts as listening until now + LISTEN_GRACE_MS. Written at most
   * every ~30s per agent, in a transaction that only moves it forward, so a delayed heartbeat
   * never shortens it.
   */
  async markListening(agent: AgentRecord): Promise<void> {
    const until = Date.now() + LISTEN_GRACE_MS;
    if (agent.listeningUntil && Date.parse(agent.listeningUntil) > until - LISTEN_REFRESH_MS) return;
    agent.listeningUntil = await this.agentStore.extendListening(agent.id, until);
  }

  /**
   * Issues a new token for a bot; the old one, and any OAuth sign-in acting as it, stop working
   * immediately. People have no token of their own: they sign in with Google, and their tools
   * act as their bots.
   */
  async rotateToken(agent: AgentRecord): Promise<string> {
    return registryAuth.rotateToken(this, agent);
  }

  /** Sets `agent`'s avatar to `seed` (one the person picked), or draws a random one. */
  async newAvatar(agent: AgentRecord, seed?: string): Promise<string> {
    if (seed !== undefined && !/^[\w-]{4,32}$/.test(seed)) throw new HubError('invalid', 'avatar must be 4-32 letters, digits, "-" or "_"');
    agent.avatar = seed ?? newAvatarSeed();
    await this.agentStore.update(agent.id, { avatar: agent.avatar });
    return agent.avatar;
  }

  /** Deletes the agent, and the agents it owns (they have no life of their own). */
  async unregister(agent: AgentRecord): Promise<void> {
    const ids = await this.agentStore.deleteAgent(agent.id, !agent.ownerId);
    await this.revokeTokens?.(ids);
  }

  /**
   * Archives (or restores) a bot: hidden from every listing, unreachable by message, and its token stops
   * working until restored. Allowed for the bot itself, its owner, and an owner of any workspace it is in (so only owners can restore).
   */
  async setArchived(caller: AgentRecord, agentId: string, archived: boolean): Promise<AgentRecord> {
    const target = agentId === caller.id ? caller : await this.get(agentId);
    const owns = !!target && (target.ownerId === caller.id || isSuperAdmin(caller) || (await this.workspacesOf(target)).some((w) => isOwner(w, caller)));
    if (!target || (target.id !== caller.id && !owns)) {
      const scope = await this.visibilityScope(caller);
      if (target && this.canSeeInScope(caller, target, scope) && !target.archived) {
        throw new HubError('forbidden', 'Only the bot itself, its owner, or an owner of one of its workspaces can archive it');
      }
      throw new HubError('not_found', `No agent "${agentId}" is available to you.`);
    }
    if (target.kind === 'human') throw new HubError('invalid', 'Only bots can be archived');
    // Archiving frees a seat in each of its workspaces, so restoring takes them back (and one of the owner's bots). An admin may put one back regardless.
    if (!archived && target.archived && target.ownerId && !isSuperAdmin(caller)) {
      const owner = await this.get(target.ownerId);
      if (owner) await this.checkBotCap(owner);
      await registryWorkspaces.addWithRoom(this, await this.workspacesOf(target), { ...target, archived: false }, caller, (tx) => this.agentStore.update(target.id, { archived }, tx));
    } else {
      await this.agentStore.update(target.id, { archived });
    }
    target.archived = archived;
    return target;
  }

  // ---- workspaces ----------------------------------------------------------------------

  get workspaceCol() {
    return this.agentStore.workspaceCol;
  }

  get channelCol() {
    return this.agentStore.channelCol;
  }

  get inviteCol() {
    return this.agentStore.inviteCol;
  }

  get skillCol() {
    return this.agentStore.skillCol;
  }

  async workspaceDoc(id: string): Promise<WorkspaceRecord | undefined> {
    if (!id || id.includes('/')) return undefined;
    return withDefaultWorkspaceSkills(await this.agentStore.workspaceDoc(id));
  }

  /** A workspace by id, for server-side checks (rooms); callers check membership themselves. */
  async workspaceById(id: string): Promise<WorkspaceRecord | undefined> {
    return registryWorkspaces.workspaceById(this, id);
  }

  /** The rooms an app opened over /v1, newest first. */
  async appRooms(appId: string): Promise<WorkspaceRecord[]> {
    return registryWorkspaces.appRooms(this, appId);
  }

  /** Records a room on a workspace, or adds a side to it, atomically. */
  async updateRoom(workspaceId: string, change: (room: RoomInfo | undefined) => RoomInfo): Promise<RoomInfo> {
    return registryWorkspaces.updateRoom(this, workspaceId, change);
  }

  /** A member's side shown in a room's channel, set by the room itself (the member needn't own the channel). */
  async setRoomRole(channelId: string, memberId: string, role: string): Promise<void> {
    return registryWorkspaces.setRoomRole(this, channelId, memberId, role);
  }

  async channelDoc(id: string): Promise<ChannelRecord | undefined> {
    if (!validDocId(id)) return undefined;
    return this.agentStore.channelDoc(id);
  }

  /**
   * Creates a workspace owned by (and including) `owner`, a person.
   */
  async createWorkspace(owner: AgentRecord, name: string, opts?: { unchecked?: boolean }): Promise<WorkspaceRecord> {
    return registryWorkspaces.createWorkspace(this, owner, name, opts);
  }

  /** Participants counted against `ws`'s cap, and the cap (null: no plans, i.e. self-hosted, or a super-admin viewer). */
  async workspaceUsage(ws: WorkspaceRecord, viewer?: AgentRecord): Promise<{ count: number; max: number | null; plan: Plan }> {
    return registryWorkspaces.workspaceUsage(this, ws, viewer);
  }

  /** Refuses adding `adding` to a full `ws` (402 PLAN_LIMIT). `actor` is who asks: a super admin is never refused. */
  async assertParticipantRoom(ws: WorkspaceRecord, adding: AgentRecord | 'invite' | 'seat', actor?: AgentRecord): Promise<void> {
    return registryWorkspaces.assertParticipantRoom(this, ws, adding, actor);
  }

  /** Active non-room workspaces `owner` owns, and their cap (null: no plans or a super-admin viewer). */
  async ownedWorkspaceUsage(owner: AgentRecord, viewer?: AgentRecord): Promise<{ count: number; max: number | null; plan: Plan }> {
    return registryWorkspaces.ownedWorkspaceUsage(this, owner, viewer);
  }

  /** The workspaces `agent` belongs to. */
  async workspacesOf(agent: AgentRecord): Promise<WorkspaceRecord[]> {
    return registryWorkspaces.workspacesOf(this, agent);
  }

  /** A workspace `agent` belongs to, by id or (case-insensitive) name. */
  async resolveMemberWorkspace(agent: AgentRecord, idOrName: string): Promise<WorkspaceRecord> {
    return registryWorkspaces.resolveMemberWorkspace(this, agent, idOrName);
  }

  async requireWorkspaceMembership(agent: AgentRecord, workspaceId: string): Promise<WorkspaceRecord> {
    return registryWorkspaces.requireWorkspaceMembership(this, agent, workspaceId);
  }

  async requireWorkspaceOwner(agent: AgentRecord, workspaceId: string): Promise<WorkspaceRecord> {
    return registryWorkspaces.requireWorkspaceOwner(this, agent, workspaceId);
  }

  /** How many agents are in each workspace (archived bots included), one count query per workspace. */
  async workspaceMemberCounts(workspaceIds: string[]): Promise<Map<string, number>> {
    return registryWorkspaces.workspaceMemberCounts(this, workspaceIds);
  }

  async countMembers(field: 'workspaces' | 'channels', ids: string[]): Promise<Map<string, number>> {
    const counts = await Promise.all(ids.map(async (id) => [id, await this.agentStore.memberCount(field, id)] as const));
    return new Map(counts);
  }

  /**
   * Any member adds a person to a workspace by email: a Google-signed-in human with that email
   * joins now; otherwise a pending invite waits (30 days) for their first Google sign-in. The
   * response doesn't say which happened. (Members can still infer it: a registered person appears
   * in the member list at once instead of in pending invites. That's inherent in auto-join.)
   */
  async inviteToWorkspace(inviter: AgentRecord, workspaceIdOrName: string, rawEmail: string): Promise<WorkspaceRecord> {
    return registryWorkspaces.inviteToWorkspace(this, inviter, workspaceIdOrName, rawEmail);
  }

  /**
   * Any member adds a bot they can see (one they own, a public one, or one in a workspace they
   * share) to a workspace, by id. People are invited by email instead, so nobody is pulled into a
   * workspace without signing in.
   */
  async addToWorkspace(adder: AgentRecord, workspaceIdOrName: string, agentId: string): Promise<{ workspace: WorkspaceRecord; agent: AgentRecord }> {
    return registryWorkspaces.addToWorkspace(this, adder, workspaceIdOrName, agentId);
  }

  /** Pending invites for a workspace the caller belongs to. */
  async listWorkspaceInvites(member: AgentRecord, workspaceIdOrName: string): Promise<InviteRecord[]> {
    return registryWorkspaces.listWorkspaceInvites(this, member, workspaceIdOrName);
  }

  async revokeWorkspaceInvite(member: AgentRecord, workspaceIdOrName: string, rawEmail: string): Promise<void> {
    return registryWorkspaces.revokeWorkspaceInvite(this, member, workspaceIdOrName, rawEmail);
  }

  /**
   * Owner only. Replaces the email domains whose Google sign-ins join this workspace
   * automatically (up to 10; public mail providers are refused).
   */
  async setWorkspaceDomains(owner: AgentRecord, workspaceId: string, domains: string[]): Promise<WorkspaceRecord> {
    return registryWorkspaces.setWorkspaceDomains(this, owner, workspaceId, domains);
  }

  /** Owner only: renames a workspace (including a personal workspace). */
  async renameWorkspace(owner: AgentRecord, workspaceId: string, name: string): Promise<WorkspaceRecord> {
    return registryWorkspaces.renameWorkspace(this, owner, workspaceId, name);
  }

  /**
   * Owner only: enables or disables public mode (`public` + `publicShowcase`) on a workspace.
   * When `opts.publicChannels` is provided on enable, atomically sets those channels to `open: true` + `publicFromSeq`
   * and flips any unselected existing channels in the workspace to `open: false` (and clears `publicFromSeq`),
   * so existing internal channels are never accidentally exposed when flipping a workspace to public.
   */
  async setWorkspacePublicShowcase(
    owner: AgentRecord,
    workspaceId: string,
    publicShowcase: boolean,
    opts?: { publicChannels?: string[]; channelSeqs?: Map<string, number>; channelSeq?: (channelId: string) => Promise<number> },
  ): Promise<WorkspaceRecord> {
    return registryWorkspaces.setWorkspacePublicShowcase(this, owner, workspaceId, publicShowcase, opts);
  }

  /** Owner only: archive (or restore) a workspace. A user's last remaining active workspace cannot be archived. */
  async setWorkspaceArchived(owner: AgentRecord, workspaceId: string, archived: boolean): Promise<WorkspaceRecord> {
    return registryWorkspaces.setWorkspaceArchived(this, owner, workspaceId, archived);
  }

  async leaveWorkspace(agent: AgentRecord, workspaceId: string): Promise<void> {
    return registryWorkspaces.leaveWorkspace(this, agent, workspaceId);
  }

  /** Owner only. `member` is an agent id; it must be in the workspace. In a public workspace, removing a non-owner guest also bans them from self-rejoining. */
  async removeFromWorkspace(owner: AgentRecord, workspaceId: string, member: string): Promise<void> {
    return registryWorkspaces.removeFromWorkspace(this, owner, workspaceId, member);
  }

  /** Owner only. Makes `member` (an agent id in the workspace) a co-owner. */
  async addWorkspaceOwner(owner: AgentRecord, workspaceId: string, member: string): Promise<WorkspaceRecord> {
    return registryWorkspaces.addWorkspaceOwner(this, owner, workspaceId, member);
  }

  /** A person in zero active workspaces gets a fresh workspace so they are never orphaned. */
  async ensureHomeWorkspace(agent: AgentRecord): Promise<void> {
    return registryAuth.ensureHomeWorkspace(this, agent);
  }

  // ---- channels ------------------------------------------------------------------------

  /** Creates a channel in a workspace the creator belongs to, with the creator as its owner and first member. */
  async createChannel(creator: AgentRecord, workspaceIdOrName: string, name: string): Promise<ChannelRecord> {
    return registryChannels.createChannel(this, creator, workspaceIdOrName, name);
  }

  /** An agent's own status (set_status): kept on its record, and in a week-long log (its log on the canvas). Null clears it. */
  async setStatus(agentId: string, status: AgentStatus | null): Promise<void> {
    return registryChannels.setStatus(this, agentId, status);
  }

  /**
   * A line in an agent's day written by the hub itself, from what the agent did (posted, ran a tool, woke): its log
   * fills whether or not the agent reports its own status. Its current status is left alone.
   */
  async logActivity(agentId: string, entry: AgentStatus): Promise<void> {
    return registryChannels.logActivity(this, agentId, entry);
  }

  /** Clears an agent's status only if it's still about `conversationId` (with `wholeChannel`, any conversation in the same channel), in one transaction (a newer one stays). */
  async clearStatusIf(agentId: string, conversationId: string, wholeChannel = false): Promise<void> {
    return registryChannels.clearStatusIf(this, agentId, conversationId, wholeChannel);
  }

  /** What an agent said it was doing (kept a week), newest first, at most `limit`; only what came before `before` when it's given. */
  async statusLog(agentId: string, before: string | undefined, limit: number): Promise<AgentStatus[]> {
    return registryChannels.statusLog(this, agentId, before, limit);
  }

  /** Moves or resizes a channel's frame on the canvas: anyone in the channel arranges it (except in a public showcase workspace, where only owners may). */
  async setChannelCanvas(caller: AgentRecord, channelId: string, box: CanvasBox): Promise<ChannelRecord> {
    return registryChannels.setChannelCanvas(this, caller, channelId, box);
  }

  /** The channels `agent` is in, optionally only those of one workspace. */
  async channelsOf(agent: AgentRecord, workspaceId?: string): Promise<ChannelRecord[]> {
    return registryChannels.channelsOf(this, agent, workspaceId);
  }

  /** A workspace's open channels that `agent`, a member of it, isn't in yet: the ones it can join. */
  async joinableChannels(agent: AgentRecord, workspaceIdOrName: string): Promise<ChannelRecord[]> {
    return registryChannels.joinableChannels(this, agent, workspaceIdOrName);
  }

  /** `agent` joins an open channel of a workspace it is in, or self-joins a public+open channel in a `publicShowcase` workspace as a guest. */
  async joinChannel(agent: AgentRecord, channelId: string): Promise<ChannelRecord> {
    return registryChannels.joinChannel(this, agent, channelId);
  }

  /** Public metadata and public+open channels for a public workspace (anyone, signed in or not). */
  async publicWorkspace(workspaceId: string): Promise<{ workspace: WorkspaceRecord; channels: ChannelRecord[] }> {
    return registryWorkspaces.publicWorkspace(this, workspaceId);
  }

  /** Signed-in human self-joins a public workspace as a guest, entering its public+open channels. */
  async joinPublicWorkspace(agent: AgentRecord, workspaceId: string): Promise<{ workspace: WorkspaceRecord; channels: ChannelRecord[] }> {
    return registryWorkspaces.joinPublicWorkspace(this, agent, workspaceId);
  }

  /** How many agents are in each channel (archived bots included), one count query per channel. */
  async channelMemberCounts(channelIds: string[]): Promise<Map<string, number>> {
    return registryChannels.channelMemberCounts(this, channelIds);
  }

  /**
   * A channel `agent` is in, by id or (case-insensitive) name; `workspace` (id or name) narrows a
   * name shared across workspaces.
   */
  async resolveMemberChannel(agent: AgentRecord, idOrName: string, workspace?: string): Promise<ChannelRecord> {
    return registryChannels.resolveMemberChannel(this, agent, idOrName, workspace);
  }

  /**
   * Any channel member adds a member of the channel's workspace (a person or a bot) to the channel,
   * by id. Agents outside the workspace are added to the workspace first.
   */
  async addToChannel(adder: AgentRecord, channelIdOrName: string, agentId: string, workspace?: string): Promise<{ channel: ChannelRecord; agent: AgentRecord }> {
    return registryChannels.addToChannel(this, adder, channelIdOrName, agentId, workspace);
  }

  async leaveChannel(agent: AgentRecord, channelId: string): Promise<void> {
    return registryChannels.leaveChannel(this, agent, channelId);
  }

  /** Channel or workspace owner only. `member` is an agent id; it must be in the channel. In a public workspace, removing a non-owner guest also bans them from self-rejoining that channel. */
  async removeFromChannel(owner: AgentRecord, channelId: string, member: string): Promise<void> {
    return registryChannels.removeFromChannel(this, owner, channelId, member);
  }

  /** Channel or workspace owner only. Makes `member` (an agent id in the channel) a co-owner. */
  async addChannelOwner(owner: AgentRecord, channelId: string, member: string): Promise<ChannelRecord> {
    return registryChannels.addChannelOwner(this, owner, channelId, member);
  }

  /** Channel or workspace owner only: rename the channel and/or archive (or restore) it. */
  async updateChannel(
    owner: AgentRecord,
    channelId: string,
    changes: { name?: string; archived?: boolean; open?: boolean; publicFromSeq?: number | null; context?: string },
  ): Promise<ChannelRecord> {
    return registryChannels.updateChannel(this, owner, channelId, changes);
  }

  /** Channel or workspace owner: anyone can read this post's thread (and its files), or not anymore. */
  async setThreadPublic(owner: AgentRecord, channelId: string, post: string, pub: boolean): Promise<ChannelRecord> {
    return registryChannels.setThreadPublic(this, owner, channelId, post, pub);
  }

  /** Thread starter (or a bot owned by the thread starter) or channel/workspace owner: marks a post's thread as done (or reopens it). */
  async setThreadDone(caller: AgentRecord, channelId: string, post: string, postAuthorId: string, done: boolean): Promise<ChannelRecord> {
    return registryChannels.setThreadDone(this, caller, channelId, post, postAuthorId, done);
  }

  /** Clears a thread's done state when a human replies in it (auto-reopen). */
  async clearThreadDone(channelId: string, post: string): Promise<void> {
    return registryChannels.clearThreadDone(this, channelId, post);
  }

  /**
   * Channel or workspace owner (a person or a bot): sets `memberId`'s role in the channel, or clears it
   * with an empty role. Membership is read in the same transaction, so a concurrent removal can't
   * leave a role behind for someone no longer in the channel.
   */
  async setChannelRole(owner: AgentRecord, channelId: string, memberId: string, role: string): Promise<ChannelRecord> {
    return registryChannels.setChannelRole(this, owner, channelId, memberId, role);
  }

  /** Members' roles in a channel, for a viewer who may read it (a member, or someone who can manage it); otherwise none. */
  async channelRolesFor(viewer: AgentRecord | undefined, channelId: string): Promise<Record<string, string> | undefined> {
    return registryChannels.channelRolesFor(this, viewer, channelId);
  }

  /** The channels with these ids (missing ones skipped), one batched read: for showing roles on delivered messages. */
  async channelsById(ids: string[]): Promise<Map<string, ChannelRecord>> {
    return registryChannels.channelsById(this, ids);
  }

  async requireChannelMembership(agent: AgentRecord, channelId: string): Promise<ChannelRecord> {
    return registryChannels.requireChannelMembership(this, agent, channelId);
  }

  /** The channel, if `agent` has owner rights on it or on its workspace. Super admins need no membership. */
  async requireChannelOwner(agent: AgentRecord, channelId: string): Promise<ChannelRecord> {
    return registryChannels.requireChannelOwner(this, agent, channelId);
  }

  // ---- skills & processes (first-class objects) ----------------------------------------

  async createSkill(
    owner: AgentRecord,
    input: registrySkills.CreateSkillInput,
  ): Promise<SkillRecord> {
    return registrySkills.createSkill(this, owner, input);
  }

  async updateSkill(
    caller: AgentRecord,
    skillId: string,
    changes: registrySkills.UpdateSkillChanges,
  ): Promise<SkillRecord> {
    return registrySkills.updateSkill(this, caller, skillId, changes);
  }

  async deleteSkill(caller: AgentRecord, skillId: string): Promise<{ ok: true; deleted: string }> {
    return registrySkills.deleteSkill(this, caller, skillId);
  }

  async getSkill(id: string): Promise<SkillRecord | undefined> {
    return registrySkills.getSkill(this, id);
  }

  async requireSkill(id: string): Promise<SkillRecord> {
    return registrySkills.requireSkill(this, id);
  }

  async requireAccessibleSkill(caller: AgentRecord, id: string): Promise<SkillRecord> {
    return registrySkills.requireAccessibleSkill(this, caller, id);
  }

  async canAccessSkill(caller: AgentRecord, skill: SkillRecord): Promise<boolean> {
    return registrySkills.canAccessSkill(this, caller, skill);
  }

  async resolveProcessSteps(
    viewer: AgentRecord | undefined,
    steps: SkillRecord['steps'],
    capChars?: number,
  ): Promise<{ steps: SurfacedProcessStep[]; truncated: boolean }> {
    return registrySkillResolve.resolveProcessSteps(this, viewer, steps, capChars);
  }

  async skillsById(ids: string[]): Promise<SkillRecord[]> {
    return registrySkillResolve.skillsById(this, ids);
  }

  async attachSkill(
    caller: AgentRecord,
    scope: SkillScope,
    id: string,
    skillId: string,
  ): Promise<{ scope: SkillScope; id: string; attachedSkills: string[]; detachedSkills?: string[] }> {
    return registrySkills.attachSkill(this, caller, scope, id, skillId);
  }

  async detachSkill(
    caller: AgentRecord,
    scope: SkillScope,
    id: string,
    skillId: string,
  ): Promise<{ scope: SkillScope; id: string; attachedSkills: string[]; detachedSkills?: string[] }> {
    return registrySkills.detachSkill(this, caller, scope, id, skillId);
  }

  async listSkills(caller: AgentRecord, opts: { scope?: SkillScope; id?: string; type?: SkillType } = {}): Promise<SkillRecord[]> {
    return registrySkillResolve.listSkills(this, caller, opts);
  }

  async resolveAttachedSkills(opts: {
    agent?: AgentRecord;
    agentId?: string;
    channel?: ChannelRecord | null;
    channelId?: string;
    workspace?: WorkspaceRecord | null;
    workspaceId?: string;
  }): Promise<SkillSummary[]> {
    return registrySkillResolve.resolveAttachedSkills(this, opts);
  }

  async mySkillsCatalog(caller: AgentRecord, opts: { type?: SkillType } = {}) {
    return registrySkillResolve.mySkillsCatalog(this, caller, opts);
  }

  async enrichSkillRecord(caller: AgentRecord, skill: SkillRecord) {
    return registrySkillResolve.enrichSkillRecord(this, caller, skill);
  }

  async scopeEffectiveSkills(
    caller: AgentRecord,
    scope: SkillScope,
    id: string,
    opts: { workspaceId?: string; channelId?: string; type?: SkillType } = {},
  ) {
    return registrySkillResolve.scopeEffectiveSkills(this, caller, scope, id, opts);
  }
}

function matchesSkill(k: AgentSkillInfo, s: string): boolean {
  return k.id.toLowerCase() === s || k.name.toLowerCase() === s || (k.tags ?? []).some((t) => t.toLowerCase() === s);
}
