import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { HubError } from '../lib/errors.js';
import type { Registry } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';
import type { OAuthStore } from './store.js';
import { toMillis } from '../db/types.js';

/**
 * The hub as an OAuth authorization server (the MCP SDK's router calls this). Sign-in itself
 * happens in the web app: `authorize` parks the request and sends the browser to the consent
 * page, which approves it as a bot the person owns (see routes.ts, POST /oauth/consent).
 */
export class HubOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly store: OAuthStore,
    private readonly registry: Registry,
    private readonly publicUrl: string,
    private readonly webUrl: string,
  ) {
    this.clientsStore = {
      getClient: (id) => store.getClient(id),
      registerClient: (client) => store.registerClient(client),
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Scopes asked for are ignored: every grant is `hub` (the token response says so). A resource must be this hub.
    if (params.resource && new URL(params.resource.href).origin !== new URL(this.publicUrl).origin) {
      throw new InvalidTargetError(`This server issues tokens for ${this.publicUrl} only`);
    }
    const id = await this.store.createCodeRequest(client, {
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
    });
    res.redirect(302, `${this.webUrl}/oauth/consent?request=${encodeURIComponent(id)}`);
  }

  challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.store.codeChallenge(client.client_id, code);
  }

  exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    // The SDK has already checked the PKCE verifier against challengeForAuthorizationCode.
    return this.store.redeemCode(client.client_id, code, redirectUri);
  }

  exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    return this.store.refresh(client.client_id, refreshToken);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const doc = await this.store.verifyAccess(token);
    if (!doc) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: doc.clientId,
      scopes: doc.scopes,
      expiresAt: Math.floor(toMillis(doc.expiresAt) / 1000),
      ...(doc.resource ? { resource: new URL(doc.resource) } : {}),
      extra: { agentId: doc.agentId },
    };
  }

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    return this.store.revoke(client.client_id, request.token);
  }

  /**
   * The bot an access token acts as, for the hub's own bearer middleware: undefined for an
   * unknown or expired token (a 401), like an agent token that doesn't resolve.
   */
  async agentForAccessToken(token: string): Promise<AgentRecord | undefined> {
    const doc = await this.store.verifyAccess(token);
    if (!doc) return undefined;
    const agent = await this.registry.get(doc.agentId);
    if (!agent) return undefined;
    if (agent.archived) throw new HubError('forbidden', 'This bot is archived. An owner of one of its workspaces can restore it.');
    this.registry.touchInBackground(agent);
    return agent;
  }
}
