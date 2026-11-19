import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/app.js';
import type { HubService } from '../src/hub/hubService.js';
import { ClaudeRoutineWaker, parseRoutineId, parseRoutineToken, type Waker } from '../src/hub/wake.js';
import { agentView } from '../src/lib/present.js';
import { parseSealingKey } from '../src/lib/sealing.js';
import type { AgentRecord } from '../src/registry/types.js';
import type { Database } from '../src/db/types.js';
import { crew, testConfig, testDb } from './helpers.js';

const TOKEN = 'sk-ant-oat01-abcdefghijklmnop';

describe('ClaudeRoutineWaker', () => {
  const agent = { id: 'a1', name: 'Dana', wake: { type: 'claude-routine', routineId: 'trig_123', token: TOKEN } } as unknown as AgentRecord;

  it('keeps private webhook URLs blocked when a general API fetch is injected', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
    const hook = { ...agent, wake: { type: 'webhook', url: 'http://127.0.0.1:9999/wake' } } as AgentRecord;
    await expect(new ClaudeRoutineWaker(1000, undefined, fetchImpl).fire(hook, 'x')).rejects.toThrow(/private address/);
    expect(calls).toBe(0);
    await new ClaudeRoutineWaker(1000, undefined, fetchImpl, true).fire(hook, 'x');
    expect(calls).toBe(1);
  });

  it('fires the Routine the way the docs show, and keeps the session URL', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ session: { id: 's1', url: 'https://claude.ai/code/session_1' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await new ClaudeRoutineWaker(1000, undefined, fetchImpl).fire(agent, 'hello');
    expect(seen!.url).toBe('https://api.anthropic.com/v1/claude_code/routines/trig_123/fire');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ text: 'hello' });
    expect(got.sessionUrl).toBe('https://claude.ai/code/session_1');
  });

  it('names the conversation in a webhook fire, only when there is one', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => (bodies.push(String(init.body)), new Response('{}', { status: 200 }))) as unknown as typeof fetch;
    const hook = { ...agent, wake: { type: 'webhook', url: 'https://hooks.example.com/grok' } } as AgentRecord;
    const waker = new ClaudeRoutineWaker(1000, undefined, undefined, false, undefined, fetchImpl);
    await waker.fire(hook, 'x', 'thread:c1:p1');
    await waker.fire(hook, 'x');
    expect(JSON.parse(bodies[0]!).conversation).toBe('thread:c1:p1');
    expect(JSON.parse(bodies[1]!)).not.toHaveProperty('conversation');
  });

  it('opens a sealed token, and says why Claude refused', async () => {
    const key = parseSealingKey(Buffer.alloc(32, 7).toString('base64'))!;
    const { seal } = await import('../src/lib/sealing.js');
    const sealed = { ...agent, wake: { type: 'claude-routine' as const, routineId: 'trig_123', sealed: seal(TOKEN, key) } };
    let auth = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization!;
      return new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    await expect(new ClaudeRoutineWaker(1000, key, fetchImpl).fire(sealed, 'x')).rejects.toThrow(/refused the trigger token/);
    expect(auth).toBe(`Bearer ${TOKEN}`);
  });

  it('reads a Routine id from what people paste, and checks the token', () => {
    expect(parseRoutineId('trig_01AbC')).toBe('trig_01AbC');
    expect(parseRoutineId('https://claude.ai/code/routines/trig_01AbC')).toBe('trig_01AbC');
    expect(parseRoutineId('https://api.anthropic.com/v1/claude_code/routines/trig_01AbC/fire')).toBe('trig_01AbC');
    expect(() => parseRoutineId('not an id!')).toThrow();
    expect(parseRoutineToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(() => parseRoutineToken('a2ah_whatever')).toThrow();
  });
});

