import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import type { AgentRecord } from '../registry/types.js';

type RoomToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
};

/** Registers room_document and update_room_document (moved out of server.ts). */
export function registerRoomTools(server: McpServer, { hub, me, tool }: RoomToolDeps): void {
  server.registerTool(
    'room_document',
    {
      title: 'Read a room document',
      description:
        "A shared room's document (what its sides work out together), with its version and which sides approved it. " +
        'The room is the workspace id of its channel (the channel\'s workspaceId on a message).',
      inputSchema: { room: z.string().describe('The room\'s workspace id.') },
    },
    (args) => tool(async () => hub.rooms.document(await me(), args.room)),
  );

  server.registerTool(
    'update_room_document',
    {
      title: 'Write a room document',
      description:
        "Writes a new version of a shared room's document, on top of `base`, the version you read (0 for the first). " +
        "If someone wrote a newer one meanwhile you get a conflict: read it, merge, write again. Any change clears the sides' approvals; " +
        'only people approve, in the web app.',
      inputSchema: {
        room: z.string().describe('The room\'s workspace id.'),
        text: z.string().describe('The whole document (Markdown).'),
        base: z.number().int().describe('The version you read; 0 for the first.'),
      },
    },
    (args) => tool(async () => hub.rooms.writeDocument(await me(), args.room, args.text, args.base)),
  );
}
