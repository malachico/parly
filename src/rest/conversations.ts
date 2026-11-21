import { createHmac } from 'node:crypto';
import { type Request, Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, requireAgent } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { agentView, channelView, messageView, workspaceView } from '../lib/present.js';
import { seal, unseal } from '../lib/sealing.js';
import { fileView } from '../files/files.js';
import { channelDecisions, findDecisions, GRAPH_KINDS, listEntries, nodeDetails, relatedEntries, webNodeView } from '../graph/queries.js';
import type { GraphNodeKind } from '../graph/store.js';
import { json, limitOf, pageView, publicMessageView, publicPeople, scheduleView, seqOf, str, webhookView } from './helpers.js';
import { type AgentRecord, isOpenChannel, isPublicWorkspace } from '../registry/types.js';

/** How long one event stream stays open: under Cloud Run's 300 s request timeout; EventSource reconnects after. */
const STREAM_MS = 240_000;
/** A stream ticket opens a stream for this long after it's minted; the stream itself then runs its STREAM_MS. */
const TICKET_MS = 5 * 60_000;

/** Files, conversations and messages, events, search, public channels, schedules. */
export function conversationsRoutes(router: Router, hub: HubService, stream: { sealingKey?: Buffer; publicUrl?: string; webUrl?: string } = {}): void {
  // Its own key (not CREDENTIALS_KEY itself), so a ticket never unseals stored credentials or the other way round.
  const ticketKey = stream.sealingKey && createHmac('sha256', stream.sealingKey).update('events-stream-ticket').digest();
  // A read ticket opens a channel or DM (GET /channels/:id/open, /agents/:id/open), never the stream, and a stream ticket never opens either.
  const readKey = stream.sealingKey && createHmac('sha256', stream.sealingKey).update('channel-read-ticket').digest();
  // The web app's origins: the only ones a browser may read a channel or DM from with a read ticket.
  const webOrigins = new Set(['https://parly.dev', ...(stream.webUrl ? [new URL(stream.webUrl).origin] : [])]);

  /**
   * A short-lived ticket for GET /events/stream?ticket=, so a browser opens the stream here directly: the web app mints
   * it with the person's token, which never reaches the browser, and hands the browser `url` (this hub's public
   * address). 404 without CREDENTIALS_KEY (the web app then proxies).
   */
  router.post(
    '/events/stream/ticket',
    requireAgent,
    json(async (req) => {
      if (!ticketKey) throw new HubError('not_found', 'Stream tickets need CREDENTIALS_KEY on this hub');
      const claim = JSON.stringify({ agent: agentOf(req)!.id, exp: Date.now() + TICKET_MS });
      const ticket = seal(claim, ticketKey);
      // `readTicket` + `hub`: the browser opens a channel or DM straight from here too (GET /channels/:id/open?ticket=, /agents/:id/open?ticket=).
      return { ticket, url: `${stream.publicUrl ?? ''}/events/stream?ticket=${encodeURIComponent(ticket)}`, readTicket: seal(claim, readKey!), hub: stream.publicUrl ?? '', expiresAt: Date.now() + TICKET_MS };
    }),
  );

  /**
   * The agent a stream ticket was minted for, while it's fresh and the agent can still sign in. The token it was minted
   * with was checked then (registry.authenticate), so signing out or a rotated token only end the
   * stream once the ticket is older than TICKET_MS. It rides in the URL, so request logs hold it for that long.
   */
  async function ticketAgent(ticket: string | undefined, key = ticketKey) {
    if (!ticket || !key) return undefined;
    let claim: { agent?: string; exp?: number };
    try {
      claim = JSON.parse(unseal(ticket, key));
    } catch {
      return undefined;
    }
    if (!claim.agent || !(Number(claim.exp) > Date.now())) return undefined;
    const agent = await hub.registry.get(claim.agent);
    return agent && !agent.archived && !agent.webhookChannel ? agent : undefined;
  }
  /**
   * A GET a browser may call straight from the web app: signed in with a bearer token, or `?ticket=` (a readTicket
   * from POST /events/stream/ticket). Only the web app's origins may read the response: never `*`, never cookies.
   */
  function browserRead(handler: (req: Request, viewer: AgentRecord) => Promise<unknown>) {
    return json(async (req, res) => {
      res.vary('Origin');
      const origin = req.header('origin');
      if (origin && webOrigins.has(origin)) res.set('access-control-allow-origin', origin);
      const viewer = agentOf(req) ?? (await ticketAgent(str(req.query.ticket), readKey));
      if (!viewer) throw new HubError('unauthorized', 'Sign in again: send a bearer token, or a fresh ?ticket= from POST /events/stream/ticket.');
      return handler(req, viewer);
    });
  }

  /** Start an upload: `{name, mediaType?, size, md5}` → `{file, upload: {method, url, headers}}`. PUT the bytes, then complete. */
  router.post(
    '/files',
    requireAgent,
    json(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created = await hub.files.create(agentOf(req)!, {
        name: str(body.name),
        mediaType: str(body.mediaType),
        size: typeof body.size === 'number' ? body.size : undefined,
        md5: str(body.md5),
      });
      res.status(201);
      return created;
    }),
  );

  router.post(
    '/files/:id/complete',
    requireAgent,
    json(async (req) => hub.files.complete(agentOf(req)!, String(req.params.id))),
  );

  /**
   * Download: redirects to a 5-minute signed link. `?link=1` returns `{url}` instead (for pages that embed it);
   * `?download=1` makes it a download even for a type a browser would show.
   */
  router.get(
    '/files/:id',
    requireAgent,
    (req, res, next) => {
      (async () => {
        const file = await hub.fileForDownload(agentOf(req)!, String(req.params.id));
        const url = await hub.files.downloadUrl(file, { attachment: Boolean(req.query.download) });
        if (req.query.link) res.json({ ...fileView(file), url, expiresInSeconds: 300 });
        else res.redirect(302, url);
      })().catch(next);
    },
  );

  /**
   * Your conversations, newest first: a channel ("channel:<id>", its threads' new messages counted in) or the
   * direct conversation with an agent ("agent:<id>"). `?workspace=<id>` keeps that workspace's channels and DMs.
   */
  router.get(
    '/conversations',
    requireAgent,
    json(async (req) => hub.conversationViews(agentOf(req)!, { limit: Math.min(Number(req.query.limit) || 100, 100), workspace: str(req.query.workspace) })),
  );

  /**
   * A page of a conversation, oldest first: "channel:<id>", "thread:<channelId>:<postId>" or "agent:<id>". `limit`
   * messages before seq `before` (default: the newest). `seen`: where each participant has read up to (seq).
   * `threads=open|done`: channel feed filled with open or completed thread posts only (skips the other).
   */
  router.get(
    '/conversations/:key/messages',
    requireAgent,
    json(async (req) => {
      const threadsRaw = str(req.query.threads);
      const threads = threadsRaw === 'open' || threadsRaw === 'done' || threadsRaw === 'all' ? threadsRaw : undefined;
      return pageView(await hub.chat.page(agentOf(req)!, String(req.params.key), limitOf(req.query.limit), seqOf(req.query.before), threads ? { threads } : undefined));
    }),
  );

  /**
   * Everything a browser needs to open a channel, in one round trip: its messages page (`limit`, `threads=open|done`),
   * its members, `people` (names and faces of whoever wrote there or was in a thread but has since left), `me`, the
   * channel and its workspace; `room` (the room's document) and `brief` (my corner's) in a room; `?thread=` (`replies`)
   * adds that thread, `?panel=channel` the details panel's data. Signed in
   * with a bearer token, or `?ticket=` (a readTicket from POST /events/stream/ticket) from the web app's own origins.
   */
  router.get(
    '/channels/:id/open',
    browserRead(async (req, viewer) => {
      const id = String(req.params.id);
      const threads = str(req.query.threads) === 'done' ? 'done' : 'open';
      const thread = str(req.query.thread);
      const panel = str(req.query.panel);
      const channel = await hub.registry.requireChannelMembership(viewer, id);
      const ws = channel.workspaceId;
      const [workspace, page, members, open] = await Promise.all([
        hub.registry.requireWorkspaceMembership(viewer, ws),
        hub.chat.page(viewer, `channel:${id}`, limitOf(req.query.limit), seqOf(req.query.before), { threads }),
        hub.registry.search(viewer, { channel: id }),
        thread ? Promise.all([hub.chat.waitForReply(viewer, thread, 0), hub.chat.page(viewer, `thread:${id}:${thread}`, limitOf(req.query.replies))]) : undefined,
      ]);
      const room = workspace.room;
      const corner = room?.sides.find((s) => s.id === viewer.id || (viewer.kind !== 'human' && s.id === viewer.ownerId))?.corner === id;
      // The details panel (?panel=channel): each part on its own, so one failing leaves the rest.
      const [roomDoc, brief, details] = await Promise.all([
        room ? hub.rooms.document(viewer, ws).catch(() => ({ agreed: false })) : undefined,
        corner ? hub.rooms.readBrief(viewer, ws).catch(() => undefined) : undefined,
        panel === 'channel'
          ? Promise.all([
              hub.registry.search(viewer, { workspace: ws }).catch(() => []),
              hub.scheduleService.channelSchedules(viewer, id).catch(() => []),
              hub.channelWebhooks(viewer, id).catch(() => []),
              hub.registry.scopeEffectiveSkills(viewer, 'channel', id, { workspaceId: ws }).catch(() => []),
              hub.registry.mySkillsCatalog(viewer, {}).catch(() => []),
              hub.slackOAuth ? hub.slackOAuth.workspaceStatus(viewer, ws, true).catch(() => undefined) : { configured: false, canManage: false },
              hub.telegram ? hub.telegram.workspaceStatus(viewer, ws).catch(() => undefined) : { configured: false, canManage: false, chats: [], links: [] },
            ])
          : undefined,
      ]);
      const known = new Set(members.map((m) => m.id));
      // At most 12 former members, as the web page did.
      const spoke = [...page.messages.map((m) => m.fromId), ...Object.values(page.threads ?? {}).flatMap((t) => t.people ?? []), ...(open ? [open[0].message.fromId, ...open[1].messages.map((m) => m.fromId)] : [])];
      const gone = [...new Set(spoke)].filter((a) => !known.has(a) && a !== viewer.id).slice(0, 12);
      return {
        me: agentView(viewer, viewer),
        workspace: workspaceView(workspace, viewer),
        channel: channelView(channel, viewer, workspace),
        page: pageView(page),
        members: members.map((a) => agentView(a)),
        people: gone.length ? await publicPeople(hub, gone) : {},
        ...(open ? { thread: { post: messageView(open[0].message), page: pageView(open[1]) } } : {}),
        ...(roomDoc ? { room: roomDoc } : {}),
        ...(brief ? { brief: brief.brief } : {}),
        ...(details
          ? {
              panel: {
                inWorkspace: details[0].map((a) => agentView(a)),
                schedules: details[1].map(scheduleView),
                webhooks: details[2].map(webhookView),
                skills: details[3],
                librarySkills: details[4],
                slack: details[5],
                telegram: details[6],
              },
            }
          : {}),
      };
    }),
  );

  /**
   * Everything a browser needs to open a direct message with agent `:id` in `?workspace=`, in one round trip: its
   * messages page (`limit`), `me`, the workspace, and `agent` (as GET /agents/:id shows it) or, when that agent is
   * archived, removed or no longer visible, `gone` (its name and face, from your conversation list). Same auth as
   * /channels/:id/open: a bearer token, or `?ticket=` from the web app's own origins.
   */
  router.get(
    '/agents/:id/open',
    browserRead(async (req, viewer) => {
      const id = String(req.params.id);
      const ws = str(req.query.workspace);
      if (!ws) throw new HubError('invalid', 'workspace is required');
      const key = `agent:${id}`;
      const [workspace, page, agent] = await Promise.all([
        hub.registry.requireWorkspaceMembership(viewer, ws),
        hub.chat.page(viewer, key, limitOf(req.query.limit)),
        hub.registry.getVisible(id, viewer),
      ]);
      // Only a conversation you already have names an agent you can no longer see, as the web page did.
      const gone = agent ? undefined : (await hub.conversationViews(viewer, { limit: 100, workspace: ws })).find((c) => c.key === key)?.with;
      if (!agent && !gone) throw new HubError('not_found', `Agent ${id} not found`);
      return {
        me: agentView(viewer, viewer),
        workspace: workspaceView(workspace, viewer),
        page: pageView(page),
        ...(agent ? { agent: agentView(agent, viewer) } : { gone }),
      };
    }),
  );

  /**
   * AI "Catch me up" summary of unread messages in a conversation ("channel:<id>", "thread:<channelId>:<postId>",
   * "dm:<a_b>" or "agent:<id>") since the caller's read cursor (or optional `?sinceSeq=<number>`). Does not advance
   * the read cursor.
   */
  router.get(
    '/conversations/:key/catchup',
    requireAgent,
    json(async (req) => {
      const rawSince = req.query.sinceSeq;
      let sinceSeq: number | undefined;
      if (rawSince !== undefined && String(rawSince).trim() !== '') {
        const parsed = Number(rawSince);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new HubError('invalid', 'sinceSeq must be a non-negative integer');
        }
        sinceSeq = parsed;
      }
      return hub.chat.summarizeCatchup(agentOf(req)!, String(req.params.key), { sinceSeq });
    }),
  );

  /** Say something in a conversation: `{text?, data?, files?}`. Returns the message. */
  router.post(
    '/conversations/:key/messages',
    requireAgent,
    json(async (req, res) => {
      const me = agentOf(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = String(req.params.key);
      const [kind, a, b] = key.split(':');
      const target = kind === 'agent' ? { to: a } : kind === 'channel' ? { channel: a } : kind === 'thread' ? { channel: a, thread: b } : undefined;
      if (!target) throw new HubError('invalid', 'The conversation is "channel:<id>", "thread:<channelId>:<postId>" or "agent:<id>"');
      const sent = await hub.send(me, target, await hub.parts(me, str(body.text), body.data, body.files), { replyTo: body.replyTo as string | undefined });
      res.status(201);
      return messageView(sent.message);
    }),
  );

  /** An agent's live status in a conversation: `{text?}` ("running the tests"), or `{done: true}` to clear it. */
  router.post(
    '/conversations/:key/status',
    requireAgent,
    json(async (req) => hub.setStatus(agentOf(req)!, String(req.params.key), str((req.body ?? {}).text), (req.body ?? {}).done === true)),
  );

  /** You have read a conversation to its end. */
  router.post(
    '/conversations/:key/read',
    requireAgent,
    json(async (req) => hub.chat.markRead(agentOf(req)!, String(req.params.key))),
  );

  /** Your activity feed (see the wait_for_events MCP tool): `?cursor=` to resume, `?since=<ISO>` to start earlier, `?wait=<seconds>` to long-poll. */
  router.get(
    '/events',
    requireAgent,
    json(async (req) => hub.eventsView(agentOf(req)!, str(req.query.cursor) ?? str(req.query.since), (Number(req.query.wait) || 0) * 1000)),
  );

  /**
   * The same feed as server-sent events with the data in them (see HubService.streamEvents): resumes from
   * Last-Event-ID or `?cursor=`, pings every 15 s, and ends after a few minutes for EventSource to reconnect.
   */
  // EventSource's own reconnect sends Last-Event-ID, which a cross-origin browser asks about first.
  router.options('/events/stream', (_req, res) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization, Last-Event-ID', 'access-control-max-age': '86400' }).status(204).end();
  });

  router.get('/events/stream', async (req, res, next) => {
    let agent;
    try {
      agent = agentOf(req) ?? (await ticketAgent(str(req.query.ticket)));
    } catch (err) {
      return next(err);
    }
    // A ticket is a credential in the URL, so the stream allows any origin but never cookies.
    if (!agent) return void res.status(401).set('access-control-allow-origin', '*').json({ error: 'Sign in again: send a bearer token, or a fresh ?ticket= from POST /events/stream/ticket.' });
    let open = true;
    req.on('close', () => (open = false));
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 2000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const send = (event: string, data: unknown, id?: string) => res.write(`event: ${event}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    try {
      // ponytail: each stream polls the store like /events does; a pub/sub fan-out when many tabs are open at once
      await hub.streamEvents(agent, str(req.header('last-event-id')) ?? str(req.query.cursor), send, () => open, Date.now() + STREAM_MS);
    } catch (err) {
      if (open) send('error', { error: err instanceof Error ? err.message : 'Stream failed' });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });

  /** Messages with `q` in them from your recent conversations, newest first (`limit` ≤ 50). */
  router.get(
    '/search',
    requireAgent,
    json(async (req) => hub.searchView(agentOf(req)!, str(req.query.q) ?? '', Math.min(Number(req.query.limit) || 30, 50))),
  );

  /**
   * Decisions from the context graph in conversations you can read: matching `q` (2+ characters), else a `channel`'s most
   * recent; `channel` limits a search to it and its threads. `limit` ≤ 20. Empty when the graph is off.
   */
  router.get(
    '/decisions',
    requireAgent,
    json(async (req) => {
      const caller = agentOf(req)!;
      const q = (str(req.query.q) ?? '').trim().slice(0, 500);
      const channel = str(req.query.channel);
      const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 10, 1), 20);
      if (!hub.graph) return { decisions: [] };
      const nodes = q.length >= 2 ? await findDecisions(hub, caller, q, { channel, limit }) : channel ? await channelDecisions(hub, caller, channel, limit) : [];
      return { decisions: nodes.map(webNodeView) };
    }),
  );

  /** What the context graph recorded in a thread you can read, and what it links to. Empty when the graph is off. */
  router.get(
    '/decisions/related',
    requireAgent,
    json(async (req) => {
      const channel = str(req.query.channel);
      const thread = str(req.query.thread);
      if (!channel || !thread) throw new HubError('invalid', 'Give a channel and a thread.');
      const { nodes } = await relatedEntries(hub, agentOf(req)!, { channel, thread, kinds: ['decision'] });
      return { decisions: nodes.map(webNodeView) };
    }),
  );

  /**
   * The graph explorer's list: entries of every kind (or `kind`) in conversations you can read (or one `channel` or `workspace` of yours),
   * newest first, or best match first for `q` (2+ characters). `limit` ≤ 100; `cursor` is the last page's `nextCursor`.
   * `counts` is entries per kind in the same scope, ignoring `kind` and `q`. Empty when the graph is off.
   */
  router.get(
    '/graph/entries',
    requireAgent,
    json(async (req) => {
      const kind = str(req.query.kind);
      if (kind && !GRAPH_KINDS.includes(kind as GraphNodeKind)) throw new HubError('invalid', `kind must be one of ${GRAPH_KINDS.join(', ')}.`);
      const cursor = str(req.query.cursor);
      if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) throw new HubError('invalid', 'Bad cursor.');
      const q = (str(req.query.q) ?? '').trim().slice(0, 500);
      const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), 100);
      return listEntries(hub, agentOf(req)!, { channel: str(req.query.channel), thread: str(req.query.thread), workspace: str(req.query.workspace), kind: kind as GraphNodeKind | undefined, q: q.length >= 2 ? q : undefined, limit, cursor: cursor ? Number(cursor) : undefined });
    }),
  );

  /** One graph entry you can read, with its neighbours by relation; `depth=2` adds theirs (30 entries at most). 404 if you can't read it. */
  router.get(
    '/graph/node/:id',
    requireAgent,
    json(async (req) => {
      const depth = str(req.query.depth) ?? '1';
      if (depth !== '1' && depth !== '2') throw new HubError('invalid', 'depth must be 1 or 2.');
      return nodeDetails(hub, agentOf(req)!, String(req.params.id), depth === '2' ? 2 : 1);
    }),
  );

  /** A message you can read, and its first answer if there is one. */
  router.get(
    '/messages/:id',
    requireAgent,
    json(async (req) => {
      const { message, reply } = await hub.chat.waitForReply(agentOf(req)!, String(req.params.id), 0);
      return { message: messageView(message), ...(reply ? { reply: messageView(reply) } : {}) };
    }),
  );

  /** Answer a message: `{text?, data?, files?}`, in its thread (a channel post) or its conversation. */
  router.post(
    '/messages/:id/reply',
    requireAgent,
    json(async (req, res) => {
      const me = agentOf(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sent = await hub.send(me, { replyTo: String(req.params.id) }, await hub.parts(me, str(body.text), body.data, body.files), { replyTo: body.replyTo as string | undefined });
      res.status(201);
      return messageView(sent.message);
    }),
  );

  /**
   * A public channel, for anyone, signed in or not: a page of its posts since it went public (`before`, `limit`
   * as for conversations), with who wrote them, its threads and their hub files. No emails, owners or data.
   */
  router.get(
    '/public/channels/:id',
    json(async (req) => {
      const page = await hub.chat.publicPage(String(req.params.id), limitOf(req.query.limit), seqOf(req.query.before));
      const workspace = await hub.registry.workspaceById(page.channel.workspaceId);
      const pubWs = isPublicWorkspace(workspace);
      return {
        channel: {
          id: page.channel.id,
          name: page.channel.name,
          ...(pubWs
            ? {
                workspaceId: page.channel.workspaceId,
                open: isOpenChannel(page.channel),
                publicShowcase: true,
                selfJoin: page.channel.publicFromSeq !== undefined && isOpenChannel(page.channel) && !workspace?.archived,
              }
            : {}),
        },
        messages: page.messages.map(publicMessageView),
        threads: page.threads,
        people: await publicPeople(hub, [...page.messages.map((m) => m.fromId), ...Object.values(page.threads).flatMap((t) => t.people)]),
        older: page.older,
      };
    }),
  );

  /**
   * Scheduled messages in a channel (members): `{text, repeat, time?, date?, day?, minutes?, tz, thread?}` makes one
   * (a person, or an agent for its owner), posted by the channel's Scheduled bot when due; GET lists them.
   */
  router.post(
    '/channels/:id/schedules',
    requireAgent,
    json(async (req, res) => {
      const s = await hub.scheduleService.createSchedule(agentOf(req)!, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      res.status(201);
      return scheduleView(s);
    }),
  );
  router.get(
    '/channels/:id/schedules',
    requireAgent,
    json(async (req) => (await hub.scheduleService.channelSchedules(agentOf(req)!, String(req.params.id))).map(scheduleView)),
  );
  /**
   * Scheduled direct messages to an agent: the same body (no thread) makes one, sent as the caller's person with ⏰ in
   * front so the answer lands in their conversation with it; GET lists theirs to that agent.
   */
  router.post(
    '/agents/:id/schedules',
    requireAgent,
    json(async (req, res) => {
      const s = await hub.scheduleService.createAgentSchedule(agentOf(req)!, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      res.status(201);
      return scheduleView(s);
    }),
  );
  router.get(
    '/agents/:id/schedules',
    requireAgent,
    json(async (req) => (await hub.scheduleService.agentSchedules(agentOf(req)!, String(req.params.id))).map(scheduleView)),
  );

  /** Everything you've scheduled, in channels and to agents (the Triggers panel's "On a schedule"). */
  router.get(
    '/me/schedules',
    requireAgent,
    json(async (req) => (await hub.scheduleService.mySchedules(agentOf(req)!)).map(scheduleView)),
  );

  /** Its maker or a channel owner: `{active}` pauses or resumes it, `text` and/or `repeat` (+ its fields) edit it; DELETE removes it. */
  router.patch(
    '/schedules/:id',
    requireAgent,
    json(async (req) => scheduleView((await hub.scheduleService.changeSchedule(agentOf(req)!, String(req.params.id), (req.body ?? {}) as Record<string, unknown>))!)),
  );
  router.delete(
    '/schedules/:id',
    requireAgent,
    json(async (req) => (await hub.scheduleService.changeSchedule(agentOf(req)!, String(req.params.id), null), { ok: true })),
  );
}
