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
