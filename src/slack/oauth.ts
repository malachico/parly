import { randomBytes } from 'node:crypto';
import type { Database } from '../db/types.js';
import { toMillis } from '../db/types.js';
import type { HubService } from '../hub/hubService.js';
import { canManageChannel, isOwner } from '../lib/admin.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';
import { LINK_CODE_RE } from '../lib/bridge.js';
import { INSTALL_GONE, extractSlackUserName, type SlackInstall, type SlackLink, type SlackStore, type SlackUserPayload } from './store.js';

/** Bot scopes requested during Slack OAuth v2 installation (matches slack/manifest.json). */
export const SLACK_BOT_SCOPES = [
  'chat:write',
  'chat:write.customize',
  'commands',
  'reactions:write',
  'channels:read',
  'groups:read',
  'channels:history',
  'groups:history',
  'im:history',
  'im:write',
  'users:read',
  'users:read.email',
  'files:read',
  'files:write',
] as const;

const STATE_TTL_MS = 10 * 60_000;

interface SlackOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  publicUrl: string;
  webUrl: string;
  fetchImpl?: typeof fetch;
}

interface SlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface SlackInstallView {
  teamId: string;
  teamName: string;
  sideId?: string;
  problem?: string;
  at: string;
}

interface WorkspaceSlackStatus {
  configured: boolean;
  canManage: boolean;
  install?: SlackInstallView;
  channels?: SlackChannelOption[];
  /** In a shared room: the caller's side's linked Slack channels (shared + private corner). */
  roomLinks?: { sharedChannelId?: string; cornerChannelId?: string; cornerParlyId: string; sharedParlyId: string };
}

interface SlackLinkCodeView {
  teamId: string;
  teamName: string;
  slackUserId: string;
  slackUserName?: string;
  slackEmail?: string;
  emailMatches?: boolean;
}



export class SlackOAuth {
  private readonly fetchImpl: typeof fetch;

