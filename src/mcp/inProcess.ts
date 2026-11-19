import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { HubService } from '../hub/hubService.js';
import type { AgentRecord } from '../registry/types.js';
import { buildServer, type Turn } from './server.js';

/**
 * Parly's MCP tools used in-process by the hub's own cloud agents: the same server every agent talks to, bound to
 * the agent, without HTTP. A curated set: what a teammate needs in a turn (not long polls, uploads or account changes).
 */
const CLOUD_MCP_TOOLS = [
  'whoami',
  'list_agents',
  'list_conversations',
  'read_thread',
  'send_message',
  'reply',
  'get_file',
  'set_status',
  'schedule_message',
  'list_schedules',
  'update_schedule',
  'room_document',
  // A room's agents write the agreed terms there; without it a hosted room never reaches "agreed".
  'update_room_document',
  'create_skill',
  'update_skill',
  'delete_skill',
  'attach_skill',
  'detach_skill',
  'list_skills',
  'get_skill',
  // Its own triggers, set up when its owner asks in their DM (the hub checks who's asking).
  'find_triggers',
  'watch',
  'watching',
  'stop_watching',
];

async function connected(hub: HubService, agent: AgentRecord | undefined, turn?: Turn): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(hub, agent, undefined, turn).connect(serverSide);
  const client = new Client({ name: 'parly-cloud-agent', version: '1' });
  await client.connect(clientSide);
  return client;
}

/** The curated tools' names, descriptions and JSON input schemas (the same for every agent). */
export async function listMcpTools(hub: HubService): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
  // Listed as a cloud agent would see them: some tools are registered only for agents Parly runs.
  const client = await connected(hub, { id: 'cloud-agent-tools', name: 'Cloud agent', kind: 'endpoint', cloud: true } as unknown as AgentRecord);
  try {
    const { tools } = await client.listTools();
    return tools.filter((t) => CLOUD_MCP_TOOLS.includes(t.name)).map((t) => {
      // Vertex takes plain JSON Schema: no $schema marker.
      const { $schema: _s, ...inputSchema } = t.inputSchema as Record<string, unknown>;
      return { name: t.name, description: t.description, inputSchema };
    });
  } finally {
    await client.close();
  }
}

/** Calls one of them as `agent`: its text result (as the agent would read it), or the error. */
export async function callMcpTool(hub: HubService, agent: AgentRecord, name: string, args: Record<string, unknown>, turn?: Turn): Promise<unknown> {
  if (!CLOUD_MCP_TOOLS.includes(name)) return { ok: false, error: `No Parly tool ${name}` };
  const client = await connected(hub, agent, turn);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return result.isError ? { ok: false, error: text } : { ok: true, result: text };
  } finally {
    await client.close();
  }
}
