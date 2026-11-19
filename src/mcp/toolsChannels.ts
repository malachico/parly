import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import { agentView, channelView } from '../lib/present.js';
import type { AgentRecord } from '../registry/types.js';

type ChannelToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
};

/** Registers create_channel…add_channel_owner, update_channel, and set_channel_role (moved out of server.ts). */
export function registerChannelTools(server: McpServer, { hub, me, tool }: ChannelToolDeps): void {
  server.registerTool(
    'create_channel',
    {
      title: 'Create channel',
      description:
        'Creates a channel in a workspace you belong to, with you as owner and first member. Add members from the workspace with add_to_channel; ' +
        'post to it with send_message and "channel".',
      inputSchema: {
        workspace: z.string().describe('Workspace id or name.'),
        name: z.string().describe('Display name for the channel.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        return channelView(await hub.registry.createChannel(caller, args.workspace, args.name), caller);
      }),
  );

  server.registerTool(
    'add_to_channel',
    {
      title: 'Add to channel',
      description:
        'Adds a member of the channel\'s workspace (a person or a bot, by id from list_agents) to a channel you are in. ' +
        'Someone outside the workspace is invited (people) or added (bots) to the workspace first.',
      inputSchema: {
        channel: z.string().describe('Channel id or name.'),
        agent: z.string().describe('Id of the agent or person to add.'),
        workspace: z.string().optional().describe('With a channel name: the workspace (id or name) it is in, if the name is not unique across your workspaces.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const { channel, agent } = await hub.registry.addToChannel(caller, args.channel, args.agent, args.workspace);
        return { ok: true, channel: channelView(channel, caller), agent: agentView(agent), note: `${agent.name} is in ${channel.name} now.` };
      }),
  );

  server.registerTool(
    'leave_channel',
    {
      title: 'Leave channel',
      description: 'Leaves a channel (the channel creator cannot leave; co-owners can).',
      inputSchema: { channel: z.string().describe('Channel id.') },
      annotations: { destructiveHint: true },
    },
    (args) =>
      tool(async () => {
        await hub.registry.leaveChannel(await me(), args.channel);
        return { ok: true };
      }),
  );

  server.registerTool(
    'remove_from_channel',
    {
      title: 'Remove from channel',
      description: 'Channel or workspace owner only: removes an agent from the channel.',
      inputSchema: { channel: z.string().describe('Channel id.'), agent: z.string().describe('Member agent id.') },
      annotations: { destructiveHint: true },
    },
    (args) =>
      tool(async () => {
        await hub.registry.removeFromChannel(await me(), args.channel, args.agent);
        return { ok: true };
      }),
  );

  server.registerTool(
    'add_channel_owner',
    {
      title: 'Add channel owner',
      description: 'Channel or workspace owner only: makes another member a co-owner of the channel, with the same rights as you.',
      inputSchema: { channel: z.string().describe('Channel id.'), agent: z.string().describe('Member agent id.') },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        return channelView(await hub.registry.addChannelOwner(caller, args.channel, args.agent), caller);
      }),
  );

  server.registerTool(
    'update_channel',
    {
      title: 'Update channel',
      description:
        'Channel or workspace owner only: renames a channel, archives it, opens it to the workspace or makes it public. An archived ' +
        'channel keeps its history and members but takes no new posts; archived: false restores it. A public channel can be read by ' +
        'anyone at <web>/p/<channel id>, from when it went public on. context sets what the channel is for (purpose, links, standing ' +
        'rules, up to 1000 characters): every agent there gets it with each message; "" clears it.',
      inputSchema: {
        channel: z.string().describe('Channel id.'),
        name: z.string().optional().describe('New name.'),
        archived: z.boolean().optional().describe('true archives, false restores.'),
        open: z.boolean().optional().describe('true: anyone in the workspace can find and join it; false: only members add others.'),
        public: z
          .boolean()
          .optional()
          .describe('true: anyone on the internet, signed in or not, can read what is said from now on (and its files); false: private again. With thread: just that thread.'),
        done: z
          .boolean()
          .optional()
          .describe('With thread: true marks that post\'s thread as done (stops agent work and hides from open feed), false reopens it.'),
        thread: z.string().optional().describe("A post's message id: with public, shares only that post's thread (all of it, at <web>/p/<channel id>?thread=<post>), or stops; with done, marks the thread as done or reopens it."),
        context: z.string().optional().describe('What the channel is for: purpose, links (repo, site), standing rules. Up to 1000 characters; "" clears it.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        if (args.thread) {
          if (args.public === undefined && args.done === undefined) throw new HubError('invalid', 'With thread, give public: true or false, or done: true or false');
          let ch = args.public !== undefined ? await hub.setThreadPublic(caller, args.channel, args.thread, args.public) : undefined;
          if (args.done !== undefined) ch = await hub.setThreadDone(caller, args.channel, args.thread, args.done);
          return channelView(ch!, caller);
        }
        // Public from the newest message on, as PATCH /channels/:id does: what was said before stays private.
        const publicFromSeq = args.public === true ? await hub.chat.channelSeq(args.channel) : args.public === false ? null : undefined;
        return channelView(await hub.registry.updateChannel(caller, args.channel, { name: args.name, archived: args.archived, open: args.open, publicFromSeq, context: args.context }), caller);
      }),
  );

  server.registerTool(
    'set_channel_role',
    {
      title: 'Set channel role',
      description:
        'Channel or workspace owner only (people and bots alike): gives a member a role in the channel, e.g. "reviewer" or "architect", ' +
        'or clears it with an empty role. A role tells everyone what is expected of that member; it grants and blocks nothing.',
      inputSchema: {
        channel: z.string().describe('Channel id.'),
        agent: z.string().describe('Member agent id.'),
        role: z.string().max(40).describe('The role, up to 40 characters; empty clears it.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        return channelView(await hub.registry.setChannelRole(caller, args.channel, args.agent, args.role), caller);
      }),
  );
}
