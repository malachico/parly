import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { AgentCard, Message, Task } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory, type Client } from '@a2a-js/sdk/client';
import { agentFetch, checkOutboundUrl } from './agentFetch.js';
import { publicFetch } from '../lib/publicFetch.js';
import type { AgentRecord } from '../registry/types.js';
import { unseal } from '../lib/sealing.js';
import { credentialProblem, parseCardAuth, staticAuthHeaders, type StoredCredential } from './agentAuth.js';
import type { WireMessage, WireTask } from '../lib/wire.js';
import { BoundedMap } from '../lib/boundedMap.js';

/** What came back from an endpoint agent. Downstream tasks lack our `metadata.hub`, hence the loose type. */
export type ForwardResult =
  | { kind: 'message'; message: WireMessage }
  | { kind: 'task'; task: Omit<WireTask, 'metadata'> & { metadata?: Record<string, unknown> } };

/** Talks A2A to endpoint agents. An interface so tests can stub it. */
export interface Forwarder {
  /** `signal`: the turn's deadline (and shutdown); a forwarder that can stop early does, the rest may ignore it. */
  send(agent: AgentRecord, message: WireMessage, signal?: AbortSignal): Promise<ForwardResult>;
  getTask(agent: AgentRecord, taskId: string): Promise<ForwardResult & { kind: 'task' }>;
  cancel(agent: AgentRecord, taskId: string): Promise<void>;
  /** Calls the agent once with its credential and says whether it got through. Optional so stubs can skip it. */
  check?(agent: AgentRecord): Promise<EndpointCheck>;
}

/** A check's outcome; `auth` when the agent refused the hub's credential (an authProblem), not when it was just unreachable. */
type EndpointCheck = { ok: true } | { ok: false; problem: string; auth: boolean };

const CLIENT_TTL_MS = 5 * 60_000;

/** Per-call options: the timeout. Credentials are added by the agent's own fetch (see agentFetch). */
function callOptions(timeoutMs: number) {
  return { signal: AbortSignal.timeout(timeoutMs) };
}

type OAuth2Credential = Extract<StoredCredential, { type: 'oauth2' }>;
/** Refetch an OAuth2 token this long before it expires. */
const TOKEN_MARGIN_MS = 30_000;
const TOKEN_TIMEOUT_MS = 10_000;

interface ForwarderOptions {
  /** Allow agents on loopback/private hosts (local development). Off (deny private) unless set. */
  allowPrivate?: boolean;
  /** Opens credentials sealed at rest (CREDENTIALS_KEY). */
  sealingKey?: Buffer;
  /** An agent's auth started failing (a reason) or works again (undefined). Called only on a change. */
  onAuthProblem?: (agent: AgentRecord, problem: string | undefined) => void;
}

export class A2AForwarder implements Forwarder {
  private readonly clients = new BoundedMap<string, { client: Client; at: number }>(1000);
  private readonly allowPrivate: boolean;
  private readonly onAuthProblem?: ForwarderOptions['onAuthProblem'];
  private readonly sealingKey?: Buffer;
  /** OAuth2 access tokens by agent and credential, and the fetches in flight (one per key). */
  private readonly tokens = new BoundedMap<string, { token: string; expiresAt: number }>(1000);
  private readonly fetching = new Map<string, Promise<string>>();
  /** Set by the authed fetch wrapper to the status of the call running inside the current check(). */
  private readonly checkStatus = new AsyncLocalStorage<{ status?: number }>();

  constructor(
    private readonly timeoutMs: number,
    options: ForwarderOptions = {},
  ) {
    this.allowPrivate = options.allowPrivate ?? false;
    this.onAuthProblem = options.onAuthProblem;
    this.sealingKey = options.sealingKey;
  }

  /** The agent's credential in the clear, opened only here, just before it's sent. */
  private open(agent: AgentRecord): StoredCredential | undefined {
    const c = agent.credential;
    if (!c || !('sealed' in c)) return c;
    if (!this.sealingKey) throw new Error(`${agent.name}'s credential is sealed, and this hub has no CREDENTIALS_KEY to open it`);
    return JSON.parse(unseal(c.sealed, this.sealingKey)) as StoredCredential;
  }

