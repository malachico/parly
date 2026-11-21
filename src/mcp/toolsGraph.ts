import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { threadKey } from '../chat/chat.js';
import { type MergedNode, mergedReadableGraph } from '../graph/acl.js';
import { conversationFilter, type GraphEdgeDoc, type GraphNodeDoc } from '../graph/store.js';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';

type GraphToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>) => Promise<CallToolResult>;
};

const SEARCH_POOL = 50;
const RELATED_MAX = 50;

// One entry per entity (duplicates merged), each readable source's text kept apart under it.
const nodeView = (n: MergedNode) => ({ id: n.id, kind: n.kind, title: n.title, sources: n.sources.map((s) => ({ conversation: s.conversationId, ...(s.text ? { text: s.text } : {}) })) });
const edgeView = (e: GraphEdgeDoc) => ({ kind: e.kind, from: e.from, to: e.to });

/** Registers find_decisions and related when the context graph is on; hidden otherwise, like web_search. */
export function registerGraphTools(server: McpServer, { hub, me, tool }: GraphToolDeps): void {
  const graph = hub.graph;
  const search = hub.graphSearch;
  if (!graph || !search) return;
  /** The one permission gate: everything these tools return passes graph/acl.ts for the caller. */
  const visible = (caller: AgentRecord, nodes: GraphNodeDoc[], edges: GraphEdgeDoc[] = []) => mergedReadableGraph(caller, hub.chat, { nodes, edges });

  server.registerTool(
    'find_decisions',
    {
      title: 'Find decisions',
      description:
        'Searches the decisions your team made in the conversations you can read (the context graph), best match first. ' +
        'Use it before re-deciding something or to find why something is the way it is; then `related` for what a decision touches.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('What the decision was about.'),
        channel: z.string().optional().describe('Only this channel and its threads (id or name, one you are in).'),
        limit: z.number().int().positive().max(20).optional().describe('Most to return (default 10).'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const ch = args.channel ? await hub.registry.resolveMemberChannel(caller, args.channel) : undefined;
        // Decisions in the caller's channels are filtered in the query, so other matches can't crowd them out of the pool.
        const scopes = ch ? [{ workspaceId: ch.workspaceId, channelId: ch.id }] : caller.workspaces.map((workspaceId) => ({ workspaceId, channelIds: caller.channels ?? [] }));
        const results = await Promise.all(scopes.map((s) => search(s, args.query, { limit: SEARCH_POOL, kind: 'decision' })));
        const score = new Map(results.flatMap((r) => r.hits).filter((h) => h.kind === 'decision').map((h) => [h.nodeId, h.score]));
        const docs = await graph.nodes(caller.workspaces, { _id: { $in: [...score.keys()] }, kind: 'decision' }, score.size || 1);
        const { nodes } = await visible(caller, docs);
        const decisions = nodes.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)).slice(0, args.limit ?? 10).map(nodeView);
        return { decisions };
      }),
  );

  server.registerTool(
    'related',
    {
      title: 'Related entries',
      description:
        'What the context graph links to an entry: give a decision or entry `id` (from find_decisions), or a `channel` and `thread` ' +
        "(the post's message id) for what was recorded in that thread. Returns the entries and the links between them you can read.",
      inputSchema: {
        id: z.string().optional().describe('An entry id from find_decisions or related.'),
        channel: z.string().optional().describe('With thread: a channel you are in (id or name).'),
        thread: z.string().optional().describe("With channel: the post's message id."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
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
        const ids = new Set((await visible(caller, seen)).nodes.flatMap((n) => n.sources.map((s) => s.nodeId)));
        const edges = await graph.edgesOf(caller.workspaces, [...ids], RELATED_MAX * 2, { fromConversationId: readable, toConversationId: readable });
        const ends = [...new Set(edges.flatMap((e) => [e.from, e.to]))].filter((id) => !ids.has(id));
        const others = ends.length ? await withDupes(await graph.nodes(caller.workspaces, { _id: { $in: ends }, conversationId: readable }, ends.length)) : [];
        // An edge shows only when both of its ends do (acl.ts), and only between the entries returned.
        const out = await visible(caller, [...seen.filter((n) => ids.has(n._id)), ...others.filter((n) => !ids.has(n._id))], edges);
        const nodes = out.nodes.slice(0, RELATED_MAX);
        const kept = new Set(nodes.map((n) => n.id));
        return { nodes: nodes.map(nodeView), edges: out.edges.filter((e) => kept.has(e.from) && kept.has(e.to)).map(edgeView) };
      }),
  );
}
