import { parseKey, threadKey } from '../chat/chat.js';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';
import { type MergedNode, mergedReadableGraph } from './acl.js';
import { conversationFilter, type GraphEdgeDoc, type GraphNodeDoc, type GraphNodeKind } from './store.js';

/**
 * The context graph's reads, shared by the agent tools (mcp/toolsGraph.ts) and the web's routes (rest/conversations.ts).
 * Each passes graph/acl.ts for the caller, so nothing it returns comes from a conversation the caller can't read,
 * and each is empty when the graph is off.
 */
const SEARCH_POOL = 50;
const RELATED_MAX = 50;

/** The one permission gate. */
const visible = (hub: HubService, caller: AgentRecord, nodes: GraphNodeDoc[], edges: GraphEdgeDoc[] = []) => mergedReadableGraph(caller, hub.chat, { nodes, edges });

/** Every read is limited to the caller's channels in the query, so unreadable rows can't take up the caps. Not the gate: `visible` is. */
const readableFilter = (caller: AgentRecord) => conversationFilter({ workspaceId: '', channelIds: caller.channels ?? [] });

/** `docs` with their duplicates (same canonicalId), so an entry gets the same merged id however it is reached. */
async function withReadableDupes(hub: HubService, caller: AgentRecord, docs: GraphNodeDoc[]): Promise<GraphNodeDoc[]> {
  const groups = [...new Set(docs.flatMap((n) => (n.canonicalId ? [n.canonicalId] : [])))];
  const dupes = groups.length && hub.graph ? await hub.graph.nodes(caller.workspaces, { canonicalId: { $in: groups }, conversationId: readableFilter(caller) }, RELATED_MAX) : [];
  return [...docs, ...dupes.filter((d) => !docs.some((n) => n._id === d._id))];
}

/** Decisions matching `query` in the conversations the caller can read (or one channel of theirs), best match first. */
export const findDecisions = (hub: HubService, caller: AgentRecord, query: string, opts: { channel?: string; limit?: number } = {}) =>
  searchEntries(hub, caller, query, { ...opts, kind: 'decision' });

/** Entries (of `kind`, or any) matching `query` in the conversations the caller can read (or one channel of theirs), best match first. */
export async function searchEntries(hub: HubService, caller: AgentRecord, query: string, opts: { channel?: string; workspaceId?: string; limit?: number; kind?: GraphNodeKind } = {}): Promise<MergedNode[]> {
  const { graph, graphSearch: search } = hub;
  if (!graph || !search) return [];
  const ch = opts.channel ? await hub.registry.resolveMemberChannel(caller, opts.channel) : undefined;
  // Entries in the caller's channels are filtered in the query, so other matches can't crowd them out of the pool.
  const scopes = ch ? [{ workspaceId: ch.workspaceId, channelId: ch.id }] : (opts.workspaceId ? [opts.workspaceId] : caller.workspaces).map((workspaceId) => ({ workspaceId, channelIds: caller.channels ?? [] }));
  const results = await Promise.all(scopes.map((s) => search(s, query, { limit: SEARCH_POOL, kind: opts.kind })));
  // Only ids and scores from the hits: their titles and text are unchecked.
  const score = new Map(results.flatMap((r) => r.hits).filter((h) => !opts.kind || h.kind === opts.kind).map((h) => [h.nodeId, h.score]));
  const docs = await graph.nodes(caller.workspaces, { _id: { $in: [...score.keys()] }, ...(opts.kind ? { kind: opts.kind } : {}) }, score.size || 1);
  const { nodes } = await visible(hub, caller, docs);
  return nodes.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)).slice(0, opts.limit ?? 10);
}

/** A channel's (and its threads') most recently updated decisions the caller can read, newest first. */
export async function channelDecisions(hub: HubService, caller: AgentRecord, channel: string, limit: number): Promise<MergedNode[]> {
  const graph = hub.graph;
  if (!graph) return [];
  const ch = await hub.registry.resolveMemberChannel(caller, channel);
  const rank = new Map((await graph.recentDecisions(ch.workspaceId, ch.id, limit)).map((d, i) => [d.id, i]));
  const docs = await graph.nodes([ch.workspaceId], { _id: { $in: [...rank.keys()] } }, rank.size || 1);
  const { nodes } = await visible(hub, caller, docs);
  // nodes() sorts by id, and an entry's id may not be its newest row's.
  const at = (n: MergedNode) => Math.min(...n.sources.map((s) => rank.get(s.nodeId) ?? Infinity));
  return nodes.sort((a, b) => at(a) - at(b));
}

