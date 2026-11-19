/**
 * OAuth sign-in for agents, over real HTTP: discovery, dynamic client registration, the
 * authorization code flow with PKCE (consent through the same REST call the web app makes),
 * refresh rotation, revocation, the device flow, and a stock MCP SDK client doing all of it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createApp } from '../src/app.js';
import { COLLECTIONS } from '../src/db/types.js';
import { HubError } from '../src/lib/errors.js';
import { OAuthStore } from '../src/oauth/store.js';
import { connectHub } from '../examples/mcp.js';
import { newAgentOverHttp, testConfig, testDb, freePort } from './helpers.js';

const WEB = 'http://web.test';
const CALLBACK = 'http://localhost:43210/callback';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('OAuth for agents', () => {
  let hubUrl: string;
  let server: Server;
  let db: Database;
  /** Malachi, signed in to the web app with Google (a session token, as the web's cookie holds). */
  let person: string;

  const verifyGoogle = async (idToken: string) => {
    const [email, sub] = idToken.split('|');
    if (!email || !sub) throw new HubError('unauthorized', 'Google sign-in failed');
    return { email, sub, name: `Malachi ${sub}` };
  };

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    db = testDb();
    const { app, oauth } = createApp({ db, config: testConfig({ port, publicUrl: hubUrl, webUrl: WEB }), verifyGoogle });
    expect(oauth).toBeDefined();
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    person = (await call(undefined, 'POST', '/auth/google', { idToken: 'malachi@example.com|g-mal' })).body.token;
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  async function call<T = any>(token: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** A form POST, the way OAuth clients talk to /token, /revoke and /device_authorization. */
  async function form<T = any>(path: string, params: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await fetch(`${hubUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function registerClient(meta: Record<string, unknown> = {}): Promise<string> {
    const res = await call(undefined, 'POST', '/register', { client_name: 'Test Client', redirect_uris: [CALLBACK], ...meta });
    expect(res.status).toBe(201);
    return res.body.client_id;
  }

  /** GET /authorize the way a browser would; returns the consent request id the hub redirected to. */
  async function authorize(clientId: string, challenge: string, state = 'st-1'): Promise<string> {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state });
    const res = await fetch(`${hubUrl}/authorize?${q}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(`${to.origin}${to.pathname}`).toBe(`${WEB}/oauth/consent`);
    return to.searchParams.get('request')!;
  }

  /** Approves as the signed-in person (what the consent page does) and returns the code from the redirect. */
  async function consent(request: string, choice: { name?: string; bot?: string } = {}): Promise<{ code: string; state: string | null; agentId: string }> {
    const res = await call(person, 'POST', '/oauth/consent', { request, approve: true, ...choice });
    expect(res.status).toBe(200);
    const back = new URL(res.body.redirect);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    return { code: back.searchParams.get('code')!, state: back.searchParams.get('state'), agentId: res.body.agent.id };
  }

  async function signInWithCode(clientId: string, choice: { name?: string; bot?: string } = {}): Promise<OAuthTokens & { agentId: string }> {
    const { verifier, challenge } = pkce();
    const { code, agentId } = await consent(await authorize(clientId, challenge), choice);
    const res = await form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: CALLBACK });
    expect(res.status).toBe(200);
    return { ...res.body, agentId };
  }

  it('publishes authorization server and protected resource metadata', async () => {
    const as = (await call(undefined, 'GET', '/.well-known/oauth-authorization-server')).body;
    expect(as).toMatchObject({
      issuer: `${hubUrl}/`,
      authorization_endpoint: `${hubUrl}/authorize`,
      token_endpoint: `${hubUrl}/token`,
      registration_endpoint: `${hubUrl}/register`,
      revocation_endpoint: `${hubUrl}/revoke`,
      device_authorization_endpoint: `${hubUrl}/device_authorization`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['hub'],
    });
    expect(as.grant_types_supported).toContain(DEVICE_GRANT);
    // /mcp has its own document (its resource is the MCP URL); the root one covers /a2a and REST.
    expect((await call(undefined, 'GET', '/.well-known/oauth-protected-resource/mcp')).body).toMatchObject({ resource: `${hubUrl}/mcp`, authorization_servers: [`${hubUrl}/`] });
    expect((await call(undefined, 'GET', '/.well-known/oauth-protected-resource')).body).toMatchObject({ resource: `${hubUrl}/`, authorization_servers: [`${hubUrl}/`] });
  });

  it('answers MCP without a token with a 401 that points at the metadata', async () => {
    const res = await fetch(`${hubUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${hubUrl}/.well-known/oauth-protected-resource/mcp"`);
    // So does /a2a (with the hub-wide document), and a bad token says invalid_token.
    expect((await fetch(`${hubUrl}/a2a`, { method: 'POST' })).headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${hubUrl}/.well-known/oauth-protected-resource"`);
    const bad = await fetch(`${hubUrl}/me`, { headers: { authorization: 'Bearer a2aa_nope' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
  });

  it('registers clients as public ones, and only with safe redirect URIs', async () => {
    const res = await call(undefined, 'POST', '/register', {
      client_name: 'Confidential wannabe',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:5555/cb', 'cursor://anysphere.cursor/oauth'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'admin',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ token_endpoint_auth_method: 'none', scope: 'hub', response_types: ['code'] });
    expect(res.body.client_secret).toBeUndefined();

    // Caller-supplied client_id is ignored; the hub always issues one.
    const forced = await call(undefined, 'POST', '/register', {
      client_name: 'Forced id',
      redirect_uris: [CALLBACK],
      client_id: 'attacker-chosen-id',
    });
    expect(forced.status).toBe(201);
    expect(forced.body.client_id).toBeTruthy();
    expect(forced.body.client_id).not.toBe('attacker-chosen-id');

    for (const redirect_uris of [['http://evil.example/cb'], ['javascript:alert(1)'], ['file:///etc/passwd']]) {
      const refused = await call(undefined, 'POST', '/register', { client_name: 'x', redirect_uris });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_client_metadata');
    }
    expect((await call(undefined, 'POST', '/register', { redirect_uris: [CALLBACK], grant_types: ['password'] })).body.error).toBe('invalid_client_metadata');
  });

  it('signs in with the code flow: consent makes an owned bot, and the token acts as it over MCP', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const request = await authorize(clientId, challenge, 'xyz');

    // The consent page reads the request as the signed-in person.
    const view = await call(person, 'GET', `/oauth/requests/${encodeURIComponent(request)}`);
    expect(view).toMatchObject({ status: 200, body: { kind: 'code', client: { id: clientId, name: 'Test Client' }, redirectTo: 'localhost', scopes: ['hub'] } });

    const { code, state, agentId } = await consent(request, { name: 'Malachi’s Test Client' });
    expect(state).toBe('xyz');

    // A wrong verifier fails (PKCE), and doesn't spend the code; the right one works once.
    const wrong = await form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pkce().verifier });
    expect(wrong.body.error).toBe('invalid_grant');
    const tokens = await form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: CALLBACK });
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'hub' });
    expect(tokens.body.access_token).toMatch(/^a2aa_/);
    expect(tokens.body.refresh_token).toMatch(/^a2ar_/);
    const again = await form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier });
    expect(again.body.error).toBe('invalid_grant');

    const mcp = await connectHub(hubUrl, tokens.body.access_token);
    const me = await mcp.call<{ id: string; name: string; ownerId: string; followsOwner: boolean }>('whoami');
    await mcp.close();
    const owner = (await call(person, 'GET', '/me')).body;
    expect(me).toMatchObject({ id: agentId, name: 'Malachi’s Test Client', followsOwner: true, ownerId: owner.id });
    expect((await call(person, 'GET', '/agents/bots')).body.map((b: { id: string }) => b.id)).toContain(agentId);

    // Signing in again can reuse that connection instead of making another.
    const reused = await signInWithCode(clientId, { bot: agentId });
    expect(reused.agentId).toBe(agentId);
    expect((await call(reused.access_token, 'GET', '/me')).body.id).toBe(agentId);
  });

  it('lets the person decline, and only Google-signed-in people consent', async () => {
    const clientId = await registerClient();
    const request = await authorize(clientId, pkce().challenge, 'st-deny');

    const bot = (await newAgentOverHttp(hubUrl, { name: 'not-a-person' }, 'nap@example.com|g-nap')).token;
    expect((await call(bot, 'POST', '/oauth/consent', { request, approve: true })).status).toBe(403);
    expect((await call(undefined, 'POST', '/oauth/consent', { request, approve: true })).status).toBe(401);

    const denied = await call(person, 'POST', '/oauth/consent', { request, approve: false });
    const back = new URL(denied.body.redirect);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('st-deny');
    // Answered once: it's gone.
    expect((await call(person, 'GET', `/oauth/requests/${encodeURIComponent(request)}`)).status).toBe(404);
    expect((await call(person, 'POST', '/oauth/consent', { request, approve: true })).status).toBe(404);
  });

  it('refuses a bot that is not one of the person\'s connections', async () => {
    const clientId = await registerClient();
    const request = await authorize(clientId, pkce().challenge);
    const stranger = await newAgentOverHttp(hubUrl, { name: 'stranger' }, 'stranger-owner@example.com|g-stranger');
    expect((await call(person, 'POST', '/oauth/consent', { request, approve: true, bot: stranger.agent.id })).status).toBe(404);
    const me = (await call(person, 'GET', '/me')).body.id;
    expect((await call(person, 'POST', '/oauth/consent', { request, approve: true, bot: me })).status).toBe(400);
  });

  it('rotates refresh tokens, and revocation ends the sign-in', async () => {
    const clientId = await registerClient();
    const first = await signInWithCode(clientId);

    const refreshed = await form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token! });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token);
    expect((await call(refreshed.body.access_token, 'GET', '/me')).body.id).toBe(first.agentId);
    // Another client can't use this one.
    const other = await registerClient();
    expect((await form('/token', { grant_type: 'refresh_token', client_id: other, refresh_token: refreshed.body.refresh_token })).body.error).toBe('invalid_grant');

    // Revoking the refresh token ends the whole grant: its access token stops working too.
    expect((await form('/revoke', { client_id: clientId, token: refreshed.body.refresh_token })).status).toBe(200);
    expect((await call(refreshed.body.access_token, 'GET', '/me')).status).toBe(401);
    expect((await form('/revoke', { client_id: clientId, token: 'a2ar_unknown' })).status).toBe(200);
  });

  it('lets a spent refresh token work briefly (concurrent refreshes), then treats reuse as theft', async () => {
    const clientId = await registerClient();
    const t = await signInWithCode(clientId);
    const a = await form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: t.refresh_token! });
    const b = await form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: t.refresh_token! });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body.access_token).not.toBe(a.body.access_token);

    // Past the grace period, reuse revokes the whole sign-in, including the pairs it already gave out.
    const hash = createHash('sha256').update(t.refresh_token!).digest('hex');
    await db.collection(COLLECTIONS.oauthTokens).doc(hash).update({ spentAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
    expect((await form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: t.refresh_token! })).body.error).toBe('invalid_grant');
    expect((await call(a.body.access_token, 'GET', '/me')).status).toBe(401);
    expect((await form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: b.body.refresh_token })).body.error).toBe('invalid_grant');
  });

  it('answering a request twice leaves no extra agent behind', async () => {
    const clientId = await registerClient();
    const request = await authorize(clientId, pkce().challenge);
    const before = (await call(person, 'GET', '/agents/bots')).body.length;
    const [x, y] = await Promise.all([
      call(person, 'POST', '/oauth/consent', { request, approve: true, name: 'Twice A' }),
      call(person, 'POST', '/oauth/consent', { request, approve: true, name: 'Twice B' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 404]);
    expect((await call(person, 'GET', '/agents/bots')).body.length).toBe(before + 1);
  });

  it('refuses malformed ids with 4xx, not a server error', async () => {
    expect((await call(person, 'GET', '/oauth/requests/a%2Fb')).status).toBe(404);
    expect((await call(person, 'POST', '/oauth/consent', { request: '__x__', approve: true })).status).toBe(404);
    expect((await form('/device_authorization', { client_id: 'a/b' })).body.error).toBe('invalid_client');
  });

  it('revoking the connection on the web, or rotating its token, ends its OAuth sign-ins', async () => {
    const clientId = await registerClient();
    const a = await signInWithCode(clientId);
    expect((await call(person, 'POST', `/agents/${a.agentId}/token`)).status).toBe(200);
    expect((await call(a.access_token, 'GET', '/me')).status).toBe(401);
    expect((await form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: a.refresh_token! })).body.error).toBe('invalid_grant');

    const b = await signInWithCode(clientId);
    expect((await call(person, 'DELETE', `/agents/${b.agentId}`)).status).toBe(200);
    expect((await call(b.access_token, 'GET', '/me')).status).toBe(401);
  });

  it('expired access tokens are refused even before the TTL index deletes them', async () => {
    const clientId = await registerClient();
    const t = await signInWithCode(clientId);
    await db.collection(COLLECTIONS.oauthTokens).doc(createHash('sha256').update(t.access_token).digest('hex')).update({ expiresAt: new Date(Date.now() - 1000) });
    expect((await call(t.access_token, 'GET', '/me')).status).toBe(401);
  });

  describe('device flow', () => {
    let clientId: string;
    beforeAll(async () => {
      clientId = await registerClient({ client_name: 'Headless Agent', grant_types: ['authorization_code', 'refresh_token', DEVICE_GRANT] });
    });

    const poll = (device_code: string) => form('/token', { grant_type: DEVICE_GRANT, client_id: clientId, device_code });

    it('waits for the person to type the code and approve, then issues tokens once', async () => {
      const start = await form('/device_authorization', { client_id: clientId });
      expect(start.status).toBe(200);
      expect(start.body).toMatchObject({ verification_uri: `${WEB}/link`, expires_in: 900, interval: 5 });
      expect(start.body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(start.body.verification_uri_complete).toBe(`${WEB}/link?code=${start.body.user_code}`);

      expect((await poll(start.body.device_code)).body.error).toBe('authorization_pending');
      expect((await poll(start.body.device_code)).body.error).toBe('slow_down');

      // Typed loosely on /link: lower case, no dash.
      const typed = start.body.user_code.replace('-', '').toLowerCase();
      const found = await call(person, 'GET', `/oauth/requests?user_code=${typed}`);
      expect(found).toMatchObject({ status: 200, body: { kind: 'device', client: { name: 'Headless Agent' } } });
      expect((await call(person, 'GET', '/oauth/requests?user_code=BBBB-BBBB')).status).toBe(404);

      const approved = await call(person, 'POST', '/oauth/consent', { request: found.body.id, approve: true, name: 'Headless' });
      expect(approved.body).toMatchObject({ ok: true, agent: { name: 'Headless' } });

      const tokens = await poll(start.body.device_code);
      expect(tokens.status).toBe(200);
      expect((await call(tokens.body.access_token, 'GET', '/me')).body).toMatchObject({ id: approved.body.agent.id, followsOwner: true });
      expect((await poll(start.body.device_code)).body.error).toBe('invalid_grant');
    });

    it('reports a declined or expired request, and refuses clients not registered for it', async () => {
      const denied = await form('/device_authorization', { client_id: clientId });
      const found = await call(person, 'GET', `/oauth/requests?user_code=${denied.body.user_code}`);
      expect((await call(person, 'POST', '/oauth/consent', { request: found.body.id, approve: false })).body).toMatchObject({ ok: true, denied: true });
      expect((await poll(denied.body.device_code)).body.error).toBe('access_denied');

      const stale = await form('/device_authorization', { client_id: clientId });
      const doc = await call(person, 'GET', `/oauth/requests?user_code=${stale.body.user_code}`);
      await db.collection(COLLECTIONS.oauthRequests).doc(doc.body.id).update({ expiresAt: new Date(Date.now() - 1000) });
      expect((await poll(stale.body.device_code)).body.error).toBe('expired_token');

      expect((await form('/device_authorization', { client_id: await registerClient() })).body.error).toBe('unauthorized_client');
      expect((await form('/device_authorization', { client_id: 'nope' })).body.error).toBe('invalid_client');
    });
  });

  it('works end to end with the MCP SDK client: 401, discovery, registration, consent, tokens', async () => {
    let authUrl: URL | undefined;
    let info: OAuthClientInformationMixed | undefined;
    let saved: OAuthTokens | undefined;
    let verifier = '';
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return CALLBACK;
      },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: 'SDK Client', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      clientInformation: () => info,
      saveClientInformation: (i) => {
        info = i;
      },
      tokens: () => saved,
      saveTokens: (t) => {
        saved = t;
      },
      redirectToAuthorization: (url) => {
        authUrl = url;
      },
      saveCodeVerifier: (v) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
    };
    const url = new URL(`${hubUrl}/mcp`);

    const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await expect(new Client({ name: 'sdk', version: '0' }).connect(first)).rejects.toThrow(UnauthorizedError);
    expect(authUrl).toBeDefined();
    expect(info?.client_id).toBeTruthy();

    // The browser leg: /authorize → consent page → back to the client's callback with a code.
    const res = await fetch(authUrl!, { redirect: 'manual' });
    const request = new URL(res.headers.get('location')!).searchParams.get('request')!;
    const { code } = await consent(request);
    await first.finishAuth(code);
    expect(saved?.access_token).toMatch(/^a2aa_/);

    const client = new Client({ name: 'sdk', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.parse((who.content as { text: string }[])[0]!.text)).toMatchObject({ name: 'Malachi\'s SDK Client', followsOwner: true });
    await client.close();
  });

  it('keeps bot tokens (from the Connect page) working beside OAuth', async () => {
    const { token } = await newAgentOverHttp(hubUrl, { name: 'scripted' }, 'scripter@example.com|g-scripter');
    const mcp = await connectHub(hubUrl, token);
    expect((await mcp.call<{ name: string }>('whoami')).name).toBe('scripted');
    await mcp.close();
  });
});

describe('revokeAgents', () => {
  it('deletes every token and sign-in request of the agent, past one 400-doc page', async () => {
    const db = testDb();
    const store = new OAuthStore(db, { accessTtlMs: 60_000, refreshTtlMs: 60_000 });
    for (const col of [COLLECTIONS.oauthTokens, COLLECTIONS.oauthRequests]) {
      const batch = db.batch();
      for (let j = 0; j < 450; j++) batch.set(db.collection(col).doc(), { agentId: 'a1', grantId: 'g1' });
      await batch.commit();
      await db.collection(col).doc().set({ agentId: 'other', grantId: 'g2' });
    }
    await store.revokeAgents(['a1']);
    for (const col of [COLLECTIONS.oauthTokens, COLLECTIONS.oauthRequests]) {
      expect((await db.collection(col).where('agentId', '==', 'a1').get()).size).toBe(0);
      expect((await db.collection(col).where('agentId', '==', 'other').get()).size).toBe(1);
    }
  });
});
