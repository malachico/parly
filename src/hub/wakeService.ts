import { timingSafeEqual } from 'node:crypto';
import { InlineQueue, type PushQueue } from '../chat/queue.js';
import { HubError } from '../lib/errors.js';
import { isListening } from '../registry/registry.js';
import type { AgentRecord, RoutineSetup } from '../registry/types.js';
import type { HubService } from './hubService.js';
import {
  conversationWakeText,
  parseRoutineId,
  parseRoutineToken,
  parseXaiKey,
  routineSetupText,
  testWakeText,
  wakeText,
  type Waker,
} from './wake.js';

/** How a fire of an agent's Routine went, as its owner sees it: the session it started, or why not. */
export type WakeCheck = { ok: true; sessionUrl?: string } | { ok: false; problem: string };

/** How long a Routine's setup code works: the fire's session uses it in its first minutes. */
const ROUTINE_SETUP_MS = 60 * 60_000;
/** Fires for one agent in one pass, oldest conversation first; the next message or the sweep takes the rest. */
const MAX_WAKES_PER_PASS = 8;
/** The sweep re-pushes an endpoint's message only between these ages: younger is still in its first enqueue, older is history. */
const REPUSH_AFTER_MS = 60_000;
const REPUSH_WITHIN_MS = 24 * 60 * 60_000;

export interface WakeTiming {
  /** A woken session that hasn't read what was waiting after this long didn't start, or died: wake it again. */
  staleMs: number;
  /** After a fire Claude refused, wait this long before the next. */
  retryMs: number;
}

/**
 * Waking mailbox agents via Claude Code Routines, outgoing webhooks, or Grok/xAI.
 */
export class WakeService {
  /** Wakes being fired past their request. */
  private readonly waking = new Set<Promise<unknown>>();

  constructor(
    private readonly hub: HubService,
    private readonly queue: PushQueue,
    private readonly waker?: Waker,
    private readonly wakeTiming: WakeTiming = { staleMs: 5 * 60_000, retryMs: 10 * 60_000 },
  ) {}

  private get registry() {
    return this.hub.registry;
  }
  private get chat() {
    return this.hub.chat;
  }
  private get mcpEvents() {
    return this.hub.mcpEvents;
  }

  get configured(): boolean {
    return !!this.waker;
  }

  /** Resolves once every wake fired past its request, and every push run in this process, is done: before shutting down, and in tests. */
  async idle(): Promise<void> {
    while (this.waking.size) await Promise.all(this.waking);
    if (this.queue instanceof InlineQueue) await this.queue.idle();
  }

  /** A message for `target` is waiting: wake it, past the request (the sender never waits on Claude). */
  wakeLater(target: AgentRecord, from: string): void {
    // A client subscribed to MCP Events (a ChatGPT dot) is told, whatever else wakes the agent.
    if (!isListening(target) && !target.archived) {
      const telling: Promise<unknown> = this.chat
        .waitingSince(target)
        .then((w) => (w.length ? this.mcpEvents.deliver(target, w.length, w.sort()[0]!, from) : 0))
        .catch((err) => console.error(`MCP event for ${target.id} failed`, err))
        .finally(() => this.waking.delete(telling));
      this.waking.add(telling);
    }
    if (!this.waker || !target.wake) return;
    const waking: Promise<unknown> = this.wake(target.id, from)
      .catch((err) => console.error(`Waking ${target.id} failed`, err))
      .finally(() => this.waking.delete(waking));
    this.waking.add(waking);
  }

