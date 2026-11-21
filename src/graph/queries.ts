import { parseKey, threadKey } from '../chat/chat.js';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';
import { type MergedNode, mergedReadableGraph } from './acl.js';
import { conversationFilter, type GraphEdgeDoc, type GraphNodeDoc } from './store.js';

/**
 * The context graph's reads, shared by the agent tools (mcp/toolsGraph.ts) and the web's routes (rest/conversations.ts).
 * Each passes graph/acl.ts for the caller, so nothing it returns comes from a conversation the caller can't read,
 * and each is empty when the graph is off.
 */
const SEARCH_POOL = 50;
const RELATED_MAX = 50;

/** The one permission gate. */
const visible = (hub: HubService, caller: AgentRecord, nodes: GraphNodeDoc[], edges: GraphEdgeDoc[] = []) => mergedReadableGraph(caller, hub.chat, { nodes, edges });

/** Decisions matching `query` in the conversations the caller can read (or one channel of theirs), best match first. */
export async function findDecisions(hub: HubService, caller: AgentRecord, query: string, opts: { channel?: string; limit?: number } = {}): Promise<MergedNode[]> {
  const { graph, graphSearch: search } = hub;
  if (!graph || !search) return [];
  const ch = opts.channel ? await hub.registry.resolveMemberChannel(caller, opts.channel) : undefined;
  // Decisions in the caller's channels are filtered in the query, so other matches can't crowd them out of the pool.
  const scopes = ch ? [{ workspaceId: ch.workspaceId, channelId: ch.id }] : caller.workspaces.map((workspaceId) => ({ workspaceId, channelIds: caller.channels ?? [] }));
  const results = await Promise.all(scopes.map((s) => search(s, query, { limit: SEARCH_POOL, kind: 'decision' })));
  // Only ids and scores from the hits: their titles and text are unchecked.
  const score = new Map(results.flatMap((r) => r.hits).filter((h) => h.kind === 'decision').map((h) => [h.nodeId, h.score]));
  const docs = await graph.nodes(caller.workspaces, { _id: { $in: [...score.keys()] }, kind: 'decision' }, score.size || 1);
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
  const readable = conversationFilter({ workspaceId: '', channelIds: caller.channels ?? [] });
  // A node with its duplicates (same canonicalId), so an entry gets the same merged id however it is reached.
  const withDupes = async (docs: GraphNodeDoc[]) => {
    const groups = [...new Set(docs.flatMap((n) => (n.canonicalId ? [n.canonicalId] : [])))];
    const dupes = groups.length ? await graph.nodes(caller.workspaces, { canonicalId: { $in: groups }, conversationId: readable }, RELATED_MAX) : [];
    return [...docs, ...dupes.filter((d) => !docs.some((n) => n._id === d._id))];
  };
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
