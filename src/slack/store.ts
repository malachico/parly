import type { SlackLink, SlackCopy } from '../lib/bridgeTypes.js';
export type { SlackLink, SlackCopy } from '../lib/bridgeTypes.js';
import { randomBytes } from 'node:crypto';
import { COLLECTIONS, FieldValue, toMillis, type Database } from '../db/types.js';
import {
  BridgeQueue,
  LINK_CODE_RE,
  claimBridgeEvent,
  keepBridgeEvent,
  queueBridgeOut,
} from '../lib/bridge.js';
import { HubError } from '../lib/errors.js';
import { seal, unseal } from '../lib/sealing.js';
import type { MessageDoc } from '../chat/chat.js';

/** Slack errors meaning the installation no longer works: syncing stops until it's reconnected. */
export const INSTALL_GONE = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'team_access_not_granted']);

/**
 * The Slack bridge's records (see PLAN-SLACK.md). Parly stays the source of truth: these only say which Slack
 * workspace serves which Parly workspace, which Slack channel mirrors which Parly channel, who a Slack user is
 * here, and where each message's copies are in Slack.
 */

/** `slack_installs/{teamId}`: the Parly Slack app installed in one Slack workspace. */
export interface SlackInstall {
  teamId: string;
  teamName: string;
  /** The Parly workspace it serves (a room's workspace, for a room side). */
  workspaceId: string;
  /** For a shared room: the side this Slack workspace is. */
  sideId?: string;
  botUserId: string;
  /** The bot token, sealed with CREDENTIALS_KEY. Read it with SlackStore.botToken. */
  sealedToken: string;
  /** The Parly person who installed it. */
  installedBy: string;
  at: string;
  /** Why syncing stopped (token revoked, app uninstalled): shown to the workspace's owners until it's reconnected. */
  problem?: string;
}



/** `slack_identities/{teamId}:{slackUserId}`: who a Slack user is on Parly, once they approved it there. */
interface SlackIdentity {
  teamId: string;
  slackUserId: string;
  /** The Parly person. */
  agentId: string;
  at: string;
}

/** A Parly message to post in one linked Slack channel (the outbox). */
export interface SlackOut {
  messageId: string;
  teamId: string;
  channelId: string;
  /** The Parly channel it was posted in; empty for a DM. */
  parlyChannelId: string;
  /** For a DM: whose Slack DM it is, checked again right before posting (they may have unlinked since). */
  dm?: { slackUserId: string; personId: string };
}

export const outKey = (j: Pick<SlackOut, 'messageId' | 'teamId' | 'channelId'>) => `${j.messageId}:${j.teamId}:${j.channelId}`;

/** The key of a Slack message, unique across Slack: a `ts` is unique only within its channel. */
export const slackKey = (c: SlackCopy) => `${c.teamId}:${c.channelId}:${c.ts}`;

export interface SlackUserPayload {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string; email?: string; image_192?: string; image_72?: string };
}

export function extractSlackUserName(u: SlackUserPayload | undefined): string | undefined {
  return u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || undefined;
}

// Its event inbox and outbox are BridgeQueue's (lib/bridge.ts):
// ponytail: scans the not-done events; an index on (done, at) when there are many
// ponytail: reads up to 100 due posts a sweep; more often, or a bigger page, if Slack gets busy
export class SlackStore extends BridgeQueue<SlackOut> {
  constructor(
    db: Database,
    private readonly sealingKey?: Buffer,
  ) {
    super(db, COLLECTIONS.slackEvents, COLLECTIONS.slackOutbox);
  }

  private get installs() {
    return this.db.collection(COLLECTIONS.slackInstalls);
  }

  /** Stores (or replaces) an installation; the token is sealed here and never stored in the clear. */
  async saveInstall(install: Omit<SlackInstall, 'sealedToken' | 'at'>, botToken: string): Promise<SlackInstall> {
    if (!this.sealingKey) throw new HubError('unavailable', "This hub can't store a Slack token safely (no CREDENTIALS_KEY is set)");
    const record: SlackInstall = { ...install, sealedToken: seal(botToken, this.sealingKey), at: new Date().toISOString() };
    await this.installs.doc(install.teamId).set(record);
    return record;
  }

  async install(teamId: string): Promise<SlackInstall | undefined> {
    return (await this.installs.doc(teamId).get()).data() as SlackInstall | undefined;
  }

  /** The installations serving a Parly workspace (one, or one per side for a room). */
  async installsFor(workspaceId: string): Promise<SlackInstall[]> {
    return (await this.installs.where('workspaceId', '==', workspaceId).get()).docs.map((d) => d.data() as SlackInstall);
  }

