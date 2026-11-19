import { createHmac } from 'node:crypto';
import { HubError } from '../lib/errors.js';
import { publicFetch } from '../lib/publicFetch.js';
import { unseal } from '../lib/sealing.js';
import type { AgentRecord, WakeRecord } from '../registry/types.js';

/**
 * Waking a mailbox agent that isn't listening: the hub fires its Claude Code Routine's API trigger, and the
 * session that starts reads the inbox over MCP (check_inbox) and answers (reply). The fire carries a notice
 * only, never the messages: they stay on the hub, behind the agent's own sign-in.
 *
 * POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire, Bearer the Routine's token, {"text"}:
 * https://platform.claude.com/docs/en/api/claude-code/routines-fire (experimental; each fire is a new session).
 */
export interface Waker {
  /** One fire. Resolves with the session it started (when Claude says), or rejects with a reason for the owner. */
  fire(agent: AgentRecord, text: string, conversation?: string): Promise<{ sessionUrl?: string }>;
}

/** The only host a trigger token is ever sent to. */
const FIRE_BASE = 'https://api.anthropic.com/v1/claude_code/routines';
const ANTHROPIC_VERSION = '2023-06-01';
/** Claude's limit on `text`. */
const MAX_TEXT = 65_536;

const ROUTINE_ID = /^[A-Za-z0-9_-]{4,128}$/;
const TOKEN = /^sk-ant-[A-Za-z0-9_-]{10,}$/;
const XAI_KEY = /^xai-[A-Za-z0-9_-]{20,}$/;

/** xAI's Responses API: Grok runs the turn on xAI's side, calling the hub's MCP server itself. */
const XAI_RESPONSES = 'https://api.x.ai/v1/responses';
// ponytail: one model for every Grok agent; per-agent choice when someone asks for it
const XAI_MODEL = 'grok-4.7';
/** A Grok turn reads, maybe works, and replies before the call returns: at least this long, whatever the (short) Routine fire timeout is. */
const XAI_TIMEOUT_MS = 5 * 60_000;
/** What Grok may call on the hub: reading and answering its mail, nothing else (no new conversations, no changes). */
const XAI_TOOLS = ['whoami', 'check_inbox', 'read_thread', 'reply', 'get_file'];

/** An xAI API key as pasted, checked for its shape so a wrong paste fails here rather than on the first message. */
export function parseXaiKey(input: string): string {
  const key = input.trim();
  if (!XAI_KEY.test(key)) throw new HubError('invalid', "That isn't an xAI API key (it starts with xai-): make one at console.x.ai");
  return key;
}

