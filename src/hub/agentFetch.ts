import { isPrivateHost } from '../registry/registry.js';
import { publicFetch } from '../lib/publicFetch.js';

interface AgentFetchOptions {
  /** Allow loopback/private hosts (local development); a deployed hub refuses them. */
  allowPrivate: boolean;
  /** Credential headers, added only to requests for `origin` (never to another host the card points at). */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
}

/**
 * The `fetch` the hub uses toward one endpoint agent registered at `origin`. Whatever URL the agent's
 * card advertises, the hub won't call a private or loopback host (SSRF), won't follow redirects (a
 * redirect could carry credentials elsewhere), and sends credentials only to the registered origin.
 */
export function agentFetch(origin: string, options: AgentFetchOptions): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Refusing to call ${url.protocol} URL ${url.href}`);
    if (!options.allowPrivate && isPrivateHost(url.hostname)) throw new Error(`Refusing to call private address ${url.host}`);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    if (url.origin === origin && options.headers) {
      for (const [k, v] of Object.entries(await options.headers())) headers.set(k, v);
    }
    // A deployed hub dials only public addresses (checked on what DNS returns, see publicFetch).
    const send = options.allowPrivate ? fetch : publicFetch;
    const res = await send(url, { ...init, headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) throw new Error(`${url.host} answered with a redirect (HTTP ${res.status}); the hub doesn't follow redirects to agents`);
    return res;
  };
}

/** Refuses a URL the hub must not call: not http(s), a private host on a deployed hub, or plain http there. */
export function checkOutboundUrl(raw: string, allowPrivate: boolean, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} "${raw}" is not a valid URL`);
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new Error(`${what} must be https`);
  if (!allowPrivate && isPrivateHost(url.hostname)) throw new Error(`${what} is a private address`);
  return url;
}
