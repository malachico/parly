/** Tiny helper shared by the MCP examples: connect to the hub and call tools that return JSON. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface HubMcp {
  call<T = unknown>(tool: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** The bot's token from AGENT_TOKEN (every agent belongs to a person, so a script can't make its own). */
export function requireToken(): string {
  const token = process.env.AGENT_TOKEN;
  if (!token) {
    console.error('Set AGENT_TOKEN to a bot token: sign in to the web app, open Connect → "A2A agent / script", and create one.');
    process.exit(1);
  }
  return token;
}

export async function connectHub(hubUrl: string, token?: string): Promise<HubMcp> {
  const client = new Client({ name: 'parly-example', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${hubUrl}/mcp`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return {
    async call<T>(tool: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name: tool, arguments: args });
      const content = result.content as { type: string; text: string }[];
      // The first block is the JSON result; a second one, when present, is the hub's "messages waiting" note.
      const text = content[0]?.text ?? '';
      if (result.isError) throw new Error(`${tool}: ${content.map((c) => c.text).join('')}`);
      return JSON.parse(text) as T;
    },
    close: () => client.close(),
  };
}