/** What the graph links to an entry (`id`), or to what was recorded in a thread (`channel` + `thread`). */
export async function relatedEntries(hub: HubService, caller: AgentRecord, args: { id?: string; channel?: string; thread?: string; kinds?: string[] }) {
  const graph = hub.graph;
  if (!graph) return { nodes: [], edges: [] };
  // Every read is limited to the caller's channels in the query, so unreadable rows can't take up the caps.
  const readable = readableFilter(caller);
  const withDupes = (docs: GraphNodeDoc[]) => withReadableDupes(hub, caller, docs);
  let start: GraphNodeDoc[];
  if (args.id) start = await graph.nodes(caller.workspaces, { _id: args.id, conversationId: readable }, 1);
  else if (args.channel && args.thread) {
    const ch = await hub.registry.resolveMemberChannel(caller, args.channel);
    start = await graph.nodes([ch.workspaceId], { conversationId: threadKey(ch.id, args.thread) }, RELATED_MAX);
  } else throw new HubError('invalid', 'Give an id, or a channel and a thread.');
  // Unreadable starts look exactly like unknown ones.
  const seen = await withDupes(start);
  const ids = new Set((await visible(hub, caller, seen)).nodes.flatMap((n) => n.sources.map((s) => s.nodeId)));
  const edges = await graph.edgesOf(caller.workspaces, [...ids], RELATED_MAX * 2, { fromConversationId: readable, toConversationId: readable });
  const ends = [...new Set(edges.flatMap((e) => [e.from, e.to]))].filter((id) => !ids.has(id));
  const others = ends.length ? await withDupes(await graph.nodes(caller.workspaces, { _id: { $in: ends }, conversationId: readable }, ends.length)) : [];
  // An edge shows only when both of its ends do (acl.ts), and only between the entries returned.
  const out = await visible(hub, caller, [...seen.filter((n) => ids.has(n._id)), ...others.filter((n) => !ids.has(n._id))], edges);
  // `kinds` filters before the cap, so other kinds never crowd out the ones asked for.
  const nodes = out.nodes.filter((n) => !args.kinds || args.kinds.includes(n.kind as string)).slice(0, RELATED_MAX);
  const kept = new Set(nodes.map((n) => n.id));
  return { nodes, edges: out.edges.filter((e) => kept.has(e.from) && kept.has(e.to)) };
}

/** An entry as the web shows it: each source as the chat key and thread the web links to. */
export const webNodeView = (n: MergedNode) => ({
  id: n.id,
  workspaceId: n.workspaceId,
  kind: n.kind,
  title: n.title,
  sources: n.sources.map((s) => {
    const k = parseKey(s.conversationId);
    return { key: `channel:${k.kind === 'dm' ? '' : k.channelId}`, ...(k.kind === 'thread' ? { thread: k.post } : {}), ...(s.text ? { text: s.text } : {}) };
  }),
});

export const GRAPH_KINDS: GraphNodeKind[] = ['decision', 'person', 'topic', 'doc', 'skill'];
const NODE_MAX = 30;

/** An entry as the explorer shows it: each source as the channel, thread and messages the web deep-links to. */
export const explorerNodeView = (n: MergedNode) => ({
  id: n.id,
  workspaceId: n.workspaceId,
  kind: n.kind as GraphNodeKind,
  title: n.title,
  ...(n.sources.find((s) => s.text) ? { summary: n.sources.find((s) => s.text)!.text } : {}),
  sources: n.sources.map((s) => {
    const k = parseKey(s.conversationId);
    return { channelId: k.kind === 'dm' ? '' : k.channelId, ...(k.kind === 'thread' ? { thread: k.post } : {}), messageIds: s.messageIds ?? [] };
  }),
});
export type ExplorerNode = ReturnType<typeof explorerNodeView>;

/**
 * The caller's readable entries (of `kind`, in `channel` or one `workspace` of theirs), newest first, or best match first with `q`, and how many of each kind there are.
 * `cursor` is an offset; search has no next page.
 */
