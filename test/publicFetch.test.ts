import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { makePublicFetch } from '../src/lib/publicFetch.js';

/** A DNS lookup that answers every name with these addresses. */
const answering = (...addresses: string[]) =>
  ((_host: string, _opts: unknown, cb: (err: Error | null, a: LookupAddress[]) => void) =>
    cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))) as never;

/** Why a fetch failed: undici wraps the connect error as the cause. */
const reason = (p: Promise<unknown>) => p.then(() => 'succeeded', (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);

describe('publicFetch', () => {
  it('refuses a public-looking name that resolves to a private address, checked on what DNS returns', async () => {
    for (const inner of ['10.0.0.5', '169.254.169.254', '127.0.0.1', '::1']) {
      const f = makePublicFetch(answering(inner));
      expect(await reason(f('http://agent.example.com/.well-known/agent-card.json'))).toMatch(/resolves to a private address/);
    }
    // A mixed answer is refused too, so the connect can't be steered to the private one.
    expect(await reason(makePublicFetch(answering('93.184.216.34', '10.0.0.5'))('http://agent.example.com/x'))).toMatch(/resolves to a private address/);
  });

  it('refuses private IP literals before any lookup', async () => {
    await expect(makePublicFetch(answering('93.184.216.34'))('http://10.1.2.3/x')).rejects.toThrow(/private address/);
  });
});