  /** The headers that authenticate the hub to `agent`. */
  private async authHeaders(agent: AgentRecord): Promise<Record<string, string>> {
    const c = this.open(agent);
    if (!c) return {};
    if (c.type === 'oauth2') return { Authorization: `Bearer ${await this.accessToken(agent, c)}` };
    return staticAuthHeaders(c);
  }

  private tokenKey(agent: AgentRecord, c: OAuth2Credential): string {
    // A fingerprint of the secret, so a rotated secret never reuses a token minted with the old one.
    const secret = createHash('sha256').update(c.clientSecret).digest('base64url');
    return JSON.stringify([agent.id, c.tokenUrl, c.clientId, c.scopes, secret]);
  }

  /** A cached OAuth2 access token, or one fetched now; concurrent callers share one fetch. */
  private accessToken(agent: AgentRecord, c: OAuth2Credential): Promise<string> {
    const key = this.tokenKey(agent, c);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return Promise.resolve(cached.token);
    const inFlight = this.fetching.get(key);
    if (inFlight) return inFlight;
    const p = this.fetchToken(c)
      .then(({ token, expiresAt }) => {
        this.tokens.set(key, { token, expiresAt });
        return token;
      })
      .finally(() => this.fetching.delete(key));
    this.fetching.set(key, p);
    return p;
  }

  /**
   * OAuth2 client credentials (RFC 6749 4.4). The token URL came from the agent's card, so it's
   * untrusted: https only, no private hosts, no redirects. Only the owner's scopes are asked for.
   */
  private async fetchToken(c: OAuth2Credential): Promise<{ token: string; expiresAt: number }> {
    const url = checkOutboundUrl(c.tokenUrl, this.allowPrivate, 'The token URL');
    const body = new URLSearchParams({ grant_type: 'client_credentials', ...(c.scopes.length ? { scope: c.scopes.join(' ') } : {}) });
    const basic = Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64');
    const res = await (this.allowPrivate ? fetch : publicFetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${basic}` },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the token endpoint ${url.host} answered HTTP ${res.status}`);
    const json = (await res.json().catch(() => ({}))) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string' || !json.access_token) throw new Error(`the token endpoint ${url.host} returned no access_token`);
    if (typeof json.token_type === 'string' && json.token_type.toLowerCase() !== 'bearer') throw new Error(`the token endpoint returned a ${json.token_type} token, not a bearer one`);
    const seconds = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 300;
    return { token: json.access_token, expiresAt: Date.now() + seconds * 1000 };
  }

  /** Records an auth problem (or its end) on the agent, once per change. */
  private report(agent: AgentRecord, problem: string | undefined): void {
    if ((agent.authProblem ?? undefined) === problem) return;
    agent.authProblem = problem;
    this.onAuthProblem?.(agent, problem);
  }

