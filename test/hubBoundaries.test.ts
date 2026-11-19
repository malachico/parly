import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { agentFetch } from '../src/hub/agentFetch.js';
import { domainOf, normalizeDomain } from '../src/lib/domains.js';
import { parseSealingKey, seal, unseal } from '../src/lib/sealing.js';

/**
 * Direct coverage for a few hub trust boundaries called out in review #95.
 * Larger untested modules (skills/workspaces/channels/…) are deferred.
 */
describe('sealing', () => {
  it('round-trips, refuses a wrong key or unknown format, and validates CREDENTIALS_KEY', () => {
    const key = randomBytes(32);
    const sealed = seal('very-secret', key);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(unseal(sealed, key)).toBe('very-secret');
    expect(() => unseal(sealed, randomBytes(32))).toThrow();
    expect(() => unseal('plain', key)).toThrow(/Unknown sealed format/);
    expect(parseSealingKey(undefined)).toBeUndefined();
    expect(parseSealingKey(key.toString('base64'))).toEqual(key);
    expect(() => parseSealingKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('domains', () => {
  it('normalizes workspace domains and refuses public mail providers', () => {
    expect(domainOf('Ada@Acme.TEST')).toBe('acme.test');
    expect(normalizeDomain(' @ACME.test ')).toBe('acme.test');
    expect(() => normalizeDomain('gmail.com')).toThrow(/public mail provider/);
    expect(() => normalizeDomain('not a domain')).toThrow(/not a valid domain/);
    expect(() => normalizeDomain('')).toThrow(/not a valid domain/);
  });
});

describe('agentFetch', () => {
  const servers: Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  const listen = () =>
    new Promise<{ origin: string; server: Server }>((resolve) => {
      const server = createServer();
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        resolve({ origin: `http://127.0.0.1:${port}`, server });
      });
    });

  it('refuses private hosts on a deployed hub and never follows redirects', async () => {
    await expect(agentFetch('http://127.0.0.1:9', { allowPrivate: false })('http://127.0.0.1:9/card')).rejects.toThrow(
      /private address/,
    );

    const { origin, server } = await listen();
    server.on('request', (_req, res) => res.writeHead(302, { location: 'https://evil.example/steal' }).end());
    await expect(agentFetch(origin, { allowPrivate: true })(`${origin}/card`)).rejects.toThrow(/doesn't follow redirects/);
  });

  it('adds credentials only for the registered origin', async () => {
    const a = await listen();
    const b = await listen();
    const seen: { url: string; auth: string | null }[] = [];
    for (const { origin, server } of [a, b]) {
      server.on('request', (req, res) => {
        seen.push({ url: `${origin}${req.url}`, auth: req.headers.authorization ?? null });
        res.writeHead(200).end('ok');
      });
    }
    const fetchAgent = agentFetch(a.origin, {
      allowPrivate: true,
      headers: () => ({ authorization: 'Bearer sekret' }),
    });
    await fetchAgent(`${a.origin}/card`);
    await fetchAgent(`${b.origin}/elsewhere`);
    expect(seen).toEqual([
      { url: `${a.origin}/card`, auth: 'Bearer sekret' },
      { url: `${b.origin}/elsewhere`, auth: null },
    ]);
  });
});
