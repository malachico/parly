import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { WORKSPACE_COOKIE } from './routes';
import { authToken } from './auth-cookie';
import { clientIpFromHeaders } from './clientIp';
import type { BillingView, Conversation, Me, Workspace } from './hub-types';

export * from './hub-types';
export * from './hub-auth';

/** Server-only client for the Parly hub REST API. The browser never talks to the hub directly. */

/** The hub's base URL, as this server reaches it (and as a connection code tells a person's tool to). */
export const HUB_URL = (process.env.HUB_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
/**
 * Hub URL safe to put in the browser or public docs (llms.txt). Falls back to HUB_URL when unset —
 * on docker set HUB_PUBLIC_URL to the LAN/localhost address, not http://hub:8080 (#37).
 */
export const HUB_PUBLIC_URL = (process.env.HUB_PUBLIC_URL ?? HUB_URL).replace(/\/+$/, '');
const PROXY_SECRET = process.env.HUB_PROXY_SECRET;

/** Relays the visitor's IP so the hub's per-IP limits apply per person, not to this server as a whole. */
async function relayHeaders(): Promise<Record<string, string>> {
  if (!PROXY_SECRET) return {};
  const ip = clientIpFromHeaders(await headers());
  return ip ? { 'x-hub-client-ip': ip, 'x-hub-proxy-secret': PROXY_SECRET } : {};
}

export { channelKey, agentKey } from './routes';

/** Splits a conversation key: "channel:<channelId>" or "agent:<agentId>". */
export function parseConversationKey(key: string): { kind: 'channel' | 'agent'; id: string } | undefined {
  const first = key.indexOf(':');
  const head = key.slice(0, first);
  if ((head === 'channel' || head === 'agent') && first < key.length - 1) return { kind: head, id: key.slice(first + 1) };
  return undefined;
}

/** A non-2xx hub response. Plan caps use status 402 with `code: 'PLAN_LIMIT'`. */
export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly limit?: 'participants' | 'workspaces',
    readonly count?: number,
    readonly max?: number,
    readonly plan?: string,
  ) {
    super(message);
  }
}

export async function token(): Promise<string | undefined> {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  return authToken(jar, requestHeaders.get('host') ?? '');
}

/** A hub call slower than this is logged, to find what makes pages slow. */
const SLOW_HUB_MS = 500;
/** Hang the page rather than wait forever when the hub is wedged (#18). */
export const HUB_FETCH_TIMEOUT_MS = 15_000;

/**
 * Calls the hub as the logged-in human (if any). Throws HubError on a non-2xx response.
 * `revalidate` (seconds) shares one cached response across visitors, but only for an anonymous GET (`as: ''`):
 * it never caches anything fetched with someone's token. Shared fetches skip the visitor's IP relay (it would key the cache per visitor).
 */
export function hub<T>(path: string, init: HubInit = {}): Promise<T> {
  const memo = requestMemo();
  if ((init.method ?? 'GET') !== 'GET' || init.body !== undefined) {
    memo.clear(); // a write makes this request's earlier reads stale (a server action reading again after it)
    return request<T>(path, init);
  }
  const key = `${init.as ?? '\u0001'}\u0000${init.revalidate ?? ''}\u0000${path}`;
  let p = memo.get(key);
  if (!p) {
    p = request<T>(path, init);
    memo.set(key, p);
    p.catch(() => memo.get(key) === p && memo.delete(key)); // a failure isn't remembered: asking again retries
  }
  return p as Promise<T>;
}

type HubInit = { method?: string; body?: unknown; as?: string; revalidate?: number };

/**
 * Identical GETs within one server request share one hub call (a layout, its page and their components often ask for the same thing).
 * React's cache() scopes the map to the request, so nothing is shared across requests or people; outside a request it's a fresh map each call.
 * Callers get the same object: treat hub results as read-only.
 */
const requestMemo = cache(() => new Map<string, Promise<unknown>>());

async function request<T>(path: string, init: HubInit): Promise<T> {
  const bearer = init.as ?? (await token());
  const shared = Boolean(init.revalidate) && !bearer && (init.method ?? 'GET') === 'GET';
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${HUB_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(shared ? {} : await relayHeaders()), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      ...(shared ? { next: { revalidate: init.revalidate } } : { cache: 'no-store' as const }),
      signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new HubError(503, `Can't reach the hub at ${HUB_URL}`);
  }
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    code?: string;
    limit?: 'participants' | 'workspaces';
    count?: number;
    max?: number;
    plan?: string;
  };
  // ponytail: slow hub calls in the runtime logs; a real trace (OpenTelemetry) if this stops being enough
  const ms = Date.now() - started;
  if (ms > SLOW_HUB_MS) console.warn(`slow hub call: ${init.method ?? 'GET'} ${path.split('?')[0]} ${res.status} ${ms}ms`);
  if (!res.ok) throw new HubError(res.status, body.error ?? `Hub returned HTTP ${res.status}`, body.code, body.limit, body.count, body.max, body.plan);
  return body;
}

/** The person's billing, asked once per request (the canvas home and the panel beside it both show it). */
export const myBilling = cache(() => hub<BillingView>('/me/billing'));

/** My conversations (in one workspace: its channels and direct messages with its members), cached per request so the rail and pages share one hub call. */
export const myConversations = cache(
  async (workspaceId?: string): Promise<Conversation[]> =>
    hub<Conversation[]>(`/conversations?${new URLSearchParams({ limit: '100', ...(workspaceId ? { workspace: workspaceId } : {}) })}`).catch(() => []),
);

/**
 * The workspace to open when none is in the URL: the one from the cookie if I'm still in it,
 * else my first. Undefined only for someone in no workspace at all (the hub makes one on sign-in).
 */
export async function currentWorkspace(user: Me): Promise<Workspace | undefined> {
  const remembered = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  return user.workspaces.find((w) => w.id === remembered && !w.archived) ?? user.workspaces.find((w) => !w.archived) ?? user.workspaces[0];
}