  botToken(install: SlackInstall): string {
    if (!this.sealingKey) throw new Error("this hub has no CREDENTIALS_KEY to open the Slack token");
    return unseal(install.sealedToken, this.sealingKey);
  }

  /** Stops syncing an installation, and says why to its workspace's owners. */
  async setProblem(teamId: string, problem: string): Promise<void> {
    await this.installs.doc(teamId).update({ problem });
  }

  async removeInstall(teamId: string): Promise<void> {
    await this.installs.doc(teamId).delete();
  }

  async identity(teamId: string, slackUserId: string): Promise<SlackIdentity | undefined> {
    return (await this.db.collection(COLLECTIONS.slackIdentities).doc(`${teamId}:${slackUserId}`).get()).data() as SlackIdentity | undefined;
  }

  /** Records who a Slack user is on Parly: only after that person approved it on Parly (a one-time link). */
  async linkIdentity(teamId: string, slackUserId: string, agentId: string): Promise<SlackIdentity> {
    const identity: SlackIdentity = { teamId, slackUserId, agentId, at: new Date().toISOString() };
    await this.db.collection(COLLECTIONS.slackIdentities).doc(`${teamId}:${slackUserId}`).set(identity);
    return identity;
  }

  async unlinkIdentity(teamId: string, slackUserId: string): Promise<void> {
    await this.db.collection(COLLECTIONS.slackIdentities).doc(`${teamId}:${slackUserId}`).delete();
  }

  /**
   * Mirrors a Parly channel to a Slack channel: `channel.slack` gets the link, and `slack_links/{teamId}:{channelId}`
   * says which Parly channel a Slack channel feeds. A Slack channel feeds one Parly channel.
   */
  async linkChannel(parlyChannelId: string, link: SlackLink): Promise<void> {
    const ref = this.db.collection(COLLECTIONS.slackLinks).doc(`${link.teamId}:${link.channelId}`);
    const channel = this.db.collection(COLLECTIONS.channels).doc(parlyChannelId);
    // One transaction: the channel's links and the reverse lookup never disagree.
    await this.db.runTransaction(async (tx) => {
      const [taken, current] = await Promise.all([tx.get(ref), tx.get(channel)]);
      const other = (taken.data() as { parlyChannelId?: string } | undefined)?.parlyChannelId;
      if (other && other !== parlyChannelId) throw new HubError('conflict', 'That Slack channel is already linked to another Parly channel');
      const links = ((current.data()?.slack as SlackLink[] | undefined) ?? []).filter((l) => !(l.teamId === link.teamId && l.channelId === link.channelId));
      tx.update(channel, { slack: [...links, link] });
      tx.set(ref, { ...link, parlyChannelId });
    });
  }

  async unlinkChannel(parlyChannelId: string, link: Pick<SlackLink, 'teamId' | 'channelId'>): Promise<void> {
    const channel = this.db.collection(COLLECTIONS.channels).doc(parlyChannelId);
    await this.db.runTransaction(async (tx) => {
      const links = (((await tx.get(channel)).data()?.slack as SlackLink[] | undefined) ?? []).filter((l) => !(l.teamId === link.teamId && l.channelId === link.channelId));
      tx.update(channel, { slack: links });
      tx.delete(this.db.collection(COLLECTIONS.slackLinks).doc(`${link.teamId}:${link.channelId}`));
    });
  }

  /** Pauses (or resumes) a link, on the Parly channel and in the reverse lookup alike. */
  async setPaused(parlyChannelId: string, link: Pick<SlackLink, 'teamId' | 'channelId'>, paused: boolean): Promise<void> {
    const channel = this.db.collection(COLLECTIONS.channels).doc(parlyChannelId);
    const ref = this.db.collection(COLLECTIONS.slackLinks).doc(`${link.teamId}:${link.channelId}`);
    await this.db.runTransaction(async (tx) => {
      const [current, lookup] = await Promise.all([tx.get(channel), tx.get(ref)]);
      if (!lookup.exists) return; // unlinked meanwhile
      const links = ((current.data()?.slack as SlackLink[] | undefined) ?? []).map(({ paused: was, ...l }) =>
        l.teamId === link.teamId && l.channelId === link.channelId ? (paused ? { ...l, paused: true } : l) : was ? { ...l, paused: true } : l,
      );
      tx.update(channel, { slack: links });
      tx.update(ref, { paused: paused ? true : FieldValue.delete() });
    });
  }

