import { randomBytes } from 'node:crypto';
import { toMillis } from '../db/types.js';
import { HubError, PlanLimitError } from '../lib/errors.js';
import { domainOf, FREE_MAIL_DOMAINS } from '../lib/domains.js';
import { BoundedMap } from '../lib/boundedMap.js';
import { cleanName } from './fields.js';
import { hashPassword, MAX_PASSWORD, MIN_PASSWORD, verifyPassword } from './password.js';
import { sameSecret } from '../lib/sealing.js';
import type { GoogleProfile } from './google.js';
import type { AgentRecord } from './types.js';
import {
  hashToken,
  MAX_NAME,
  normalizeEmail,
  type Registry,
} from './registry.js';
import * as registryWorkspaces from './workspaces.js';

const MAX_SESSIONS = 10;
const STALE_CLAIM_MS = 10 * 60_000;
const AUTH_CACHE_MS = 15_000;

// Token hash -> its agent's id, so a repeat request reads one doc by id instead of running two queries.
// Only the id is kept: the record is re-read and the hash re-checked on every hit, so rotate, revoke, archive,
// delete and workspace changes all take effect at once on every instance, with no invalidation to forget.
// ponytail: 10k entries, then the oldest goes; a hit still costs 1 doc read (caching the record would make it 0 but serve stale workspaces/channels).
const authIds = new BoundedMap<string, { id: string; until: number }>(10_000);

export function isSignedInPerson(agent: AgentRecord | undefined): boolean {
  return !!agent && agent.kind === 'human' && (!!agent.googleSub || !!agent.githubId || !!agent.passwordHash);
}

