import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { MergedNode } from '../graph/acl.js';
import { findDecisions, relatedEntries } from '../graph/queries.js';
import type { GraphEdgeDoc } from '../graph/store.js';
import type { HubService } from '../hub/hubService.js';
import type { AgentRecord } from '../registry/types.js';

type GraphToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>) => Promise<CallToolResult>;
};

// One entry per entity (duplicates merged), each readable source's text kept apart under it.
const nodeView = (n: MergedNode) => ({ id: n.id, kind: n.kind, title: n.title, sources: n.sources.map((s) => ({
  conversation: s.conversationId, ...(s.text ? { text: s.text } : {}),
  // ponytail: the first 5 cited messages; page them if agents need the rest.
  ...(s.messageIds?.length ? { messageIds: s.messageIds.slice(0, 5) } : {}), createdAt: s.createdAt, updatedAt: s.updatedAt,
})) });
const edgeView = (e: GraphEdgeDoc) => ({ kind: e.kind, from: e.from, to: e.to });

/** Registers find_decisions and related when the context graph is on; hidden otherwise, like web_search. */
export function registerGraphTools(server: McpServer, { hub, me, tool }: GraphToolDeps): void {
  if (!hub.graph || !hub.graphSearch) return;

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
    (args) => tool(async () => ({ decisions: (await findDecisions(hub, await me(), args.query, args)).map(nodeView) })),
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
        const { nodes, edges } = await relatedEntries(hub, await me(), args);
        return { nodes: nodes.map(nodeView), edges: edges.map(edgeView) };
      }),
  );
}
