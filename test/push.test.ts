import { SKILLS_NOTE } from '../src/lib/present.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { threadKey } from '../src/chat/chat.js';
import { ChatService } from '../src/chat/chatService.js';
import { PASS, Pusher } from '../src/chat/push.js';
import { InlineQueue } from '../src/chat/queue.js';
import { ChatStore } from '../src/chat/store.js';
import type { Forwarder, ForwardResult } from '../src/hub/forward.js';
import { textOf, type WireMessage } from '../src/lib/wire.js';
import { Registry } from '../src/registry/registry.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, testDb, testPerson } from './helpers.js';

const say = (text: string) => ({ parts: [{ text }] });

/** An endpoint agent the tests script: what each send returns (or throws), and what getTask returns. */
class ScriptedAgent implements Forwarder {
  sent: WireMessage[] = [];
  next: (m: WireMessage, signal?: AbortSignal) => ForwardResult | Promise<ForwardResult> = (m) => ({ kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', contextId: 'down-ctx', parts: [{ text: 'ok' }] } });
  task: (id: string) => ForwardResult & { kind: 'task' } = (id) => ({ kind: 'task', task: { id, contextId: 'down-ctx', status: { state: 'TASK_STATE_WORKING' } } });
  async send(_agent: AgentRecord, message: WireMessage, signal?: AbortSignal): Promise<ForwardResult> {
    this.sent.push(message);
    return this.next(message, signal);
  }
  async getTask(_agent: AgentRecord, id: string) {
    return this.task(id);
  }
  async cancel() {}
}

describe('pushing to endpoint agents', () => {
  let registry: Registry;
  let chat: ChatService;
  let queue: InlineQueue;
  let pusher: Pusher;
  const agent = new ScriptedAgent();

  beforeAll(() => {
    const db = testDb();
    registry = new Registry(db, { fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
    queue = new InlineQueue();
    chat = new ChatService(new ChatStore(db), registry, queue, { maxWaitMs: 2000 });
    pusher = new Pusher(chat, registry, agent, queue, { pollEveryMs: 20, busyRetryMs: 20 });
    queue.setHandler((job) => pusher.run(job));
  });

  async function room(name: string) {
    const c = await crew(registry, name, []);
    const { agent: ep } = await registry.createBot(c.owner, { name: `${name}-ep`, url: 'http://remote.test' });
    await registry.addToWorkspace(c.owner, c.workspace.id, ep.id);
    await registry.addToChannel(c.owner, c.channel.id, ep.id);
    return { ...c, ep: (await registry.get(ep.id))!, owner: (await registry.get(c.owner.id))! };
  }

  it('shutdown aborts the turn under way and frees its push lease before the turn ends', async () => {
    const { owner, channel, ep } = await room('shutdown');
    const before = agent.next;
    queue.setHandler(async () => {});
    try {
      const { message } = await chat.post(owner, { channelId: channel.id }, say('long one'));
      let signal: AbortSignal | undefined;
      let finish!: () => void;
      const hanging = new Promise<void>((r) => (finish = r));
      // A turn that keeps going past the abort, as one SIGKILLed mid-call would: only shutdown can free its lease.
      agent.next = async (m, s) => {
        signal = s;
        await hanging;
        return { kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', parts: [{ text: 'stopped' }] } };
      };
      const run = pusher.run({ agentId: ep.id, conversationId: message.conversationId });
      await expect.poll(() => signal).toBeDefined();
      expect(await chat.store.lease(ep.id, message.conversationId, 60_000)).toBeUndefined();

      await pusher.shutdown();
      expect(signal!.aborted).toBe(true);
      const next = await chat.store.lease(ep.id, message.conversationId, 60_000);
      expect(next).toBeTruthy();

      finish();
      await run;
      // The turn's own (fenced) release leaves the lease the next taker holds.
      expect(await chat.store.lease(ep.id, message.conversationId, 60_000)).toBeUndefined();
    } finally {
      agent.next = before;
      queue.setHandler((job) => pusher.run(job));
    }
  });

  it('a retried push does not ask again for what the agent already answered, and what came meanwhile still goes', async () => {
    const { owner, channel, ep } = await room('retry');
    const before = agent.next;
    queue.setHandler(async () => {}); // this test is the queue: it runs the jobs, and sees them fail
    try {
      const { message } = await chat.post(owner, { channelId: channel.id }, say('who does the dishes?'));
      const thread = { channelId: channel.id, thread: message.id };
      // The agent answers on its own (over MCP), then the push times out.
      agent.next = async () => {
        await chat.post(ep, thread, say('we do'));
        throw new Error('timed out');
      };
      agent.sent = [];
      const job = { agentId: ep.id, conversationId: message.conversationId };
      await expect(pusher.run(job)).rejects.toThrow('timed out');
      await pusher.run(job);
      expect(agent.sent).toHaveLength(1);
      const replies = await chat.store.since(threadKey(channel.id, message.id), 0, 10);
      expect(replies.filter((m) => m.fromId === ep.id)).toHaveLength(1);

      // In a thread (or a DM) its answer lands in the same conversation, and its cursor stays behind what it was asked.
      const again = await chat.post(owner, thread, say(`@${ep.name} and today?`));
      agent.next = async () => {
        await chat.post(ep, thread, say('we do, again'));
        throw new Error('timed out');
      };
      agent.sent = [];
      const once = { agentId: ep.id, conversationId: again.message.conversationId };
      await expect(pusher.run(once)).rejects.toThrow('timed out');
      await pusher.run(once);
      expect(agent.sent).toHaveLength(1);

      // Same in a thread, where the answer lands after a message that came while the agent worked: that one still goes.
      const asked = await chat.post(owner, thread, say(`@${ep.name} and tomorrow?`));
      agent.next = async () => {
        await chat.post(owner, thread, say(`@${ep.name} and Sunday?`));
        await chat.post(ep, thread, say('you do'));
        throw new Error('timed out');
      };
      agent.sent = [];
      const inThread = { agentId: ep.id, conversationId: asked.message.conversationId };
      await expect(pusher.run(inThread)).rejects.toThrow('timed out');
      agent.next = before;
      await pusher.run(inThread);
      expect(agent.sent.map((m) => textOf(m))).toEqual([expect.stringContaining('tomorrow'), expect.stringContaining('Sunday')]);
    } finally {
      agent.next = before;
      queue.setHandler((job) => pusher.run(job));
    }
  });

  it('a post that throws leaves the cursor behind the question, so the retry re-pushes the answer', async () => {
    const { owner, channel, ep } = await room('post-throws');
    const realPost = chat.post.bind(chat);
    const setPost = (fn: ChatService['post']) => ((chat as unknown as { post: ChatService['post'] }).post = fn);
    queue.setHandler(async () => {});
    try {
      const asked = await chat.post(owner, { channelId: channel.id }, say(`@${ep.name} who cooks?`));
      const job = { agentId: ep.id, conversationId: asked.message.conversationId };
      // The agent answers normally, but the hub's post of that answer throws the first time (a store blip).
      let blown = false;
      setPost((async (...args: Parameters<ChatService['post']>) => {
        if (!blown) { blown = true; throw new Error('store blip'); }
        return realPost(...args);
      }) as ChatService['post']);
      agent.sent = [];
      await expect(pusher.run(job)).rejects.toThrow('store blip');
      // The post threw before see(): the cursor must stay behind the question, or a retry would swallow the answer.
      expect((await chat.store.cursor(ep.id, asked.message.conversationId))?.seenUpTo ?? 0).toBeLessThan(asked.message.seq);
      // Run 1 reached the agent and got an answer: the throw was at the post of that answer, not before it.
      expect(agent.sent).toHaveLength(1);
      // Post works again: the retry re-pushes, and the answer lands exactly once.
      setPost(realPost);
      agent.sent = [];
      await pusher.run(job);
      expect(agent.sent).toHaveLength(1);
      const replies = await chat.store.since(threadKey(channel.id, asked.message.id), 0, 20);
      expect(replies.filter((m) => m.fromId === ep.id)).toHaveLength(1);
    } finally {
      setPost(realPost);
      queue.setHandler((job) => pusher.run(job));
    }
  });

  it('a push that failed and was answered afterwards is not asked again, in a thread or a DM', async () => {
    const { owner, channel, ep } = await room('late');
    const before = agent.next;
    queue.setHandler(async () => {});
    try {
      const { message: post } = await chat.post(owner, { channelId: channel.id }, say('hello'));
      const thread = { channelId: channel.id, thread: post.id };
      // A push that worked first gives it a cursor: with none, its own post moves it past the question anyway.
      for (const where of [thread, { dm: ep.id }]) {
        const hi = await chat.post(owner, where, say(`@${ep.name} hi`));
        await pusher.run({ agentId: ep.id, conversationId: hi.message.conversationId });
      }
      for (const [where, back] of [[thread, thread], [{ dm: ep.id }, { dm: owner.id }]] as const) {
        const asked = await chat.post(owner, where, say(`@${ep.name} who washes up?`));
        agent.next = async () => {
          throw new Error('timed out');
        };
        agent.sent = [];
        const job = { agentId: ep.id, conversationId: asked.message.conversationId };
        await expect(pusher.run(job)).rejects.toThrow('timed out');
        // Still working when the push gave up: its answer lands after the failure was handled.
        await chat.post(ep, back, say('I do'));
        await pusher.run(job);
        expect(agent.sent).toHaveLength(1);
      }
    } finally {
      agent.next = before;
      queue.setHandler((job) => pusher.run(job));
    }
  });

  it('what came during a push that worked still goes, though the agent posted after it', async () => {
    const { owner, channel, ep } = await room('during');
    const before = agent.next;
    queue.setHandler(async () => {});
    try {
      const { message: post } = await chat.post(owner, { channelId: channel.id }, say('hello'));
      const thread = { channelId: channel.id, thread: post.id };
      const asked = await chat.post(owner, thread, say(`@${ep.name} and today?`));
      agent.next = async (m) => {
        agent.next = before;
        await chat.post(owner, thread, say(`@${ep.name} and Sunday?`));
        await chat.post(ep, thread, say('we do'));
        return before(m);
      };
      agent.sent = [];
      await pusher.run({ agentId: ep.id, conversationId: asked.message.conversationId });
      expect(agent.sent.map((m) => textOf(m))).toEqual([expect.stringContaining('today'), expect.stringContaining('Sunday')]);
    } finally {
      agent.next = before;
      queue.setHandler((job) => pusher.run(job));
    }
  });

  it("a person's pitch into a process channel always wakes the first-step agent, even when the router picks nobody", async () => {
    const c = await crew(registry, 'kickoff', ['kickoff-auditor', 'kickoff-other']);
    const auditor = c.members[0]!;
    const other = c.members[1]!;
    await registry.setChannelRole(c.owner, c.channel.id, auditor.id, 'First-Impression Auditor');
    await registry.createSkill(c.owner, {
      name: 'Roast',
      description: 'roast pitches',
      type: 'process',
      scope: 'channel',
      id: c.channel.id,
      steps: [{ order: 1, role: 'First-Impression Auditor', action: 'audit the pitch', output: 'take', transition: 'mention the next role' }],
    });
    // Kickoff only applies to public-showcase workspaces (not private/dev channels).
    await registry.setWorkspacePublicShowcase(c.owner, c.workspace.id, true, { publicChannels: [c.channel.id] });
    const prev = chat.route;
    chat.route = async () => []; // the router judges the post as chatter and picks nobody
    try {
      const { recipients, message } = await chat.post(c.owner, { channelId: c.channel.id }, say('parly.dev is for connecting your agents as teams'));
      const ids = recipients.map((r) => r.id);
      expect(ids).toContain(auditor.id); // kickoff forces the process's step-1 role agent to engage
      expect(message.mentions).toContain(auditor.id); // addressed to it, so its push carries no "[You may pass]"
      expect(ids).not.toContain(other.id); // the router's "none" still holds for everyone else
    } finally {
      chat.route = prev;
    }
  });

  it("a public showcase's guest can't DM its agents (only its tables), while the owner still can", async () => {
    const c = await crew(registry, 'guest-dm', ['guest-dm-judge']);
    const judge = c.members[0]!;
    await registry.setWorkspacePublicShowcase(c.owner, c.workspace.id, true, { publicChannels: [c.channel.id] });
    const visitor = await testPerson(registry, 'Visitor');
    await registry.joinPublicWorkspace(visitor, c.workspace.id);
    const guest = (await registry.get(visitor.id))!;
    await expect(chat.post(guest, { dm: judge.id }, say('psst, private question'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(chat.post(guest, { channelId: c.channel.id }, say('my pitch'))).resolves.toBeDefined();
    await expect(chat.post(c.owner, { dm: judge.id }, say('owner check-in'))).resolves.toBeDefined();
  });

  it('tells the agent who holds each role here, by @name, so it can hand off without looking people up', async () => {
    const { owner, channel, ep } = await room('roster');
    await registry.setChannelRole(owner, channel.id, ep.id, 'Hype Enabler');
    await registry.setChannelRole(owner, channel.id, owner.id, 'Visitor');
    agent.sent = [];
    await chat.post(owner, { channelId: channel.id }, say('I want a Tesla'));
    await queue.idle();
    const roster = agent.sent[0]!.parts.map((p) => p.text ?? '').find((t) => t.startsWith('[Roles here]'));
    expect(roster).toContain(`@${ep.name}: Hype Enabler (you)`);
    expect(roster).toContain(`@${owner.name}: Visitor`);
  });

  it("pushes a post, and the agent's answer lands in the post's thread", async () => {
    const { owner, channel, ep } = await room('push-answer');
    agent.sent = [];
    const { message } = await chat.post(owner, { channelId: channel.id }, say("who's online?"));
    await queue.idle();
    expect(agent.sent.map((m) => m.parts.at(-1)?.text)).toEqual(["who's online?"]);
    expect(agent.sent[0]!.metadata?.a2aHub).toMatchObject({ fromId: owner.id, messageId: message.id });

    const thread = await chat.page(owner, threadKey(channel.id, message.id), 10);
    expect(thread.messages.map((m) => [m.fromId, m.parts[0]?.text])).toEqual([[ep.id, 'ok']]);
    // Pushed is seen, and its own conversation is remembered for the post's thread.
    expect(await chat.store.cursor(ep.id, message.conversationId)).toMatchObject({ seenUpTo: message.seq });
    expect(await chat.store.cursor(ep.id, threadKey(channel.id, message.id))).toMatchObject({ downstream: { contextId: 'down-ctx' } });
  });

  it('a message that comes while the agent answers waits for that answer, then goes on its own', async () => {
    const { owner, ep } = await room('push-busy');
    agent.sent = [];
    agent.next = (m) => ({ kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', parts: [{ text: `answer ${agent.sent.length}` }] } });
    const send = agent.send.bind(agent);
    let busy = 0;
    let overlapped = false;
    agent.send = async (a, m) => {
      overlapped ||= ++busy > 1;
      await new Promise((r) => setTimeout(r, 150));
      busy--;
      return send(a, m);
    };
    await chat.post(owner, { dm: ep.id }, say('first'));
    // Wait until 'first' is actually mid-send before posting 'second', so the
    // ordering under test doesn't hinge on a fixed timer racing the queue.
    while (busy < 1) await new Promise((r) => setTimeout(r, 1));
    await chat.post(owner, { dm: ep.id }, say('second'));
    await queue.idle();
    agent.send = send;
    expect(overlapped).toBe(false);
    expect(agent.sent.map((m) => m.parts.at(-1)?.text)).toEqual(['first', 'second']);
  });

  it("an agent's answer doesn't mark what came while it worked as seen", async () => {
    const store = chat.store;
    const conv = { id: `dm:cursor-test-${Date.now()}`, kind: 'dm' as const, participants: ['person', 'bot'] };
    const post = (id: string, fromId: string, human: boolean) => store.append(conv, { id: `${conv.id}-${id}`, from: fromId, fromId, human, parts: [{ text: id }] });
    await post('one', 'person', true);
    await store.see('bot', conv.id, 1);
    await post('two', 'person', true);
    await post('answer', 'bot', false);
    expect((await store.cursor('bot', conv.id))?.seenUpTo).toBe(1); // "two" is still new to it
    await store.see('bot', conv.id, 2);
    await post('answer2', 'bot', false);
    expect((await store.cursor('bot', conv.id))?.seenUpTo).toBe(4); // caught up: its post moves it on
  });

  it("a pushed agent's cursor moves past its own answer, unless something came while it worked", async () => {
    const { owner, ep } = await room('own-answer');
    const reply = agent.next;
    queue.setHandler(async () => {});
    try {
      const ask = async (text: string) => {
        const asked = await chat.post(owner, { dm: ep.id }, say(text));
        await pusher.run({ agentId: ep.id, conversationId: asked.message.conversationId });
        return asked.message;
      };
      await ask('hi'); // gives it a cursor
      const asked = await ask('who cooks?');
      const answer = (await chat.store.since(asked.conversationId, asked.seq, 5)).find((m) => m.fromId === ep.id)!;
      // Its answer is part of what it has heard, so its next turn's history (up to the cursor) has it.
      expect((await chat.store.cursor(ep.id, asked.conversationId))?.seenUpTo).toBe(answer.seq);
      // Something that came while it worked is still sent to it after its answer.
      agent.next = async (m) => {
        agent.next = reply;
        await chat.post(owner, { dm: ep.id }, say('and Sunday?'));
        return reply(m);
      };
      const busy = await ask('and today?');
      const after = await chat.store.since(busy.conversationId, busy.seq, 5);
      expect(after.map((m) => (m.fromId === ep.id ? 'agent' : m.parts[0]?.text))).toEqual(['and Sunday?', 'agent', 'agent']);
    } finally {
      agent.next = reply;
      queue.setHandler((job) => pusher.run(job));
    }
  });

  it('follows an answer the agent is still working on, and posts it once when it is there', async () => {
    const { owner, channel, ep } = await room('push-working');
    let done = false;
    agent.next = (m) => ({ kind: 'task', task: { id: `t-${m.messageId}`, contextId: 'down-ctx', status: { state: 'TASK_STATE_WORKING' } } });
    agent.task = (id) =>
      done
        ? { kind: 'task', task: { id, contextId: 'down-ctx', status: { state: 'TASK_STATE_COMPLETED', message: { messageId: `${id}-answer`, role: 'ROLE_AGENT', parts: [{ text: 'took a while' }] } } } }
        : { kind: 'task', task: { id, contextId: 'down-ctx', status: { state: 'TASK_STATE_WORKING' } } };
    const { message } = await chat.post(owner, { channelId: channel.id }, say('slow one'));
    setTimeout(() => (done = true), 100);
    await queue.idle();
    const thread = await chat.page(owner, threadKey(channel.id, message.id), 10);
    expect(thread.messages.map((m) => [m.fromId, m.parts[0]?.text])).toEqual([[ep.id, 'took a while']]);
  });

  it('asks again less and less often while the agent is still working', async () => {
    const { owner, channel } = await room('push-backoff');
    let polls = 0;
    agent.next = (m) => ({ kind: 'task', task: { id: `t-${m.messageId}`, contextId: 'down-ctx', status: { state: 'TASK_STATE_WORKING' } } });
    agent.task = (id) =>
      ++polls < 4
        ? { kind: 'task', task: { id, contextId: 'down-ctx', status: { state: 'TASK_STATE_WORKING' } } }
        : { kind: 'task', task: { id, contextId: 'down-ctx', status: { state: 'TASK_STATE_COMPLETED', message: { messageId: `${id}-a`, role: 'ROLE_AGENT', parts: [{ text: 'done' }] } } } };
    const delays: number[] = [];
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = (job, delayMs) => (job.poll && delays.push(delayMs ?? 0), enqueue(job, delayMs));
    await chat.post(owner, { channelId: channel.id }, say('slow again'));
    await queue.idle();
    queue.enqueue = enqueue;
    expect(delays).toEqual([20, 40, 80, 160]);
  });

  it("an unreachable agent's cursor stays put, and the next push brings what it missed", async () => {
    const { owner, channel, ep } = await room('push-down');
    agent.sent = [];
    agent.next = () => {
      throw new Error('connect ECONNREFUSED');
    };
    const first = (await chat.post(owner, { channelId: channel.id }, say('while you were out'))).message;
    await queue.idle();
    expect((await chat.store.cursor(ep.id, first.conversationId))?.seenUpTo ?? 0).toBe(0);

    agent.next = (m) => ({ kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', parts: [{ text: 'back' }] } });
    await chat.post(owner, { channelId: channel.id }, say('are you there?'));
    await queue.idle();
    const last = agent.sent.at(-1)!;
    expect(textOf(last)).toContain('while you were out');
    expect(textOf(last)).toContain('are you there?');
  });

  it(`tells it in a channel that it may pass, and posts nothing when it answers ${PASS} (or NO_REPLY)`, async () => {
    const { owner, channel, ep } = await room('push-pass');
    agent.sent = [];
    agent.next = (m) => ({ kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', parts: [{ text: ` ${PASS}\n` }] } });
    const chatter = (await chat.post(owner, { channelId: channel.id }, say('thanks all!'))).message;
    await queue.idle();
    expect(textOf(agent.sent[0])).toContain(`answer with just ${PASS}`);
    expect((await chat.page(owner, threadKey(channel.id, chatter.id), 10)).messages).toHaveLength(0);
    // NO_REPLY, the token agents learned first, still passes.
    agent.next = (m) => ({ kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', parts: [{ text: 'NO_REPLY' }] } });
    const more = (await chat.post(owner, { channelId: channel.id }, say('see you tomorrow'))).message;
    await queue.idle();
    expect((await chat.page(owner, threadKey(channel.id, more.id), 10)).messages).toHaveLength(0);

    // Mentioned, it's asked: no leave to pass, and a real answer is posted as before.
    agent.next = (m) => ({ kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', parts: [{ text: 'on it' }] } });
    const asked = (await chat.post(owner, { channelId: channel.id }, say(`@${ep.name} can you check the deploy?`))).message;
    await queue.idle();
    expect(textOf(agent.sent.at(-1))).not.toContain('[You may pass]');
    expect((await chat.page(owner, threadKey(channel.id, asked.id), 10)).messages.map((m) => m.parts[0]?.text)).toEqual(['on it']);
  });

  it('tells it when the channel is public, and not otherwise', async () => {
    const { owner, channel } = await room('push-public');
    agent.sent = [];
    await chat.post(owner, { channelId: channel.id }, say('private hello'));
    await queue.idle();
    expect(textOf(agent.sent.at(-1))).not.toContain('[Public channel]');
    await registry.updateChannel(owner, channel.id, { publicFromSeq: await chat.channelSeq(channel.id) });
    await chat.post(owner, { channelId: channel.id }, say('public hello'));
    await queue.idle();
    expect(textOf(agent.sent.at(-1))).toContain('[Public channel] Anyone on the internet can read');
    expect(agent.sent.at(-1)?.metadata).toMatchObject({ a2aHub: { public: true } });
  });

  it("hands the channel's context with each message, labelled as background; only owners set it, and the previous one stays", async () => {
    const { owner, channel, ep } = await room('push-context');
    agent.sent = [];
    await chat.post(owner, { channelId: channel.id }, say('before any context'));
    await queue.idle();
    expect(textOf(agent.sent.at(-1))).not.toContain('[Channel context]');
    const set = await registry.updateChannel(owner, channel.id, { context: 'Inner Piece: repo malachico/inner-piece, PRs to Joey' });
    expect(set).toMatchObject({ context: 'Inner Piece: repo malachico/inner-piece, PRs to Joey' });
    await chat.post(owner, { channelId: channel.id }, say('with context'));
    await queue.idle();
    expect(textOf(agent.sent.at(-1))).toContain("[Channel context] The channel's context, set by its owners: background");
    expect(textOf(agent.sent.at(-1))).toContain('repo malachico/inner-piece');
    // No history is kept; a member that isn't an owner can't set it; it stays short.
    const v2 = await registry.updateChannel(owner, channel.id, { context: 'v2' });
    expect(v2).toMatchObject({ context: 'v2' });
    expect(v2).not.toHaveProperty('contextPrev');
    await expect(registry.updateChannel((await registry.get(ep.id))!, channel.id, { context: 'hijack' })).rejects.toThrow();
    await expect(registry.updateChannel(owner, channel.id, { context: 'x'.repeat(1001) })).rejects.toThrow(/at most 1000/);
  });

  it('includes compact [Skills] summaries in workspace -> channel -> agent order on pushed messages', async () => {
    const { owner, workspace, channel, ep } = await room('push-skills');
    const wsSkill = await registry.createSkill(owner, {
      name: 'Org Security',
      description: 'Never log secrets',
      instructions: 'Redact tokens in logs.',
    });
    const chSkill = await registry.createSkill(owner, {
      name: 'Deploy Checklist',
      description: 'Run smoke tests after deploy',
      instructions: 'Check /healthz.',
    });
    const epSkill = await registry.createSkill(owner, {
      name: 'Bot Style',
      description: 'Answer concisely',
      instructions: 'Keep replies under 3 sentences.',
    });
    await registry.attachSkill(owner, 'workspace', workspace.id, wsSkill.id);
    await registry.attachSkill(owner, 'channel', channel.id, chSkill.id);
    await registry.attachSkill(owner, 'agent', ep.id, epSkill.id);

    agent.sent = [];
    await chat.post(owner, { channelId: channel.id }, say('deploy staging'));
    await queue.idle();
    const pushedText = textOf(agent.sent.at(-1));
    expect(pushedText).toContain(`[Skills] Available skills in this scope (${SKILLS_NOTE}):`);
    const wsIdx = pushedText.indexOf(`Org Security (id: ${wsSkill.id}): Never log secrets`);
    const chIdx = pushedText.indexOf(`Deploy Checklist (id: ${chSkill.id}): Run smoke tests after deploy`);
    const epIdx = pushedText.indexOf(`Bot Style (id: ${epSkill.id}): Answer concisely`);
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    expect(chIdx).toBeGreaterThan(wsIdx);
    expect(epIdx).toBeGreaterThan(chIdx);
  });

  it('surfaces [Process] steps inline with outputs, transitions, bounded length, and safe skill references on pushed messages', async () => {
    const { owner, channel } = await room('push-processes');
    const chSkill = await registry.createSkill(owner, {
      name: 'Smoke Test Skill',
      description: 'How to verify staging',
      instructions: 'NEVER_INLINE_THIS_SKILL_INSTRUCTION_IN_PUSH',
      scope: 'channel',
      id: channel.id,
    });
    const privateSkill = await registry.createSkill(owner, {
      name: 'Secret Owner Skill',
      description: 'Private',
      instructions: 'SECRET_OWNER_ONLY_TEXT',
    });
    const proc = await registry.createSkill(owner, {
      name: 'Release Process',
      description: 'Team release workflow',
      type: 'process',
      scope: 'channel',
      id: channel.id,
      steps: [
        {
          order: 1,
          role: 'implementer',
          action: 'Open PR and run server tests',
          output: 'PR link with passing tests',
          transition: 'CI green and reviewer sign-off',
          skillId: chSkill.id,
        },
        {
          order: 2,
          role: 'owner',
          action: 'Verify private checklist',
          output: 'Signed release',
          transition: 'Abort on failure',
          skillId: privateSkill.id,
        },
      ],
    });

    agent.sent = [];
    await chat.post(owner, { channelId: channel.id }, say('ship release'));
    await queue.idle();
    const pushedText = textOf(agent.sent.at(-1));
    expect(pushedText).toContain('[Processes] Process template');
    expect(pushedText).toContain(`[Process] Release Process (id: ${proc.id}): Team release workflow`);
    expect(pushedText).toContain(`1. [implementer] Open PR and run server tests -> Output: PR link with passing tests | Transition: CI green and reviewer sign-off (skill: Smoke Test Skill, load with get_skill("${chSkill.id}"))`);
    expect(pushedText).toContain('2. [owner] Verify private checklist -> Output: Signed release | Transition: Abort on failure (skill: unavailable)');
    expect(pushedText).not.toContain('NEVER_INLINE_THIS_SKILL_INSTRUCTION_IN_PUSH');
    expect(pushedText).not.toContain('SECRET_OWNER_ONLY_TEXT');
    expect(pushedText).not.toContain('Secret Owner Skill');

    // Large process exceeding PROCESS_SURFACE_MAX truncates inline steps and directs agent to get_skill(id).
    const bigProc = await registry.createSkill(owner, {
      name: 'Large Process',
      description: 'Many detailed steps',
      type: 'process',
      scope: 'channel',
      id: channel.id,
      steps: Array.from({ length: 6 }, (_, idx) => ({
        order: idx + 1,
        role: `role-${idx + 1}`,
        action: `Perform detailed step ${idx + 1}: ${'x'.repeat(350)}`,
      })),
    });
    agent.sent = [];
    await chat.post(owner, { channelId: channel.id }, say('run big process'));
    await queue.idle();
    const bigPushedText = textOf(agent.sent.at(-1));
    expect(bigPushedText).toContain(`(Steps truncated; load full process with get_skill("${bigProc.id}"))`);
  });

  it('running a job twice pushes once and stores the answer once', async () => {
    const { owner, channel, ep } = await room('push-twice');
    agent.sent = [];
    agent.next = (m) => ({ kind: 'message', message: { messageId: 'same-answer', role: 'ROLE_AGENT', parts: [{ text: `seen ${m.messageId}` }] } });
    const { message } = await chat.post(owner, { channelId: channel.id }, say('once'));
    await queue.idle();
    await pusher.run({ agentId: ep.id, conversationId: message.conversationId });
    expect(agent.sent).toHaveLength(1);
    expect((await chat.page(owner, threadKey(channel.id, message.id), 10)).messages).toHaveLength(1);
  });
});

describe('push lease owner-fence', () => {
  it('release only frees the lease the caller still owns', async () => {
    const store = new ChatStore(testDb());
    const a = 'agent-x', c = 'conv-x';
    const first = await store.lease(a, c, 60_000);
    expect(first).toBeTruthy();
    // A lease is held, so a second taker is turned away.
    expect(await store.lease(a, c, 60_000)).toBeUndefined();
    // A stale/wrong token must NOT delete the current holder's lease.
    await store.release(a, c, 'not-the-owner');
    expect(await store.lease(a, c, 60_000)).toBeUndefined();
    // The real owner's release frees it, so the next push can take it.
    await store.release(a, c, first!);
    expect(await store.lease(a, c, 60_000)).toBeTruthy();
  });
});