  constructor(
    _db: Database,
    private readonly store: SlackStore,
    private readonly hub: HubService,
    private readonly opts: SlackOAuthOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get callbackUrl(): string {
    return `${this.opts.webUrl.replace(/\/+$/, '')}/slack/installed`;
  }

  get configured(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  /** Starts a Slack OAuth v2 install for `workspaceId` with a single-use 10-minute `state`. */
  async startInstall(caller: AgentRecord, workspaceId: string, now = Date.now()): Promise<{ url: string; state: string }> {
    if (caller.kind !== 'human') throw new HubError('forbidden', 'Only a person can connect a Slack workspace');
    if (!this.opts.clientId || !this.opts.clientSecret) {
      throw new HubError('unavailable', 'Slack OAuth is not configured on this hub (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET)');
    }
    // No workspace: the Parly workspace is made from the Slack one when the install completes.
    const workspace = workspaceId ? await this.hub.registry.requireWorkspaceMembership(caller, workspaceId) : undefined;
    let sideId: string | undefined;
    if (!workspace) {
      // nothing to check yet
    } else if (workspace.room) {
      const side = this.hub.rooms.sideOf(workspace.room, caller);
      if (!side || side.id !== caller.id) {
        throw new HubError('forbidden', 'Only the owner of a side in this room can connect Slack for that side');
      }
      sideId = side.id;
    } else if (!isOwner(workspace, caller)) {
      throw new HubError('forbidden', 'Only a workspace owner can connect Slack');
    }

    const state = randomBytes(18).toString('base64url');
    await this.store.saveOAuthState(state, {
      ownerId: caller.id,
      workspaceId: workspace?.id ?? '',
      ...(sideId ? { sideId } : {}),
      expiresAt: new Date(now + STATE_TTL_MS),
    });

    const params = new URLSearchParams({
      client_id: this.opts.clientId,
      scope: SLACK_BOT_SCOPES.join(','),
      redirect_uri: this.callbackUrl,
      state,
    });
    return { url: `https://slack.com/oauth/v2/authorize?${params}`, state };
  }

  /** Spends an OAuth state once; returns undefined if unknown, already used, or expired. */
  async spendState(state: string, now = Date.now()): Promise<{ ownerId: string; workspaceId: string; sideId?: string } | undefined> {
    if (!LINK_CODE_RE.test(state)) return undefined;
    return this.store.spendOAuthState(state, now);
  }

  /**
   * POST /slack/oauth/complete: verifies the signed-in `caller` is the person who started the single-use `state`,
   * exchanges `code` at Slack's `oauth.v2.access`, and saves `SlackInstall`.
   */
  async completeInstall(
    caller: AgentRecord,
    query: { code?: string; state?: string; error?: string },
    now = Date.now(),
  ): Promise<{ install?: SlackInstall; workspaceId: string; redirectUrl: string }> {
    const stateData = await this.spendState(query.state ?? '', now);
    if (!stateData) {
      throw new HubError('invalid', 'This Slack installation link has expired or was already used. Start again from workspace settings.');
    }
    if (caller.kind !== 'human' || caller.id !== stateData.ownerId) {
      throw new HubError('forbidden', 'Only the workspace owner who started this Slack installation can complete it');
    }
    const wsBase = (id: string) => `${this.opts.webUrl}/w/${encodeURIComponent(id)}?panel=workspace`;
    if (query.error) {
      const back = stateData.workspaceId ? `${wsBase(stateData.workspaceId)}&` : `${this.opts.webUrl}/?`;
      return { workspaceId: stateData.workspaceId, redirectUrl: `${back}error=${encodeURIComponent('Slack installation was cancelled.')}` };
    }
    if (!query.code) throw new HubError('invalid', 'Missing OAuth code from Slack');
    if (!this.opts.clientId || !this.opts.clientSecret) {
      throw new HubError('unavailable', 'Slack OAuth is not configured on this hub');
    }

    const workspace = stateData.workspaceId ? await this.hub.registry.workspaceById(stateData.workspaceId) : undefined;
    if (stateData.workspaceId && !workspace) {
      throw new HubError('not_found', 'The workspace or owner for this Slack installation no longer exists');
    }
    if (!workspace) {
      // a new workspace, made below
    } else if (workspace.room) {
      const side = this.hub.rooms.sideOf(workspace.room, caller);
      if (!side || side.id !== caller.id || side.id !== stateData.sideId) {
        throw new HubError('forbidden', 'You are no longer the owner of that room side');
      }
    } else if (!isOwner(workspace, caller)) {
      throw new HubError('forbidden', 'You are no longer an owner of that workspace');
    }

    const res = await this.fetchImpl('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        code: query.code,
        redirect_uri: this.callbackUrl,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const out = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      access_token?: string;
      bot_user_id?: string;
      team?: { id?: string; name?: string };
    };
    if (!res.ok || out.ok !== true || !out.access_token || !out.team?.id || !out.bot_user_id) {
      throw new HubError('invalid', `Slack refused the installation (${out.error ?? `HTTP ${res.status}`})`);
    }

    const teamId = String(out.team.id);
    const teamName = String(out.team.name || out.team.id);
    const existing = await this.store.install(teamId);
    let workspaceId = stateData.workspaceId;
    if (!workspaceId) {
      // Connected from scratch: the Slack workspace's own Parly workspace, or (already connected) that one, if it's the caller's.
      if (existing) {
        const theirs = !existing.sideId ? await this.hub.registry.workspaceById(existing.workspaceId) : undefined;
        if (!theirs || !isOwner(theirs, caller)) throw new HubError('conflict', `Slack workspace "${teamName}" is already connected to another Parly workspace`);
        workspaceId = theirs.id;
      } else {
        workspaceId = (await this.hub.registry.createWorkspace(caller, teamName)).id;
      }
    } else if (existing && (existing.workspaceId !== workspaceId || (existing.sideId ?? '') !== (stateData.sideId ?? ''))) {
      throw new HubError('conflict', `Slack workspace "${teamName}" is already connected to another Parly workspace`);
    }

    const install = await this.store.saveInstall(
      {
        teamId,
        teamName,
        workspaceId,
        ...(stateData.sideId ? { sideId: stateData.sideId } : {}),
        botUserId: String(out.bot_user_id),
        installedBy: caller.id,
      },
      out.access_token,
    );

    return { install, workspaceId, redirectUrl: `${wsBase(workspaceId)}&slack=installed` };
  }

  /**
   * Slack connection status for `workspaceId` as `caller` sees it. In a shared room, each side only ever sees
   * its own side's Slack installation and channels.
   */
  async workspaceStatus(caller: AgentRecord, workspaceId: string, withChannels = false): Promise<WorkspaceSlackStatus> {
    const workspace = await this.hub.registry.requireWorkspaceMembership(caller, workspaceId);
    const installs = await this.store.installsFor(workspace.id);
    let canManage = false;
    let install: SlackInstall | undefined;
    let roomLinks: WorkspaceSlackStatus['roomLinks'];

    if (workspace.room) {
      const side = this.hub.rooms.sideOf(workspace.room, caller);
      canManage = Boolean(side && caller.kind === 'human' && side.id === caller.id);
      install = side ? installs.find((i) => i.sideId === side.id) : undefined;
      if (side) {
        const both = await this.hub.registry.channelsById([workspace.room.shared, side.corner]);
        const sharedLink = both.get(workspace.room.shared)?.slack?.find((l) => l.sideId === side.id);
        const cornerLink = both.get(side.corner)?.slack?.find((l) => l.sideId === side.id);
        roomLinks = {
          sharedParlyId: workspace.room.shared,
          cornerParlyId: side.corner,
          ...(sharedLink ? { sharedChannelId: sharedLink.channelId } : {}),
          ...(cornerLink ? { cornerChannelId: cornerLink.channelId } : {}),
        };
      }
    } else {
      canManage = isOwner(workspace, caller) && caller.kind === 'human';
      install = installs.find((i) => !i.sideId);
    }

    let channels: SlackChannelOption[] | undefined;
    if (withChannels && install && !install.problem) {
      channels = await this.listBotChannels(install);
      install = (await this.store.install(install.teamId)) ?? install;
    }

    return {
      configured: this.configured,
      canManage,
      ...(install
        ? {
            install: {
              teamId: install.teamId,
              teamName: install.teamName,
              ...(install.sideId ? { sideId: install.sideId } : {}),
              ...(install.problem ? { problem: install.problem } : {}),
              at: install.at,
            },
          }
        : {}),
      ...(channels ? { channels } : {}),
      ...(roomLinks ? { roomLinks } : {}),
    };
  }

  /** Lists the Slack channels (public and private) the Parly bot has been invited to (`users.conversations`). */
  async listBotChannels(install: SlackInstall): Promise<SlackChannelOption[]> {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    const res = await this.fetchImpl(`https://slack.com/api/users.conversations?${params}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.store.botToken(install)}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    if (!res) return [];
    const out = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channels?: { id?: string; name?: string; is_private?: boolean }[];
    };
    if (!res.ok || out.ok !== true) {
      if (out.error && INSTALL_GONE.has(out.error)) {
        await this.store.setProblem(install.teamId, `Slack refused the Parly app (${out.error}): reconnect Slack`);
      }
      return [];
    }
    return (out.channels ?? [])
      .filter((c): c is { id: string; name: string; is_private?: boolean } => Boolean(c.id && c.name))
      .map((c) => ({ id: c.id, name: c.name, isPrivate: Boolean(c.is_private) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Links a Parly channel to a Slack channel.
   * - In a standard workspace: links `parlyChannelId` to `channelId` (channel or workspace owner).
   * - In a shared room: a side owner must link BOTH the room's shared channel (`channelId`) and their side's
   *   private corner channel (`cornerChannelId`), both scoped to `side.id`.
   */
  async linkChannel(
    caller: AgentRecord,
    parlyChannelId: string,
    input: { channelId?: string; cornerChannelId?: string; teamId?: string },
  ): Promise<{ slack: SlackLink[] }> {
    const channel = await this.hub.registry.resolveMemberChannel(caller, parlyChannelId);
    const workspace = await this.hub.registry.workspaceById(channel.workspaceId);
    if (!workspace) throw new HubError('not_found', 'Workspace not found');

    if (workspace.room) {
      const room = workspace.room;
      const side = this.hub.rooms.sideOf(room, caller);
      if (!side || caller.kind !== 'human' || side.id !== caller.id) {
        throw new HubError('forbidden', 'Only the owner of a side in this room can link Slack channels for their side');
      }
      if (channel.id !== room.shared && channel.id !== side.corner) {
        throw new HubError('forbidden', "You can only link the room's shared channel and your own side's corner");
      }
      const install = (await this.store.installsFor(workspace.id)).find((i) => i.sideId === side.id);
      if (!install) throw new HubError('invalid', "Connect your side's Slack workspace in workspace settings first");
      if (install.problem) throw new HubError('invalid', install.problem);

      const sharedChannelId = input.channelId?.trim();
      const cornerChannelId = input.cornerChannelId?.trim();
      if (!sharedChannelId || !cornerChannelId) {
        throw new HubError(
          'invalid',
          "Each room side must link two Slack channels: one for the shared room, and a private one for your side's corner",
        );
      }
      if (sharedChannelId === cornerChannelId) {
        throw new HubError(
          'invalid',
          "Pick two different Slack channels: one for the shared room, and a separate private channel for your side's corner",
        );
      }

      const [takenShared, takenCorner] = await Promise.all([
        this.store.linkedChannel(install.teamId, sharedChannelId),
        this.store.linkedChannel(install.teamId, cornerChannelId),
      ]);
      if (takenShared && takenShared.parlyChannelId !== room.shared) {
        throw new HubError('conflict', 'That shared Slack channel is already linked to another Parly channel');
      }
      if (takenCorner && takenCorner.parlyChannelId !== side.corner) {
        throw new HubError('conflict', 'That corner Slack channel is already linked to another Parly channel');
      }

      const both = await this.hub.registry.channelsById([room.shared, side.corner]);
      for (const prev of both.get(room.shared)?.slack ?? []) {
        if ((prev.sideId === side.id || prev.teamId === install.teamId) && prev.channelId !== sharedChannelId) {
          await this.store.unlinkChannel(room.shared, prev);
        }
      }
      for (const prev of both.get(side.corner)?.slack ?? []) {
        if ((prev.sideId === side.id || prev.teamId === install.teamId) && prev.channelId !== cornerChannelId) {
          await this.store.unlinkChannel(side.corner, prev);
        }
      }

      await this.store.linkChannel(room.shared, { teamId: install.teamId, channelId: sharedChannelId, sideId: side.id });
      await this.store.linkChannel(side.corner, { teamId: install.teamId, channelId: cornerChannelId, sideId: side.id });
      const updated = (await this.hub.registry.channelsById([channel.id])).get(channel.id);
      return { slack: (updated?.slack ?? []).filter((l) => l.sideId === side.id) };
    }

    if (!canManageChannel(channel, workspace, caller)) {
      throw new HubError('forbidden', 'Only a channel or workspace owner can link a Slack channel');
    }
    const slackChannelId = input.channelId?.trim();
    if (!slackChannelId) throw new HubError('invalid', 'Pick a Slack channel to link');
    const installs = await this.store.installsFor(channel.workspaceId);
    const install = input.teamId ? installs.find((i) => i.teamId === input.teamId && !i.sideId) : installs.find((i) => !i.sideId);
    if (!install) throw new HubError('invalid', 'Connect Slack in workspace settings first');
    if (install.problem) throw new HubError('invalid', install.problem);

    for (const prev of channel.slack ?? []) {
      if (prev.teamId === install.teamId && prev.channelId !== slackChannelId) {
        await this.store.unlinkChannel(channel.id, prev);
      }
    }
    await this.store.linkChannel(channel.id, { teamId: install.teamId, channelId: slackChannelId });
    const updated = (await this.hub.registry.channelsById([channel.id])).get(channel.id);
    return { slack: updated?.slack ?? [] };
  }

  /**
   * Unlinks a Parly channel from Slack. In a shared room, unlinks the caller's side from both the shared channel
   * and the side's corner channel.
   */
  async unlinkChannel(
    caller: AgentRecord,
    parlyChannelId: string,
    input: { teamId?: string; channelId?: string } = {},
  ): Promise<{ slack: SlackLink[] }> {
    const channel = await this.hub.registry.resolveMemberChannel(caller, parlyChannelId);
    const workspace = await this.hub.registry.workspaceById(channel.workspaceId);
    if (!workspace) throw new HubError('not_found', 'Workspace not found');

    if (workspace.room) {
      const room = workspace.room;
      const side = this.hub.rooms.sideOf(room, caller);
      if (!side || caller.kind !== 'human' || side.id !== caller.id) {
        throw new HubError('forbidden', 'Only the owner of a side in this room can unlink Slack for their side');
      }
      const both = await this.hub.registry.channelsById([room.shared, side.corner]);
      for (const ch of both.values()) {
        for (const l of (ch.slack ?? []).filter((x) => x.sideId === side.id)) {
          await this.store.unlinkChannel(ch.id, l);
        }
      }
      return { slack: [] };
    }

    if (!canManageChannel(channel, workspace, caller)) {
      throw new HubError('forbidden', 'Only a channel or workspace owner can unlink a Slack channel');
    }
    const toRemove = (channel.slack ?? []).filter(
      (l) => (!input.teamId || l.teamId === input.teamId) && (!input.channelId || l.channelId === input.channelId),
    );
    for (const l of toRemove) {
      await this.store.unlinkChannel(channel.id, l);
    }
    const updated = (await this.hub.registry.channelsById([channel.id])).get(channel.id);
    return { slack: updated?.slack ?? [] };
  }

  /**
   * Inspects a one-time Slack identity link code without spending it, so the approval page (/slack/link) can
   * show which Slack workspace and user is being linked and whether their Slack email matches their Parly email.
   */
  async inspectLinkCode(person: AgentRecord, code: string, now = Date.now()): Promise<SlackLinkCodeView> {
    if (person.kind !== 'human') throw new HubError('forbidden', 'People link their Slack accounts');
    if (!LINK_CODE_RE.test(code)) {
      throw new HubError('not_found', 'That link has expired or was already used: write in Slack again for a new one');
    }
    const data = await this.store.peekLinkCode(code);
    if (!data || toMillis(data.expiresAt) <= now) {
      throw new HubError('not_found', 'That link has expired or was already used: write in Slack again for a new one');
    }
    const install = await this.store.install(data.teamId);
    if (!install) throw new HubError('not_found', 'That Slack workspace is no longer connected');

    let slackUserName: string | undefined;
    let slackEmail: string | undefined;
    try {
      const res = await this.fetchImpl(`https://slack.com/api/users.info?${new URLSearchParams({ user: data.slackUserId })}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.store.botToken(install)}` },
        signal: AbortSignal.timeout(5_000),
      });
      const out = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        user?: SlackUserPayload;
      };
      if (out.ok && out.user) {
        slackUserName = extractSlackUserName(out.user);
        slackEmail = out.user.profile?.email || undefined;
      }
    } catch {
      // Best-effort hint only: approval works even if Slack's users.info is unreachable.
    }

