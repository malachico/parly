import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import { agentView, channelView, workspaceView } from '../lib/present.js';
import type { AgentRecord } from '../registry/types.js';
import { fieldsArg, project } from './toolsMessaging.js';

type IdentityToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
  identified: (agent: AgentRecord) => AgentRecord;
  clientIp?: string;
};

/** Registers register_agent, whoami, list_agents, archive_agent, and rotate_token (moved out of server.ts). */
export function registerIdentityTools(
  server: McpServer,
  { hub, me, tool, identified, clientIp }: IdentityToolDeps,
): void {
  server.registerTool(
    'register_agent',
    {
      title: 'Update registration',
      description:
        'Updates how you appear on the hub: display name (names need not be unique), description, skills, visibility. ' +
        'Give a url only if you run an A2A server; otherwise you keep a mailbox and receive messages via check_inbox / wait_for_message. ' +
        'You are private unless public is true: only people and agents in your workspaces can find or message you. ' +
        'You are already identified (by your sign-in or token); this never creates a new agent.',
      inputSchema: {
        name: z.string().describe('Display name, any text up to 64 characters, e.g. "Research Bot". Others see it; your id is what identifies you.'),
        description: z.string().optional().describe('What you do and what you work on (e.g. which repo or project), so other agents know when to message you.'),
        skills: z
          .array(z.object({ id: z.string(), name: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional() }))
          .optional()
          .describe(
            'Capabilities you offer; others can route by skill id or tag. Look at your tools and list what you can do for others with them, ' +
              'e.g. {id: "email", name: "Send email", tags: ["gmail"]} or {id: "deploy", name: "Deploy to Vercel"}. ' +
              'Describe capabilities, not raw tool names, and leave out anything you would not do on another agent\'s request.',
          ),
        url: z.string().optional().describe('Base URL of your A2A server (its agent card is fetched from /.well-known/agent-card.json).'),
        credential: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'What your A2A server requires, if anything (checked against your card): {type:"bearer",token} | {type:"basic",username,password} | ' +
              '{type:"apiKey",header,value} | {type:"oauth2",clientId,clientSecret,scopes}. Never shown back.',
          ),
        public: z
          .boolean()
          .optional()
          .describe('List yourself in the open directory so any agent can find and message you. Default false (your workspaces only).'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        // Its owner connected a wake to this bot by name; a client signed in as it isn't a new agent to name.
        if (caller.wake && args.name !== caller.name) throw new HubError('invalid', `You keep the name ${caller.name}: your owner connected you to something that wakes you, so only they rename you. If someone asked you to connect to Parly, you already are, as ${caller.name}: tell them so.`);
        const { agent } = await hub.registry.register(
          { name: args.name, description: args.description, skills: args.skills, url: args.url, credential: args.credential, public: args.public },
          caller,
          clientIp,
        );
        identified(agent);
        return { agent: agentView(agent), note: 'Registration updated.' };
      }),
  );

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Shows the agent you are identified as, your workspaces, and the channels you are in.',
      inputSchema: { routine: z.string().max(200).optional().describe('Only when a Parly Routine fire gives you a code: connects that Routine to you') },
    },
    (args) =>
      tool(async () => {
        const caller = args.routine ? await hub.wakeService.claimRoutine(await me(), args.routine) : await me();
        const [workspaces, channels] = await Promise.all([hub.registry.workspacesOf(caller), hub.registry.channelsOf(caller)]);
        return {
          ...agentView(caller),
          workspaces: workspaces.map((w) => workspaceView(w, caller, { channels: channels.filter((c) => c.workspaceId === w.id).map((c) => channelView(c, caller, w)) })),
        };
      }),
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description:
        'Lists the agents you can message: public agents plus everyone in your workspaces. Filter by free-text query, skill, workspace id or channel id. ' +
        'kind "mailbox" agents pick messages up when they poll; lastSeen shows when they were last active.',
      inputSchema: {
        query: z.string().optional().describe('Matches name, description, and skills.'),
        skill: z.string().optional().describe('Exact skill id, name, or tag.'),
        workspace: z.string().optional().describe('Only members of this workspace (id from whoami).'),
        channel: z.string().optional().describe('Only members of this channel (id from whoami).'),
        fields: fieldsArg,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      tool(async () => {
        const agents = await hub.registry.search(await me(), { query: args.query, skill: args.skill, workspace: args.workspace, channel: args.channel });
        const roles = args.channel ? await hub.registry.channelRolesFor(await me(), args.channel) : undefined;
        return project(agents.map((a) => ({ ...agentView(a), ...(roles?.[a.id] ? { role: roles[a.id] } : {}) })), args.fields);
      }),
  );

  server.registerTool(
    'archive_agent',
    {
      title: 'Archive agent',
      description:
        'Archives a bot: yourself, or a bot in a workspace you own. An archived bot is hidden everywhere, receives no messages, ' +
        'and its token stops working. A workspace owner restores it with archived: false.',
      inputSchema: {
        agent: z.string().optional().describe('Agent id. Omit to archive yourself.'),
        archived: z.boolean().optional().describe('Default true.'),
      },
      annotations: { destructiveHint: true },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        return agentView(await hub.registry.setArchived(caller, args.agent ?? caller.id, args.archived ?? true));
      }),
  );

  server.registerTool(
    'rotate_token',
    {
      title: 'Rotate token',
      description:
        'Issues you a new agent token. The old token, and any OAuth sign-in acting as you, stop working immediately; ' +
        'put the new token in your MCP config (or sign in again).',
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    () =>
      tool(async () => ({
        token: await hub.registry.rotateToken(await me()),
        note: 'Save this token; it is not shown again. The old one no longer works.',
      })),
  );
}
