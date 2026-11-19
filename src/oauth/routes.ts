import express, { Router, type Request, type Response } from 'express';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { InvalidClientError, InvalidRequestError, OAuthError, ServerError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { agentOf, ipOf, requireAgent } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { json } from '../rest/helpers.js';
import { agentView } from '../lib/present.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import { isSignedInPerson, type Registry } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';
import type { HubOAuthProvider } from './provider.js';
import type { OAuthStore } from './store.js';
import { toMillis } from '../db/types.js';
import { DEVICE_GRANT, HUB_SCOPE, type OAuthRequestRecord } from './types.js';

interface OAuthRouterOptions {
  provider: HubOAuthProvider;
  store: OAuthStore;
  registry: Registry;
  /** The hub's public URL: issuer, and the protected resource (covers /mcp and /a2a). */
  publicUrl: string;
  /** The web app, where people sign in and approve (/oauth/consent, /link). */
  webUrl: string;
  /** Per-IP limit on device-code requests. */
  deviceLimiter: RateLimiter;
  /** Per-person limit on typed-code lookups (guessing a user code is the attack). Keyed by person, since the web server makes the call. */
  lookupLimiter: RateLimiter;
  /** Client registrations per IP per hour (the hub's REGISTER_LIMIT_PER_HOUR). */
  registerLimitPerHour: number;
  docsUrl?: string;
}

const MAX_NAME = 64;

/** Sends an OAuth error the RFC 6749 way: `{error, error_description}`. */
function oauthError(res: Response, err: unknown): void {
  const e = err instanceof OAuthError ? err : new ServerError('Internal Server Error');
  if (!(err instanceof OAuthError)) console.error(err);
  res.status(e instanceof ServerError ? 500 : 400).json(e.toResponseObject());
}

/** Wraps an async JSON handler (like the REST router's) so errors reach the error middleware. */
/** Consent is given by a person who signed in (Google, or a self-hosted password): the bot will be theirs. */
function requireGooglePerson(req: Request): AgentRecord {
  const me = agentOf(req)!;
  if (!isSignedInPerson(me)) throw new HubError('forbidden', 'Sign in to connect an agent');
  return me;
}

/** What the consent page shows about a request. */
function requestView(r: OAuthRequestRecord) {
  return {
    id: r.id,
    kind: r.kind,
    client: { id: r.clientId, name: r.clientName, ...(r.clientUri ? { uri: r.clientUri } : {}) },
    /** Code flow: where the browser goes back to (show it, so a look-alike client stands out). */
    ...(r.redirectUri ? { redirectTo: redirectLabel(r.redirectUri) } : {}),
    scopes: r.scopes,
    expiresAt: new Date(toMillis(r.expiresAt)).toISOString(),
  };
}

/** "localhost" for loopback callbacks, otherwise the host (or the scheme of a native app). */
function redirectLabel(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}//`;
    return u.hostname === '127.0.0.1' || u.hostname === '[::1]' ? 'localhost' : u.hostname;
  } catch {
    return uri;
  }
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

/** "Malachi's Claude Code": the person's first name and the client's name. */
function defaultBotName(person: AgentRecord, clientName: string): string {
  const first = person.name.trim().split(/\s+/)[0] || 'My';
  return `${first}'s ${clientName}`.slice(0, MAX_NAME);
}

/**
 * OAuth 2.1 for MCP clients (and anything else): discovery, dynamic client registration,
 * authorization code + PKCE, refresh, revocation (all from the MCP SDK's router), plus the
 * device authorization grant and the consent API the web app calls. Mount at the app root.
 */