  private async client(given: AgentRecord): Promise<Client> {
    const agent = { ...given };
    if (!agent.url) throw new Error(`Agent ${agent.name} has no URL`);
    // The credential is part of the key, so a changed one takes effect at once.
    const key = `${agent.id}|${agent.url}|${agent.cardPath ?? ''}|${JSON.stringify(agent.credential ?? null)}`;
    const cached = this.clients.get(key);
    if (cached && Date.now() - cached.at < CLIENT_TTL_MS) return cached.client;
    const origin = new URL(agent.url).origin;
    // The card is fetched without credentials; calls carry them, but only to the registered origin.
    const plain = agentFetch(origin, { allowPrivate: this.allowPrivate });
    const once = agentFetch(origin, { allowPrivate: this.allowPrivate, headers: () => this.authHeaders(agent) });
    const authed: typeof fetch = async (input, init) => {
      let res: Response;
      try {
        res = await once(input, init);
        const c = res.status === 401 ? this.open(agent) : undefined;
        // An OAuth2 token may have been revoked early: fetch a new one and try once more.
        if (res.status === 401 && c?.type === 'oauth2') {
          this.tokens.delete(this.tokenKey(agent, c));
          res = await once(input, init);
        }
      } catch (err) {
        if (/token endpoint|token URL/.test((err as Error).message)) this.report(agent, `getting an OAuth2 token failed: ${(err as Error).message}`);
        throw err;
      }
      const slot = this.checkStatus.getStore();
      if (slot) slot.status = res.status;
      if (res.status === 401 || res.status === 403) this.report(agent, refusal(agent, res.status));
      else if (res.status < 400) this.report(agent, undefined);
      return res;
    };
    // The card as the agent sent it: the SDK's parsed card keeps only A2A 1.0 security schemes, so a 0.3-style
    // one ({"type": "http", "scheme": "bearer"}, as Hermes sends) would read as unknown and stop the call.
    let rawCard: unknown;
    const keepRaw: typeof fetch = async (input, init) => {
      const res = await plain(input, init);
      rawCard = await res.clone().json().catch(() => undefined);
      return res;
    };
    const resolver = new DefaultAgentCardResolver({ fetchImpl: keepRaw });
    // Each time the card is read, the credential is checked against what it asks for now.
    const report = (problem: string | undefined) => this.report(agent, problem);
    const cardResolver = {
      async resolve(baseUrl: string, path?: string) {
        const card = await resolver.resolve(baseUrl, path);
        const problem = credentialProblem(agent.credential, parseCardAuth(rawCard ?? AgentCard.toJSON(card)));
        if (problem) {
          report(problem);
          throw new Error(`${agent.name}: ${problem}`);
        }
        return card;
      },
    };
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl: authed }), new RestTransportFactory({ fetchImpl: authed })],
        cardResolver,
      }),
    );
    const client = await factory.createFromUrl(agent.url, agent.cardPath);
    this.clients.set(key, { client, at: Date.now() });
    return client;
  }

  /**
   * GetTask for a task that doesn't exist: authenticated, and nothing runs on the agent's side. Any answer but
   * 401/403 (a "task not found" included) means the credential got through.
   */
  async check(agent: AgentRecord): Promise<EndpointCheck> {
    const slot: { status?: number } = {};
    return this.checkStatus.run(slot, async () => {
      try {
        await this.getTask(agent, `hub-check-${randomUUID()}`);
        return { ok: true };
      } catch (err) {
        const status = slot.status;
        if (status === 401 || status === 403) return { ok: false, problem: refusal(agent, status), auth: true };
        if (status !== undefined && status < 500) return { ok: true };
        const cause = (err as Error & { cause?: unknown }).cause;
        return { ok: false, problem: cause instanceof Error ? `${(err as Error).message} (${cause.message})` : (err as Error).message, auth: false };
      }
    });
  }

  async send(agent: AgentRecord, message: WireMessage): Promise<ForwardResult> {
    const client = await this.client(agent);
    // returnImmediately (A2A 1.0): an agent that supports it answers with its task right away, and the hub
    // fetches the result with GetTask, so slow work (an agent messaging others first) never times out the send.
    // An agent that ignores it answers when it's done, as before.
    const result = await client.sendMessage(
      {
        tenant: '',
        message: Message.fromJSON(message),
        configuration: { acceptedOutputModes: [], taskPushNotificationConfig: undefined, returnImmediately: true },
        metadata: undefined,
      },
      callOptions(this.timeoutMs),
    );
    // A Task has a `status`; a Message has a `role`.
    if ('status' in result) return { kind: 'task', task: Task.toJSON(result) as WireTask };
    return { kind: 'message', message: Message.toJSON(result) as WireMessage };
  }

  async getTask(agent: AgentRecord, taskId: string): Promise<ForwardResult & { kind: 'task' }> {
    const client = await this.client(agent);
    const task = await client.getTask({ tenant: '', id: taskId }, callOptions(this.timeoutMs));
    return { kind: 'task', task: Task.toJSON(task) as WireTask };
  }

  async cancel(agent: AgentRecord, taskId: string): Promise<void> {
    const client = await this.client(agent);
    await client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, callOptions(this.timeoutMs));
  }
}

/** Why the agent turned the hub away, in the owner's words. */
function refusal(agent: AgentRecord, status: number): string {
  return agent.credential ? `it refused the hub's credential (HTTP ${status})` : `it requires auth, and the hub has no credential for it (HTTP ${status})`;
}
