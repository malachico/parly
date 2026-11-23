import { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, requireAgent } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { CREDIT_MICROS } from '../lib/plans.js';
import { agentView, channelView, workspaceView } from '../lib/present.js';
import { json, roomSetup, str } from './helpers.js';

/** Workspaces, channels and shared rooms: members, owners, roles, invites. */
export function workspacesRoutes(router: Router, hub: HubService): void {
  // ---- workspaces ----------------------------------------------------------------------

  /** My workspaces with member counts. */
  router.get(
    '/workspaces',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const workspaces = await hub.registry.workspacesOf(me);
      const counts = await hub.registry.workspaceMemberCounts(workspaces.map((w) => w.id));
      return workspaces.map((w) => workspaceView(w, me, { memberCount: counts.get(w.id) }));
    }),
  );

  /** A person makes a workspace: `{name}`. */
  router.post(
    '/workspaces',
    requireAgent,
    json(async (req, res) => {
      const me = agentOf(req)!;
      const workspace = await hub.registry.createWorkspace(me, str((req.body ?? {}).name) ?? '');
      res.status(201);
      return workspaceView(workspace, me);
    }),
  );

  /** One workspace I belong to, with `participants: {count, max}` against its owner's plan (`max` null: no limit). */
  router.get(
    '/workspaces/:id',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const workspace = await hub.registry.requireWorkspaceMembership(me, String(req.params.id));
      const { count, max } = await hub.registry.workspaceUsage(workspace, me);
      return workspaceView(workspace, me, { participants: { count, max } });
    }),
  );

  /** My channels in a workspace, with member counts. */
  router.get(
    '/workspaces/:id/channels',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const workspace = await hub.registry.requireWorkspaceMembership(me, String(req.params.id));
      const channels = await hub.registry.channelsOf(me, workspace.id);
      const counts = await hub.registry.channelMemberCounts(channels.map((c) => c.id));
      return channels.map((c) => channelView(c, me, workspace, counts.get(c.id)));
    }),
  );

  /** Make a channel in a workspace I belong to: `{name}`. */
  router.post(
    '/workspaces/:id/channels',
    requireAgent,
    json(async (req, res) => {
      const me = agentOf(req)!;
      const channel = await hub.registry.createChannel(me, String(req.params.id), str((req.body ?? {}).name) ?? '');
      res.status(201);
      return channelView(channel, me);
    }),
  );

  /** Add a person to the workspace by email (any member). Same response whether or not the email is registered. */
  router.post(
    '/workspaces/:id/invites',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const workspace = await hub.registry.inviteToWorkspace(me, String(req.params.id), str((req.body ?? {}).email) ?? '');
      return { ok: true, workspace: workspaceView(workspace, me) };
    }),
  );

  router.get(
    '/workspaces/:id/invites',
    requireAgent,
    json(async (req) =>
      (await hub.registry.listWorkspaceInvites(agentOf(req)!, String(req.params.id))).map((i) => ({
        email: i.email,
        invitedBy: i.invitedByName,
        createdAt: i.createdAt,
      })),
    ),
  );

  router.delete(
    '/workspaces/:id/invites/:email',
    requireAgent,
    json(async (req) => {
      await hub.registry.revokeWorkspaceInvite(agentOf(req)!, String(req.params.id), String(req.params.email));
      return { ok: true };
    }),
  );

  /** Add a bot the caller can see to the workspace, by id: `{agentId}` (any member). People are invited by email. */
  router.post(
    '/workspaces/:id/members',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const { workspace, agent } = await hub.registry.addToWorkspace(me, String(req.params.id), str((req.body ?? {}).agentId) ?? '');
      return { ok: true, workspace: workspaceView(workspace, me), agent: agentView(agent) };
    }),
  );

  router.delete(
    '/workspaces/:id/members/me',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const wsId = String(req.params.id);
      await hub.registry.leaveWorkspace(me, wsId);
      await hub.slackOAuth?.unlinkMemberFromWorkspace(wsId, me.id).catch((err) => console.error('slack unlink on leave failed:', err));
      return { ok: true };
    }),
  );

  router.delete(
    '/workspaces/:id/members/:agent',
    requireAgent,
    json(async (req) => {
      const wsId = String(req.params.id);
      const targetId = String(req.params.agent);
      await hub.registry.removeFromWorkspace(agentOf(req)!, wsId, targetId);
      await hub.slackOAuth?.unlinkMemberFromWorkspace(wsId, targetId).catch((err) => console.error('slack unlink on remove failed:', err));
      return { ok: true };
    }),
  );

  /** Owner only: make a member a co-owner: `{agent}` (an agent id). */
  router.post(
    '/workspaces/:id/owners',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      return workspaceView(await hub.registry.addWorkspaceOwner(me, String(req.params.id), str((req.body ?? {}).agent) ?? ''), me);
    }),
  );

  /** Owner only: replace the email domains that join automatically: `{domains: ["acme.com"]}`. Public mail providers are refused. */
  router.put(
    '/workspaces/:id/domains',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const domains = (req.body ?? {}).domains;
      return workspaceView(await hub.registry.setWorkspaceDomains(me, String(req.params.id), Array.isArray(domains) ? domains : []), me);
    }),
  );

  /**
   * Owner only: the company credit pool (the workspace's own billing record, which members who joined by email domain bill),
   * its balance, and this month's model spend per member.
   */
  router.get(
    '/workspaces/:id/billing',
    requireAgent,
    json(async (req) => {
      const ws = await hub.registry.requireWorkspaceOwner(agentOf(req)!, String(req.params.id));
      const [limits, { spentMicros, capMicros, budgetMicros }, rows, rec, blockedBy] = await Promise.all([
        hub.llm.limits(ws.id),
        hub.llm.balance(ws.id),
        hub.llm.agentSpend(ws.id),
        hub.billing.get(ws.id),
        hub.llm.blockedBy(ws.id),
      ]);
      // ponytail: model spend (agentUsage) only, metered tools aren't per agent; agentUsage keeps the latest payer, so someone linked mid-month shows their whole month.
      const agents = await hub.registry.workspaceStore.getAgentsByIds([...new Set(rows.map((r) => r.agentId))]);
      const personOf = new Map(agents.map((a) => [a.id, a.ownerId ?? a.id]));
      const byPerson = new Map<string, number>();
      for (const r of rows) {
        const p = personOf.get(r.agentId) ?? r.agentId;
        byPerson.set(p, (byPerson.get(p) ?? 0) + r.micros);
      }
      const people = await hub.registry.workspaceStore.getAgentsByIds([...byPerson.keys()]);
      const names = new Map(people.map((a) => [a.id, a.name]));
      return {
        workspaceId: ws.id,
        plan: limits.plan,
        seats: rec?.seats,
        // Only the creator may buy or manage Team: the webhook accepts a Team subscription only when ownerId is ws.ownerId.
        buyer: agentOf(req)!.id === ws.ownerId,
        managed: !!rec?.paddleSubscriptionId,
        monthlyUsd: limits.monthlyMicros / 1e6,
        extraUsd: limits.extraMicros / 1e6,
        leftUsd: Math.max(0, capMicros - spentMicros) / 1e6,
        budgetCredits: budgetMicros === undefined ? null : budgetMicros / CREDIT_MICROS,
        spentCredits: spentMicros / CREDIT_MICROS,
        ...(blockedBy ? { blockedBy } : {}),
        members: [...byPerson].map(([id, micros]) => ({ id, name: names.get(id) ?? id, spentUsd: micros / 1e6 })).sort((a, b) => b.spentUsd - a.spentUsd),
      };
    }),
  );

  /** Owner or co-owner: set the pool's monthly budget (this UTC month's spend past it stops work): `{credits}`, or `{credits: null}` to remove it. */
  router.put(
    '/workspaces/:id/budget',
    requireAgent,
    json(async (req) => {
      const ws = await hub.registry.requireWorkspaceOwner(agentOf(req)!, String(req.params.id));
      await hub.billing.setBudget(ws.id, (req.body ?? {}).credits);
      const { budgetMicros } = await hub.llm.balance(ws.id);
      return { workspaceId: ws.id, budgetCredits: budgetMicros === undefined ? null : budgetMicros / CREDIT_MICROS };
    }),
  );

  /** Creator only (the Team buyer): Paddle's customer portal for the pool's Team subscription: `{url}`. */
  router.post(
    '/workspaces/:id/billing/portal',
    requireAgent,
    json(async (req) => {
      const ws = await hub.registry.requireWorkspaceOwner(agentOf(req)!, String(req.params.id));
      if (ws.ownerId !== agentOf(req)!.id) throw new HubError('forbidden', 'Only the workspace creator manages its Team subscription');
      return { url: await hub.billing.portalUrl(ws.id) };
    }),
  );

  /** Owner only: rename a workspace and/or toggle `public` / `publicShowcase`: `{name?, public?, publicShowcase?, publicChannels?}`. */
  router.patch(
    '/workspaces/:id',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = String(req.params.id);
      const pubFlag = typeof body.public === 'boolean' ? body.public : typeof body.publicShowcase === 'boolean' ? body.publicShowcase : undefined;
      const publicChannels = Array.isArray(body.publicChannels) ? body.publicChannels.map(String) : undefined;
      let ws =
        pubFlag !== undefined
          ? await hub.registry.setWorkspacePublicShowcase(me, id, pubFlag, {
              publicChannels,
              channelSeq: (cid) => hub.chat.channelSeq(cid),
            })
          : undefined;
      if (body.name !== undefined || ws === undefined) {
        ws = await hub.registry.renameWorkspace(me, id, str(body.name) ?? '');
      }
      return workspaceView(ws, me);
    }),
  );

  /** Owner only: enable (`{public: true}` or `{publicShowcase: true}`, optional `publicChannels: string[]`) or disable (`false`) public mode on a workspace. */
  for (const path of ['/workspaces/:id/showcase', '/workspaces/:id/public'] as const) {
    router.put(
      path,
      requireAgent,
      json(async (req) => {
        const me = agentOf(req)!;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const pubFlag = typeof body.public === 'boolean' ? body.public : typeof body.publicShowcase === 'boolean' ? body.publicShowcase : undefined;
        if (typeof pubFlag !== 'boolean') throw new HubError('invalid', 'public or publicShowcase must be true or false');
        const publicChannels = Array.isArray(body.publicChannels) ? body.publicChannels.map(String) : undefined;
        return workspaceView(
          await hub.registry.setWorkspacePublicShowcase(me, String(req.params.id), pubFlag, {
            publicChannels,
            channelSeq: (cid) => hub.chat.channelSeq(cid),
          }),
          me,
        );
      }),
    );
  }

  /** Public workspace info and its public+open channels (anyone, signed in or not). */
  router.get(
    '/public/workspaces/:id',
    json(async (req) => {
      const { workspace, channels } = await hub.registry.publicWorkspace(String(req.params.id));
      return {
        workspace: { id: workspace.id, name: workspace.name, public: true, publicShowcase: true },
        channels: channels.map((c) => ({ id: c.id, name: c.name, ...(c.context ? { context: c.context } : {}) })),
      };
    }),
  );

  /** Signed-in human joins a public workspace as a guest (entering its public+open channels). */
  router.post(
    '/workspaces/:id/join',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const { workspace, channels } = await hub.registry.joinPublicWorkspace(me, String(req.params.id));
      return workspaceView(workspace, me, { channels: channels.map((c) => channelView(c, me, workspace)) });
    }),
  );

  /** Owner only: archive (`{archived: true}`) or restore (`false`) a workspace. */
  router.put(
    '/workspaces/:id/archived',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const archived = (req.body ?? {}).archived;
      if (typeof archived !== 'boolean') throw new HubError('invalid', 'archived must be true or false');
      const workspace = await hub.registry.setWorkspaceArchived(me, String(req.params.id), archived);
      if (archived && workspace.room) await hub.roomEvent(workspace.id, 'room.closed');
      return workspaceView(workspace, me);
    }),
  );

  // ---- channels ------------------------------------------------------------------------

  /** Add a member of the channel's workspace to the channel, by id: `{agentId}` (any channel member). */
  router.post(
    '/channels/:id/members',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const { channel, agent } = await hub.registry.addToChannel(me, String(req.params.id), str((req.body ?? {}).agentId) ?? '');
      return { ok: true, channel: channelView(channel, me), agent: agentView(agent) };
    }),
  );

  router.delete(
    '/channels/:id/members/me',
    requireAgent,
    json(async (req) => {
      await hub.registry.leaveChannel(agentOf(req)!, String(req.params.id));
      return { ok: true };
    }),
  );

  router.delete(
    '/channels/:id/members/:agent',
    requireAgent,
    json(async (req) => {
      await hub.registry.removeFromChannel(agentOf(req)!, String(req.params.id), String(req.params.agent));
      return { ok: true };
    }),
  );

  /** Channel or workspace owner only: rename, archive (restore), open or make public a channel: `{name?, archived?, open?, public?}`. */
  router.patch(
    '/channels/:id',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const body = req.body ?? {};
      const archived = typeof body.archived === 'boolean' ? body.archived : undefined;
      const open = typeof body.open === 'boolean' ? body.open : undefined;
      const id = String(req.params.id);
      // Public from the newest message on: what was said before stays private.
      const publicFromSeq = body.public === true ? await hub.chat.channelSeq(id) : body.public === false ? null : undefined;
      return channelView(await hub.registry.updateChannel(me, id, { name: str(body.name), archived, open, publicFromSeq, context: typeof body.context === 'string' ? body.context : undefined }), me);
    }),
  );

  /** A room's own agent is a cloud agent: a hub that doesn't run them says so up front. */
  const setupOf = (body: Record<string, unknown>) => {
    const setup = roomSetup(body);
    if (setup.ownAgent && !hub.cloudAgents) throw new HubError('unavailable', "This hub doesn't run cloud agents");
    return setup;
  };

  /** Open a shared room (people only): `{goal, invite, side, bots?, brief?, ownAgent?}`. Returns the room's workspace. */
  router.post(
    '/rooms',
    requireAgent,
    json(async (req, res) => {
      const me = agentOf(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { workspace } = await hub.rooms.create(me, { goal: str(body.goal) ?? '', invite: str(body.invite) ?? '', ...setupOf(body) });
      res.status(201);
      return workspaceView(workspace, me);
    }),
  );

  /** Set up your side in a room you were invited to: `{side, bots?, brief?, ownAgent?}`. */
  router.post(
    '/rooms/:id/side',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const room = await hub.rooms.joinSide(me, String(req.params.id), setupOf((req.body ?? {}) as Record<string, unknown>));
      // The last side is in: the agents start talking. A failure here doesn't undo the side.
      if (room.sides.length >= 2) await hub.talks.start(String(req.params.id)).catch(() => undefined);
      return workspaceView((await hub.registry.requireWorkspaceMembership(me, String(req.params.id)))!, me);
    }),
  );

  /** A room's shared document (anyone in the room): `{doc?, agreed}`. */
  router.get(
    '/rooms/:id/document',
    requireAgent,
    json(async (req) => hub.rooms.document(agentOf(req)!, String(req.params.id))),
  );

  /** Write a new version of a room's document: `{text, base}` (`base`: the version you read; 0 for the first). 409 if it moved on. */
  router.put(
    '/rooms/:id/document',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.base !== 'number' || !Number.isInteger(body.base)) throw new HubError('invalid', 'base is the version you read (0 for the first)');
      return hub.rooms.writeDocument(agentOf(req)!, String(req.params.id), str(body.text) ?? '', body.base);
    }),
  );

  /** The private brief of the side I set up: `{brief}`. */
  router.get(
    '/rooms/:id/brief',
    requireAgent,
    json(async (req) => hub.rooms.readBrief(agentOf(req)!, String(req.params.id))),
  );

  /** Replace the private brief of the side I set up: `{brief}`. */
  router.put(
    '/rooms/:id/brief',
    requireAgent,
    json(async (req) => hub.rooms.writeBrief(agentOf(req)!, String(req.params.id), str((req.body ?? {}).brief) ?? '')),
  );

  /** The person who set up a side answers what its agent asked them to decide: `{choice}`. */
  router.post(
    '/rooms/:id/decision',
    requireAgent,
    json(async (req) => {
      await hub.talks.decide(agentOf(req)!, String(req.params.id), str((req.body ?? {}).choice) ?? '');
      return { ok: true };
    }),
  );

  /** The person who set up a side approves the current version for it: `{version}`. */
  router.post(
    '/rooms/:id/approve',
    requireAgent,
    json(async (req) => {
      const version = (req.body ?? {}).version;
      if (typeof version !== 'number') throw new HubError('invalid', 'version is the document version you approve');
      return hub.rooms.approve(agentOf(req)!, String(req.params.id), version);
    }),
  );

  /** A workspace's open channels you aren't in yet, with member counts: the ones you can join. */
  router.get(
    '/workspaces/:id/channels/joinable',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const channels = await hub.registry.joinableChannels(me, String(req.params.id));
      const counts = await hub.registry.channelMemberCounts(channels.map((c) => c.id));
      return channels.map((c) => channelView(c, me, undefined, counts.get(c.id) ?? 0));
    }),
  );

  /** Join an open channel of a workspace you're in. */
  router.post(
    '/channels/:id/join',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      return channelView(await hub.registry.joinChannel(me, String(req.params.id)), me);
    }),
  );

  /** Channel or workspace owner only (a person or a bot): set a member's role, `{role}`; an empty role clears it. */
  router.put(
    '/channels/:id/roles/:agent',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const role = (req.body ?? {}).role;
      // An explicit "" clears; anything that isn't a string is a mistake, not a clear.
      if (typeof role !== 'string') throw new HubError('invalid', '"role" must be a string ("" clears it)');
      return channelView(await hub.registry.setChannelRole(me, String(req.params.id), String(req.params.agent), role), me);
    }),
  );

  /** Channel or workspace owner only: make a member a co-owner: `{agent}` (an agent id). */
  router.post(
    '/channels/:id/owners',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      return channelView(await hub.registry.addChannelOwner(me, String(req.params.id), str((req.body ?? {}).agent) ?? ''), me);
    }),
  );
}
