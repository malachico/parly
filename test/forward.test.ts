import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startEchoAgent } from '../examples/echo-agent.js';
import { A2AForwarder } from '../src/hub/forward.js';
import type { AgentRecord } from '../src/registry/types.js';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const message = { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'ping' }] } as never;

// The test agents listen on 127.0.0.1, so these forwarders opt into private hosts explicitly
// (the A2AForwarder default now denies them).
const mkForwarder = (opts: ConstructorParameters<typeof A2AForwarder>[1] = {}) => new A2AForwarder(3_000, { allowPrivate: true, ...opts });

/** Records the Authorization header of every request fetch makes, by method. */
function spyAuth() {
  const seen: { method: string; url: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push({ method: init?.method ?? 'GET', url, auth: new Headers(init?.headers).get('authorization') });
    return realFetch(input, init);
  });
  return seen;
}

describe('A2AForwarder', () => {
  let server: Server | undefined;
  const others: Server[] = [];
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const s of [server, ...others]) if (s) await new Promise((r) => s.close(r));
  });

  it("sends the agent's bearer credential as a bearer token, and nothing without one", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const { server: srv, url } = await startEchoAgent(port);
    server = srv;

    const auth: (string | null)[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') auth.push(new Headers(init.headers).get('authorization'));
      return realFetch(input, init);
    });

    const agent = { id: 'e', name: 'echo', url, cardPath: '.well-known/agent-card.json' } as AgentRecord;
    await mkForwarder().send({ ...agent, credential: { type: 'bearer', token: 'sekret', for: 'bearer' } }, message);
    await mkForwarder().send(agent, { ...(message as object), messageId: 'm2' } as never);
    vi.restoreAllMocks();

    expect(auth).toEqual(['Bearer sekret', null]);
  });

  it('sends credentials only to the registered origin: not with the card, not where a card points elsewhere', async () => {
    const port = await freePort();
    // Registered as 127.0.0.1, but its card advertises the endpoint at "localhost": another origin.
    const { server: srv } = await startEchoAgent(port, '127.0.0.1', `http://localhost:${port}`);
    others.push(srv);
    const seen = spyAuth();
    const agent = { id: 'x', name: 'echo', url: `http://127.0.0.1:${port}`, cardPath: '.well-known/agent-card.json', credential: { type: 'bearer', token: 'sekret', for: 'bearer' } } as AgentRecord;
    await mkForwarder().send(agent, message);
    vi.restoreAllMocks();
    expect(seen.find((r) => r.method === 'GET')?.auth).toBeNull();
    expect(seen.filter((r) => r.method === 'POST').map((r) => [new URL(r.url).hostname, r.auth])).toEqual([['localhost', null]]);
  });

  it('refuses private hosts on a deployed hub, and never follows a redirect', async () => {
    const agent = { id: 'p', name: 'inside', url: 'http://127.0.0.1:9', cardPath: '.well-known/agent-card.json' } as AgentRecord;
    await expect(new A2AForwarder(3_000, { allowPrivate: false }).send(agent, message)).rejects.toThrow(/private address/);

    const port = await freePort();
    const redirector = createServer((_req, res) => res.writeHead(302, { location: 'http://example.com/card' }).end());
    await new Promise<void>((r) => redirector.listen(port, '127.0.0.1', () => r()));
    others.push(redirector);
    const moved = { id: 'r', name: 'moved', url: `http://127.0.0.1:${port}`, cardPath: '.well-known/agent-card.json', credential: { type: 'bearer', token: 'sekret', for: 'bearer' } } as AgentRecord;
    await expect(mkForwarder().send(moved, message)).rejects.toThrow();
  });

  it('denies a private agent by default, and reaches it when allowPrivate is opted in', async () => {
    const port = await freePort();
    const { server: srv, url } = await startEchoAgent(port);
    others.push(srv);
    const agent = { id: 'd', name: 'echo', url, cardPath: '.well-known/agent-card.json' } as AgentRecord;
    // Default (no option): deny-by-default blocks the loopback host.
    await expect(new A2AForwarder(3_000).send(agent, message)).rejects.toThrow(/private address/);
    // Explicit opt-in: the same send goes through.
    await new A2AForwarder(3_000, { allowPrivate: true }).send(agent, message);
  });

  it('sends Basic and header API keys as their schemes say', async () => {
    const port = await freePort();
    const { server: srv, url } = await startEchoAgent(port);
    others.push(srv);
    const seen: Headers[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') seen.push(new Headers(init.headers));
      return realFetch(input, init);
    });
    const base = { name: 'echo', url, cardPath: '.well-known/agent-card.json' } as AgentRecord;
    await mkForwarder().send({ ...base, id: 'b', credential: { type: 'basic', username: 'u', password: 'p', for: 'basic' } }, message);
    await mkForwarder().send({ ...base, id: 'k', credential: { type: 'apiKey', header: 'X-API-Key', value: 'v', for: 'apiKey:x-api-key' } }, message);
    vi.restoreAllMocks();
    expect(seen[0]!.get('authorization')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect([seen[1]!.get('x-api-key'), seen[1]!.get('authorization')]).toEqual(['v', null]);
  });

  it("doesn't send a credential the card no longer asks for", async () => {
    const port = await freePort();
    let posts = 0;
    const srv = createServer((req, res) => {
      if (req.method === 'POST') {
        posts++;
        return res.writeHead(500).end();
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          name: 'changed',
          description: '',
          version: '1',
          supportedInterfaces: [{ url: `http://127.0.0.1:${port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: {},
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [],
          securitySchemes: { t: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
          securityRequirements: [{ schemes: { t: { list: [] } } }],
        }),
      );
    });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    others.push(srv);
    const agent = {
      id: 'c',
      name: 'changed',
      url: `http://127.0.0.1:${port}`,
      cardPath: '.well-known/agent-card.json',
      credential: { type: 'apiKey', header: 'X-API-Key', value: 'v', for: 'apiKey:x-api-key' },
    } as AgentRecord;
    await expect(mkForwarder().send(agent, message)).rejects.toThrow(/now asks for a bearer token/);
    expect(posts).toBe(0);
  });

  it('reads a 0.3-style security scheme on the card (Hermes: {type: "http", scheme: "bearer"})', async () => {
    const port = await freePort();
    const srv = createServer((req, res) => {
      if (req.method !== 'POST') {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            name: 'hermes',
            description: '',
            version: '1.0.0',
            url: `http://127.0.0.1:${port}/`,
            supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
            capabilities: {},
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [],
            securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
            security: [{ bearer: [] }],
          }),
        );
      }
      if (req.headers.authorization !== 'Bearer right') return res.writeHead(401).end();
      // Authenticated: a task the agent doesn't know, which is what the hub's check asks for.
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Task not found' } }));
    });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    others.push(srv);
    const agent = (token: string) =>
      ({ id: `h-${token}`, name: 'hermes', url: `http://127.0.0.1:${port}`, cardPath: '.well-known/agent-card.json', credential: { type: 'bearer', token, for: 'bearer' } }) as AgentRecord;
    const forwarder = mkForwarder();
    expect(await forwarder.check(agent('right'))).toEqual({ ok: true });
    expect(await forwarder.check(agent('wrong'))).toMatchObject({ ok: false, auth: true });
  });

  it('reports an auth problem once when the agent refuses, and its end once calls work again', async () => {
    const port = await freePort();
    const { server: echo, url } = await startEchoAgent(port);
    others.push(echo);
    let refuse = 2;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST' && refuse-- > 0) return Promise.resolve(new Response('no', { status: 401 }));
      return realFetch(input, init);
    });
    const reports: (string | undefined)[] = [];
    const forwarder = mkForwarder({ onAuthProblem: (_a, p) => reports.push(p) });
    const agent = { id: 'a', name: 'echo', url, cardPath: '.well-known/agent-card.json', credential: { type: 'bearer', token: 'wrong', for: 'bearer' } } as AgentRecord;
    await expect(forwarder.send(agent, message)).rejects.toThrow();
    await expect(forwarder.send(agent, message)).rejects.toThrow();
    await forwarder.send(agent, message);
    await forwarder.send(agent, message);
    vi.restoreAllMocks();
    expect(reports).toEqual(["it refused the hub's credential (HTTP 401)", undefined]);
  });

  it('check: a refused credential is an auth problem, "task not found" means it got through, a dead host is neither', async () => {
    const port = await freePort();
    const { server: echo, url } = await startEchoAgent(port);
    others.push(echo);
    let refuse = 1;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST' && refuse-- > 0) return Promise.resolve(new Response('no', { status: 401 }));
      return realFetch(input, init);
    });
    const reports: (string | undefined)[] = [];
    const forwarder = mkForwarder({ onAuthProblem: (_a, p) => reports.push(p) });
    const agent = { id: 'c', name: 'echo', url, cardPath: '.well-known/agent-card.json' } as AgentRecord;
    expect(await forwarder.check(agent)).toEqual({ ok: false, problem: 'it requires auth, and the hub has no credential for it (HTTP 401)', auth: true });
    // The echo agent has no task by that id: it answers with an error, which means the call was let in.
    expect(await forwarder.check(agent)).toEqual({ ok: true });
    vi.restoreAllMocks();
    expect(reports).toEqual(['it requires auth, and the hub has no credential for it (HTTP 401)', undefined]);
    const dead = await forwarder.check({ ...agent, id: 'd', url: `http://127.0.0.1:${await freePort()}` });
    expect(dead).toMatchObject({ ok: false, auth: false });
  });

  it('check: two concurrent checks of one agent each see their own 401 (reentrant)', async () => {
    const port = await freePort();
    const { server: echo, url } = await startEchoAgent(port);
    others.push(echo);
    // Both getTask POSTs are refused. The second response is held until the first
    // check has fully returned — the ordering that made the old shared-slot delete
    // clobber the second check's status (it reported auth:false instead of auth:true).
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') {
        const refused = new Response('no', { status: 401 });
        return ++posts === 1 ? Promise.resolve(refused) : gate.then(() => refused);
      }
      return realFetch(input, init);
    });
    const forwarder = mkForwarder();
    const agent = { id: 'c', name: 'echo', url, cardPath: '.well-known/agent-card.json' } as AgentRecord;
    const expected = { ok: false, problem: 'it requires auth, and the hub has no credential for it (HTTP 401)', auth: true };
    const results: unknown[] = [];
    const pA = forwarder.check(agent).then((r) => void results.push(r));
    const pB = forwarder.check(agent).then((r) => void results.push(r));
    await Promise.race([pA, pB]); // the ungated check returns (and runs its finally) first
    release();
    await Promise.all([pA, pB]);
    expect(results).toEqual([expected, expected]);
    vi.restoreAllMocks();
  });

  it('OAuth2 client credentials: one token fetch for concurrent sends, cached, refetched once on a 401', async () => {
    const tokenPort = await freePort();
    const requests: { auth?: string; body: string }[] = [];
    let issued = 0;
    const tokenServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `tok${++issued}`, token_type: 'Bearer', expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => tokenServer.listen(tokenPort, '127.0.0.1', () => r()));
    others.push(tokenServer);
    const port = await freePort();
    const { server: echo, url } = await startEchoAgent(port);
    others.push(echo);

    const sentAuth: (string | null)[] = [];
    let refuseNext = false;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      if (init?.method === 'POST' && target.startsWith(url)) {
        sentAuth.push(new Headers(init.headers).get('authorization'));
        if (refuseNext) {
          refuseNext = false;
          return Promise.resolve(new Response('expired', { status: 401 }));
        }
      }
      return realFetch(input, init);
    });
    const agent = {
      id: 'o',
      name: 'echo',
      url,
      cardPath: '.well-known/agent-card.json',
      credential: { type: 'oauth2', clientId: 'id', clientSecret: 's3', tokenUrl: `http://127.0.0.1:${tokenPort}/token`, scopes: ['tasks:write'], for: `oauth2:http://127.0.0.1:${tokenPort}/token` },
    } as AgentRecord;
    const forwarder = mkForwarder();
    await Promise.all([forwarder.send(agent, message), forwarder.send(agent, message)]);
    await forwarder.send(agent, message);
    expect(issued).toBe(1);
    refuseNext = true;
    await forwarder.send(agent, message);
    vi.restoreAllMocks();
    expect(issued).toBe(2);
    expect(sentAuth).toEqual(['Bearer tok1', 'Bearer tok1', 'Bearer tok1', 'Bearer tok1', 'Bearer tok2']);
    expect(requests[0]).toEqual({ auth: `Basic ${Buffer.from('id:s3').toString('base64')}`, body: 'grant_type=client_credentials&scope=tasks%3Awrite' });

    // A rotated client secret gets a token of its own, not the one minted with the old secret.
    await forwarder.send({ ...agent, credential: { ...(agent.credential as object), clientSecret: 'rotated' } } as AgentRecord, message);
    expect(issued).toBe(3);
    expect(requests[2]!.auth).toBe(`Basic ${Buffer.from('id:rotated').toString('base64')}`);
  });

  it("won't fetch a token from a card's private or plain-http token URL on a deployed hub", async () => {
    const agent = {
      id: 'q',
      name: 'remote',
      url: 'https://agent.example.com',
      cardPath: '.well-known/agent-card.json',
      credential: { type: 'oauth2', clientId: 'id', clientSecret: 's', tokenUrl: 'http://169.254.169.254/token', scopes: [] as string[], for: 'oauth2:http://169.254.169.254/token' },
    } as AgentRecord;
    const forwarder = new A2AForwarder(3_000, { allowPrivate: false }) as unknown as { fetchToken(c: unknown): Promise<unknown> };
    await expect(forwarder.fetchToken(agent.credential)).rejects.toThrow(/must be https/);
  });
});
