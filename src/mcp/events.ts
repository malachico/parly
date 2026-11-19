import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/types.js';
import { z } from 'zod';
import { HubError } from '../lib/errors.js';
import { publicFetch } from '../lib/publicFetch.js';
import { seal, unseal } from '../lib/sealing.js';
import type { AgentRecord } from '../registry/types.js';
import { McpEventStore } from './eventStore.js';

/** MCP events/* params: name + webhook delivery; secret checked after parse.
 * name/mode/url optional so unsubscribe-by-id and `{ delivery: {} }` reach HubError checks. */
const eventParamsSchema = z.object({
  name: z.string().optional(),
  ttlMs: z.union([z.number(), z.null()]).optional(),
  arguments: z.unknown().optional(),
  id: z.string().optional(),
  delivery: z
    .object({
      mode: z.string().optional(),
      url: z.unknown().optional(),
      secret: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
});

/**
 * MCP Events (protocol 2026-07-28, as ChatGPT's dots use them): a client subscribes to an event with a callback URL
 * and a `whsec_` secret, and the hub POSTs a Standard Webhooks-signed event there when it happens. Parly has one:
 * `message.received`, when messages wait for the subscribing agent. The woken client reads them with check_inbox.
 */
const EVENT = 'message.received';

export const EVENT_DEFINITIONS = [
  {
    name: EVENT,
    description:
      'New Parly messages are waiting for you (a direct message, a mention, or a post in one of your teams). When it fires, call check_inbox, do what each message asks, and reply where it asks you something or you have something useful to add (not to say "got it").',
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    payloadSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        agentName: { type: 'string' },
        waiting: { type: 'integer', description: 'Conversations with something new' },
        from: { type: 'string', description: 'Who wrote the latest one' },
        instructions: { type: 'string' },
      },
      required: ['agentId', 'waiting', 'instructions'],
    },
  },
];

