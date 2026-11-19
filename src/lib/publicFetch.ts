import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateHost } from '../registry/registry.js';

type Lookup = typeof dnsLookup;

/**
 * A `fetch` that only connects to public addresses. Checking a hostname's text isn't enough: a public
 * name can resolve (or rebind, between a check and the connect) to an internal IP. Here the check runs
 * inside the DNS lookup the connection itself uses, on every address returned, so what's validated is
 * exactly what's dialed. IP literals skip DNS and are refused by isPrivateHost before the call.
 */
export function makePublicFetch(lookup: Lookup = dnsLookup): typeof fetch {
  const dispatcher = new Agent({
    connect: {
      lookup: ((hostname: string, options: { all?: boolean }, callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err);
          const list = addresses as LookupAddress[];
          // Refuse if any address is private, so a mixed answer can't steer the connect inward.
          const inner = list.find((a) => isPrivateHost(a.address));
          if (!list.length || inner) return callback(new Error(`${hostname} resolves to a private address; the hub only calls public ones`));
          if (options.all) return callback(null, list);
          callback(null, list[0]!.address, list[0]!.family);
        });
      }) as never,
    },
  });
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (isPrivateHost(url.hostname)) return Promise.reject(new Error(`Refusing to call private address ${url.host}`));
    return undiciFetch(url, { ...(init as object), dispatcher } as never);
  }) as unknown as typeof fetch;
}

/** The public-only fetch a deployed hub uses toward agents and their token endpoints. */
export const publicFetch = makePublicFetch();

/** Reads a response body up to `max` bytes, cancelling the stream past it, so a huge body is never buffered whole. */
export async function readBodyCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    if (!reader) break;
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
    if (total > max) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { bytes: Buffer.concat(chunks).subarray(0, max), truncated };
}
