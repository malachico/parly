import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import type { AgentRecord } from '../registry/types.js';

type TriggerToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
  headerAgent: AgentRecord | undefined;
};

/** Registers find_triggers…stop_watching when the caller is a cloud/hosted agent (moved out of server.ts). */
export function registerTriggerTools(server: McpServer, { hub, me, tool, headerAgent }: TriggerToolDeps): void {
  // Agents Parly runs (cloud and computer) set up their own triggers when their owner asks in their DM ("tell me about
  // mails from x"); the hub refuses anyone else's asking (HubService.askedByOwner).
  if (headerAgent?.cloud || headerAgent?.hosted) {
    server.registerTool(
      'find_triggers',
      {
        title: 'Find triggers',
        description:
          "Finds what you can be told about in your owner's connected apps (a new email, a new pull request, a calendar event…), with each one's settings. Use it when your owner asks you to keep an eye on something, then call watch.",
        inputSchema: { query: z.string().describe('What to watch for, e.g. "new email" or "pull request opened"'), app: z.string().optional().describe('Optional: one app, e.g. "github"') },
        annotations: { readOnlyHint: true },
      },
      (args) => tool(async () => hub.triggerService.agentFindTriggers(await me(), args.query, args.app)),
    );
    server.registerTool(
      'watch',
      {
        title: 'Watch for something',
        description:
          'Turns on a trigger for you: from then on, each matching event comes to you as a message, and you act on it. Only when your owner asks you to, in your direct conversation with them. Tell them what you turned on.',
        inputSchema: {
          trigger: z.string().describe('The trigger, as find_triggers named it (e.g. GMAIL_NEW_GMAIL_MESSAGE)'),
          settings: z.record(z.string(), z.unknown()).optional().describe('Its settings, as find_triggers listed them (e.g. {"owner": "acme", "repo": "web"})'),
          mentions: z.string().optional().describe('Only events that mention this (any app)'),
          from: z.string().optional().describe('Emails only: only from this sender (part of the address or name)'),
          subject: z.string().optional().describe('Emails only: only with this in the subject'),
          channel: z.string().optional().describe('Post the events in this channel of yours (its name), for the team to see; else in your DM with your owner'),
          task: z.string().optional().describe("What your owner wants you to do with each event, in their words (e.g. \"check if it's a user-facing feature; send me a draft post for #Build-in-public\")"),
        },
      },
      (args) => tool(async () => hub.triggerService.agentWatch(await me(), args)),
    );
    server.registerTool(
      'watching',
      {
        title: 'What you watch',
        description: 'Your triggers: what each one watches for, its filters, and how often it has fired.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => tool(async () => hub.triggerService.agentWatching(await me())),
    );
    server.registerTool(
      'stop_watching',
      {
        title: 'Stop watching',
        description: 'Turns one of your triggers off (its id from watching). Only when your owner asks you to, in your direct conversation with them.',
        inputSchema: { id: z.string() },
      },
      (args) => tool(async () => hub.triggerService.agentStopWatching(await me(), args.id)),
    );
  }
}