export function oauthRouter(o: OAuthRouterOptions): Router {
  const router = Router();
  const issuerUrl = new URL(o.publicUrl);
  const docs = o.docsUrl ? new URL(o.docsUrl) : undefined;
  const base = createOAuthMetadata({ provider: o.provider, issuerUrl, scopesSupported: [HUB_SCOPE], serviceDocumentationUrl: docs });
  const deviceEndpoint = new URL('/device_authorization', issuerUrl).href;

  // The SDK's metadata knows two grants; the device grant is ours, so this document shadows its own.
  router.use(
    '/.well-known/oauth-authorization-server',
    metadataHandler({
      ...base,
      grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_GRANT],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: base.revocation_endpoint ? ['none'] : undefined,
      device_authorization_endpoint: deviceEndpoint,
    } as typeof base),
  );
  // Protected resource metadata (RFC 9728): one for /mcp (its resource is the MCP URL, which strict
  // clients check against the URL they called), and one for the rest of the hub (/a2a, REST).
  const prm = (resource: string) =>
    metadataHandler({
      resource,
      authorization_servers: [base.issuer],
      scopes_supported: [HUB_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Parly',
      ...(docs ? { resource_documentation: docs.href } : {}),
    });
  router.use('/.well-known/oauth-protected-resource/mcp', prm(new URL('/mcp', issuerUrl).href));
  router.use('/.well-known/oauth-protected-resource', prm(issuerUrl.href));

  // ---- device authorization grant (RFC 8628) ---------------------------------------------

  router.post('/device_authorization', express.urlencoded({ extended: false }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      o.deviceLimiter.hit(ipOf(req));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const client = await o.store.getClient(String(body.client_id ?? ''));
      if (!client) throw new InvalidClientError('Invalid client_id');
      if (!client.grant_types?.includes(DEVICE_GRANT)) {
        throw new UnauthorizedClientError(`Register the client with grant_types including "${DEVICE_GRANT}" to use the device flow`);
      }
      const { deviceCode, userCode, expiresIn, interval } = await o.store.createDeviceRequest(client);
      res.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${o.webUrl}/link`,
        verification_uri_complete: `${o.webUrl}/link?code=${encodeURIComponent(userCode)}`,
        expires_in: expiresIn,
        interval,
      });
    } catch (err) {
      if (err instanceof HubError && err.code === 'rate_limited') {
        res.status(429).json({ error: 'slow_down', error_description: err.message });
        return;
      }
      oauthError(res, err);
    }
  });

  // The device grant at the token endpoint; every other grant falls through to the SDK's handler.
  router.post('/token', express.urlencoded({ extended: false }), async (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.grant_type !== DEVICE_GRANT) return next();
    res.set('Cache-Control', 'no-store');
    try {
      const client = await o.store.getClient(String(body.client_id ?? ''));
      if (!client) throw new InvalidClientError('Invalid client_id');
      if (typeof body.device_code !== 'string' || !body.device_code) throw new InvalidRequestError('device_code is required');
      res.json(await o.store.pollDevice(client.client_id, body.device_code));
    } catch (err) {
      oauthError(res, err);
    }
  });

  // /authorize, /token (code and refresh), /register, /revoke; its metadata routes are shadowed above.
  router.use(
    mcpAuthRouter({
      provider: o.provider,
      issuerUrl,
      resourceServerUrl: issuerUrl,
      scopesSupported: [HUB_SCOPE],
      resourceName: 'Parly',
      serviceDocumentationUrl: docs,
      clientRegistrationOptions: { rateLimit: { max: o.registerLimitPerHour } },
    }),
  );

  // ---- consent: the web app, as the signed-in person -------------------------------------

  /** A sign-in waiting for this person's answer: by request id (code flow), or `?user_code=` (device flow, typed on /link). */
  router.get(
    '/oauth/requests/:id',
    requireAgent,
    json(async (req) => {
      requireGooglePerson(req);
      const r = await o.store.getPending(String(req.params.id));
      if (!r) throw new HubError('not_found', 'This sign-in request has expired. Start again from your agent.');
      return requestView(r);
    }),
  );
  router.get(
    '/oauth/requests',
    requireAgent,
    json(async (req) => {
      o.lookupLimiter.hit(requireGooglePerson(req).id);
      const r = await o.store.findPendingByUserCode(String(req.query.user_code ?? ''));
      if (!r || r.kind !== 'device') throw new HubError('not_found', 'No sign-in is waiting for that code. Check it, or start again from your agent.');
      return requestView(r);
    }),
  );

  /**
   * The person's answer: `{request, approve}`, and for approval either `bot` (one of their
   * connections) or `name` (a new one). The tokens will act as that bot. A code request answers
   * with `redirect`, where the browser goes next; a device request just with `ok`.
   */
  router.post(
    '/oauth/consent',
    requireAgent,
    json(async (req) => {
      const me = requireGooglePerson(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = String(body.request ?? '');
      const pending = await o.store.getPending(id);
      if (!pending) throw new HubError('not_found', 'This sign-in request has expired. Start again from your agent.');
      try {
        if (body.approve !== true) {
          const denied = await o.store.deny(id);
          return denied.kind === 'code'
            ? { redirect: withParams(denied.redirectUri!, { error: 'access_denied', error_description: 'The person declined', state: denied.state }) }
            : { ok: true, denied: true };
        }

        let agent: AgentRecord;
        let made = false;
        if (typeof body.bot === 'string' && body.bot) {
          agent = await o.registry.requireSelfOrOwned(me, body.bot);
          if (agent.id === me.id || !agent.followsOwner) throw new HubError('invalid', 'Pick one of your connections, or make a new one');
          if (agent.archived) throw new HubError('invalid', 'That connection is archived');
        } else {
          const name = typeof body.name === 'string' && body.name.trim() ? body.name : defaultBotName(me, pending.clientName);
          agent = (await o.registry.createBot(me, { name, follow: true }, ipOf(req))).agent;
          made = true;
        }

        let approved: Awaited<ReturnType<OAuthStore['approve']>>;
        try {
          approved = await o.store.approve(id, { agentId: agent.id, ownerId: me.id });
        } catch (err) {
          // Answered twice (a double click, a second tab) or expired meanwhile: don't leave a bot behind.
          if (made) await o.registry.unregister(agent).catch(() => undefined);
          throw err;
        }
        const { request, code } = approved;
        const view = { agent: agentView(agent), client: { name: request.clientName } };
        return request.kind === 'code' ? { ...view, redirect: withParams(request.redirectUri!, { code, state: request.state }) } : { ...view, ok: true };
      } catch (err) {
        // The request expired between the page loading and the answer.
        if (err instanceof OAuthError) throw new HubError('not_found', err.message);
        throw err;
      }
    }),
  );

  return router;
}
