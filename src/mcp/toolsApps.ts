import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import type { AgentRecord } from '../registry/types.js';

type AppToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
  headerAgent: AgentRecord | undefined;
};

/** Registers find_tools…connect_app when the caller is an owned non-cloud agent (moved out of server.ts). */
export function registerAppTools(server: McpServer, { hub, me, tool, headerAgent }: AppToolDeps): void {
  // Any agent with an owner (a coding tool they connected, a computer agent): the owner's connected apps, used on the hub
  // as the owner, so no app token reaches the agent. Not offered to cloud agents (they have these built in) nor to people.
  if (headerAgent && headerAgent.kind !== 'human' && headerAgent.ownerId && !headerAgent.cloud && !headerAgent.webhookChannel) {
    server.registerTool(
      'find_tools',
      {
        title: 'Find tools',
        description:
          "Searches the tools of the apps your owner connected and turned on for you (GitHub, Gmail, Jira, ...). Returns matching tools with what they do and their arguments. Call it before run_tool. If nothing is connected, it gives you the link to send your owner.",
        inputSchema: {
          query: z.string().optional().describe('What you want to do, e.g. "list open issues" or "send an email"'),
          queries: z.array(z.string()).optional().describe('Several things at once instead of query, e.g. ["get a pull request", "merge a pull request"]'),
          app: z.string().optional().describe('Optional: one app to search, e.g. "github"'),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      (args) => tool(async () => hub.appTool(await me(), 'find_tools', args)),
    );
    server.registerTool(
      'run_tool',
      {
        title: 'Run tool',
        description: 'Runs one tool that find_tools returned, as your owner, with its arguments. Pass fields to get only the parts of the result you need.',
        inputSchema: {
          tool: z.string().describe("The tool's slug, e.g. GITHUB_LIST_ISSUES"),
          arguments: z.record(z.string(), z.unknown()).optional().describe('Its arguments, as find_tools described them'),
          fields: z.array(z.string()).optional().describe('Only these fields of the result, found at any depth (e.g. ["title", "number"])'),
        },
        annotations: { openWorldHint: true },
      },
      (args) => tool(async () => hub.appTool(await me(), 'run_tool', args)),
    );
    server.registerTool(
      'connect_app',
      {
        title: 'Connect an app',
        description:
          'The link where your owner connects an app (GitHub, Gmail, ...) and turns it on for you. Send it to them when you need an app you don\'t have. Never ask anyone for passwords or tokens instead.',
        inputSchema: { app: z.string().optional().describe('The app you need, e.g. "github"') },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        tool(async () => ({
          link: hub.toolsLink(await me()),
          say: `To let me use ${args.app ?? 'an app'} for you, connect it and turn it on for me here: ${hub.toolsLink(await me())}`,
        })),
    );
  }
}
