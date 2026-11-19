import type { Request, Response } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { CallbackError, EVENT_DEFINITIONS } from './events.js';

/**
 * MCP's stateless revision (2026-07-28), alongside the SDK's handshake-based one: a request that carries its protocol
 * version in `_meta` (or the MCP-Protocol-Version header) is "modern". server/discover and events/* are answered here;
 * any other modern request goes on to the SDK as a legacy one, and its result gets the fields modern clients expect.
 * ponytail: dual-era by hand until the SDK speaks 2026-07-28.
 */
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const SUPPORTED = [MODERN, LEGACY, '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'parly', version: '0.2.0' };
const META = 'io.modelcontextprotocol/';

/** Handles a modern request (true), or leaves it to the legacy path (false). */
export async function handleModern(hub: HubService, req: Request, res: Response): Promise<boolean> {
  const body = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | undefined;
  if (!body || Array.isArray(body) || typeof body.method !== 'string') return false;
  const meta = body.params?._meta;
  const metaVersion = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>)[`${META}protocolVersion`] : undefined;
  const version = (typeof metaVersion === 'string' ? metaVersion : undefined) ?? (req.header('mcp-protocol-version') === MODERN ? MODERN : undefined);
  if (!version || body.method === 'initialize') return false;
  if (!SUPPORTED.includes(version)) {
    res.status(400).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED, requested: version } } });
    return true;
  }
  if (version !== MODERN) return false;

  const reply = (result: Record<string, unknown>) => res.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: SERVER_INFO } } });
  const fail = (code: number, message: string, data?: unknown) => res.json({ jsonrpc: '2.0', id: body.id, error: { code, message, ...(data ? { data } : {}) } });
  const caller = agentOf(req);
  try {
    switch (body.method) {
      case 'server/discover':
        reply({ supportedVersions: SUPPORTED, capabilities: { tools: {}, events: {} }, instructions: 'Parly: a chat for people and AI agents. Call whoami first.', ttlMs: 3600_000, cacheScope: 'public' });
        return true;
      case 'events/list':
        reply({ events: EVENT_DEFINITIONS });
        return true;
      case 'events/subscribe':
        if (!caller) throw new HubError('unauthorized', 'Sign in first');
        reply(await hub.mcpEvents.subscribe(caller, body.params ?? {}));
        return true;
      case 'events/unsubscribe':
        if (!caller) throw new HubError('unauthorized', 'Sign in first');
        reply(await hub.mcpEvents.unsubscribe(caller, body.params ?? {}));
        return true;
    }
  } catch (err) {
    if (err instanceof CallbackError) fail(-32015, 'CallbackEndpointError', { reason: err.reason, detail: err.message });
    else if (err instanceof HubError) fail(-32602, err.message);
    else throw err;
    return true;
  }

  // Anything else (tools/list, tools/call, …): the SDK answers it as a legacy request; the result gets resultType,
  // our serverInfo, and the list's cache fields.
  setHeader(req, 'mcp-protocol-version', LEGACY);
  if (!String(req.headers.accept ?? '').includes('text/event-stream')) setHeader(req, 'accept', 'application/json, text/event-stream');
  // The SDK may write the JSON in pieces: collect them, and send the amended result once at the end.
  const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const end = res.end.bind(res) as (chunk?: unknown, ...rest: unknown[]) => Response;
  const chunks: Buffer[] = [];
  const asBuffer = (c: unknown) => (Buffer.isBuffer(c) ? c : typeof c === 'string' ? Buffer.from(c) : c instanceof Uint8Array ? Buffer.from(c) : undefined);
  const patched = res as unknown as { write: typeof write; end: typeof end; writeHead: (...args: unknown[]) => Response };
  // The amended body is longer: drop the SDK's content-length and let Node frame it.
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  patched.writeHead = (...args: unknown[]) => {
    res.removeHeader('content-length');
    for (const a of args) {
      if (Array.isArray(a)) for (let k = a.length - 2; k >= 0; k -= 2) if (String(a[k]).toLowerCase() === 'content-length') a.splice(k, 2);
      if (a && typeof a === 'object' && !Array.isArray(a)) for (const key of Object.keys(a)) if (key.toLowerCase() === 'content-length') delete (a as Record<string, unknown>)[key];
    }
    return writeHead(...args);
  };
  patched.write = (chunk: unknown, ...rest: unknown[]) => {
    const b = asBuffer(chunk);
    if (!b) return write(chunk, ...rest);
    chunks.push(b);
    return true;
  };
  patched.end = (chunk?: unknown, ...rest: unknown[]) => {
    const b = asBuffer(chunk);
    if (b) chunks.push(b);
    const all = Buffer.concat(chunks).toString('utf8');
    let out = all;
    try {
      const msg = JSON.parse(all) as { result?: Record<string, unknown> };
      if (msg.result) {
        msg.result = { resultType: 'complete', ...msg.result, _meta: { ...((msg.result._meta as object) ?? {}), [`${META}serverInfo`]: SERVER_INFO } };
        if (body.method === 'tools/list') Object.assign(msg.result, { ttlMs: 300_000, cacheScope: 'private' });
        out = JSON.stringify(msg);
      }
    } catch {
      /* not JSON (an SSE stream): pass it through as it was */
    }
    if (!res.headersSent) res.setHeader('content-length', Buffer.byteLength(out));
    if (out) write(out);
    return end(...(typeof rest[0] === 'function' ? [rest[0]] : []));
  };
  return false;
}

/** Sets a request header both where Express reads it and in the raw list the SDK's transport reads. */
function setHeader(req: Request, name: string, value: string): void {
  req.headers[name] = value;
  const raw = req.rawHeaders;
  const i = raw.findIndex((h, k) => k % 2 === 0 && h.toLowerCase() === name);
  if (i >= 0) raw[i + 1] = value;
  else raw.push(name, value);
}
