import { describe } from './schedules.js';
import { avatarOf } from '../lib/present.js';
import { isShowcaseGuest } from '../registry/registry.js';
import type { AgentRecord, AgentStatus, CanvasBox, ChannelRecord } from '../registry/types.js';
import type { HubService } from './hubService.js';

export type Presence =
  | { state: 'listening'; source: string; checkedAt: string }
  | { state: 'wakes'; source: string; lastSeen: string }
  | { state: 'quiet'; lastSeen: string }
  | { state: 'person'; lastSeen: string }
  /** An incoming webhook or a channel's Scheduled bot: it only posts, nothing is delivered to it. */
  | { state: 'posts'; source: 'webhook' | 'schedule' };

/** A Scheduled bot's messages, for the canvas: when in words ("Weekdays at 09:00 (Asia/Bangkok)") and what. */
export type CanvasSchedule = { text: string; when: string; nextAt?: string; active: boolean };

export interface CanvasView {
  workspaceId: string;
  teams: { channelId: string; name: string; canvas: CanvasBox; slack?: boolean; slackUrl?: string; slackPaused?: boolean; roles?: Record<string, string>; members: string[]; needsYou: number }[];
  agents: { id: string; name: string; kind: string; avatar: string; presence: Presence; status?: AgentStatus; schedules?: CanvasSchedule[]; teams: string[]; runs?: 'cloud' | 'computer'; cloud?: boolean; hosted?: boolean; webhookChannel?: string; scheduler?: boolean; myCloud?: boolean }[];
  /** Today's agent-to-agent messages (@mentions) per channel: the lines between creatures. */
  needsYou: number;
  /** What waits on the viewer, as GET /waiting returns it (the web reads it here instead of asking twice). */
  waiting: Awaited<ReturnType<HubService['chat']['waitingFor']>>;
  /** The viewer's own agents that aren't in this workspace: the bench offers to add them. */
  elsewhere?: { id: string; name: string; kind: string; avatar: string; cloud?: boolean; hosted?: boolean }[];
}

/** A channel that was never placed: a 4-wide grid, in creation order. */
function autoBox(i: number): CanvasBox {
  return { x: 40 + (i % 4) * 640, y: 40 + Math.floor(i / 4) * 480, w: 580, h: 420 };
}

/**
 * The workspace canvas (PLAN-CANVAS.md), agent presence, and an agent's day log.
 */
export class CanvasService {
  constructor(private readonly hub: HubService) {}

  private get registry() {
    return this.hub.registry;
  }
  private get chat() {
    return this.hub.chat;
  }
  private get schedules() {
    return this.hub.schedules;
  }

  /**
   * Everything a workspace's canvas draws, as `viewer` may see it: its teams (the channels the viewer is in, with their
   * frames and how many things wait on the viewer there) and everyone in them, each once, with presence from real
   * signals only and the status the agent itself last posted.
   */
  async canvas(viewer: AgentRecord, workspaceId: string): Promise<CanvasView> {
    const workspace = await this.registry.requireWorkspaceMembership(viewer, workspaceId);
    // A showcase guest joined the public tables that existed then: tables opened since are joined on their next visit.
    if (isShowcaseGuest(workspace, viewer) && viewer.kind === 'human') await this.registry.joinPublicWorkspace(viewer, workspace.id).catch(() => undefined);
    const channels = (await this.registry.channelsOf(viewer, workspace.id)).filter((c) => !c.archived).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const [members, waiting, mine] = await Promise.all([
      this.registry.channelMembers(viewer, channels),
      this.chat.waitingFor(viewer),
      this.registry.botsOf(viewer),
    ]);
    const agents = new Map<string, AgentRecord>();
    members.flat().forEach((a) => !a.archived && agents.set(a.id, a));
    // The viewer's own agents that aren't in this workspace at all: the bench offers to add them here (never for showcase guests).
    const elsewhere = isShowcaseGuest(workspace, viewer)
      ? []
      : mine
          .filter((b) => !b.archived && !b.webhookChannel && !(b.workspaces ?? []).includes(workspace.id))
          .map((b) => ({ id: b.id, name: b.name, kind: b.kind, avatar: avatarOf(b), ...(b.cloud ? { cloud: true } : b.hosted ? { hosted: true } : {}) }));
    const teams = channels.map((c, i) => ({
      channelId: c.id,
      name: c.name,
      canvas: c.canvas ?? autoBox(i),
      ...(c.slack?.length
        ? {
            slack: true,
            slackUrl: `https://slack.com/app_redirect?team=${c.slack[0]!.teamId}&channel=${c.slack[0]!.channelId}`,
            // Its Slack channel is archived: the link waits (it resumes when the channel is back).
            ...(c.slack.every((l) => l.paused) ? { slackPaused: true } : {}),
          }
        : {}),
      ...(c.roles && Object.keys(c.roles).length ? { roles: c.roles } : {}),
      members: members[i]!.filter((a) => !a.archived).map((a) => a.id),
      needsYou: waiting.filter((w) => w.channelId === c.id).length,
    }));
    const inTeams = (id: string) => teams.filter((t) => t.members.includes(id)).map((t) => t.channelId);
    // Agents share conversations and Scheduled-bot channels: each is read once.
    const once = <T>(m: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => m.get(key) ?? m.set(key, read()).get(key)!;
    const readable = new Map<string, Promise<boolean>>();
    const schedulesOf = new Map<string, ReturnType<typeof this.schedules.ofChannel>>();
    return {
      workspaceId: workspace.id,
      teams,
      ...(elsewhere.length ? { elsewhere } : {}),
      agents: await Promise.all(
        [...agents.values()].map(async (a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          avatar: avatarOf(a),
          presence: await this.presence(a, viewer),
          // Only a status about a conversation the viewer can read: a private channel's work stays private.
          ...(a.status && (await once(readable, a.status.conversationId, () => this.chat.canRead(viewer, a.status!.conversationId).catch(() => false))) ? { status: a.status } : {}),
          // A Scheduled bot's channel is one of the viewer's (everyone here is), so its schedules are theirs to see.
          ...(a.scheduler && a.webhookChannel
            ? {
                schedules: (await once(schedulesOf, a.webhookChannel, () => this.schedules.ofChannel(a.webhookChannel!)))
                  .filter((s) => s.botId === a.id)
                  .map((s) => ({ text: s.text, when: describe(s), ...(s.nextAt ? { nextAt: s.nextAt } : {}), active: s.active })),
              }
            : {}),
          teams: inTeams(a.id),
          // Where Parly runs it, for everyone: a cloud agent, or one with its own computer.
          ...(a.cloud ? { runs: 'cloud' as const, cloud: true } : a.hosted ? { runs: 'computer' as const, hosted: true } : {}),
          // The avatar's corner mark for incoming webhooks and Scheduled bots.
          ...(a.webhookChannel ? { webhookChannel: a.webhookChannel, ...(a.scheduler ? { scheduler: true } : {}) } : {}),
          // The viewer's own agent (not an incoming webhook): the canvas offers its tools and triggers.
          ...(a.kind !== 'human' && !a.webhookChannel && a.ownerId === viewer.id ? { myCloud: true } : {}),
        })),
      ),
      needsYou: waiting.length,
      waiting,
    };
  }

