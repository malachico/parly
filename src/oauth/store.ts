import { randomBytes, randomInt } from 'node:crypto';
import type { Database, Transaction } from '../db/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { CustomOAuthError, InvalidClientMetadataError, InvalidGrantError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { COLLECTIONS, toMillis } from '../db/types.js';
import { hashToken } from '../registry/registry.js';
import {
  ACCESS_PREFIX,
  DEVICE_GRANT,
  HUB_SCOPE,
  REFRESH_PREFIX,
  type OAuthClientRecord,
  type OAuthRequestRecord,
  type OAuthTokenRecord,
} from './types.js';

/** How long a code request may sit on the consent page. */
const CODE_REQUEST_TTL_MS = 10 * 60 * 1000;
/** How long an issued authorization code lives. */
const CODE_TTL_MS = 5 * 60 * 1000;
/** How long a device code (and its user code) lives. */
const DEVICE_TTL_MS = 15 * 60 * 1000;
/** Seconds between device polls; slow_down adds 5. */
const DEVICE_INTERVAL_S = 5;
/** A client nobody gets tokens for is forgotten after this. */
const CLIENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** User codes: no vowels (no words), no 0/O/1/I. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const GRANT_TYPES = new Set(['authorization_code', 'refresh_token', DEVICE_GRANT]);
/** Schemes a redirect URI must never use. https, loopback http and native-app schemes (RFC 8252) are fine. */
const BAD_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * A spent refresh token still works this long: an MCP client refreshing from several requests at
 * once must not be logged out because one of them won. Reuse after that revokes the whole grant.
 */
const REFRESH_GRACE_MS = 60 * 1000;
/** Ids we mint (and doc ids we accept from callers): no "/", nothing reserved. */
const ID_RE = /^[\w-]{1,128}$/;
/** An id we'd look up: our characters, and not a reserved "__...__" name. */
const validId = (id: string) => ID_RE.test(id) && !/^__.*__$/.test(id);

interface OAuthStoreOptions {
  accessTtlMs: number;
  refreshTtlMs: number;
}

/** "abcd-efgh", "ABCDEFGH" or " abcd efgh " → "ABCD-EFGH". */
function normalizeUserCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function newUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET.charAt(randomInt(USER_CODE_ALPHABET.length));
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const secret = (prefix = '') => `${prefix}${randomBytes(32).toString('base64url')}`;
const alive = (doc: { expiresAt: Date }, now = Date.now()) => toMillis(doc.expiresAt) > now;

/** Throws unless every redirect URI is https, http on a loopback host, or a native app's own scheme. */
function checkRedirectUris(uris: string[]): void {
  if (!uris.length) throw new InvalidClientMetadataError('redirect_uris is required');
  for (const raw of uris) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new InvalidClientMetadataError(`Invalid redirect URI: ${raw}`);
    }
    if (u.hash) throw new InvalidClientMetadataError(`Redirect URI must not have a fragment: ${raw}`);
    if (BAD_SCHEMES.has(u.protocol)) throw new InvalidClientMetadataError(`Redirect URI scheme not allowed: ${raw}`);
    if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) {
      throw new InvalidClientMetadataError(`Redirect URI must be https, or http on localhost: ${raw}`);
    }
  }
}

/**
 * DB access for OAuth: registered clients, sign-ins in progress (code and device requests), and
 * issued tokens. Codes and tokens are stored as SHA-256 hashes only. Every lookup checks
 * `expiresAt` itself, because TTL deletion lags.
 */
export class OAuthStore {
  constructor(
    private readonly db: Database,
    private readonly opts: OAuthStoreOptions,
  ) {}

  private get clients() {
    return this.db.collection(COLLECTIONS.oauthClients);
  }
  private get requests() {
    return this.db.collection(COLLECTIONS.oauthRequests);
  }
  private get tokens() {
    return this.db.collection(COLLECTIONS.oauthTokens);
  }

