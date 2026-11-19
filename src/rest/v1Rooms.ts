import type { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import { textOf } from '../lib/wire.js';
import type { RoomInfo, RoomSide, WorkspaceRecord } from '../registry/types.js';
import { CARD_MAX } from '../apps/appAgents.js';
import { costMicros } from '../lib/llmCost.js';
import { appOf, requireApp } from './v1.js';
import { json, str } from './helpers.js';

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const INSTRUCTIONS_MAX = 8000;
const METADATA_MAX = 20;

/** An app's room, or 404: another app's room (or a person's) is never there for it. */
async function roomOf(hub: HubService, appId: string, id: string): Promise<{ workspace: WorkspaceRecord; room: RoomInfo }> {
  const workspace = await hub.registry.workspaceById(id);
  if (!workspace?.room || workspace.room.appId !== appId || workspace.archived) throw new HubError('not_found', 'No such room');
  return { workspace, room: workspace.room };
}

function sideOf(room: RoomInfo, ref: string): RoomSide {
  const side = room.sides.find((s) => s.ref === ref);
  if (!side) throw new HubError('not_found', `No side ${ref} in this room`);
  return side;
}

function metadataOf(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HubError('invalid', 'metadata is an object of strings');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > METADATA_MAX || entries.some(([k, v]) => !KEY.test(k) || typeof v !== 'string' || v.length > 200)) {
    throw new HubError('invalid', `metadata: up to ${METADATA_MAX} keys (a-z, 0-9, _ or -), each a string of up to 200 characters`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** /v1/agents and /v1/rooms: an app opens rooms between two sides of its own, reads them, and acts for its sides. */
export function v1RoomRoutes(router: Router, hub: HubService) {
  const read = requireApp(hub, 'rooms:read');
  const write = requireApp(hub, 'rooms:write');

  async function view(workspaceId: string, room: RoomInfo) {
    const v = await hub.rooms.appView(workspaceId, room);
    const refOf = (sideId: string) => room.sides.find((s) => s.id === sideId)?.ref;
    const status = room.closed ? 'closed' : v.agreed ? 'agreed' : v.stuck ? 'stuck' : v.waiting ? 'needs_decision' : 'talking';
    return {
      id: workspaceId,
      status,
      goal: room.goal,
      sides: room.sides.map((s) => ({ ref: s.ref, name: s.name })),
      ...(v.doc
        ? { document: { version: v.doc.version, text: v.doc.text, approvals: Object.fromEntries(Object.entries(v.doc.approvals).filter(([, a]) => a.version === v.doc!.version).map(([side, a]) => [refOf(side), { version: a.version, at: a.at }])) } }
        : {}),
      // One decision waits at a time; its id is the side it waits on.
      pending: v.waiting ? [{ decisionId: refOf(v.waiting.side), sideRef: refOf(v.waiting.side), question: v.waiting.question, options: v.waiting.options }] : [],
      ...(room.metadata ? { metadata: room.metadata } : {}),
    };
  }

  /** One of the app's agents from a request body: key, name and private instructions, and a public card. */
  function agentInput(key: string, body: Record<string, unknown>) {
    const name = (str(body.name) ?? '').trim();
    const instructions = (str(body.instructions) ?? '').trim();
    if (!KEY.test(key)) throw new HubError('invalid', 'key: 1-40 characters, a-z, 0-9, _ or -');
    if (!name || name.length > 60) throw new HubError('invalid', 'name: 1-60 characters');
    if (!instructions || instructions.length > INSTRUCTIONS_MAX) throw new HubError('invalid', `instructions: 1-${INSTRUCTIONS_MAX} characters`);
    if (body.card !== undefined && (typeof body.card !== 'string' || body.card.length > CARD_MAX)) throw new HubError('invalid', `card: up to ${CARD_MAX} characters`);
    if (body.listed !== undefined && typeof body.listed !== 'boolean') throw new HubError('invalid', 'listed: true or false');
    return { name, instructions, ...(typeof body.card === 'string' ? { card: body.card.trim() } : {}), ...(typeof body.listed === 'boolean' ? { listed: body.listed } : {}) };
  }

  /**
   * `{key, name, instructions, card?, listed?}`: saves (or updates) one of the app's agents. Rooms name it by its key,
   * and each room side gets its own private copy of it. A listed agent with a card is found by search.
   */
  router.post('/agents', write, json(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = str(body.key) ?? '';
    const input = agentInput(key, body);
    const { created } = await hub.appAgents.set(appOf(req).id, key, input);
    if (created) res.status(201);
    return { key, name: input.name };
  }));

  router.put('/agents/:key', write, json(async (req, res) => {
    const key = String(req.params.key);
    const input = agentInput(key, (req.body ?? {}) as Record<string, unknown>);
    const { created } = await hub.appAgents.set(appOf(req).id, key, input);
    if (created) res.status(201);
    return { key, name: input.name };
  }));

  router.delete('/agents/:key', write, json(async (req) => {
    if (!(await hub.appAgents.remove(appOf(req).id, String(req.params.key)))) throw new HubError('not_found', 'No such agent');
    return { deleted: true };
  }));

  /**
   * `{query, limit?, exclude?}` → `{results: [{key, name, card, score, why}]}`: the app's listed agents ranked against
   * the query by their public cards (never their instructions), best first. The model call is charged to the app's maker.
   */
  router.post('/agents/search', read, json(async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (str(body.query) ?? '').trim();
    if (!query || query.length > 2000) throw new HubError('invalid', 'query: 1-2000 characters');
    const limit = body.limit === undefined ? 10 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HubError('invalid', 'limit: 1-50');
    const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.filter((k): k is string => typeof k === 'string') : []);
    if (!hub.agentRanker || !hub.llm) throw new HubError('unavailable', "This hub doesn't search agents");
    const app = (await hub.apps.get(appOf(req).id))!;
    if ((await hub.llm.used(app.createdBy)) >= 1) throw new HubError('rate_limited', "This app's AI allowance is used up this month");
    const pool = (await hub.appAgents.listed(app.id)).filter((a) => !exclude.has(a.key));
    const { ranked, usage } = await hub.agentRanker(query, pool.map((a) => ({ key: a.key, card: a.card! })));
    if (usage && hub.vertexPrices) await hub.llm.add(app.createdBy, costMicros(hub.vertexPrices, usage));
    const byKey = new Map(pool.map((a) => [a.key, a]));
    return { results: ranked.slice(0, limit).map((r) => ({ key: r.key, name: byKey.get(r.key)!.name, card: byKey.get(r.key)!.card, score: r.score, why: r.why })) };
  }));

  /** `{goal, sides: [{ref, name, brief, agent}] (two), metadata?}` → `{id, status}`: the talks start right away. */
  router.post('/rooms', write, json(async (req, res) => {
    const app = (await hub.apps.get(appOf(req).id))!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.sides)) throw new HubError('invalid', 'sides: two sides');
    const sides = [];
    for (const s of body.sides as Record<string, unknown>[]) {
      const agentKey = str(s?.agent) ?? '';
      // The app's own agents; templates saved before they had their own store live on the app.
      const own = KEY.test(agentKey) ? await hub.appAgents.get(app.id, agentKey) : undefined;
      const template = own ? { name: own.name, instructions: own.instructions } : app.agents?.[agentKey];
      if (!template) throw new HubError('invalid', `No agent "${agentKey}": make it with POST /v1/agents first`);
      sides.push({ ref: str(s.ref) ?? '', name: str(s.name) ?? '', brief: typeof s.brief === 'string' ? s.brief : '', template });
    }
    const owner = await hub.registry.get(app.createdBy);
    if (!owner || owner.archived) throw new HubError('unavailable', "This app's maker no longer has a Parly account");
    const { workspace, room } = await hub.rooms.openForApp(owner, app.id, { goal: str(body.goal) ?? '', sides, metadata: metadataOf(body.metadata) });
    await hub.talks.start(workspace.id).catch((err) => console.error('app room talks not started', err));
    res.status(201);
    return { id: workspace.id, status: room.closed ? 'closed' : 'talking' };
  }));

  /** The app's rooms, newest first; `?metadata.<key>=<value>` keeps the ones labelled so. */
  router.get('/rooms', read, json(async (req) => {
    const filters = Object.entries(req.query)
      .filter(([k]) => k.startsWith('metadata.'))
      .map(([k, v]) => [k.slice('metadata.'.length), String(v)] as const);
    const rooms = (await hub.registry.appRooms(appOf(req).id)).filter(
      (w) => !w.archived && filters.every(([k, v]) => w.room!.metadata?.[k] === v),
    );
    // ponytail: at most 100, newest first; add a cursor when an app needs more.
    return { rooms: await Promise.all(rooms.slice(0, 100).map((w) => view(w.id, w.room!))) };
  }));

  router.get('/rooms/:id', read, json(async (req) => {
    const { workspace, room } = await roomOf(hub, appOf(req).id, String(req.params.id));
    return view(workspace.id, room);
  }));

  /**
   * What one side may read: the shared channel and that side's own corner, oldest first, after `after` (an ISO time).
   * Never the other side's corner, and never a brief (briefs are not messages).
   */
  router.get('/rooms/:id/messages', read, json(async (req) => {
    const { room } = await roomOf(hub, appOf(req).id, String(req.params.id));
    const side = sideOf(room, String(req.query.side ?? ''));
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    const [shared, corner] = await Promise.all([hub.chat.store.inChannel(room.shared, 500), hub.chat.store.inChannel(side.corner, 500)]);
    const messages = [...shared.map((m) => ({ m, where: 'shared' as const })), ...corner.map((m) => ({ m, where: 'corner' as const }))]
      .filter(({ m }) => m.at > after)
      .sort((a, b) => a.m.at.localeCompare(b.m.at));
    return {
      messages: messages.map(({ m, where }) => ({ id: m.id, channel: where, from: m.from, at: m.at, text: textOf(m), ...(m.post ? { post: m.post } : {}) })),
    };
  }));

  /** Answers the decision a side's agent asked for (`decisionId`: that side's ref, from GET /v1/rooms/:id). */
  router.post('/rooms/:id/decisions/:decisionId', write, json(async (req) => {
    const { workspace, room } = await roomOf(hub, appOf(req).id, String(req.params.id));
    const side = sideOf(room, String(req.params.decisionId));
    await hub.talks.decideSide(workspace.id, side, str((req.body ?? {}).choice) ?? '');
    return { ok: true };
  }));

  /** `{version}`: the side approves the document's current version. Every side approving it: agreed. */
  router.post('/rooms/:id/sides/:ref/approve', write, json(async (req) => {
    const { workspace, room } = await roomOf(hub, appOf(req).id, String(req.params.id));
    const side = sideOf(room, String(req.params.ref));
    const version = (req.body ?? {}).version;
    if (typeof version !== 'number') throw new HubError('invalid', 'version is the document version you approve');
    const { agreed } = await hub.rooms.approveSide(room, workspace.id, side, { by: side.id, byName: side.name }, version);
    return { ok: true, agreed };
  }));

  router.post('/rooms/:id/close', write, json(async (req) => {
    const { workspace } = await roomOf(hub, appOf(req).id, String(req.params.id));
    await hub.rooms.close(workspace.id);
    await hub.roomEvent(workspace.id, 'room.closed');
    return { ok: true };
  }));
}