    const emailMatches = Boolean(person.email && slackEmail && person.email.toLowerCase() === slackEmail.toLowerCase());
    return {
      teamId: install.teamId,
      teamName: install.teamName,
      slackUserId: data.slackUserId,
      ...(slackUserName ? { slackUserName } : {}),
      ...(slackEmail ? { slackEmail } : {}),
      ...(emailMatches ? { emailMatches: true } : {}),
    };
  }

  /** Lists the Slack accounts linked to `person`, for account settings. */
  async identitiesOf(person: AgentRecord): Promise<{ teamId: string; teamName: string; slackUserId: string; at: string }[]> {
    const out: { teamId: string; teamName: string; slackUserId: string; at: string }[] = [];
    for (const d of await this.store.identitiesOf(person.id)) {
      const install = await this.store.install(d.teamId);
      out.push({ teamId: d.teamId, teamName: install?.teamName ?? d.teamId, slackUserId: d.slackUserId, at: d.at });
    }
    return out;
  }

  /** Unlinks a person's Slack account in `teamId`. */
  async unlinkMyIdentity(person: AgentRecord, teamId: string): Promise<void> {
    await this.store.unlinkPersonInTeam(teamId, person.id);
  }

  /** When a person leaves a Parly workspace, unlinks their Slack identity for any Slack installation serving it. */
  async unlinkMemberFromWorkspace(workspaceId: string, agentId: string): Promise<void> {
    const installs = await this.store.installsFor(workspaceId);
    for (const install of installs) {
      await this.store.unlinkPersonInTeam(install.teamId, agentId);
    }
  }
}
