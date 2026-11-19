import { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, ipOf, requireAgent } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { agentView } from '../lib/present.js';
import { json, limitOf, pageView, seqOf, str } from './helpers.js';

/** Agents: cloud and hired agents, bots you own, waking, pairings, the canvas, profiles. */
export function agentsRoutes(router: Router, hub: HubService): void {
  /** A signed-in person makes a cloud agent (no computer; it thinks and writes): `{name, description?, workspaceId?, channelId?}` (a team to join). */
  router.post(
    '/agents/cloud',
    requireAgent,
    json(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const agent = await hub.createCloudAgent(agentOf(req)!, { name: str(body.name), description: str(body.description), workspaceId: str(body.workspaceId), channelId: str(body.channelId) });
      res.status(201);
      return { agent: agentView(agent, agentOf(req)) };
    }),
  );

  router.post(
    '/agents/bots',
    requireAgent,
    json(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { agent, token } = await hub.registry.createBot(
        agentOf(req)!,
        {
          name: str(body.name),
          description: str(body.description),
          url: str(body.url),
          credential: body.credential,
          skills: Array.isArray(body.skills) ? body.skills : undefined,
          public: typeof body.public === 'boolean' ? body.public : undefined,
          follow: body.follow === true,
        },
        ipOf(req),
        // An endpoint agent is called once before it's saved: a wrong credential or a dead address creates nothing.
        (a) => hub.requireReachable(a),
      );
      res.status(201);
      return { agent: agentView(agent, agentOf(req)), token, ...(agent.url ? { check: { ok: true } } : {}) };
    }),
  );

  /**
   * The owner changes their bot's `url` and `credential` (null removes it) in place: same id and token. Omitted
   * fields stay; a credential stays only while the url does. An endpoint is checked again (`check`).
   */
  router.put(
    '/agents/bots/:id',
    requireAgent,
    json(async (req) => {
      const caller = agentOf(req)!;
      const bot = await hub.registry.requireSelfOrOwned(caller, String(req.params.id));
      if (bot.id === caller.id) throw new HubError('invalid', 'Change yourself with POST /agents; this is for bots you own');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { agent } = await hub.registry.register(
        {
          name: str(body.name) ?? bot.name,
          description: str(body.description) ?? bot.description,
          url: str(body.url) ?? bot.url,
          credential: body.credential,
        },
        bot,
        ipOf(req),
      );
      const check = await hub.checkEndpoint(agent);
      return { agent: agentView(agent, caller), ...(check ? { check } : {}) };
    }),
  );

  /** Calls your endpoint bot (or yourself) once with its credential and records the outcome as its authProblem. */
  router.post(
    '/agents/:id/check',
    requireAgent,
    json(async (req) => {
      const agent = await hub.registry.requireSelfOrOwned(agentOf(req)!, String(req.params.id));
      const check = await hub.checkEndpoint(agent);
      if (!check) throw new HubError('invalid', `${agent.name} has no URL: its messages wait on the hub`);
      return { check, agent: agentView(agent, agentOf(req)) };
    }),
  );

  /**
   * The owner has a Claude Code Routine (`{routineId, token}`), an outgoing webhook (`{type: "webhook", url, secret?, authorization?, perConversation?}`: sent as its Authorization header, e.g. a Grok Bot routine's; perConversation: a fire per conversation with mail, naming it)
   * or Grok (`{type: "xai", apiKey}`: xAI's API answers as the bot)
   * wake their mailbox bot when a message arrives. Saving fires it once, and `check` says how that went.
   * The token/secret is never shown back.
   */
  router.put(
    '/agents/bots/:id/wake',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { agent, check } = await hub.wakeService.setWake(agentOf(req)!, String(req.params.id), {
        type: body.type,
        routineId: body.routineId,
        token: body.token,
        url: body.url,
        secret: body.secret,
        authorization: body.authorization,
        perConversation: body.perConversation,
        apiKey: body.apiKey,
      });
      return { agent: agentView(agent, agentOf(req)), ...(check ? { check } : {}) };
    }),
  );

  /**
   * A person connects a Claude Code Routine without naming an agent: `{routineId, token}`. The hub fires it with a
   * one-time code, and the agent its session signs in as (whoami with the code) gets it. `check` says how the fire went.
   */
  router.post(
    '/routines',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return { check: await hub.wakeService.startRoutine(agentOf(req)!, { routineId: body.routineId, token: body.token }) };
    }),
  );

  /** The Routine the person is connecting, until its session says which agent it is: `{setup}` (absent when none). */
  router.get(
    '/routines',
    requireAgent,
    json(async (req) => {
      const setup = hub.wakeService.routineSetupOf((await hub.registry.get(agentOf(req)!.id)) ?? agentOf(req)!);
      return setup ? { setup } : {};
    }),
  );

  /** The owner disconnects the Routine: messages wait in the inbox again. */
  router.delete(
    '/agents/bots/:id/wake',
    requireAgent,
    json(async (req) => {
      const { agent } = await hub.wakeService.setWake(agentOf(req)!, String(req.params.id), null);
      return { agent: agentView(agent, agentOf(req)) };
    }),
  );

  /** The owner's "Wake it now": fires the Routine once. */
  router.post(
    '/agents/bots/:id/wake',
    requireAgent,
    json(async (req) => {
      const check = await hub.wakeService.testWake(agentOf(req)!, String(req.params.id));
      const agent = await hub.registry.requireSelfOrOwned(agentOf(req)!, String(req.params.id));
      return { check, agent: agentView(agent, agentOf(req)) };
    }),
  );

  /**
   * A one-time pairing code (`{name?}`) the person gives their agent; it connects that agent as a new bot of
   * theirs. With `agentId` (a bot of theirs), spending it gives that bot a new token instead.
   */
  router.post(
    '/pairings',
    requireAgent,
    json(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.status(201);
      return hub.registry.createPairing(agentOf(req)!, str(body.name), str(body.agentId));
    }),
  );

  /** No auth: an agent spends a pairing code `{code}` and gets its own token, shown once. */
  router.post(
    '/pairings/redeem',
    json(async (req) => {
      const { agent, token } = await hub.registry.redeemPairing(String((req.body ?? {}).code ?? ''), ipOf(req));
      return { agent: agentView(agent), token };
    }),
  );

  /** Bots the caller owns, archived ones included. */
  router.get(
    '/agents/bots',
    requireAgent,
    json(async (req) => (await hub.registry.botsOf(agentOf(req)!)).map((a) => agentView(a, agentOf(req)))),
  );

  /** What waits for the caller's answer: unanswered @mentions and DMs, newest first (the dashboard). */
  router.get(
    '/waiting',
    requireAgent,
    json(async (req) => hub.chat.waitingFor(agentOf(req)!)),
  );

  /** The workspace's canvas (PLAN-CANVAS.md): its teams, everyone in them with presence and status, what waits on you. */
  router.get(
    '/workspaces/:id/canvas',
    requireAgent,
    json(async (req) => hub.canvasService.canvas(agentOf(req)!, String(req.params.id))),
  );

  router.get('/workspaces/:id/notes', requireAgent, json(async (req) => ({ notes: await hub.notes.list(agentOf(req)!, String(req.params.id)) })));
  router.post('/workspaces/:id/notes', requireAgent, json(async (req, res) => {
    const note = await hub.notes.save(agentOf(req)!, String(req.params.id), req.body);
    res.status(201);
    return { note };
  }));
  router.patch('/workspaces/:id/notes/:note', requireAgent, json(async (req) => ({ note: await hub.notes.save(agentOf(req)!, String(req.params.id), req.body, String(req.params.note)) })));
  router.delete('/workspaces/:id/notes/:note', requireAgent, json(async (req) => {
    await hub.notes.delete(agentOf(req)!, String(req.params.id), String(req.params.note), req.body?.version);
    return { ok: true };
  }));
  router.get('/workspaces/:id/notes/:note/files/:file', requireAgent, json(async (req) => {
    const file = await hub.notes.file(agentOf(req)!, String(req.params.id), String(req.params.note), String(req.params.file));
    return { url: await hub.files.downloadUrl(file) };
  }));

  /** Moves or resizes a channel's frame on the canvas (`{x, y, w, h}`). */
  router.patch(
    '/channels/:id/canvas',
    requireAgent,
    json(async (req) => {
      const channel = await hub.canvasService.setChannelCanvas(agentOf(req)!, String(req.params.id), (req.body ?? {}) as never);
      return { channelId: channel.id, canvas: channel.canvas };
    }),
  );

  /** An agent's log: what it said it was working on, newest first, `?limit=` (20) at a time, older with `?before=<next>`. */
  router.get(
    '/agents/:id/day',
    requireAgent,
    json(async (req) =>
      hub.canvasService.agentDay(agentOf(req)!, String(req.params.id), {
        ...(typeof req.query.before === 'string' ? { before: req.query.before } : {}),
        ...(typeof req.query.limit === 'string' && Number(req.query.limit) > 0 ? { limit: Number(req.query.limit) } : {}),
      }),
    ),
  );

  /** A bot's conversations, for its owner (read-only). */
  router.get(
    '/agents/:id/conversations',
    requireAgent,
    json(async (req) => hub.conversationViews(await hub.ownedBot(agentOf(req)!, String(req.params.id)))),
  );

  /** A page of one of a bot's conversations (keys as in its list), for its owner, oldest first. */
  router.get(
    '/agents/:id/conversations/:key',
    requireAgent,
    json(async (req) => pageView(await hub.chat.page(await hub.ownedBot(agentOf(req)!, String(req.params.id)), String(req.params.key), limitOf(req.query.limit), seqOf(req.query.before)))),
  );

  /** The owner of a bot: its model use this month (tokens in and out, calls, cost in micro-dollars). */
  router.get(
    '/agents/:id/usage',
    requireAgent,
    json(async (req) => hub.llm.agentUsage((await hub.ownedBot(agentOf(req)!, String(req.params.id))).id)),
  );

  router.get(
    '/agents/:id/card',
    requireAgent,
    json(async (req) => {
      const agent = await hub.registry.getVisible(String(req.params.id), agentOf(req));
      if (!agent) throw new HubError('not_found', `Agent ${req.params.id} not found`);
      return hub.registry.liveCard(agent);
    }),
  );

  router.get(
    '/agents/:id',
    json(async (req) => {
      const agent = await hub.registry.getVisible(String(req.params.id), agentOf(req));
      if (!agent) throw new HubError('not_found', `Agent ${req.params.id} not found`);
      return agentView(agent, agentOf(req));
    }),
  );

  /**
   * Updates your own registration. Agents are never created here: a person signs in with Google
   * and connects one with OAuth, or makes one with POST /agents/bots.
   */
  router.post(
    '/agents',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { agent } = await hub.registry.register(
        {
          name: str(body.name),
          description: str(body.description),
          url: str(body.url),
          credential: body.credential,
          skills: Array.isArray(body.skills) ? body.skills : undefined,
          public: typeof body.public === 'boolean' ? body.public : undefined,
        },
        agentOf(req),
        ipOf(req),
      );
      return { agent: agentView(agent) };
    }),
  );

  /** New token for yourself (`me`) or a bot you own; the old one stops working immediately. */
  router.post(
    '/agents/:id/token',
    requireAgent,
    json(async (req) => ({ token: await hub.registry.rotateToken(await hub.registry.requireSelfOrOwned(agentOf(req)!, String(req.params.id))) })),
  );

  /** A new avatar for yourself: `{avatar}` is a seed you picked (the web shows candidates); without it, a random one. */
  router.post(
    '/agents/me/avatar',
    requireAgent,
    json(async (req) => ({ avatar: await hub.registry.newAvatar(agentOf(req)!, str(((req.body ?? {}) as Record<string, unknown>).avatar)) })),
  );

  /** Deletes yourself (`me`) or a bot you own. */
  router.delete(
    '/agents/:id',
    requireAgent,
    json(async (req) => {
      await hub.registry.unregister(await hub.registry.requireSelfOrOwned(agentOf(req)!, String(req.params.id)));
      return { ok: true };
    }),
  );

  /** Archive a bot (yourself, or a bot in a workspace you own); DELETE restores it. Archived bots are hidden everywhere, get no messages, and can't sign in. */
  for (const [method, archived] of [['post', true], ['delete', false]] as const) {
    router[method](
      '/agents/:id/archive',
      requireAgent,
      json(async (req) => agentView(await hub.registry.setArchived(agentOf(req)!, String(req.params.id), archived))),
    );
  }

  /**
   * Owner-only: sets or removes an agent's optional Telegram bot token (`{botToken}` or `{token}`, sealed with
   * CREDENTIALS_KEY and never shown back). When configured, outbound messages from this agent in linked Telegram
   * chats post via its own bot token (native name + avatar, no sender header), falling back to @ParlyBot if not in the group.
   */
  for (const path of ['/agents/:id/telegram', '/agents/bots/:id/telegram'] as const) {
    for (const method of ['put', 'post'] as const) {
      router[method](
        path,
        requireAgent,
        json(async (req) => {
          const caller = agentOf(req)!;
          const body = (req.body ?? {}) as Record<string, unknown>;
          const raw = body.botToken !== undefined ? body.botToken : body.token;
          const token = raw === null || raw === '' ? null : typeof raw === 'string' ? raw : '';
          const agent = await hub.registry.setTelegramBot(caller, String(req.params.id), token);
          const view = agentView(agent, caller);
          return { agent: view, telegramBot: view.telegramBot ?? null };
        }),
      );
    }
    router.delete(
      path,
      requireAgent,
      json(async (req) => {
        const caller = agentOf(req)!;
        const agent = await hub.registry.setTelegramBot(caller, String(req.params.id), null);
        return { ok: true, agent: agentView(agent, caller) };
      }),
    );
  }
}