describe('waking a mailbox agent with its Routine', () => {
  let hub: HubService;
  let db: Database;
  const fires: { agent: string; text: string; conversation?: string }[] = [];
  let refuse = false;
  const waker: Waker = {
    fire: async (agent, text, conversation) => {
      fires.push({ agent: agent.id, text, ...(conversation ? { conversation } : {}) });
      if (refuse) throw new Error('Claude answered HTTP 503');
      return { sessionUrl: `https://claude.ai/code/session_${fires.length}` };
    },
  };
  const firesFor = (id: string) => fires.filter((f) => f.agent === id);

  beforeEach(() => {
    // Control wake deadlines without faking the timers used by the DB client.
    vi.useFakeTimers({ toFake: ['Date'] });
    db = testDb();
    hub = createHub({ db, config: testConfig({ wakeStaleMs: 400, wakeRetryMs: 400 }), waker });
  });

  afterEach(async () => {
    await hub.wakeService.idle();
    refuse = false;
    vi.useRealTimers();
  });

  /** A crew whose second bot is woken by a Routine (connecting it fires once, the test fire). */
  async function woken(name: string) {
    const { owner, members } = await crew(hub.registry, name);
    const [sender, bot] = members as [AgentRecord, AgentRecord];
    const { check } = await hub.wakeService.setWake(owner, bot.id, { routineId: `https://claude.ai/code/routines/trig_${name}`, token: TOKEN });
    expect(check).toEqual({ ok: true, sessionUrl: expect.stringContaining('https://claude.ai/code/session_') });
    vi.setSystemTime(Date.now() + 1); // New mail arrives after the setup fire.
    return { owner, sender, bot };
  }

  it('connecting fires once; the owner sees the Routine and its session, never the token', async () => {
    const { owner, bot } = await woken('wake-connect');
    expect(firesFor(bot.id)).toHaveLength(1);
    expect(firesFor(bot.id)[0]!.text).toContain('whoami');
    const stored = (await hub.registry.get(bot.id))!;
    const view = agentView(stored, owner);
    expect(view.wake).toMatchObject({ type: 'claude-routine', routineId: 'trig_wake-connect', lastFire: { ok: true } });
    expect(view.wakes).toBe(true);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(agentView(stored))).not.toContain('routineId');
  });

  it('a routine that answers one conversation is fired once for each, told which, and only again when that one has news', async () => {
    const { owner, members } = await crew(hub.registry, 'wake-threads');
    const [sender, bot] = members as [AgentRecord, AgentRecord];
    await hub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/grok', perConversation: true });
    fires.length = 0;
    await hub.send(sender, { to: bot.id }, [{ text: 'one' }]);
    await hub.wakeService.idle();
    vi.setSystemTime(Date.now() + 1);
    await hub.send(owner, { to: bot.id }, [{ text: 'two' }]);
    await hub.send(sender, { to: bot.id }, [{ text: 'three' }]);
    await hub.wakeService.idle();
    const first = firesFor(bot.id);
    const conversations = first.map((f) => f.conversation);
    expect(new Set(conversations).size).toBe(2);
    expect(first).toHaveLength(2);
    expect(first[0]!.text).toContain(`check_inbox tool with conversation "${conversations[0]}"`);

    // Its first run reads its conversation; news there fires that one again, and the other, still unread, stays put.
    const stored = (await hub.registry.get(bot.id))!;
    await hub.chat.take(stored, 20, conversations[0]);
    vi.setSystemTime(Date.now() + 1);
    await hub.send(sender, { to: bot.id }, [{ text: 'four' }]);
    await hub.wakeService.idle();
    expect(firesFor(bot.id).map((f) => f.conversation)).toEqual([...conversations, conversations[0]]);

    // Changing the URL keeps it; a refused fire is said to the owner and tried again.
    await hub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/grok2' });
    expect((await hub.registry.get(bot.id))!.wake!.perConversation).toBe(true);
    vi.setSystemTime(Date.now() + 400);
    refuse = true;
    fires.length = 0;
    expect(await hub.wakeService.wake(bot.id)).toBe(true);
    refuse = false;
    expect(firesFor(bot.id)).toHaveLength(1); // the first refusal leaves the rest for the retry
    expect((await hub.registry.get(bot.id))!.wake!.problem).toMatch(/503/);
    expect(await hub.wakeService.wake(bot.id)).toBe(false);
    vi.setSystemTime(Date.now() + 400);
    expect(await hub.wakeService.wake(bot.id)).toBe(true);
    expect(firesFor(bot.id)).toHaveLength(3);
    expect((await hub.registry.get(bot.id))!.wake!.problem).toBeUndefined();
  });

  it('a webhook without it stays one wake for all of its conversations', async () => {
    const { owner, members } = await crew(hub.registry, 'wake-one');
    const [sender, bot] = members as [AgentRecord, AgentRecord];
    await hub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/plain' });
    vi.setSystemTime(Date.now() + 1);
    fires.length = 0;
    await hub.send(sender, { to: bot.id }, [{ text: 'one' }]);
    await hub.send(owner, { to: bot.id }, [{ text: 'two' }]);
    await hub.wakeService.idle();
    expect(firesFor(bot.id)).toHaveLength(1);
    expect(firesFor(bot.id)[0]!.conversation).toBeUndefined();
    await expect(hub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/plain', perConversation: 'yes' })).rejects.toThrow(/true or false/);
  });

  it('one burst of messages wakes it once; a message after its session read them wakes it again', async () => {
    const { sender, bot } = await woken('wake-burst');
    const before = firesFor(bot.id).length;
    for (const text of ['one', 'two', 'three']) await hub.send(sender, { to: bot.id }, [{ text }]);
    await hub.wakeService.idle();
    expect(firesFor(bot.id)).toHaveLength(before + 1);
    expect(firesFor(bot.id).at(-1)!.text).toMatch(/message/);

    // The woken session reads its inbox (one conversation, three messages); the next message needs a new one.
    const [item] = await hub.chat.take((await hub.registry.get(bot.id))!);
    expect(item!.earlier.map((m) => m.parts[0]?.text)).toEqual(['one', 'two']);
    vi.setSystemTime(Date.now() + 1);
    await hub.send(sender, { to: bot.id }, [{ text: 'four' }]);
    await hub.wakeService.idle();
    expect(firesFor(bot.id)).toHaveLength(before + 2);
  });

  it("doesn't wake an agent that is listening, and the sweep wakes it again when its session never came", async () => {
    const { sender, bot } = await woken('wake-listen');
    const before = firesFor(bot.id).length;
    await hub.registry.markListening((await hub.registry.get(bot.id))!);
    await hub.send(sender, { to: bot.id }, [{ text: 'hi' }]);
    await hub.wakeService.idle();
    expect(firesFor(bot.id)).toHaveLength(before);

    // Not listening any more (its wait ended long ago).
    await db.collection('agents').doc(bot.id).update({ listeningUntil: new Date(Date.now() - 1000).toISOString() });
    await hub.wakeService.wakeSweep();
    expect(firesFor(bot.id)).toHaveLength(before + 1);
    // Woken, not yet read: no second fire until it's stale.
    vi.setSystemTime(Date.now() + 399);
    await hub.wakeService.wakeSweep();
    expect(firesFor(bot.id)).toHaveLength(before + 1);
    vi.setSystemTime(Date.now() + 1);
    await hub.wakeService.wakeSweep();
    expect(firesFor(bot.id)).toHaveLength(before + 2);
  });

  it('a refused fire is kept for the owner and in the sender\'s warning, and retried later', async () => {
    const { owner, sender, bot } = await woken('wake-refused');
    refuse = true;
    try {
      const task = await hub.send(sender, { to: bot.id }, [{ text: 'hi' }]);
      await hub.wakeService.idle();
      const stored = (await hub.registry.get(bot.id))!;
      expect(agentView(stored, owner).wake?.problem).toBe('Claude answered HTTP 503');
      expect(agentView(stored, owner).wakes).toBeUndefined();
      const [warning] = hub.listeningWarnings([(await hub.registry.get(bot.id))!], task.message);
      expect(warning?.text).toContain("can't wake it");
      const before = firesFor(bot.id).length;
      await hub.wakeService.wakeSweep();
      expect(firesFor(bot.id)).toHaveLength(before);
    } finally {
      refuse = false;
    }
    vi.setSystemTime(Date.now() + 400);
    await hub.wakeService.wakeSweep();
    expect(agentView((await hub.registry.get(bot.id))!, owner).wake?.problem).toBeUndefined();
  });

  it('a healthy Routine means no not-listening warning; disconnecting brings it back', async () => {
    const { owner, sender, bot } = await woken('wake-warn');
    const task = await hub.send(sender, { to: bot.id }, [{ text: 'hi' }]);
    await hub.wakeService.idle();
    expect(hub.listeningWarnings([(await hub.registry.get(bot.id))!], task.message)).toEqual([]);
    await hub.wakeService.setWake(owner, bot.id, null);
    expect((await hub.registry.get(bot.id))!.wake).toBeUndefined();
    expect(hub.listeningWarnings([(await hub.registry.get(bot.id))!], task.message)).toHaveLength(1);
  });

  it('only the owner connects a Routine, and only to a mailbox bot', async () => {
    const { members, owner } = await crew(hub.registry, 'wake-perm');
    const [a, b] = members as [AgentRecord, AgentRecord];
    await expect(hub.wakeService.setWake(a, b.id, { routineId: 'trig_x', token: TOKEN })).rejects.toThrow();
    await expect(hub.wakeService.setWake(owner, owner.id, { routineId: 'trig_x', token: TOKEN })).rejects.toThrow();
    await expect(hub.wakeService.setWake(owner, a.id, { routineId: 'trig_x', token: 'nope' })).rejects.toThrow(/sk-ant-/);
  });

  it('connecting without naming an agent: the agent whose session calls whoami with the code gets the Routine', async () => {
    const { owner, members } = await crew(hub.registry, 'wake-claim');
    const [old, connector] = members as [AgentRecord, AgentRecord];
    await hub.wakeService.setWake(owner, old.id, { routineId: 'trig_wake-claim', token: TOKEN });
    expect(await hub.wakeService.startRoutine(owner, { routineId: 'trig_wake-claim', token: TOKEN })).toMatchObject({ ok: true });
    const code = /routine: "([^"]+)"/.exec(firesFor(owner.id).at(-1)!.text)![1]!;
    expect(hub.wakeService.routineSetupOf((await hub.registry.get(owner.id))!)).toMatchObject({ routineId: 'trig_wake-claim', sessionUrl: expect.any(String) });
    expect(JSON.stringify(hub.wakeService.routineSetupOf((await hub.registry.get(owner.id))!))).not.toContain(code.split('.')[1]);

    // Someone else's agent with the code: refused, and the owner is told who signed in.
    const stranger = (await crew(hub.registry, 'wake-claim-other')).members[0]!;
    await expect(hub.wakeService.claimRoutine(stranger, code)).rejects.toThrow(/someone else's account/);
    expect(hub.wakeService.routineSetupOf((await hub.registry.get(owner.id))!)?.problem).toContain(stranger.name);

    await expect(hub.wakeService.claimRoutine(connector, `${owner.id}.wrong`)).rejects.toThrow(/no longer valid/);
    await hub.wakeService.claimRoutine(connector, code);
    expect((await hub.registry.get(connector.id))!.wake).toMatchObject({ routineId: 'trig_wake-claim', lastFire: { ok: true } });
    expect((await hub.registry.get(old.id))!.wake).toBeUndefined();
    expect(hub.wakeService.routineSetupOf((await hub.registry.get(owner.id))!)).toBeUndefined();
    await expect(hub.wakeService.claimRoutine(connector, code)).rejects.toThrow(/no longer valid/);
  });

  it('wakes a Grok agent through xAI with the hub as its MCP server, as the bot, never showing the key', async () => {
    const key = parseSealingKey(Buffer.alloc(32, 9).toString('base64'))!;
    const calls: { url: string; auth: string; body: any }[] = [];
    const grokWaker = new ClaudeRoutineWaker(5_000, key, (async (url, init) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).authorization!, body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: calls.length > 1 ? 401 : 200 });
    }) as typeof fetch, false, 'https://hub.example');
    const grokHub = createHub({ db, config: testConfig({ credentialsKey: key }), waker: grokWaker });
    const { owner, members } = await crew(grokHub.registry, 'wake-grok');
    const bot = members[1] as AgentRecord;
    await expect(grokHub.wakeService.setWake(owner, bot.id, { type: 'xai', apiKey: 'sk-not-xai' })).rejects.toThrow(/xAI API key/);

    const apiKey = 'xai-abcdefghijklmnopqrstuvwxyz0123';
    const saved = await grokHub.wakeService.setWake(owner, bot.id, { type: 'xai', apiKey });
    expect(saved.check).toEqual({ ok: true });
    expect(JSON.stringify(agentView(saved.agent, owner))).not.toContain(apiKey);
    const [call] = calls;
    expect(call!.url).toBe('https://api.x.ai/v1/responses');
    expect(call!.auth).toBe(`Bearer ${apiKey}`);
    const mcp = call!.body.tools[0];
    expect(mcp).toMatchObject({ type: 'mcp', server_url: 'https://hub.example/mcp', server_label: 'parly' });
    expect(mcp.allowed_tools).toContain('reply');
    expect(mcp.allowed_tools).toEqual(['whoami', 'check_inbox', 'read_thread', 'reply', 'get_file']);
    // Grok calls the hub as the bot, with the bot's new token.
    expect((await grokHub.registry.authenticate(mcp.authorization))?.id).toBe(bot.id);
    expect(call!.body.input[0].content).toContain(bot.name);

    const check = await grokHub.wakeService.testWake(owner, bot.id); // xAI now refuses the key: said in words for the owner
    expect(check).toMatchObject({ ok: false, problem: expect.stringMatching(/refused the API key/) });
    // Connecting with a key xAI refuses leaves no wake behind.
    const refused = await grokHub.wakeService.setWake(owner, bot.id, { type: 'xai', apiKey });
    expect(refused.check).toMatchObject({ ok: false });
    expect(refused.agent.wake).toBeUndefined();
    expect((await grokHub.registry.get(bot.id))!.wake).toBeUndefined();
  });

  it('wakes a mailbox bot via an outgoing webhook with HMAC-SHA256 signature and blocks private URLs when disallowed', async () => {
    const key = parseSealingKey(Buffer.alloc(32, 7).toString('base64'))!;
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const webhookWaker = new ClaudeRoutineWaker(5_000, key, undefined, false, undefined, (async (url, init) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    const webHub = createHub({
      db,
      config: testConfig({ allowPrivateAgentUrls: false, credentialsKey: key, wakeStaleMs: 400, wakeRetryMs: 400 }),
      waker: webhookWaker,
    });
    const { owner, members } = await crew(webHub.registry, 'wake-webhook');
    const [sender, bot] = members as [AgentRecord, AgentRecord];

    await expect(
      webHub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'http://127.0.0.1:9999/wake' }),
    ).rejects.toThrow(/publicly reachable/);

    const secret = 'whsec_test_secret_123';
    const saved = await webHub.wakeService.setWake(owner, bot.id, {
      type: 'webhook',
      url: 'https://hooks.example.com/parly-wake',
      secret,
    });
    expect(saved.check).toEqual({ ok: true });
    const view = agentView(saved.agent, owner);
    expect(view.wake).toMatchObject({
      type: 'webhook',
      url: 'https://hooks.example.com/parly-wake',
      hasSecret: true,
    });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(calls).toHaveLength(1);
    const ts = calls[0]!.headers['x-parly-timestamp'];
    expect(ts).toBeTruthy();
    const expectedSig = `sha256=${createHmac('sha256', secret).update(`${ts}.${calls[0]!.body}`).digest('hex')}`;
    expect(calls[0]!.headers['x-parly-signature']).toBe(expectedSig);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      event: 'parly.wake',
      agentId: bot.id,
      agentName: bot.name,
      at: ts,
    });

    vi.setSystemTime(Date.now() + 1);
    await webHub.send(sender, { to: bot.id }, [{ text: 'ping via webhook' }]);
    await webHub.wakeService.idle();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body).text).toContain(sender.name);

    // Updating the webhook URL without resending `secret` preserves the existing signing secret.
    const updated = await webHub.wakeService.setWake(owner, bot.id, {
      type: 'webhook',
      url: 'https://hooks.example.com/parly-wake-v2',
    });
    expect(agentView(updated.agent, owner).wake).toMatchObject({
      type: 'webhook',
      url: 'https://hooks.example.com/parly-wake-v2',
      hasSecret: true,
    });
    expect(calls).toHaveLength(3);
    const ts3 = calls[2]!.headers['x-parly-timestamp'];
    expect(calls[2]!.headers['x-parly-signature']).toBe(
      `sha256=${createHmac('sha256', secret).update(`${ts3}.${calls[2]!.body}`).digest('hex')}`,
    );
    expect(calls[2]!.headers.authorization).toBeUndefined();

    // A Grok Bot routine's webhook: its Authorization header goes with every fire, sealed and never shown back.
    const auth = 'Bearer grok_routine_tok_456';
    const grok = await webHub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/grok', authorization: auth });
    expect(agentView(grok.agent, owner).wake).toMatchObject({ hasAuthorization: true, hasSecret: true });
    expect(JSON.stringify(agentView(grok.agent, owner))).not.toContain('grok_routine_tok');
    expect((await db.collection('agents').doc(bot.id).get()).get('wake.auth')).toBeUndefined(); // sealed, not plain
    expect(calls.at(-1)!.headers.authorization).toBe(auth);
    // Kept when only the URL changes, dropped with authorization: ''.
    await webHub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/grok2' });
    expect(calls.at(-1)!.headers.authorization).toBe(auth);
    const dropped = await webHub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/grok2', authorization: '' });
    expect(agentView(dropped.agent, owner).wake).toMatchObject({ hasAuthorization: false });
    expect(calls.at(-1)!.headers.authorization).toBeUndefined();
    // Pasted with its header name, or as a bare token: sent as "Bearer …" all the same.
    await webHub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/grok3', authorization: 'Authorization: Bearer grok_tok_789' });
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer grok_tok_789');
    await webHub.wakeService.setWake(owner, bot.id, { type: 'webhook', url: 'https://hooks.example.com/grok4', authorization: 'grok_tok_789' });
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer grok_tok_789');
  });
});