  /**
   * How reachable an agent is right now, from real signals only: listening (a wait open, or its endpoint answers, with
   * when that was checked), wakes (a working Routine or webhook wakes it on a message), or quiet (with when last seen).
   * Only the agent or its owner triggers a fresh outbound endpoint check; other channel members reuse the cache.
   */
  async presence(a: AgentRecord, viewer: AgentRecord): Promise<Presence> {
    if (a.kind === 'human') return { state: 'person', lastSeen: a.lastSeen };
    if (a.webhookChannel) return { state: 'posts', source: a.scheduler ? 'schedule' : 'webhook' };
    const mayProbe = viewer.id === a.id || viewer.id === a.ownerId;
    if (await this.hub.online(a, { probe: mayProbe })) {
      const checkedAt = a.kind === 'endpoint' ? this.hub.lastCheckedAt(a.id) : a.lastSeen;
      return { state: 'listening', source: a.cloud ? 'runs on Parly' : a.kind === 'endpoint' ? 'endpoint answers' : 'open wait', checkedAt };
    }
    if (a.wake && !a.wake.problem) return { state: 'wakes', source: a.wake.type, lastSeen: a.lastSeen };
    return { state: 'quiet', lastSeen: a.lastSeen };
  }

  /**
   * An agent's log: what it said it was working on (kept a week), newest first, `limit` at a time; `before` (the
   * previous page's `next`) gives the older ones. Anyone who can see it reads it.
   */
  async agentDay(
    viewer: AgentRecord,
    agentId: string,
    page: { before?: string; limit?: number } = {},
  ): Promise<{ agentId: string; status?: AgentStatus; updates: AgentStatus[]; next?: string }> {
    const agent = await this.registry.requireVisible(agentId, viewer);
    const limit = Math.min(100, Math.max(1, Math.floor(page.limit ?? 20)));
    // ponytail: reads at most 300 lines per page; if all 300 are about conversations the viewer can't read, the page comes back empty
    const all = await this.registry.statusLog(agent.id, page.before, 300);
    // Only what was said where the viewer can read: an update about a conversation they can't see isn't shown.
    const updates: AgentStatus[] = [];
    let i = 0;
    for (; i < all.length && updates.length < limit; i++) {
      // A line about no conversation (its computer waking) is its owner's to see.
      const visible = all[i]!.conversationId
        ? await this.chat.canRead(viewer, all[i]!.conversationId).catch(() => false)
        : viewer.id === agent.ownerId || viewer.id === agent.id;
      if (visible) updates.push(all[i]!);
    }
    return {
      agentId: agent.id,
      ...(agent.status && (await this.chat.canRead(viewer, agent.status.conversationId).catch(() => false)) ? { status: agent.status } : {}),
      updates,
      ...((i < all.length || all.length === 300) && updates.length ? { next: updates[updates.length - 1]!.at } : {}),
    };
  }

  setChannelCanvas(caller: AgentRecord, channelId: string, box: CanvasBox): Promise<ChannelRecord> {
    return this.registry.setChannelCanvas(caller, channelId, box);
  }
}
