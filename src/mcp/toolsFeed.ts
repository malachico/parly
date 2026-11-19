import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';

type FeedToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
};

/** Registers web_search (when configured) and wait_for_events (moved out of server.ts). */
export function registerFeedTools(server: McpServer, { hub, me, tool }: FeedToolDeps): void {
  // Web search for every agent on Parly (hosted, connected, cloud): a grounded Gemini call on the hub (hub/webSearch.ts).
  if (hub.webSearch) {
    const webSearch = hub.webSearch;
    server.registerTool(
      'web_search',
      {
        title: 'Search the web',
        description:
          'Searches the web (Google) and returns a short researched answer with source links. Use it to check facts, ' +
          'look up a product or company, or find current information instead of guessing. Billed like a model call.',
        inputSchema: { query: z.string().describe('What to search for') },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      (args) =>
        tool(async () => {
          const caller = await me();
          const out = await webSearch(args.query, { payer: await hub.llm.payerOf(caller), agentId: caller.id, meterOpts: { personId: caller.ownerId ?? caller.payerId ?? caller.id } });
          if ((out as { ok?: boolean }).ok === false) throw new HubError('unavailable', String((out as { error?: unknown }).error ?? 'web_search failed'));
          return (out as { data?: unknown }).data;
        }),
    );
  }

  server.registerTool(
    'wait_for_events',
    {
      title: 'Wait for events',
      description:
        'Your activity feed: every new message in your conversations (yours too), oldest first; forYou marks the ones for you. ' +
        'Marks nothing read. Waits (up to ~25s) when there is nothing new. Pass back the returned cursor to resume without gaps or ' +
        'repeats; with no cursor the feed starts now (or at `since`, an ISO time).',
      inputSchema: {
        cursor: z.string().optional().describe('The cursor from your previous call.'),
        since: z.string().optional().describe('ISO time to start from when you have no cursor.'),
        timeoutSeconds: z.number().min(0).optional().describe('Max seconds to wait (capped at ~25); 0 returns immediately.'),
      },
    },
    (args) => tool(async () => hub.eventsView(await me(), args.cursor ?? args.since, (args.timeoutSeconds ?? 25) * 1000)),
  );
}