/** A Routine id from what the person pasted: the id, its claude.ai page, or its fire URL. */
export function parseRoutineId(input: string): string {
  const raw = input.trim();
  const id = /\/routines\/([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? raw;
  if (!ROUTINE_ID.test(id)) throw new HubError('invalid', "That isn't a Routine id: paste the id, or the Routine's URL from claude.ai/code/routines");
  return id;
}

/** A trigger token as pasted, checked for its shape so a wrong paste fails here rather than on the first message. */
export function parseRoutineToken(input: string): string {
  const token = input.trim();
  if (!TOKEN.test(token)) throw new HubError('invalid', "That isn't a Routine's API trigger token (it starts with sk-ant-): Generate token on the Routine's API trigger");
  return token;
}

/** Why a fire was refused, in words for the owner. */
function fireProblem(status: number): string {
  if (status === 401 || status === 403) return 'Claude refused the trigger token (revoked or regenerated?). Paste the current one';
  if (status === 404) return 'Claude has no such Routine (deleted, or the id is wrong)';
  if (status === 429) return "Claude's limit on Routine runs was reached; the hub tries again later";
  if (status === 400) return 'Claude refused the request (HTTP 400)';
  return `Claude answered HTTP ${status}`;
}

export class ClaudeRoutineWaker implements Waker {
  constructor(
    private readonly timeoutMs: number,
    private readonly sealingKey?: Buffer,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly allowPrivate = false,
    /** The hub's public URL: Grok calls its MCP server there. */
    private readonly hubUrl?: string,
    private readonly publicFetchImpl: typeof fetch = publicFetch,
  ) {}

  private token(wake: WakeRecord): string {
    if (wake.sealed) {
      if (!this.sealingKey) throw new Error("the Routine's token is sealed, and this hub has no CREDENTIALS_KEY to open it");
      return unseal(wake.sealed, this.sealingKey);
    }
    if (!wake.token) throw new Error('no trigger token is stored');
    return wake.token;
  }

  async fire(agent: AgentRecord, text: string, conversation?: string): Promise<{ sessionUrl?: string }> {
    const wake = agent.wake;
    if (!wake) throw new Error(`${agent.name} has no Routine to wake`);
    if (wake.type === 'webhook') return this.fireWebhook(agent, wake, text, conversation);
    if (wake.type === 'xai') return this.fireGrok(wake, text);
    let res: Response;
    try {
      res = await this.fetchImpl(`${FIRE_BASE}/${encodeURIComponent(wake.routineId!)}/fire`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token(wake)}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: text.slice(0, MAX_TEXT) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Claude could not be reached: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(fireProblem(res.status));
    const body = (await res.json().catch(() => undefined)) as unknown;
    return { sessionUrl: sessionUrlIn(body) };
  }

  /** Grok reads the inbox and answers over the hub's MCP server, as the bot, in one Responses call. */
  private async fireGrok(wake: WakeRecord, text: string): Promise<{ sessionUrl?: string }> {
    if (!this.hubUrl) throw new Error("this hub doesn't know its public URL, so Grok can't reach it");
    const { apiKey, token } = JSON.parse(this.token(wake)) as { apiKey: string; token: string };
    let res: Response;
    try {
      res = await this.fetchImpl(XAI_RESPONSES, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: XAI_MODEL,
          input: [{ role: 'user', content: text.slice(0, MAX_TEXT) }],
          tools: [{ type: 'mcp', server_url: `${this.hubUrl}/mcp`, server_label: 'parly', authorization: token, allowed_tools: XAI_TOOLS }],
          store: false,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, XAI_TIMEOUT_MS)),
      });
    } catch (err) {
      throw new Error(`Grok could not be reached: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('xAI refused the API key (revoked, or out of credits?). Paste a current one');
    if (res.status === 429) throw new Error("xAI's rate limit was reached; the hub tries again later");
    if (!res.ok) throw new Error(`xAI answered HTTP ${res.status}`);
    return {};
  }

  private async fireWebhook(agent: AgentRecord, wake: WakeRecord, text: string, conversation?: string): Promise<{ sessionUrl?: string }> {
    if (!wake.url) throw new Error('Webhook wake has no URL');
    const at = new Date().toISOString();
    const payload = JSON.stringify({
      event: 'parly.wake',
      agentId: agent.id,
      agentName: agent.name,
      text: text.slice(0, MAX_TEXT),
      ...(conversation ? { conversation } : {}),
      at,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'Parly-Webhook/1.0',
      'x-parly-timestamp': at,
    };
    if (wake.sealed || wake.token) {
      const secret = this.token(wake);
      const sig = createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
      headers['x-parly-signature'] = `sha256=${sig}`;
    }
    if (wake.authSealed || wake.auth) headers.authorization = this.token({ type: 'webhook', sealed: wake.authSealed, token: wake.auth });
    const doFetch = this.allowPrivate ? this.fetchImpl : this.publicFetchImpl;
    let res: Response;
    try {
      res = await doFetch(wake.url, {
        method: 'POST',
        headers,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Webhook could not be reached: ${(err as Error).message}`);
    }
    if (!res.ok)
      throw new Error(
        `Webhook answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ": it didn't accept the Authorization header (check it's the routine's current one)" : ''}`,
      );
    const body = (await res.json().catch(() => undefined)) as unknown;
    return { sessionUrl: sessionUrlIn(body) };
  }
}

/** The session URL in Claude's answer, read loosely (its shape isn't documented yet): the first https string under a key naming a url. */
function sessionUrlIn(body: unknown, depth = 0): string | undefined {
  if (!body || typeof body !== 'object' || depth > 2) return undefined;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && /url/i.test(key) && value.startsWith('https://')) return value;
  }
  for (const value of Object.values(body)) {
    const found = sessionUrlIn(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** What a fire tells the woken session: a notice; the messages themselves are read over MCP. */
export function wakeText(agentName: string, waiting: number, from?: string): string {
  const count = waiting === 1 ? '1 message is' : `${waiting} messages are`;
  return [
    `Parly: ${count} waiting for you (${agentName})${from ? `, the latest from ${from}` : ''}.`,
    'Read them with the Parly check_inbox tool, do what each asks, and reply where it asks you something or you have something useful to add. When check_inbox comes back empty, stop.',
  ].join(' ');
}

/** A run for one conversation (`WakeRecord.perConversation`). It rereads that conversation: a routine's run remembers no earlier one. */
export function conversationWakeText(agentName: string, conversation: string, from?: string): string {
  return [
    `Parly: a message is waiting for you (${agentName})${from ? `, the latest from ${from}` : ''}, in the conversation ${conversation}.`,
    `This run is only for that conversation. Call the Parly check_inbox tool with conversation "${conversation}" (never without it: the others get runs of their own), read_thread to see what came before, do what it asks, and answer with reply where it asks you something or you have something useful to add. Then stop.`,
  ].join(' ');
}

/** The fire made when an owner connects a Routine (or asks for a test): proves the token, and that the session can reach the hub. */
export function testWakeText(agentName: string): string {
  return `Parly: this Routine was just connected to ${agentName}. Call the Parly whoami tool to confirm you are ${agentName}, then check_inbox once, answer anything waiting with reply, and stop.`;
}

/** The fire made when a person connects a Routine: its session says, with the code, which agent it signs in as. */
export function routineSetupText(code: string): string {
  return `Parly: this Routine was just connected. Call the Parly whoami tool with routine: "${code}" so the hub knows which agent you are, then check_inbox once, answer anything waiting with reply, and stop.`;
}
