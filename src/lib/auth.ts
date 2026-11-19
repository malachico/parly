import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Registry } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';

const agents = new WeakMap<Request, AgentRecord>();

/** The authenticated agent for this request, if any. */
export function agentOf(req: Request): AgentRecord | undefined {
  return agents.get(req);
}

/** The raw bearer token on the request, if any. */
export function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  // MCP clients that take "an authorization token" (xAI's remote MCP tools) may send it bare, or prefix "Bearer " to a value that has one.
  const token = header.trim().replace(/^(bearer\s+)+/i, '');
  if (token === header.trim() && !token.startsWith('a2ah_')) return undefined;
  return token && !/\s/.test(token) ? token : undefined;
}

/** Resolves a bearer token (an agent token, or an OAuth access token) to its agent. */
type TokenResolver = (token: string) => Promise<AgentRecord | undefined>;

/** The registry's agent tokens, plus OAuth access tokens when the hub signs agents in with OAuth. */
export function tokenResolver(registry: Registry, oauthAgentFor?: TokenResolver): TokenResolver {
  return (token) => (oauthAgentFor && token.startsWith('a2aa_') ? oauthAgentFor(token) : registry.authenticate(token));
}

/**
 * The `WWW-Authenticate` challenge for a 401. When the hub runs OAuth (`app.locals.resourceMetadataUrl`),
 * it names the protected resource metadata, which is how MCP clients find where to sign in.
 */
function challenge(req: Request, error?: string): string {
  const root = req.app.locals.resourceMetadataUrl as string | undefined;
  // /mcp has its own metadata document, whose resource is the MCP URL itself.
  const meta = root && req.path === '/mcp' ? `${root}/mcp` : root;
  const params = [error ? `error="${error}"` : '', meta ? `resource_metadata="${meta}"` : ''].filter(Boolean);
  return params.length ? `Bearer ${params.join(', ')}` : 'Bearer';
}

/**
 * Resolves `Authorization: Bearer <token>` to an agent. A missing header is fine (some calls
 * are public); a present-but-invalid token is rejected, with a challenge so an OAuth client
 * refreshes or signs in again.
 */
export function authenticate(resolve: TokenResolver) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return next();
    try {
      const agent = await resolve(token);
      if (!agent) {
        res
          .status(401)
          .set('WWW-Authenticate', challenge(req, 'invalid_token'))
          .json({ error: 'Invalid or expired token. Sign in again, or get a new token from the Connect page.' });
        return;
      }
      // A webhook's token sits in a URL people paste into other services: it only posts through POST /hooks, never signs in here.
      if (agent.webhookChannel) {
        res.status(403).json({ error: "This token belongs to an incoming webhook: it only works in its URL (POST /hooks/<channel id>/<token>)." });
        return;
      }
      agents.set(req, agent);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAgent(req: Request, res: Response, next: NextFunction) {
  if (agentOf(req)) return next();
  res
    .status(401)
    .set('WWW-Authenticate', challenge(req))
    .json({ error: 'Authentication required: sign in with OAuth, or send "Authorization: Bearer <agent token>" (a bot token from the web app\'s Connect page).' });
}

const clientIps = new WeakMap<Request, string>();

/** The caller's IP, for per-IP rate limits. */
export function ipOf(req: Request): string {
  return clientIps.get(req) ?? req.ip ?? 'unknown';
}

/**
 * Resolves the client IP. Behind Cloud Run, `req.ip` (with trust proxy 1) is the real client.
 * A trusted server-side caller (the web app) relays its visitor's IP in `x-hub-client-ip`,
 * proven by `x-hub-proxy-secret`; without the secret that header is ignored.
 */
export function resolveClientIp(proxySecret: string | undefined) {
  const expected = proxySecret ? createHash('sha256').update(proxySecret).digest() : undefined;
  return (req: Request, _res: Response, next: NextFunction) => {
    const relayed = req.headers['x-hub-client-ip'];
    const secret = req.headers['x-hub-proxy-secret'];
    if (expected && typeof relayed === 'string' && relayed && typeof secret === 'string') {
      const given = createHash('sha256').update(secret).digest();
      if (timingSafeEqual(given, expected)) clientIps.set(req, relayed.trim());
    }
    next();
  };
}
