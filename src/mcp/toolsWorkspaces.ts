import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import { agentView, workspaceView } from '../lib/present.js';
import type { AgentRecord } from '../registry/types.js';

type WorkspaceToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
};

/** Registers create_workspace…leave_workspace and archive_workspace (moved out of server.ts). */
export function registerWorkspaceTools(server: McpServer, { hub, me, tool }: WorkspaceToolDeps): void {
  server.registerTool(
    'create_workspace',
    {
      title: 'Create workspace',
      description:
        'People only: creates a workspace with you as owner. Everyone in a workspace can see and message each other. ' +
        'Invite people with invite_to_workspace, add bots with add_to_workspace, then make channels with create_channel. ' +
        'Your plan caps how many workspaces you own; past it this fails with a message saying so.',
      inputSchema: { name: z.string().describe('Display name for the workspace.') },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        return workspaceView(await hub.registry.createWorkspace(caller, args.name), caller);
      }),
  );

  server.registerTool(
    'invite_to_workspace',
    {
      title: 'Invite to workspace',
      description:
        'Adds a person to a workspace you belong to, by email: if they already signed in with Google they join now, ' +
        'otherwise on their first Google sign-in (the invite lasts 30 days); the reply is the same either way. ' +
        "A pending invite takes a seat: the owner's plan caps a workspace's participants (people and bots), and a full workspace refuses with a message saying so.",
      inputSchema: {
        workspace: z.string().describe('Workspace id or name.'),
        email: z.string(),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const workspace = await hub.registry.inviteToWorkspace(caller, args.workspace, args.email);
        return { ok: true, workspace: workspaceView(workspace, caller), note: `${args.email} is in ${workspace.name} now, or will be on their first Google sign-in.` };
      }),
  );

  server.registerTool(
    'add_to_workspace',
    {
      title: 'Add bot to workspace',
      description:
        'Adds a bot you can see (your own, a public one, or one from a workspace you share; an id from list_agents) to a workspace you belong to. ' +
        'People are invited by email instead (invite_to_workspace). The bot takes a seat under the owner\'s plan cap.',
      inputSchema: {
        workspace: z.string().describe('Workspace id or name.'),
        agent: z.string().describe('Id of the bot to add.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const { workspace, agent } = await hub.registry.addToWorkspace(caller, args.workspace, args.agent);
        return { ok: true, workspace: workspaceView(workspace, caller), agent: agentView(agent), note: `${agent.name} is in ${workspace.name} now.` };
      }),
  );

  server.registerTool(
    'leave_workspace',
    {
      title: 'Leave workspace',
      description: 'Leaves a workspace and every channel of it you are in (the workspace creator cannot leave; co-owners can).',
      inputSchema: { workspace: z.string().describe('Workspace id.') },
      annotations: { destructiveHint: true },
    },
    (args) =>
      tool(async () => {
        await hub.registry.leaveWorkspace(await me(), args.workspace);
        return { ok: true };
      }),
  );

  server.registerTool(
    'archive_workspace',
    {
      title: 'Archive workspace',
      description:
        'Workspace owner only: archives a workspace. It keeps its history and members but its channels take no new posts; ' +
        'archived: false restores it. Your last remaining workspace cannot be archived.',
      inputSchema: {
        workspace: z.string().describe('Workspace id.'),
        archived: z.boolean().optional().describe('Default true; false restores.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const workspace = await hub.registry.setWorkspaceArchived(caller, args.workspace, args.archived ?? true);
        if ((args.archived ?? true) && workspace.room) await hub.roomEvent(workspace.id, 'room.closed');
        return workspaceView(workspace, caller);
      }),
  );
}
