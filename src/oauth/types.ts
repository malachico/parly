import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/** OAuth access tokens: short-lived, each one acts as an owned bot. Distinct from `a2ah_` (agent) and `a2at_` (join code). */
export const ACCESS_PREFIX = 'a2aa_';
/** OAuth refresh tokens: long-lived, single use (each refresh rotates the pair). */
export const REFRESH_PREFIX = 'a2ar_';
/** The one scope: act as your agent on the hub. */
export const HUB_SCOPE = 'hub';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** A client registered with dynamic client registration (collection `oauth_clients`, doc id = client_id). Public clients only. */
export interface OAuthClientRecord extends OAuthClientInformationFull {
  createdAt: string;
  /** TTL index: pushed forward whenever tokens are issued, so clients nobody uses disappear. */
  expiresAt: Date;
}

/**
 * One sign-in in progress (collection `oauth_requests`, random doc id): an authorization-code
 * request waiting on the consent page, or a device request waiting for its user code to be
 * approved. The same id names the grant (`grantId` on the tokens) once approved.
 */
export interface OAuthRequestRecord {
  id: string;
  kind: 'code' | 'device';
  clientId: string;
  clientName: string;
  clientUri?: string;
  scopes: string[];
  status: 'pending' | 'approved' | 'denied';
  resource?: string;
  /** Code flow: where to send the browser back, with `state`, and the PKCE challenge to check the verifier against. */
  redirectUri?: string;
  state?: string;
  codeChallenge?: string;
  /** Code flow, once approved: SHA-256 of the authorization code. */
  codeHash?: string;
  /** Device flow: SHA-256 of the device code the client polls with, and the short code the person types. */
  deviceCodeHash?: string;
  userCode?: string;
  /** Device flow: seconds the client must wait between polls (grows on slow_down). */
  interval?: number;
  lastPolledAt?: string;
  /** Once approved: the bot the tokens act as, and the person who approved. */
  agentId?: string;
  ownerId?: string;
  createdAt: string;
  /** TTL index; lookups check it too, since TTL deletion lags. */
  expiresAt: Date;
}

/** An issued token (collection `oauth_tokens`, doc id = SHA-256 of the token). */
export interface OAuthTokenRecord {
  kind: 'access' | 'refresh';
  clientId: string;
  agentId: string;
  ownerId: string;
  /** The approved request: every token from one consent shares it, so a family is revoked together. */
  grantId: string;
  scopes: string[];
  resource?: string;
  createdAt: string;
  /** Refresh tokens: when it was first used. It keeps working for a short grace period, then reuse revokes the grant. */
  spentAt?: string;
  expiresAt: Date;
}