  /**
   * Wakes a mailbox agent that isn't listening while messages wait for it, by firing its Claude Code Routine:
   * the session that starts reads the inbox over MCP. Every fire is a new session, so one burst of messages
   * gets one: no fire while the session woken last hasn't read what was waiting then (it takes the newer ones
   * too), unless that was over `staleMs` ago (it never started, or died). A refused fire is retried after
   * `retryMs`, by the next message or the sweep. Returns whether it fired.
   */
  async wake(agentId: string, from?: string): Promise<boolean> {
    if (!this.waker) return false;
    const agent = await this.registry.get(agentId);
    const wake = agent?.wake;
    if (!agent || !wake || agent.archived || agent.kind !== 'mailbox' || isListening(agent)) return false;
    if (wake.perConversation) return this.wakeConversations(agent);
    const waiting = (await this.chat.waitingSince(agent)).sort();
    if (waiting.length === 0) return false;
    const last = wake.lastFire;
    if (!this.fireDue(last, waiting[0]!)) return false;
    const claimed = await this.registry.claimFire(agent.id, last?.at);
    if (!claimed) return false;
    await this.fire({ ...agent, wake: claimed }, wakeText(agent.name, waiting.length, from));
    return true;
  }

  /** Whether mail waiting since `since` calls for a fire, after `last`. */
  private fireDue(last: { at: string; ok: boolean } | undefined, since: string): boolean {
    if (!last) return true;
    const age = Date.now() - Date.parse(last.at);
    return last.ok ? age >= this.wakeTiming.staleMs || since > last.at : age >= this.wakeTiming.retryMs;
  }

  /**
   * `wake`, for a routine whose run answers one conversation: the same rules, per conversation, so a conversation
   * with a run on its way isn't fired again while another's first message still is. A fire refused (a routine's rate
   * limit, say) leaves the rest for the retry rather than spending more of it.
   */
  private async wakeConversations(agent: AgentRecord): Promise<boolean> {
    const waiting = await this.chat.waitingIn(agent);
    if (waiting.length === 0) return false;
    const claimed = await this.registry.claimConversationFires(
      agent.id,
      waiting.map((w) => w.conversation),
      (fires) => waiting.filter((w) => this.fireDue(fires[w.conversation], w.since)).slice(0, MAX_WAKES_PER_PASS).map((w) => w.conversation),
    );
    if (!claimed) return false;
    const woken = { ...agent, wake: claimed.wake };
    const at = claimed.wake.lastFire!.at;
    const left = [...claimed.conversations];
    let sessionUrl: string | undefined;
    try {
      while (left.length) {
        const conversation = left[0]!;
        const from = waiting.find((w) => w.conversation === conversation)?.from;
        sessionUrl = (await this.waker!.fire(woken, conversationWakeText(agent.name, conversation, from), conversation)).sessionUrl ?? sessionUrl;
        left.shift();
      }
      await this.registry.recordFire(agent.id, at, { sessionUrl });
    } catch (err) {
      await this.registry.failConversationFires(agent.id, at, left);
      await this.registry.recordFire(agent.id, at, { problem: (err as Error).message });
    }
    return true;
  }

  /** One fire of the agent's Routine (claimFire has just recorded it), and how it went, kept for its owner. */
  private async fire(agent: AgentRecord, text: string): Promise<WakeCheck> {
    const at = agent.wake!.lastFire!.at;
    try {
      const { sessionUrl } = await this.waker!.fire(agent, text);
      await this.registry.recordFire(agent.id, at, { sessionUrl });
      return { ok: true, ...(sessionUrl ? { sessionUrl } : {}) };
    } catch (err) {
      const problem = (err as Error).message;
      await this.registry.recordFire(agent.id, at, { problem });
      return { ok: false, problem };
    }
  }

