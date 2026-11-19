/**
 * What an A2A agent's card says a caller must authenticate with. The card declares named
 * `securitySchemes` and `securityRequirements`: a list of alternatives, each a set of schemes that
 * must all be satisfied. That shape is kept as-is (alternatives of combinations), so the hub never
 * prompts for the wrong credential or quietly settles for less than the card asks.
 */

type AuthScheme =
  | { id: string; type: 'bearer' }
  | { id: string; type: 'basic' }
  | { id: string; type: 'apiKey'; header: string }
  | { id: string; type: 'oauth2'; tokenUrl: string; scopes: string[] }
  | { id: string; type: 'unsupported'; detail: string };

export interface CardAuth {
  /**
   * Alternatives: the caller satisfies any one, by satisfying every scheme in it. (Objects, not nested
   * arrays, so stored docs never hold arrays of arrays.)
   */
  options: { schemes: AuthScheme[] }[];
}

/** A scheme the hub can satisfy with one credential, identified across card refreshes. */
function schemeKey(s: AuthScheme): string {
  switch (s.type) {
    case 'bearer':
    case 'basic':
      return s.type;
    case 'apiKey':
      return `apiKey:${s.header.toLowerCase()}`;
    case 'oauth2':
      return `oauth2:${s.tokenUrl}`;
    default:
      return `unsupported:${s.detail}`;
  }
}

/** The alternatives the hub supports: exactly one scheme, of a kind it can send. */
export function supportedOptions(auth: CardAuth | undefined): AuthScheme[] {
  return (auth?.options ?? []).filter((o) => o.schemes.length === 1 && o.schemes[0]!.type !== 'unsupported').map((o) => o.schemes[0]!);
}

/** Plain words for an option, e.g. "an API key in header X-API-Key". */
export function describeScheme(s: AuthScheme): string {
  switch (s.type) {
    case 'bearer':
      return 'a bearer token';
    case 'basic':
      return 'a username and password (HTTP Basic)';
    case 'apiKey':
      return `an API key in header ${s.header}`;
    case 'oauth2':
      return `OAuth2 client credentials (token from ${s.tokenUrl})`;
    default:
      return `${s.detail} (not supported by the hub)`;
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One declared scheme, from the A2A 1.0 (oneof) or 0.3 (`type`) card format. */
function parseScheme(id: string, raw: Json): AuthScheme {
  const http = obj(raw.httpAuthSecurityScheme) ?? (raw.type === 'http' ? raw : undefined);
  if (http) {
    const scheme = str(http.scheme).toLowerCase();
    if (scheme === 'bearer') return { id, type: 'bearer' };
    if (scheme === 'basic') return { id, type: 'basic' };
    return { id, type: 'unsupported', detail: `HTTP ${scheme || 'auth'}` };
  }
  const apiKey = obj(raw.apiKeySecurityScheme) ?? (raw.type === 'apiKey' ? raw : undefined);
  if (apiKey) {
    const where = str(apiKey.location ?? apiKey.in).toLowerCase();
    const name = str(apiKey.name);
    // Keys in a URL end up in logs; only headers are supported.
    if (where === 'header' && name) return { id, type: 'apiKey', header: name };
    return { id, type: 'unsupported', detail: `an API key in ${where || 'an unknown place'}` };
  }
  const oauth = obj(raw.oauth2SecurityScheme) ?? (raw.type === 'oauth2' ? raw : undefined);
  if (oauth) {
    const cc = obj(obj(oauth.flows)?.clientCredentials);
    const tokenUrl = str(cc?.tokenUrl);
    if (cc && tokenUrl) return { id, type: 'oauth2', tokenUrl, scopes: Object.keys(obj(cc.scopes) ?? {}) };
    return { id, type: 'unsupported', detail: 'OAuth2 without client credentials' };
  }
  if (raw.openIdConnectSecurityScheme || raw.type === 'openIdConnect') return { id, type: 'unsupported', detail: 'OpenID Connect' };
  if (raw.mtlsSecurityScheme || raw.type === 'mutualTLS') return { id, type: 'unsupported', detail: 'mutual TLS' };
  return { id, type: 'unsupported', detail: 'an unknown scheme' };
}

/** The card's auth, or undefined when it declares none. */
export function parseCardAuth(card: unknown): CardAuth | undefined {
  const c = obj(card) ?? {};
  const declared = obj(c.securitySchemes) ?? {};
  const schemes = new Map(Object.entries(declared).flatMap(([id, raw]) => (obj(raw) ? [[id, parseScheme(id, obj(raw)!)] as const] : [])));
  // 1.0: securityRequirements: [{ schemes: { id: { list } } }]; 0.3: security: [{ id: [scopes] }].
  const rawRequirements = Array.isArray(c.securityRequirements) ? c.securityRequirements : Array.isArray(c.security) ? c.security : undefined;
  let options: AuthScheme[][];
  if (rawRequirements) {
    options = rawRequirements.map((r) => {
      const ids = Object.keys(obj(obj(r)?.schemes) ?? obj(r) ?? {});
      return ids.map((id) => schemes.get(id) ?? { id, type: 'unsupported' as const, detail: `undeclared scheme "${id}"` });
    });
    options = options.filter((o) => o.length > 0);
  } else {
    // No requirements: each declared scheme is offered on its own.
    options = [...schemes.values()].map((s) => [s]);
  }
  return options.length ? { options: options.map((schemes) => ({ schemes })) } : undefined;
}

/** What the hub sends to an endpoint agent. Stored with the agent, never shown back. */
type Credential =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; header: string; value: string }
  | { type: 'oauth2'; clientId: string; clientSecret: string; tokenUrl: string; scopes: string[] };

/** A credential as stored: with the scheme (schemeKey) it was given for, so a changed card can't reuse it. */
export type StoredCredential = Credential & { for: string };

/** What an owner gives: for OAuth2 the token URL comes from the card, not from them. */
export type CredentialInput =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; header?: string; value: string }
  | { type: 'oauth2'; clientId: string; clientSecret: string; scopes?: string[] };