function checkPassword(password: unknown): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
    throw new HubError('invalid', `A password needs ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
}

export function newAgentToken(): string {
  return `a2ah_${randomBytes(32).toString('base64url')}`;
}

/** Resolves a token to its agent: the main token, or a web sign-in session token. */
export async function authenticate(registry: Registry, token: string): Promise<AgentRecord | undefined> {
  if (!token.startsWith('a2ah_')) return undefined;
  const hash = hashToken(token);
  const cached = authIds.get(hash);
  if (cached && cached.until > Date.now()) {
    const agent = await registry.authStore.agent(cached.id);
    if (!agent || (agent.tokenHash !== hash && !agent.sessionHashes?.includes(hash))) {
      authIds.delete(hash);
      return undefined;
    }
    if (agent.archived) throw new HubError('forbidden', 'This bot is archived. An owner of one of its workspaces can restore it.');
    registry.touchInBackground(agent);
    return agent;
  }
  // Both at once: a web sign-in session (sessionHashes) used to wait for the main-token lookup to come back empty.
  const { main, session } = await registry.authStore.byTokenHash(hash);
  const agent = main ?? session;
  if (agent?.archived) throw new HubError('forbidden', 'This bot is archived. An owner of one of its workspaces can restore it.');
  if (agent) {
    authIds.set(hash, { id: agent.id, until: Date.now() + AUTH_CACHE_MS });
    registry.touchInBackground(agent);
  }
  return agent;
}

/**
 * Signs a person in with a Google credential: finds their human agent by Google account or
 * verified email, or creates one; applies pending invites and the workspaces that take their
 * email domain; makes them a workspace of their own if they still have none; and returns a new
 * session token. The main token is untouched, so MCP clients using it stay signed in.
 */
export async function signInWithGoogle(
  registry: Registry,
  idToken: string,
  clientIp?: string,
): Promise<{ agent: AgentRecord; token: string; created: boolean }> {
  if (!registry.verifyGoogle) throw new HubError('unsupported', 'Google sign-in is not configured on this hub');
  if (clientIp) await registry.googleLimiter?.hit(clientIp);
  const profile = await registry.verifyGoogle(String(idToken ?? ''));
  const { agent, created } = await registry.personFor(profile, clientIp);
  const token = await newSession(registry, agent);
  await applyInvites(registry, agent, created);
  await applyDomainJoins(registry, agent, created);
  await registry.ensureHomeWorkspace(agent);
  return { agent, token, created };
}

/**
 * The person a verified Google profile belongs to: found by Google account or verified email,
 * or created. Pending invites are applied by the caller (sign-in).
 */
export async function personFor(registry: Registry, verified: GoogleProfile, clientIp?: string): Promise<{ agent: AgentRecord; created: boolean }> {
  const profile = { ...verified, email: normalizeEmail(verified.email) };
  let agent = await findPerson(registry, profile);
  let created = false;
  if (!agent) {
    agent = await createGoogleHuman(registry, profile.email, profile.name, clientIp);
    created = true;
  }
  if (!created && !agent.googleSub) {
    // A password record for this email was never proven. Google takes it over.
    agent.passwordHash = undefined;
    agent.sessionHashes = [];
    agent.tokenHash = hashToken(newAgentToken());
    await registry.authStore.dropPassword(agent.id, { tokenHash: agent.tokenHash });
    // Its bots act with the owner's skills and apps: archive them, with new tokens so a restore doesn't revive the old ones.
    const bots = await registry.botsOf(agent);
    if (bots.length) await registry.authStore.archiveBots(bots.map((bot) => ({ id: bot.id, tokenHash: hashToken(newAgentToken()) })));
    await registry.revokeTokens?.([agent.id, ...bots.map((b) => b.id)]);
  }
  if (agent.googleSub !== profile.sub || agent.email !== profile.email) {
    agent.googleSub = profile.sub;
    agent.email = profile.email;
    await registry.authStore.update(agent.id, { googleSub: profile.sub, email: profile.email });
  }
  return { agent, created };
}

/** Self-hosted: signs in with email + password. Wrong email and wrong password get the same answer. */
export async function signInWithPassword(registry: Registry, rawEmail: string, password: string, clientIp?: string): Promise<{ agent: AgentRecord; token: string; created: boolean }> {
  await requirePasswordLogin(registry, clientIp);
  const email = normalizeEmail(String(rawEmail ?? ''));
  // Per account too: a self-hosted hub's client IP comes from X-Forwarded-For, which a client can vary.
  await registry.googleLimiter?.hit(`password:${email}`);
  const agent = await registry.authStore.findBy('email', email);
  const ok = await verifyPassword(String(password ?? ''), agent?.kind === 'human' ? agent.passwordHash : undefined);
  if (!agent || !ok) throw new HubError('unauthorized', 'Wrong email or password');
  await onboardPasswordPerson(registry, agent, false);
  return { agent, token: await newSession(registry, agent), created: false };
}

/** Self-hosted: the first owner, once, with the setup secret the installer printed. */
export async function setupOwner(registry: Registry, input: { setupSecret?: string; email?: string; name?: string; password?: string }, clientIp?: string) {
  const { setupSecret } = await requirePasswordLogin(registry, clientIp);
  if (!sameSecret(String(input.setupSecret ?? '').trim(), setupSecret)) throw new HubError('forbidden', 'Wrong setup secret');
  const email = normalizeEmail(String(input.email ?? ''));
  checkPassword(input.password);
  // Exactly once: the marker's create() fails for a second setup, even a concurrent one.
  await claim(registry, 'owner', { email });
  try {
    return await createPasswordPerson(registry, email, input.name, input.password!, clientIp);
  } catch (err) {
    // Nobody was made: release the marker so setup can be tried again. Once the owner's account exists it stays
    // claimed, and their sign-in finishes onboarding.
    if (!(err as { accountCommitted?: boolean }).accountCommitted) await registry.authStore.releaseClaim('owner');
    throw err;
  }
}

/** Self-hosted: anyone signs up with email + password. */
export async function signUpWithPassword(registry: Registry, input: { email?: string; name?: string; password?: string }, clientIp?: string) {
  await requirePasswordLogin(registry, clientIp);
  const email = normalizeEmail(String(input.email ?? ''));
  checkPassword(input.password);
  return createPasswordPerson(registry, email, input.name, input.password!, clientIp);
}

/** Sets a person's password from the host (`npm run reset-password`): there is no email to reset it by. */
export async function resetPassword(registry: Registry, rawEmail: string, password: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  checkPassword(password);
  const agent = await registry.authStore.findBy('email', email);
  if (agent?.kind !== 'human') throw new HubError('not_found', `No person with email ${email}`);
  // Signs out every web session: whoever knew the old password is out.
  await registry.authStore.update(agent.id, { passwordHash: await hashPassword(password), sessionHashes: [] });
}

async function requirePasswordLogin(registry: Registry, clientIp?: string): Promise<{ setupSecret: string }> {
  if (!registry.passwordLogin) throw new HubError('unsupported', 'Password sign-in is not enabled on this hub');
  if (clientIp) await registry.googleLimiter?.hit(clientIp);
  return registry.passwordLogin;
}

/**
 * The email's marker. One left by a sign-up that died before making the person (no account has this email, and
 * it's older than STALE_CLAIM_MS) is taken over, so that email isn't stuck.
 */
async function claimEmail(registry: Registry, email: string): Promise<void> {
  try {
    await claim(registry, `email:${email}`, {});
  } catch (err) {
    if (!(err instanceof HubError && err.code === 'conflict')) throw err;
    // In a transaction: of two concurrent takeovers, the second sees the first's fresh claim and stops.
    const taken = await registry.authStore.retakeClaim(
      `email:${email}`,
      email,
      (claim, someoneHasEmail) => {
        const at = Date.parse(String(claim?.at ?? ''));
        return !(someoneHasEmail || !(Date.now() - at > STALE_CLAIM_MS));
      },
      () => new Date().toISOString(),
    );
    if (!taken) throw err;
  }
}

/** One email, one account: a marker doc whose create() fails if it exists. */
async function claim(registry: Registry, key: string, data: Record<string, unknown>): Promise<void> {
  try {
    await registry.authStore.createClaim(key, { ...data, at: new Date().toISOString() });
  } catch (err) {
    if ((err as { code?: number }).code === 6) throw new HubError('conflict', key === 'owner' ? 'This Parly already has an owner. Sign in instead.' : 'An account with this email exists. Sign in instead.');
    throw err;
  }
}

async function createPasswordPerson(registry: Registry, email: string, name: string | undefined, password: string, clientIp?: string) {
  await claimEmail(registry, email);
  const release = () => registry.authStore.releaseClaim(`email:${email}`);
  let agent: AgentRecord;
  try {
    if (await registry.authStore.findBy('email', email)) throw new HubError('conflict', 'An account with this email exists. Sign in instead.');
    const display = name?.trim() || email;
    // Created with its email in the same write, so an interrupted sign-up is still found by reset-password.
    agent = (
      await registry.register({ name: (cleanName(display) || 'user').slice(0, MAX_NAME), description: display, kind: 'human' }, undefined, clientIp, undefined, true, async (a) => {
        a.email = email;
      })
    ).agent;
  } catch (err) {
    // No account was made (or one already existed without the claim): free the email for a retry.
    if (!(err instanceof HubError && err.code === 'conflict')) await release();
    throw err;
  }
  agent.email = email;
  agent.passwordHash = await hashPassword(password);
  // The account exists from here (it can sign in); onboarding below that fails is finished at the next sign-in.
  await registry.authStore.update(agent.id, { email, passwordHash: agent.passwordHash });
  try {
    await onboardPasswordPerson(registry, agent, true);
    return { agent, token: await newSession(registry, agent), created: true };
  } catch (err) {
    throw Object.assign(err as object, { accountCommitted: true });
  }
}

/** What every sign-in makes sure of (as Google sign-in does): a home workspace. Workspace invites and domain joins need Google. */
async function onboardPasswordPerson(registry: Registry, agent: AgentRecord, created = false): Promise<void> {
  await applyInvites(registry, agent, created);
  await registry.ensureHomeWorkspace(agent);
}

async function newSession(registry: Registry, agent: AgentRecord): Promise<string> {
  const token = newAgentToken();
  agent.sessionHashes = await registry.authStore.setSessions(agent.id, (current) => {
    if (!current || current.archived) throw new HubError('forbidden', 'This account is unavailable');
    return [...(current.sessionHashes ?? []), hashToken(token)].slice(-MAX_SESSIONS);
  });
  return token;
}

/** The person with this Google account, or else this email. */
async function findPerson(registry: Registry, profile: GoogleProfile): Promise<AgentRecord | undefined> {
  const email = normalizeEmail(profile.email);
  return (
    (await registry.authStore.findBy('googleSub', profile.sub)) ??
    (await registry.authStore.findBy('email', email))
  );
}

// ponytail: two first-time sign-ins racing for one email could create two agents; add a unique `emails` doc if that ever matters
async function createGoogleHuman(registry: Registry, email: string, displayName: string, clientIp?: string): Promise<AgentRecord> {
  const name = (cleanName(displayName) || email.split('@')[0] || 'user').slice(0, MAX_NAME);
  // Counts against the per-IP registration limit, like any new identity.
  return (await registry.register({ name, description: displayName, kind: 'human' }, undefined, clientIp, undefined, true)).agent;
}

/** Revokes a web sign-in session token (the main token is revoked with rotateToken instead). */
export async function revokeSession(registry: Registry, agent: AgentRecord, token: string): Promise<void> {
  const hash = hashToken(token);
  if (!(agent.sessionHashes ?? []).includes(hash)) return;
  agent.sessionHashes = (agent.sessionHashes ?? []).filter((h) => h !== hash);
  await registry.authStore.removeSession(agent.id, hash);
}

/**
 * Issues a new token for a bot; the old one, and any OAuth sign-in acting as it, stop working
 * immediately. People have no token of their own: they sign in with Google, and their tools
 * act as their bots.
 */
export async function rotateToken(registry: Registry, agent: AgentRecord): Promise<string> {
  if (agent.kind === 'human') throw new HubError('forbidden', 'People sign in with Google; tokens are for bots. Make one on the Connect page.');
  const token = newAgentToken();
  agent.tokenHash = hashToken(token);
  await registry.authStore.update(agent.id, { tokenHash: agent.tokenHash });
  await registry.revokeTokens?.([agent.id]);
  return token;
}

/** Joins every workspace with a live invite for the agent's email, then deletes those invites. Google accounts only: a password account's email is unproven. */
async function applyInvites(registry: Registry, agent: AgentRecord, created = false): Promise<void> {
  if (!agent.email || !agent.googleSub) return;
  const invites = await registry.authStore.invitesFor(agent.email);
  if (invites.length === 0) return;
  const now = Date.now();
  const live = invites.map(([, i]) => i).filter((i) => toMillis(i.expiresAt) > now);
  live.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  // Free caps workspaces joined too: take the oldest invites that fit, the rest stay pending for a later sign-in.
  // ponytail: room is read outside the accept, so two concurrent sign-ins could overshoot by one; transact if that matters.
  const room = await registryWorkspaces.joinRoom(registry, agent);
  const mine = new Set(agent.workspaces ?? []);
  const workspaceIds = [...new Set(live.map((i) => i.workspaceId))].filter((id) => !mine.has(id)).slice(0, room);
  const accepted = new Set([...workspaceIds, ...mine]);
  // Someone new who came by an invite: the first inviter is who brought them (referral credits, see LlmMeter).
  const first = live[0];
  let referredBy: string | undefined;
  if (created && first?.invitedBy && first.invitedBy !== agent.id && !agent.referredBy) {
    referredBy = first.invitedBy;
    agent.referredBy = first.invitedBy;
  }
  const done = invites.filter(([, i]) => toMillis(i.expiresAt) <= now || accepted.has(i.workspaceId)).map(([id]) => id);
  await registry.authStore.acceptInvites(agent.id, workspaceIds, referredBy, done);
  agent.workspaces = [...new Set([...(agent.workspaces ?? []), ...workspaceIds])];
}

/** Joins every workspace that takes the agent's email domain (never a public mail provider). Idempotent; runs on every sign-in. */
async function applyDomainJoins(registry: Registry, agent: AgentRecord, created = false): Promise<void> {
  if (!agent.email || !agent.googleSub) return;
  const domain = domainOf(agent.email);
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return;
  const matches = await registry.authStore.workspacesWithDomain(domain);
  for (const [id, data] of matches) {
    const ws = { ...data, id };
    if (ws.archived || (agent.workspaces ?? []).includes(ws.id) || (ws.bannedAgents ?? []).includes(agent.id)) continue;
    // ponytail: one owner read per matching workspace; few workspaces share a domain.
    if (!(await registryWorkspaces.verifiedOwnerDomains(registry, ws)).has(domain)) continue;
    // Seat check, membership, payer link and referral commit together, so concurrent joins can't overshoot the cap.
    const refer = created && ws.ownerId && ws.ownerId !== agent.id && !agent.referredBy ? { referredBy: ws.ownerId } : {};
    // Joining by company domain links the person to that workspace's credit pool (billing/payer.ts); invited outsiders aren't linked.
    // ponytail: first matching workspace wins when several share the domain; let the person pick if that happens.
    const link = agent.billingAccountId ? {} : { billingAccountId: ws.id };
    try {
      await registryWorkspaces.addWithRoom(registry, [ws], agent, undefined, async (tx) => {
        await registry.workspaceStore.addAgentToWorkspace(agent.id, ws.id, false, tx);
        if (refer.referredBy || link.billingAccountId) await registry.agentStore.update(agent.id, { ...refer, ...link }, tx);
      });
    } catch (e) {
      if (e instanceof PlanLimitError) continue; // A full workspace is skipped silently.
      throw e;
    }
    if (refer.referredBy) agent.referredBy = refer.referredBy;
    if (link.billingAccountId) agent.billingAccountId = link.billingAccountId;
    agent.workspaces = [...(agent.workspaces ?? []), ws.id];
  }
}

/** A person in zero active workspaces gets a fresh workspace so they are never orphaned. */
export async function ensureHomeWorkspace(registry: Registry, agent: AgentRecord): Promise<void> {
  const active = (await registry.workspacesOf(agent)).filter((w) => !w.archived && !w.room);
  if (active.length > 0) return;
  await registry.createWorkspace(agent, registryWorkspaces.homeWorkspaceName(agent.name), { unchecked: true });
}