/** `mcpEventSubs/{id}`: one client's subscription; the id is deterministic, so a refresh updates it. */
export interface Subscription {
  id: string;
  agentId: string;
  name: string;
  url: string;
  /** The `whsec_` secret, sealed with CREDENTIALS_KEY (`secret` only on a hub without one). */
  sealed?: string;
  secret?: string;
  refreshBefore: string;
  lastSentAt?: string;
  createdAt: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 3600_000;
const MIN_TTL_MS = 3600_000;
/** A client that was told and hasn't read since is told again only after this (its run never came, or died). */
const STALE_MS = 10 * 60_000;
const VERIFIED_FOR_MS = 24 * 3600_000;

/** Standard Webhooks signature of `${id}.${timestamp}.${body}` with a `whsec_` secret. */
function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export class McpEvents {
  private readonly fetchImpl: typeof fetch;
  private readonly store: McpEventStore;

  constructor(
    db: Database,
    private readonly opts: { sealingKey?: Buffer; fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? publicFetch;
    this.store = new McpEventStore(db);
  }

  /** `events/subscribe`: checks the event, secret and callback (a signed challenge it must echo), then stores it. */
  async subscribe(agent: AgentRecord, params: unknown): Promise<{ id: string; refreshBefore: string; cursor: null; truncated: false }> {
    const { name, url, secret, args, ttlMs } = this.parse(params);
    if (typeof secret !== 'string' || !/^whsec_/.test(secret)) throw new HubError('invalid', 'delivery.secret must start with whsec_');
    const bytes = Buffer.from(secret.slice(6), 'base64').length;
    if (bytes < 24 || bytes > 64) throw new HubError('invalid', 'delivery.secret must decode to 24-64 bytes');
    const id = this.idOf(agent.id, url, name, args);
    const existing = await this.store.subscription(id);
    // Verified recently with this same secret: a refresh needn't challenge again.
    const sameSecret = existing && this.secretOf(existing) === secret;
    const needVerify = !sameSecret || !existing?.verifiedAt || Date.now() - Date.parse(existing.verifiedAt) > VERIFIED_FOR_MS;
    if (needVerify) await this.verify(url, secret, id);
    const ttl = ttlMs === undefined || ttlMs === null ? DEFAULT_TTL_MS : Math.max(MIN_TTL_MS, Math.min(DEFAULT_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
    const refreshBefore = new Date(Date.now() + ttl).toISOString();
    const stored = this.opts.sealingKey ? { sealed: seal(secret, this.opts.sealingKey) } : { secret };
    await this.store.saveSubscription({
      id,
      agentId: agent.id,
      name,
      url,
      ...stored,
      refreshBefore,
      verifiedAt: needVerify ? new Date().toISOString() : existing!.verifiedAt,
      ...(existing?.lastSentAt ? { lastSentAt: existing.lastSentAt } : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    return { id, refreshBefore, cursor: null, truncated: false };
  }

  /** `events/unsubscribe`: idempotent; only the caller's own. */
  async unsubscribe(agent: AgentRecord, params: unknown): Promise<Record<string, never>> {
    const raw = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    // By its id, or by what identifies it (name, arguments, callback URL).
    const id =
      typeof raw.id === 'string'
        ? raw.id
        : (({ name, url, args }) => this.idOf(agent.id, url, name, args))(
            this.parse({ ...raw, delivery: { mode: 'webhook', ...(raw.delivery && typeof raw.delivery === 'object' ? raw.delivery : {}) } }),
          );
    const doc = await this.store.subscription(id);
    if (doc && doc.agentId === agent.id) await this.store.removeSubscription(id);
    return {};
  }

  /**
   * Tells the agent's live subscriptions that messages wait: once per burst. A client told before the oldest waiting
   * message arrived has read since, so it's told now; one told after it hasn't caught up yet, so it isn't (unless
   * that was over STALE_MS ago).
   */
  async deliver(agent: AgentRecord, waiting: number, oldestWaiting: string, from?: string): Promise<number> {
    const now = new Date();
    const subs = await this.store.subscriptionsOf(agent.id);
    let sent = 0;
    for (const s of subs) {
      if (Date.parse(s.refreshBefore) < now.getTime()) continue;
      if (s.lastSentAt && oldestWaiting <= s.lastSentAt && now.getTime() - Date.parse(s.lastSentAt) < STALE_MS) continue;
      const eventId = `evt_${randomBytes(12).toString('hex')}`;
      const body = JSON.stringify({
        eventId,
        name: s.name,
        timestamp: now.toISOString(),
        data: {
          agentId: agent.id,
          agentName: agent.name,
          waiting,
          ...(from ? { from } : {}),
          instructions: 'Messages are waiting for you on Parly. Call the Parly check_inbox tool, do what each asks, and reply where it asks you something or you have something useful to add.',
        },
        cursor: null,
      });
      const status = await this.post(s, eventId, body).catch((err) => {
        console.warn('mcp event not delivered', s.id, String(err));
        return 0;
      });
      if (status === 410) await this.store.removeSubscription(s.id);
      else if (status >= 200 && status < 300) {
        await this.store.markSent(s.id, now.toISOString());
        sent++;
      }
    }
    return sent;
  }

  private parse(params: unknown) {
    const parsed = eventParamsSchema.safeParse(params ?? {});
    if (!parsed.success) throw new HubError('invalid', parsed.error.issues[0]?.message ?? 'Invalid event params');
    const { name, delivery, arguments: args, ttlMs } = parsed.data;
    if (name !== EVENT) throw new HubError('invalid', `Unknown event "${name}"; Parly has ${EVENT}`);
    if (!delivery || delivery.mode !== 'webhook') throw new HubError('invalid', 'Only webhook delivery is supported');
    let url: URL;
    try {
      url = new URL(String(delivery.url));
    } catch {
      throw new HubError('invalid', 'delivery.url is not a URL');
    }
    if (url.protocol !== 'https:') throw new HubError('invalid', 'delivery.url must be https');
    return { name, url: url.href, secret: delivery.secret, args: args ?? {}, ttlMs };
  }

  private idOf(agentId: string, url: string, name: string, args: unknown): string {
    const canonical = (v: unknown): string =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? `{${Object.keys(v as object)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
            .join(',')}}`
        : JSON.stringify(v);
    return `sub_${createHash('sha256').update(`${agentId}\n${url}\n${name}\n${canonical(args)}`).digest('hex').slice(0, 32)}`;
  }

  private async verify(url: string, secret: string, subscriptionId: string): Promise<void> {
    const challenge = randomBytes(24).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    let echoed: unknown;
    try {
      const res = await this.signedPost(url, secret, `msg_verify_${randomBytes(8).toString('hex')}`, body, subscriptionId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      echoed = ((await res.json().catch(() => ({}))) as { challenge?: unknown }).challenge;
    } catch (err) {
      throw new CallbackError('timeout', `The callback URL didn't answer the verification: ${(err as Error).message}`);
    }
    const ok = typeof echoed === 'string' && echoed.length === challenge.length && timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
    if (!ok) throw new CallbackError('challenge_failed', "The callback URL didn't echo the challenge");
  }

  private secretOf(s: Subscription): string | undefined {
    return s.sealed && this.opts.sealingKey ? unseal(s.sealed, this.opts.sealingKey) : s.secret;
  }

  private async post(s: Subscription, eventId: string, body: string): Promise<number> {
    const secret = this.secretOf(s);
    if (!secret) throw new Error('no secret');
    return (await this.signedPost(s.url, secret, eventId, body, s.id)).status;
  }

  private signedPost(url: string, secret: string, id: string, body: string, subscriptionId: string): Promise<Response> {
    const ts = Math.floor(Date.now() / 1000);
    return this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': signWebhook(secret, id, ts, body),
        'x-mcp-subscription-id': subscriptionId,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  }
}

/** JSON-RPC -32015 (CallbackEndpointError) with `data.reason`, as the MCP Events spec asks. */
export class CallbackError extends Error {
  constructor(
    readonly reason: 'challenge_failed' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}
