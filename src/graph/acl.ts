import type { ChatService } from '../chat/chatService.js';
import type { AgentRecord } from '../registry/types.js';

/** What the filter needs of a stored node (graph_nodes) or edge (graph_edges); anything else on them passes through. */
export interface GraphNodeAcl { _id: string; workspaceId: string; conversationId: string }
export interface GraphEdgeAcl { workspaceId: string; from: string; to: string; fromConversationId: string; toConversationId: string }

/**
 * The part of a graph result `reader` may see; every graph read goes through this. A node is visible when it is in
 * one of the reader's workspaces and the reader can read the conversation it came from (ChatService.canRead). An
 * edge is visible only when both its end nodes are in `graph.nodes` and visible, so an edge into a hidden
 * conversation never reveals that end: pass the end nodes along with any edges you want shown.
 * Only conversations count: a node from anything else (a room side's brief lives in room_briefs, not in a
 * conversation) is hidden from everyone. Fails closed: a missing field hides the item.
 */
export async function readableGraph<N extends GraphNodeAcl, E extends GraphEdgeAcl>(
  reader: AgentRecord,
  chat: Pick<ChatService, 'readableConversations'>,
  graph: { nodes: N[]; edges: E[] },
): Promise<{ nodes: N[]; edges: E[] }> {
  const workspaces = new Set(reader.workspaces ?? []);
  const inWorkspace = (x: { workspaceId: string }) => typeof x.workspaceId === 'string' && workspaces.has(x.workspaceId);
  const nodes = graph.nodes.filter(inWorkspace);
  const edges = graph.edges.filter(inWorkspace);
  const readable = await chat.readableConversations(reader, [
    ...nodes.map((n) => n.conversationId),
    ...edges.flatMap((e) => [e.fromConversationId, e.toConversationId]),
  ].filter((id) => typeof id === 'string'));
  // A node hidden here hides every copy of its id, so one readable copy can't vouch for a hidden one.
  const hidden = new Set(graph.nodes.filter((n) => !inWorkspace(n) || !readable.has(n.conversationId)).map((n) => n._id));
  const visible = nodes.filter((n) => typeof n._id === 'string' && !hidden.has(n._id));
  const shown = new Set(visible.map((n) => n._id));
  return {
    nodes: visible,
    // An edge needs both end nodes in the result and visible: its recorded conversations are a second check, never the only one.
    edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to) && readable.has(e.fromConversationId) && readable.has(e.toConversationId)),
  };
}

/** One entry per canonical entity: duplicates (same canonicalId) folded together, each source's text kept apart under it. */
export interface MergedNode {
  id: string;
  workspaceId: string;
  kind?: string;
  title?: string;
  sources: { nodeId: string; conversationId: string; title?: string; text?: string }[];
}

/**
 * readableGraph, then duplicates folded into one entry each (GraphStore gives a duplicate person or topic its
 * group's canonicalId). Merging runs only over what the reader can see, so an entry's title and sources come from
 * readable conversations alone: a source the reader can't read adds nothing, not even its existence. Edges move to
 * their ends' entries, one per (kind, from, to).
 */
export async function mergedReadableGraph<N extends GraphNodeAcl & { canonicalId?: string; kind?: string; title?: string; text?: string }, E extends GraphEdgeAcl & { kind?: string }>(
  reader: AgentRecord,
  chat: Pick<ChatService, 'readableConversations'>,
  graph: { nodes: N[]; edges: E[] },
): Promise<{ nodes: MergedNode[]; edges: (E & { from: string; to: string })[] }> {
  const { nodes, edges } = await readableGraph(reader, chat, graph);
  // The entry id is its smallest visible member id, not canonicalId: that hashes the group's first key, which may be a hidden source's name.
  const firstOf = new Map<string, string>();
  for (const n of nodes) {
    const g = n.canonicalId ?? n._id;
    if (!firstOf.has(g) || n._id < firstOf.get(g)!) firstOf.set(g, n._id);
  }
  const entryOf = new Map(nodes.map((n) => [n._id, firstOf.get(n.canonicalId ?? n._id)!]));
  const merged = new Map<string, MergedNode>();
  for (const n of nodes) {
    const id = entryOf.get(n._id)!;
    const entry = merged.get(id) ?? merged.set(id, { id, workspaceId: n.workspaceId, kind: n.kind, title: n.title, sources: [] }).get(id)!;
    // The longest visible name is the fullest ("Dana Levi" over "Dana").
    if ((n.title?.length ?? 0) > (entry.title?.length ?? 0)) entry.title = n.title;
    entry.sources.push({ nodeId: n._id, conversationId: n.conversationId, title: n.title, text: n.text });
  }
  const seen = new Set<string>();
  return {
    nodes: [...merged.values()],
    edges: edges.map((e) => ({ ...e, from: entryOf.get(e.from)!, to: entryOf.get(e.to)! })).filter((e) => {
      const k = `${e.kind}\u0000${e.from}\u0000${e.to}`;
      return !seen.has(k) && !!seen.add(k);
    }),
  };
}