  /** The Parly channel a Slack channel feeds, with its link (side), or undefined when it isn't linked. */
  async linkedChannel(teamId: string, channelId: string): Promise<(SlackLink & { parlyChannelId: string }) | undefined> {
    return (await this.db.collection(COLLECTIONS.slackLinks).doc(`${teamId}:${channelId}`).get()).data() as (SlackLink & { parlyChannelId: string }) | undefined;
  }

  /**
   * Keeps a Slack event before Slack is told it arrived: false when it was kept already (Slack retries a delivery
   * it thinks failed). Kept events are handled right away and, if that fails, by the sweep (pendingEvents).
   */
  async keepEvent(eventId: string, envelope: unknown): Promise<boolean> {
    return keepBridgeEvent(this.db, COLLECTIONS.slackEvents, eventId, { envelope });
  }

  /**
   * Takes a kept event to handle it: undefined when it was handled already, or when another handler took it in
   * the last minute (the first try and the sweep must not both post it). A handler that died loses it after that.
   */
  async claimEvent(eventId: string, now = Date.now()): Promise<{ envelope: unknown; attempts: number } | undefined> {
    const data = await claimBridgeEvent<{ envelope: unknown }>(this.db, COLLECTIONS.slackEvents, eventId, now);
    return data ? { envelope: data.envelope, attempts: data.attempts } : undefined;
  }

  /**
   * A one-time code for a Slack user to link themselves to their Parly account (10 minutes). Undefined when one
   * was made for them in the last hour, so a busy channel doesn't prompt them on every message.
   */
  async linkCode(teamId: string, slackUserId: string, now = Date.now()): Promise<string | undefined> {
    const prompted = this.db.collection(COLLECTIONS.slackLinkCodes).doc(`prompt:${teamId}:${slackUserId}`);
    const last = (await prompted.get()).data() as { at?: number } | undefined;
    if (last?.at && now - last.at < 60 * 60_000) return undefined;
    const code = randomBytes(18).toString('base64url');
    await this.db.collection(COLLECTIONS.slackLinkCodes).doc(code).set({ teamId, slackUserId, expiresAt: new Date(now + 10 * 60_000) });
    await prompted.set({ at: now, expiresAt: new Date(now + 60 * 60_000) });
    return code;
  }

