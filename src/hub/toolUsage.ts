import type { Database } from '../db/types.js';
import { HubStore } from './hubStore.js';

/** `toolUsage/{agentId}|{toolkit}`: how an agent has used one of its owner's apps, for "Apps & triggers". */
export interface ToolUse {
  ownerId: string;
  agentId: string;
  toolkit: string;
  uses: number;
  failures?: number;
  lastAt: string;
  lastTool: string;
}

/** A tool an agent found (find_tools), kept so it can run it again later without looking for it. */
export interface KnownTool {
  tool: string;
  app: string;
  does?: string;
  /** Its arguments, compacted: name → type, and the required ones. */
  arguments?: { properties: Record<string, string>; required?: string[] };
  writes?: boolean;
}

/** How many tools an agent remembers (newest first). */
const KNOWN_MAX = 20;

/** An argument schema as just names and types (and what's required): enough to call it, a fraction of the size. */
export function compactArgs(schema: unknown): KnownTool['arguments'] {
  const s = (schema ?? {}) as { properties?: Record<string, { type?: unknown }>; required?: unknown };
  const properties = Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, typeof v?.type === 'string' ? v.type : 'any']));
  const required = Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : [];
  return { properties, ...(required.length ? { required } : {}) };
}

export class ToolUsage {
  private readonly store: HubStore;

  constructor(db: Database) {
    this.store = new HubStore(db);
  }

  /** One run_tool: counted, with the last time and tool, and kept in its history (tool, time, outcome; never arguments or results). */
  async record(ownerId: string, agentId: string, toolkit: string, tool: string, ok: boolean): Promise<void> {
    const at = new Date().toISOString();
    await this.store.recordToolUse(ownerId, agentId, toolkit, tool, ok, at, new Date(Date.now() + 90 * 86_400_000));
  }

  /** An agent's latest uses of one app, newest first; retained for 90 days. */
  async history(agentId: string, toolkit: string, limit = 25): Promise<{ at: string; tool: string; ok: boolean }[]> {
    return this.store.toolUseHistory(agentId, toolkit, limit);
  }

  /** The tools an agent found, newest first (at most KNOWN_MAX). */
  async known(agentId: string): Promise<KnownTool[]> {
    return this.store.knownTools(agentId);
  }

  /** Keeps tools an agent just found: newest first, one each, KNOWN_MAX at most. */
  async remember(agentId: string, tools: KnownTool[]): Promise<void> {
    if (!tools.length) return;
    await this.store.rememberTools(agentId, tools, KNOWN_MAX, new Date().toISOString());
  }

  async ofOwner(ownerId: string): Promise<ToolUse[]> {
    return this.store.toolUsesOfOwner(ownerId);
  }
}
