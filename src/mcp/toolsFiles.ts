import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { fileView } from '../files/files.js';
import type { HubService } from '../hub/hubService.js';
import type { AgentRecord } from '../registry/types.js';

type FileToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
};

/** Registers upload_file…get_file (moved out of server.ts). */
export function registerFileTools(server: McpServer, { hub, me, tool }: FileToolDeps): void {
  server.registerTool(
    'upload_file',
    {
      title: 'Upload file',
      description:
        'Uploads a small file (up to 5MB) so you can attach it: pass the returned id in "files" on send_message or reply. ' +
        'Only people who can read a message a file is attached to can download it. For bigger files use create_upload.',
      inputSchema: {
        name: z.string().describe('File name, e.g. "report.pdf".'),
        mediaType: z.string().optional().describe('MIME type, e.g. "application/pdf" (default application/octet-stream).'),
        contentBase64: z.string().describe('The file\'s bytes, base64-encoded.'),
      },
    },
    (args) => tool(async () => hub.files.uploadInline(await me(), args)),
  );

  server.registerTool(
    'create_upload',
    {
      title: 'Create upload',
      description:
        'Starts an upload of any size up to the hub\'s limit (25MB by default): returns a URL to PUT the bytes to, with the exact headers to send. ' +
        'Then call complete_upload, and attach the file id with "files" on send_message or reply.',
      inputSchema: {
        name: z.string(),
        mediaType: z.string().optional(),
        size: z.number().int().positive().describe('Exact size in bytes.'),
        md5: z.string().describe('Base64 MD5 of the bytes (e.g. `openssl md5 -binary f | base64`).'),
      },
    },
    (args) => tool(async () => hub.files.create(await me(), args)),
  );

  server.registerTool(
    'complete_upload',
    {
      title: 'Complete upload',
      description: 'Call after PUTting the bytes from create_upload; the file is attachable once the hub has checked them.',
      inputSchema: { fileId: z.string() },
    },
    (args) => tool(async () => hub.files.complete(await me(), args.fileId)),
  );

  server.registerTool(
    'get_file',
    {
      title: 'Get file',
      description: 'A short-lived download link for a file attached to a message you can read (or one you uploaded).',
      inputSchema: { fileId: z.string() },
    },
    (args) =>
      tool(async () => {
        const file = await hub.fileForDownload(await me(), args.fileId);
        return { ...fileView(file), url: await hub.files.downloadUrl(file), expiresInSeconds: 300 };
      }),
  );
}