export async function listEntries(hub: HubService, caller: AgentRecord, args: { channel?: string; workspace?: string; kind?: GraphNodeKind; q?: string; limit: number; cursor?: number }) {
  const graph = hub.graph;
  if (!graph) return { entries: [], counts: {}, nextCursor: null };
  const ch = args.channel ? await hub.registry.resolveMemberChannel(caller, args.channel) : undefined;
  const ws = args.workspace ? (await hub.registry.resolveMemberWorkspace(caller, args.workspace)).id : undefined;
  if (ch && ws && ch.workspaceId !== ws) throw new HubError('not_found', 'No such channel in that workspace.');
  const workspaces = ch ? [ch.workspaceId] : ws ? [ws] : caller.workspaces;
  // Channel and thread conversations of the caller's channels: what the ACL lets them read, minus DMs and skills.
  const scope = { conversationId: ch ? conversationFilter({ workspaceId: ch.workspaceId, channelId: ch.id }) : readableFilter(caller) };
  const counts = await graph.countByKind(workspaces, scope);
  if (args.q) return { entries: (await searchEntries(hub, caller, args.q, { channel: args.channel, workspaceId: ws, kind: args.kind, limit: args.limit })).map(explorerNodeView), counts, nextCursor: null };
  const skip = args.cursor ?? 0;
  // ponytail: offset paging, so a node updated between pages can repeat or be skipped; keyset on (updatedAt, _id) if that shows.
  const page = await graph.nodes(workspaces, { ...scope, ...(args.kind ? { kind: args.kind } : {}) }, args.limit, { newestFirst: true, skip });
  const rank = new Map(page.map((n, i) => [n._id, i]));
  const { nodes } = await visible(hub, caller, await withReadableDupes(hub, caller, page));
  // A group may show up on more than one page (its members' updatedAt differ); within a page it is one entry, at its newest member.
  const at = (n: MergedNode) => Math.min(...n.sources.map((s) => rank.get(s.nodeId) ?? Infinity));
  const entries = nodes.filter((n) => at(n) < Infinity).sort((a, b) => at(a) - at(b)).map(explorerNodeView);
  return { entries, counts, nextCursor: page.length === args.limit ? String(skip + page.length) : null };
}

/**
 * One entry with what the graph links to it: its direct neighbours grouped by relation, and (depth 2) theirs, up to 30 entries.
 * Each hop goes through `relatedEntries`, so each is read-checked on its own. Not found if the caller can't read it.
 */
export async function nodeDetails(hub: HubService, caller: AgentRecord, id: string, depth: 1 | 2) {
  const first = await relatedEntries(hub, caller, { id });
  const node = first.nodes.find((n) => n.sources.some((s) => s.nodeId === id));
  if (!node) throw new HubError('not_found', 'No such graph entry.');
  const nodes = new Map<string, MergedNode>([[node.id, node]]);
  const near = first.nodes.filter((n) => n.id !== node.id);
  for (const n of near.slice(0, NODE_MAX - 1)) nodes.set(n.id, n);
  let edges = first.edges;
  if (depth === 2) {
    for (const n of near) {
      if (nodes.size >= NODE_MAX) break;
      const next = await relatedEntries(hub, caller, { id: n.id });
      edges = [...edges, ...next.edges];
      for (const m of next.nodes) if (nodes.size < NODE_MAX && !nodes.has(m.id)) nodes.set(m.id, m);
    }
  }
  const seen = new Set<string>();
  const kept = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to) && !seen.has(`${e.kind}\u0000${e.from}\u0000${e.to}`) && seen.add(`${e.kind}\u0000${e.from}\u0000${e.to}`));
  const neighbours: Record<string, { id: string; direction: 'out' | 'in' }[]> = {};
  for (const e of kept) {
    if (e.from === node.id && e.to !== node.id) (neighbours[e.kind] ??= []).push({ id: e.to, direction: 'out' });
    else if (e.to === node.id && e.from !== node.id) (neighbours[e.kind] ??= []).push({ id: e.from, direction: 'in' });
  }
  return {
    node: explorerNodeView(node),
    neighbours,
    nodes: [...nodes.values()].filter((n) => n.id !== node.id).map(explorerNodeView),
    edges: kept.map((e) => ({ kind: e.kind, from: e.from, to: e.to })),
  };
}
