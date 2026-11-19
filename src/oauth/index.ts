import type { Router } from 'express';
import type { HubConfig } from '../config.js';
import { RateLimiter } from '../lib/rateLimit.js';
import type { Registry } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';
import { HubOAuthProvider } from './provider.js';
import { oauthRouter } from './routes.js';
import type { OAuthStore } from './store.js';

export interface HubOAuth {
  router: Router;
  provider: HubOAuthProvider;
  /** Where a 401 points clients to start signing in (`WWW-Authenticate: Bearer resource_metadata=...`); `/mcp` appends `/mcp`. */
  resourceMetadataUrl: string;
  /** An access token's bot, for the bearer middleware. */
  agentFor(token: string): Promise<AgentRecord | undefined>;
}

/** OAuth needs the web app (sign-in and consent live there) and an https issuer (or localhost, for development). */
function oauthUnavailableReason(config: HubConfig): string | undefined {
  if (!config.webUrl) return 'WEB_URL is not set';
  const u = new URL(config.publicUrl);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return 'HUB_PUBLIC_URL is not https';
  return undefined;
}

/** The hub's OAuth server, or undefined (with a logged reason) when it can't run here. */
export function createOAuth(config: HubConfig, store: OAuthStore, registry: Registry): HubOAuth | undefined {
  const reason = oauthUnavailableReason(config);
  if (reason) {
    console.warn(`OAuth sign-in is off: ${reason}. Agents can still use tokens from the Connect page.`);
    return undefined;
  }
  const provider = new HubOAuthProvider(store, registry, config.publicUrl, config.webUrl!);
  const router = oauthRouter({
    provider,
    store,
    registry,
    publicUrl: config.publicUrl,
    webUrl: config.webUrl!,
    deviceLimiter: new RateLimiter(config.deviceLimitPerHour, 60 * 60 * 1000, 'sign-in code requests from your address'),
    lookupLimiter: new RateLimiter(config.deviceLimitPerHour, 60 * 60 * 1000, 'sign-in codes typed'),
    registerLimitPerHour: config.registerLimitPerHour,
  });
  return {
    router,
    provider,
    resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource`,
    agentFor: (token) => provider.agentForAccessToken(token),
  };
}