  /** Spends a link code: who it was made for, or undefined when it's unknown, spent or expired. */
  async spendLinkCode(code: string, now = Date.now()): Promise<{ teamId: string; slackUserId: string } | undefined> {
    if (!LINK_CODE_RE.test(code)) return undefined;
    const ref = this.db.collection(COLLECTIONS.slackLinkCodes).doc(code);
    return this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as { teamId: string; slackUserId: string; expiresAt?: Date | { toMillis(): number } } | undefined;
      if (!data) return undefined;
      tx.delete(ref);
      return toMillis(data.expiresAt) > now ? { teamId: data.teamId, slackUserId: data.slackUserId } : undefined;
    });
  }

  /** A Parly message, read directly (the bridge mirrors what was already allowed to be posted). */
  async message(messageId: string): Promise<MessageDoc | undefined> {
    return (await this.db.collection(COLLECTIONS.messages).doc(messageId).get()).data() as MessageDoc | undefined;
  }

  /** Records a copy the bridge posted in Slack, on the message and in the (teamId, channelId, ts) lookup. */
  async addCopy(messageId: string, copy: SlackCopy): Promise<void> {
    await Promise.all([this.db.collection(COLLECTIONS.messages).doc(messageId).update({ slack: FieldValue.arrayUnion(copy) }), this.rememberCopy(copy, messageId)]);
  }

  /** The Slack users linked to these Parly people in one Slack workspace: person id → Slack user id. */
  async slackUsersOf(teamId: string, agentIds: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!agentIds.length) return found;
    const snap = await this.db.collection(COLLECTIONS.slackIdentities).where('teamId', '==', teamId).where('agentId', 'in', agentIds).get();
    for (const d of snap.docs) found.set(d.data().agentId as string, d.data().slackUserId as string);
    return found;
  }

  /**
   * One message to post in one Slack channel, kept until it's posted (`slack_outbox/{messageId}:{teamId}:{channelId}`):
   * false when it's already waiting or posted.
   */
  async queueOut(job: SlackOut): Promise<boolean> {
    return queueBridgeOut(this.db, COLLECTIONS.slackOutbox, outKey(job), job);
  }

  /**
   * A Parly person talks with an agent from their Slack DM with the app: that DM is where the agent's answers go,
   * and the agent is the DM's current one (what they write next goes to it, until another `@Name`).
   */
  async useDm(teamId: string, slackUserId: string, personId: string, agentId: string, channelId: string): Promise<void> {
    const col = this.db.collection(COLLECTIONS.slackDms);
    const at = new Date().toISOString();
    await Promise.all([
      col.doc(`${teamId}:${slackUserId}:${agentId}`).set({ teamId, slackUserId, personId, agentId, channelId, at }),
      col.doc(`current:${teamId}:${slackUserId}`).set({ agentId, at }),
    ]);
  }

  /** The agent a Slack user's DM with the app is talking to now, if any. */
  async currentDm(teamId: string, slackUserId: string): Promise<string | undefined> {
    return ((await this.db.collection(COLLECTIONS.slackDms).doc(`current:${teamId}:${slackUserId}`).get()).data() as { agentId?: string } | undefined)?.agentId;
  }

  /** The Slack DMs where a person talks with an agent: where that agent's answers to them are mirrored. */
  async dmsWith(personId: string, agentId: string): Promise<{ teamId: string; channelId: string; slackUserId: string }[]> {
    const snap = await this.db.collection(COLLECTIONS.slackDms).where('personId', '==', personId).where('agentId', '==', agentId).get();
    const dms = snap.docs.map((d) => d.data() as { teamId: string; slackUserId: string; channelId: string });
    // Only while that Slack user is still this person, and the workspace still connected: an unlink stops it at once.
    const live = await Promise.all(dms.map(async (d) => (await this.identity(d.teamId, d.slackUserId))?.agentId === personId && !!(await this.install(d.teamId))));
    return dms.filter((_, i) => live[i]).map(({ teamId, channelId, slackUserId }) => ({ teamId, channelId, slackUserId }));
  }

  /** The Parly message a Slack message is (or is a copy of), by its full key. */
  async messageAt(copy: SlackCopy): Promise<string | undefined> {
    return ((await this.db.collection(COLLECTIONS.slackTs).doc(slackKey(copy)).get()).data() as { messageId?: string } | undefined)?.messageId;
  }

  /** Remembers that this Slack message is that Parly message. */
  async rememberCopy(copy: SlackCopy, messageId: string): Promise<void> {
    await this.db.collection(COLLECTIONS.slackTs).doc(slackKey(copy)).set({ ...copy, messageId });
  }

  /** Keeps a Slack OAuth `state` until it's spent or expires. */
  async saveOAuthState(state: string, data: { ownerId: string; workspaceId: string; sideId?: string; expiresAt: Date }): Promise<void> {
    await this.db.collection(COLLECTIONS.slackLinkCodes).doc(`oauth:${state}`).set(data);
  }

  /** Spends an OAuth state once: undefined if unknown, already used, or expired at `now`. */
  async spendOAuthState(state: string, now: number): Promise<{ ownerId: string; workspaceId: string; sideId?: string } | undefined> {
    const ref = this.db.collection(COLLECTIONS.slackLinkCodes).doc(`oauth:${state}`);
    return this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as StoredOAuthState | undefined;
      if (!data) return undefined;
      tx.delete(ref);
      if (toMillis(data.expiresAt) <= now) return undefined;
      return { ownerId: data.ownerId, workspaceId: data.workspaceId, ...(data.sideId ? { sideId: data.sideId } : {}) };
    });
  }

  /** A link code, read without spending it. */
  async peekLinkCode(code: string): Promise<{ teamId: string; slackUserId: string; expiresAt: { toMillis(): number } | Date } | undefined> {
    return (await this.db.collection(COLLECTIONS.slackLinkCodes).doc(code).get()).data() as
      | { teamId: string; slackUserId: string; expiresAt: { toMillis(): number } | Date }
      | undefined;
  }

  /** The Slack accounts linked to a Parly person. */
  async identitiesOf(agentId: string): Promise<SlackIdentity[]> {
    const snap = await this.db.collection(COLLECTIONS.slackIdentities).where('agentId', '==', agentId).get();
    return snap.docs.map((doc) => doc.data() as SlackIdentity);
  }

  /** Unlinks a person's Slack identity in `teamId`, and forgets their DMs there. */
  async unlinkPersonInTeam(teamId: string, agentId: string): Promise<void> {
    const [ids, dms] = await Promise.all([
      this.db.collection(COLLECTIONS.slackIdentities).where('teamId', '==', teamId).where('agentId', '==', agentId).get(),
      this.db.collection(COLLECTIONS.slackDms).where('teamId', '==', teamId).where('personId', '==', agentId).get(),
    ]);
    await Promise.all([...ids.docs, ...dms.docs].map((d) => d.ref.delete()));
  }
}

interface StoredOAuthState {
  ownerId: string;
  workspaceId: string;
  sideId?: string;
  expiresAt: { toMillis(): number } | Date;
}