  // ---- clients ---------------------------------------------------------------------------

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (!validId(clientId)) return undefined;
    const doc = (await this.clients.doc(clientId).get()).data() as OAuthClientRecord | undefined;
    if (!doc || !alive(doc)) return undefined;
    const { createdAt: _c, expiresAt: _e, ...client } = doc;
    return client;
  }

  /**
   * Dynamic client registration. Every client is public (no secret; PKCE protects the code):
   * a confidential registration is accepted but answered as a public one, which RFC 7591 lets
   * the server do. Scopes asked for at registration are ignored; every grant is `hub`.
   */
  async registerClient(input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & { client_id?: string }): Promise<OAuthClientInformationFull> {
    checkRedirectUris(input.redirect_uris);
    const grants = input.grant_types ?? ['authorization_code', 'refresh_token'];
    const unknown = grants.filter((g) => !GRANT_TYPES.has(g));
    if (unknown.length) throw new InvalidClientMetadataError(`Unsupported grant_types: ${unknown.join(', ')}`);
    if (input.response_types && input.response_types.some((r) => r !== 'code')) {
      throw new InvalidClientMetadataError('Only response_type "code" is supported');
    }
    // Ignore caller-supplied client_id (RFC 7591 §3.2.1): the hub always issues one.
    const { client_secret: _s, client_secret_expires_at: _x, client_id: _c, ...rest } = input;
    const client: OAuthClientInformationFull = {
      ...rest,
      client_id: secret().slice(0, 32),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: grants,
      response_types: ['code'],
      scope: HUB_SCOPE,
    };
    const record: OAuthClientRecord = { ...client, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + CLIENT_TTL_MS) };
    await this.clients.doc(client.client_id).set(record);
    return client;
  }

  // ---- requests --------------------------------------------------------------------------

  /** A code request, waiting on the consent page. Returns its id (the page's `request`). */
  async createCodeRequest(client: OAuthClientInformationFull, p: { redirectUri: string; state?: string; codeChallenge: string; resource?: string }): Promise<string> {
    const now = Date.now();
    const id = secret();
    const record: OAuthRequestRecord = {
      id,
      kind: 'code',
      clientId: client.client_id,
      clientName: client.client_name || 'An MCP client',
      ...(client.client_uri ? { clientUri: client.client_uri } : {}),
      scopes: [HUB_SCOPE],
      status: 'pending',
      ...(p.resource ? { resource: p.resource } : {}),
      redirectUri: p.redirectUri,
      ...(p.state !== undefined ? { state: p.state } : {}),
      codeChallenge: p.codeChallenge,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CODE_REQUEST_TTL_MS),
    };
    await this.requests.doc(id).create(record);
    return id;
  }

  /** A device request: the client polls with `deviceCode`, the person types `userCode`. */
  async createDeviceRequest(client: OAuthClientInformationFull): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
    const now = Date.now();
    const deviceCode = secret();
    // 28^8 codes; a clash with another pending code is unlikely, but a typed code must name exactly one request.
    let userCode = newUserCode();
    if (await this.findPendingByUserCode(userCode)) userCode = newUserCode();
    const id = secret();
    const record: OAuthRequestRecord = {
      id,
      kind: 'device',
      clientId: client.client_id,
      clientName: client.client_name || 'An MCP client',
      ...(client.client_uri ? { clientUri: client.client_uri } : {}),
      scopes: [HUB_SCOPE],
      status: 'pending',
      deviceCodeHash: hashToken(deviceCode),
      userCode,
      interval: DEVICE_INTERVAL_S,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEVICE_TTL_MS),
    };
    await this.requests.doc(id).create(record);
    return { deviceCode, userCode, expiresIn: DEVICE_TTL_MS / 1000, interval: DEVICE_INTERVAL_S };
  }

  /** A request still waiting for the person's answer, or undefined. */
  async getPending(id: string): Promise<OAuthRequestRecord | undefined> {
    if (!validId(id)) return undefined;
    const doc = (await this.requests.doc(id).get()).data() as OAuthRequestRecord | undefined;
    return doc && doc.status === 'pending' && alive(doc) ? doc : undefined;
  }

  async findPendingByUserCode(raw: string): Promise<OAuthRequestRecord | undefined> {
    const userCode = normalizeUserCode(raw);
    if (userCode.length !== 9) return undefined;
    const snap = await this.requests.where('userCode', '==', userCode).limit(5).get();
    return snap.docs.map((d) => d.data() as OAuthRequestRecord).find((r) => r.status === 'pending' && alive(r));
  }

  /**
   * The person approved: the request now acts as `agentId`. A code request gets its one-time
   * authorization code (returned here, stored hashed); a device request waits for its next poll.
   */
  async approve(id: string, who: { agentId: string; ownerId: string }): Promise<{ request: OAuthRequestRecord; code?: string }> {
    if (!validId(id)) throw new InvalidGrantError('This sign-in request has expired');
    const ref = this.requests.doc(id);
    return this.db.runTransaction(async (tx) => {
      const request = (await tx.get(ref)).data() as OAuthRequestRecord | undefined;
      if (!request || request.status !== 'pending' || !alive(request)) throw new InvalidGrantError('This sign-in request has expired');
      const update: Partial<OAuthRequestRecord> = { status: 'approved', agentId: who.agentId, ownerId: who.ownerId };
      let code: string | undefined;
      if (request.kind === 'code') {
        code = secret();
        update.codeHash = hashToken(code);
        update.expiresAt = new Date(Date.now() + CODE_TTL_MS);
      }
      tx.update(ref, update);
      return { request: { ...request, ...update }, code };
    });
  }

  /** The person said no. Kept until it expires so a polling device hears access_denied. */
  async deny(id: string): Promise<OAuthRequestRecord> {
    if (!validId(id)) throw new InvalidGrantError('This sign-in request has expired');
    const ref = this.requests.doc(id);
    return this.db.runTransaction(async (tx) => {
      const request = (await tx.get(ref)).data() as OAuthRequestRecord | undefined;
      if (!request || request.status !== 'pending' || !alive(request)) throw new InvalidGrantError('This sign-in request has expired');
      tx.update(ref, { status: 'denied' });
      return { ...request, status: 'denied' as const };
    });
  }

  private async approvedCode(clientId: string, code: string): Promise<OAuthRequestRecord> {
    const snap = await this.requests.where('codeHash', '==', hashToken(code)).limit(1).get();
    const request = snap.docs[0]?.data() as OAuthRequestRecord | undefined;
    if (!request || request.status !== 'approved' || request.clientId !== clientId || !alive(request)) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return request;
  }

  /** The PKCE challenge the code's request began with (the SDK checks the verifier against it). */
  async codeChallenge(clientId: string, code: string): Promise<string> {
    return (await this.approvedCode(clientId, code)).codeChallenge ?? '';
  }

  /** Trades an authorization code for tokens, once: the request is deleted in the same transaction. */
  async redeemCode(clientId: string, code: string, redirectUri?: string): Promise<OAuthTokens> {
    const query = this.requests.where('codeHash', '==', hashToken(code)).limit(1);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(query);
      const doc = snap.docs[0];
      const request = doc?.data() as OAuthRequestRecord | undefined;
      if (!doc || !request || request.status !== 'approved' || request.clientId !== clientId || !alive(request)) {
        throw new InvalidGrantError('Invalid or expired authorization code');
      }
      if (redirectUri !== undefined && redirectUri !== request.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      tx.delete(doc.ref);
      return this.issue(tx, request);
    });
  }

  /**
   * One device poll (RFC 8628 §3.5). Answers authorization_pending until the person approves,
   * slow_down when polled faster than the interval, then the tokens, once.
   */
  async pollDevice(clientId: string, deviceCode: string): Promise<OAuthTokens> {
    const query = this.requests.where('deviceCodeHash', '==', hashToken(deviceCode)).limit(1);
    // Errors are returned, not thrown, inside the transaction: a throw would roll back the writes they go with.
    const outcome = await this.db.runTransaction(async (tx): Promise<OAuthTokens | OAuthError> => {
      const doc = (await tx.get(query)).docs[0];
      const request = doc?.data() as OAuthRequestRecord | undefined;
      if (!doc || !request || request.clientId !== clientId) return new InvalidGrantError('Invalid device_code');
      const now = Date.now();
      if (!alive(request, now)) return new CustomOAuthError('expired_token', 'The device code has expired. Start again.');
      if (request.status === 'denied') {
        tx.delete(doc.ref);
        return new CustomOAuthError('access_denied', 'The person declined the sign-in');
      }
      if (request.status === 'approved') {
        tx.delete(doc.ref);
        return this.issue(tx, request);
      }
      const interval = request.interval ?? DEVICE_INTERVAL_S;
      if (request.lastPolledAt && now - Date.parse(request.lastPolledAt) < interval * 1000) {
        tx.update(doc.ref, { interval: interval + 5, lastPolledAt: new Date(now).toISOString() });
        return new CustomOAuthError('slow_down', `Poll at most every ${interval + 5} seconds`);
      }
      tx.update(doc.ref, { lastPolledAt: new Date(now).toISOString() });
      return new CustomOAuthError('authorization_pending', 'Waiting for the person to approve the sign-in');
    });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  // ---- tokens ----------------------------------------------------------------------------

  /** Writes a new access + refresh pair for an approved grant, inside `tx`. */
  private issue(tx: Transaction, grant: Pick<OAuthRequestRecord, 'id' | 'clientId' | 'agentId' | 'ownerId' | 'scopes' | 'resource'>): OAuthTokens {
    if (!grant.agentId || !grant.ownerId) throw new InvalidGrantError('This grant names no agent');
    const now = Date.now();
    const access = secret(ACCESS_PREFIX);
    const refresh = secret(REFRESH_PREFIX);
    const base = {
      clientId: grant.clientId,
      agentId: grant.agentId,
      ownerId: grant.ownerId,
      grantId: grant.id,
      scopes: grant.scopes,
      ...(grant.resource ? { resource: grant.resource } : {}),
      createdAt: new Date(now).toISOString(),
    };
    tx.create(this.tokens.doc(hashToken(access)), { ...base, kind: 'access', expiresAt: new Date(now + this.opts.accessTtlMs) } satisfies OAuthTokenRecord);
    tx.create(this.tokens.doc(hashToken(refresh)), { ...base, kind: 'refresh', expiresAt: new Date(now + this.opts.refreshTtlMs) } satisfies OAuthTokenRecord);
    // Clients in use are kept; ones nobody signs in with expire.
    tx.update(this.clients.doc(grant.clientId), { expiresAt: new Date(now + CLIENT_TTL_MS) });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(this.opts.accessTtlMs / 1000),
      refresh_token: refresh,
      scope: grant.scopes.join(' '),
    };
  }

  /**
   * Refresh rotation: the refresh token is spent and a new pair issued. A spent one still works
   * for REFRESH_GRACE_MS (concurrent refreshes from one client); after that, presenting it again
   * looks like a stolen token, so the whole grant is revoked (OAuth 2.1 §4.3.1).
   */
  async refresh(clientId: string, refreshToken: string): Promise<OAuthTokens> {
    if (!refreshToken.startsWith(REFRESH_PREFIX)) throw new InvalidGrantError('Invalid refresh token');
    const ref = this.tokens.doc(hashToken(refreshToken));
    const outcome = await this.db.runTransaction(async (tx): Promise<OAuthTokens | { reused: string }> => {
      const doc = (await tx.get(ref)).data() as OAuthTokenRecord | undefined;
      if (!doc || doc.kind !== 'refresh' || doc.clientId !== clientId || !alive(doc)) throw new InvalidGrantError('Invalid or expired refresh token');
      const now = Date.now();
      if (doc.spentAt && now - Date.parse(doc.spentAt) > REFRESH_GRACE_MS) return { reused: doc.grantId };
      if (!doc.spentAt) tx.update(ref, { spentAt: new Date(now).toISOString() });
      return this.issue(tx, { id: doc.grantId, clientId: doc.clientId, agentId: doc.agentId, ownerId: doc.ownerId, scopes: doc.scopes, resource: doc.resource });
    });
    if ('reused' in outcome) {
      await this.deleteWhere('grantId', [outcome.reused]);
      throw new InvalidGrantError('This refresh token was already used; the sign-in has been revoked');
    }
    return outcome;
  }

  /** A live access token's record, or undefined. */
  async verifyAccess(token: string): Promise<OAuthTokenRecord | undefined> {
    if (!token.startsWith(ACCESS_PREFIX)) return undefined;
    const doc = (await this.tokens.doc(hashToken(token)).get()).data() as OAuthTokenRecord | undefined;
    return doc && doc.kind === 'access' && alive(doc) ? doc : undefined;
  }

  /**
   * RFC 7009: revokes a token the client holds. Revoking a refresh token ends the whole grant
   * (its access tokens too); revoking an access token ends just that one. Unknown tokens are fine.
   */
  async revoke(clientId: string, token: string): Promise<void> {
    const ref = this.tokens.doc(hashToken(token));
    const doc = (await ref.get()).data() as OAuthTokenRecord | undefined;
    if (!doc || doc.clientId !== clientId) return;
    if (doc.kind === 'access') {
      await ref.delete();
      return;
    }
    await this.deleteWhere('grantId', [doc.grantId]);
  }

  /**
   * Every token acting as these agents (they were deleted, or their token was rotated), and any
   * approved sign-in for them not yet traded for tokens.
   */
  async revokeAgents(agentIds: string[]): Promise<void> {
    await this.deleteWhere('agentId', agentIds);
    await this.deleteWhere('agentId', agentIds, this.requests);
  }

  /** Deletes every doc of `col` (tokens by default) with `field` in `values`, 400 at a time (a batch holds 500). */
  private async deleteWhere(field: 'grantId' | 'agentId', values: string[], col = this.tokens): Promise<void> {
    for (const value of values) {
      for (;;) {
        const snap = await col.where(field, '==', value).limit(400).get();
        if (snap.empty) break;
        const batch = this.db.batch();
        for (const d of snap.docs) batch.delete(d.ref);
        await batch.commit();
        if (snap.size < 400) break;
      }
    }
  }
}