const MAX_SECRET = 4096;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
// Headers the hub sets itself, or that would change what the request means.
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'connection', 'cookie', 'transfer-encoding', 'a2a-version']);

function secret(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > MAX_SECRET || /[\r\n]/.test(v)) throw new Error(`${what} must be a non-empty string without line breaks, up to ${MAX_SECRET} characters`);
  return v;
}

/** A credential input from JSON, shape-checked. Throws a plain Error with a message for the caller. */
export function parseCredentialInput(raw: unknown): CredentialInput {
  const c = obj(raw);
  if (!c) throw new Error('credential must be an object with a "type"');
  switch (c.type) {
    case 'bearer':
      return { type: 'bearer', token: secret(c.token, 'credential.token') };
    case 'basic':
      if (typeof c.username !== 'string' || !c.username || c.username.includes(':')) throw new Error('credential.username must be a non-empty string without ":"');
      return { type: 'basic', username: secret(c.username, 'credential.username'), password: secret(c.password, 'credential.password') };
    case 'apiKey':
      if (c.header !== undefined && (typeof c.header !== 'string' || !HEADER_NAME.test(c.header) || RESERVED_HEADERS.has(c.header.toLowerCase()))) throw new Error('credential.header must be a valid HTTP header name');
      return { type: 'apiKey', ...(typeof c.header === 'string' ? { header: c.header } : {}), value: secret(c.value, 'credential.value') };
    case 'oauth2':
      if (c.scopes !== undefined && (!Array.isArray(c.scopes) || c.scopes.some((s) => typeof s !== 'string' || !s))) throw new Error('credential.scopes must be a list of scope names');
      return { type: 'oauth2', clientId: secret(c.clientId, 'credential.clientId'), clientSecret: secret(c.clientSecret, 'credential.clientSecret'), ...(c.scopes ? { scopes: c.scopes as string[] } : {}) };
    default:
      throw new Error('credential.type must be "bearer", "basic", "apiKey" or "oauth2"');
  }
}

/**
 * Matches a credential to what the card asks for. With declared auth it must fit one supported
 * alternative (exactly); a card that declares nothing takes a bearer, Basic or header key as given.
 * Returns the credential to store, bound to its scheme. Throws with plain words otherwise.
 */
export function bindCredential(input: CredentialInput, auth: CardAuth | undefined): StoredCredential {
  const options = supportedOptions(auth);
  if (!auth) {
    if (input.type === 'oauth2') throw new Error("OAuth2 needs a token URL from the agent's card, and this card declares no auth");
    if (input.type === 'apiKey') {
      if (!input.header) throw new Error('credential.header is required: this card declares no API key header');
      return { type: 'apiKey', header: input.header, value: input.value, for: `apiKey:${input.header.toLowerCase()}` };
    }
    return { ...input, for: input.type };
  }
  const wanted = options.map(describeScheme);
  if (!wanted.length) throw new Error(`This agent requires ${auth.options.map((o) => o.schemes.map(describeScheme).join(' and ')).join(', or ')}, which the hub can't send yet`);
  for (const s of options) {
    if (s.type === 'bearer' && input.type === 'bearer') return { ...input, for: schemeKey(s) };
    if (s.type === 'basic' && input.type === 'basic') return { ...input, for: schemeKey(s) };
    if (s.type === 'apiKey' && input.type === 'apiKey' && (!input.header || input.header.toLowerCase() === s.header.toLowerCase())) {
      return { type: 'apiKey', header: s.header, value: input.value, for: schemeKey(s) };
    }
    if (s.type === 'oauth2' && input.type === 'oauth2') {
      // The owner's scopes, not the card's: a card can't widen what the owner granted.
      return { type: 'oauth2', clientId: input.clientId, clientSecret: input.clientSecret, tokenUrl: s.tokenUrl, scopes: input.scopes ?? [], for: schemeKey(s) };
    }
  }
  throw new Error(`This agent's card asks for ${wanted.join(', or ')}; the credential given doesn't match`);
}

/** The headers for a stored credential (OAuth2 tokens are fetched by the forwarder). */
export function staticAuthHeaders(c: StoredCredential): Record<string, string> {
  switch (c.type) {
    case 'bearer':
      return { Authorization: `Bearer ${c.token}` };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` };
    case 'apiKey':
      return { [c.header]: c.value };
    default:
      return {};
  }
}

/**
 * Why a stored credential mustn't be sent under the card as it is now, or undefined if it may. A
 * credential given for one scheme is never reinterpreted under another: if the card changes its auth,
 * the credential waits until the owner gives one for the new requirement.
 */
export function credentialProblem(credential: Pick<StoredCredential, 'for'> | undefined, auth: CardAuth | undefined): string | undefined {
  if (!credential || !auth) return undefined;
  if (supportedOptions(auth).some((s) => schemeKey(s) === credential.for)) return undefined;
  const now = auth.options.map((o) => o.schemes.map(describeScheme).join(' and ')).join(', or ');
  return `its card now asks for ${now}, not the credential its owner gave; the owner needs to enter a new one`;
}