  /**
   * The owner connects their mailbox bot to a Routine's API trigger or an outgoing webhook URL, or disconnects
   * it (null). Connecting fires it once (`check`), the only way to know the token/URL works.
   */
  async setWake(
    caller: AgentRecord,
    botId: string,
    input: { type?: unknown; routineId?: unknown; token?: unknown; url?: unknown; secret?: unknown; authorization?: unknown; apiKey?: unknown; perConversation?: unknown } | null,
  ): Promise<{ agent: AgentRecord; check?: WakeCheck }> {
    const bot = await this.requireOwnBot(caller, botId);
    if (input === null) return { agent: await this.registry.setWake(bot, null) };
    if (!this.waker) throw new HubError('unavailable', "This hub doesn't wake agents");
    if (input.type === 'xai') {
      // Grok answers as this bot: it gets a token of its own (which ends any other connection the bot had).
      const apiKey = parseXaiKey(typeof input.apiKey === 'string' ? input.apiKey : '');
      const agent = await this.registry.setWake(bot, { type: 'xai', apiKey, token: await this.registry.rotateToken(bot) });
      const check = await this.testWake(caller, agent.id);
      // A key xAI refuses leaves no wake behind: nothing fires with it again.
      if (!check.ok) return { agent: await this.registry.setWake(agent, null), check };
      return { agent: (await this.registry.get(agent.id)) ?? agent, check };
    }
    if (input.type === 'webhook' || (input.type === undefined && typeof input.url === 'string')) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (input.secret !== undefined && typeof input.secret !== 'string') {
        throw new HubError('invalid', 'secret must be a string');
      }
      const secret = typeof input.secret === 'string' && input.secret.trim() ? input.secret.trim() : undefined;
      if (input.authorization !== undefined && typeof input.authorization !== 'string') throw new HubError('invalid', 'authorization must be a string');
      // ponytail: header injection is stopped by fetch itself (it rejects CR/LF in header values).
      // As pasted: "Authorization: Bearer …" or a bare token both mean the header value "Bearer …".
      const raw = typeof input.authorization === 'string' ? input.authorization.trim().replace(/^authorization:\s*/i, '') : undefined;
      const authorization = raw && !/^\w+\s/.test(raw) ? `Bearer ${raw}` : raw;
      if (input.perConversation !== undefined && typeof input.perConversation !== 'boolean') throw new HubError('invalid', 'perConversation must be true or false');
      const agent = await this.registry.setWake(bot, { type: 'webhook', url, ...(secret ? { secret } : {}), ...(authorization !== undefined ? { authorization } : {}), ...(input.perConversation !== undefined ? { perConversation: input.perConversation } : {}) });
      const check = await this.testWake(caller, agent.id);
      return { agent: (await this.registry.get(agent.id)) ?? agent, check };
    }
    const routineId = parseRoutineId(typeof input.routineId === 'string' ? input.routineId : '');
    const token = parseRoutineToken(typeof input.token === 'string' ? input.token : '');
    const agent = await this.registry.setWake(bot, { routineId, token });
    const check = await this.testWake(caller, agent.id);
    return { agent: (await this.registry.get(agent.id)) ?? agent, check };
  }

  /** The owner's "Wake it now": fires the Routine once, whatever is waiting, and says how it went. */
  async testWake(caller: AgentRecord, botId: string): Promise<WakeCheck> {
    const bot = await this.requireOwnBot(caller, botId);
    if (!bot.wake) throw new HubError('invalid', `${bot.name} has no Routine to wake`);
    if (!this.waker) throw new HubError('unavailable', "This hub doesn't wake agents");
    const claimed = await this.registry.claimFire(bot.id, bot.wake.lastFire?.at);
    if (!claimed) throw new HubError('conflict', `${bot.name} is being woken right now; try again in a moment`);
    return this.fire({ ...bot, wake: claimed }, testWakeText(bot.name));
  }

  /**
   * Wakes every agent with a Routine that has messages waiting and is due (see wake): catches fires that
   * failed, and sessions that never came. Run every minute or so; returns how many it fired.
   */
  async wakeSweep(): Promise<number> {
    let fired = await this.repush().catch((err) => (console.error('Re-pushing endpoints failed', err), 0));
    if (!this.waker) return fired;
    for (const agent of await this.registry.wakeable()) {
      if (await this.wake(agent.id).catch((err) => (console.error(`Waking ${agent.id} failed`, err), false))) fired++;
    }
    return fired;
  }

  /** Re-pushes endpoint agents' messages whose push was never enqueued (PUSH_DROPPED): not sent, no push in flight. */
  private async repush(): Promise<number> {
    let pushed = 0;
    const now = Date.now();
    for (const agent of await this.registry.endpoints()) {
      for (const { conversation, message } of await this.chat.newFor(agent)) {
        const age = now - Date.parse(message.at);
        if (age < REPUSH_AFTER_MS || age > REPUSH_WITHIN_MS) continue;
        // Sent: the push reached the endpoint and its queue owns the retries.
        if (((await this.chat.store.cursor(agent.id, conversation.id))?.sending ?? 0) >= message.seq) continue;
        if (await this.chat.store.leased(agent.id, conversation.id)) continue;
        await this.queue.enqueue({ agentId: agent.id, conversationId: conversation.id });
        pushed++;
      }
    }
    return pushed;
  }

  /**
   * A person connects a Routine without saying which agent it is: its sessions sign in through Claude's Parly
   * connector, which already is one of their agents. The hub fires it with a one-time code, and the agent whose
   * session calls whoami with that code gets the Routine (claimRoutine). `check` says how the fire went.
   */
  async startRoutine(caller: AgentRecord, input: { routineId?: unknown; token?: unknown }): Promise<WakeCheck> {
    if (caller.kind !== 'human') throw new HubError('forbidden', 'A person connects a Routine, from the Connect page');
    const routineId = parseRoutineId(typeof input.routineId === 'string' ? input.routineId : '');
    const token = parseRoutineToken(typeof input.token === 'string' ? input.token : '');
    if (!this.waker) throw new HubError('unavailable', "This hub doesn't wake agents");
    const setup = await this.registry.startRoutineSetup(caller, routineId, token);
    const { secret: _s, at: _a, ...trigger } = setup;
    try {
      const { sessionUrl } = await this.waker.fire({ ...caller, wake: { type: 'claude-routine', ...trigger } }, routineSetupText(`${caller.id}.${setup.secret}`));
      await this.registry.noteRoutineSetup(caller.id, setup.at, { ...(sessionUrl ? { sessionUrl } : {}) });
      return { ok: true, ...(sessionUrl ? { sessionUrl } : {}) };
    } catch (err) {
      const problem = (err as Error).message;
      await this.registry.noteRoutineSetup(caller.id, setup.at, { problem });
      return { ok: false, problem };
    }
  }

  /** The Routine its owner is connecting, while its session hasn't said which agent it is (never its token or code). */
  routineSetupOf(person: AgentRecord): { routineId: string; at: string; sessionUrl?: string; problem?: string } | undefined {
    const s = person.routineSetup;
    return s && { routineId: s.routineId, at: s.at, ...(s.sessionUrl ? { sessionUrl: s.sessionUrl } : {}), ...(s.problem ? { problem: s.problem } : {}) };
  }

  /**
   * whoami with a Routine's setup code: the calling agent is the one the Routine's sessions sign in as, so it gets
   * the Routine. Its owner has to be the person connecting it; otherwise they're told who signed in instead.
   */
  async claimRoutine(caller: AgentRecord, code: string): Promise<AgentRecord> {
    const [ownerId = '', secret = ''] = code.trim().split('.');
    const owner = /^[\w-]{1,64}$/.test(ownerId) ? await this.registry.get(ownerId) : undefined;
    const setup: RoutineSetup | undefined = owner?.routineSetup;
    const valid = !!setup && setup.secret.length === secret.length && timingSafeEqual(Buffer.from(setup.secret), Buffer.from(secret));
    if (!valid || Date.now() - Date.parse(setup!.at) > ROUTINE_SETUP_MS) throw new HubError('invalid', 'That Routine code is no longer valid: its owner connects the Routine again on the Connect page');
    if (caller.ownerId !== owner!.id || caller.kind !== 'mailbox') {
      const problem = `The Routine's sessions sign in as ${caller.name}, which isn't one of your agents (it belongs to another Parly account). In Claude, connect Parly again, signed in to this site as you, then connect the Routine again.`;
      await this.registry.noteRoutineSetup(owner!.id, setup!.at, { problem });
      throw new HubError('forbidden', `This Routine is being connected by someone else's account, so it can't wake ${caller.name}. They were told.`);
    }
    return this.registry.attachRoutine(caller, setup!);
  }

  private async requireOwnBot(caller: AgentRecord, botId: string): Promise<AgentRecord> {
    const bot = await this.registry.requireSelfOrOwned(caller, botId);
    if (bot.id === caller.id || bot.kind === 'human') throw new HubError('invalid', 'A Routine wakes a bot you own, not you');
    return bot;
  }
}
