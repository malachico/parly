import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { channelKey, dmKey, threadKey } from '../src/chat/chat.js';
import { ChatService, isFor } from '../src/chat/chatService.js';
import { InlineQueue, type PushJob } from '../src/chat/queue.js';
import { ChatStore } from '../src/chat/store.js';
import { Registry } from '../src/registry/registry.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, testDb, testPerson } from './helpers.js';

const AGENT_RUN_MAX = 10;
const AGENT_RUN_MAX_MENTIONED = 40;
const prevRunMax = process.env.AGENT_RUN_MAX;
const prevRunMaxMentioned = process.env.AGENT_RUN_MAX_MENTIONED;
process.env.AGENT_RUN_MAX = String(AGENT_RUN_MAX);
process.env.AGENT_RUN_MAX_MENTIONED = String(AGENT_RUN_MAX_MENTIONED);
afterAll(() => {
  if (prevRunMax === undefined) delete process.env.AGENT_RUN_MAX;
  else process.env.AGENT_RUN_MAX = prevRunMax;
  if (prevRunMaxMentioned === undefined) delete process.env.AGENT_RUN_MAX_MENTIONED;
  else process.env.AGENT_RUN_MAX_MENTIONED = prevRunMaxMentioned;
});

const say = (text: string) => ({ parts: [{ text }] });
const texts = (ms: { parts: { text?: string }[] }[]) => ms.map((m) => m.parts[0]?.text);

describe('chat: one message per message, one cursor per participant', () => {
  const db = testDb();
  let registry: Registry;
  let chat: ChatService;
  let queue: InlineQueue;
  const pushed: PushJob[] = [];
  const woken: string[] = [];

  beforeAll(() => {
    registry = new Registry(db, { fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
    queue = new InlineQueue();
    queue.setHandler(async (job) => void pushed.push(job));
    chat = new ChatService(new ChatStore(db), registry, queue, { maxWaitMs: 2000, onMailbox: (a) => woken.push(a.id) });
  });

  const fresh = async (a: AgentRecord) => (await registry.get(a.id))!;

  it('a channel post is one message: every member finds it past their cursor, and the next take moves the cursor', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-post');
    const [x, y] = members;
    const { message, conversation } = await chat.post(owner, { channelId: channel.id }, say('hello all'));
    expect(conversation.id).toBe(channelKey(channel.id));
    expect(message.seq).toBe(1);

    for (const bot of [x!, y!]) {
      const items = await chat.take(bot);
      expect(items.map((i) => i.message.id)).toEqual([message.id]);
      expect(await chat.newFor(bot)).toEqual([]);
      // Handing it out only leases it; the next take acks it.
      expect(await chat.take(bot)).toEqual([]);
    }
    // The sender's own post is seen by them already.
    expect(await chat.newFor(owner)).toEqual([]);
    expect((await chat.store.seenIn(conversation.id, [owner.id, x!.id, y!.id]))).toEqual({ [owner.id]: 1, [x!.id]: 1, [y!.id]: 1 });
  });

  it('numbers messages 1, 2, 3 with no gaps, and an inbox item brings what came before', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-seq');
    await Promise.all(['a', 'b', 'c'].map((t) => chat.post(owner, { channelId: channel.id }, say(t))));
    const page = await chat.page(owner, channelKey(channel.id), 10);
    expect(page.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    const [item] = await chat.take(members[0]!);
    expect(item!.message.seq).toBe(3);
    expect(item!.earlier.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('a page carries the viewer their own unread, so the client needn\'t scan every conversation for one number', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-unread');
    const x = members[0]!;
    await Promise.all(['a', 'b', 'c'].map((t) => chat.post(owner, { channelId: channel.id }, say(t))));
    // The sender has seen their own; a member who hasn't looked has all three unread.
    expect((await chat.page(owner, channelKey(channel.id), 10)).unread).toBe(0);
    expect((await chat.page(x, channelKey(channel.id), 10)).unread).toBe(3);
    // Same number the sidebar (conversations) computes on its own — the client can drop that scan on open.
    expect((await chat.conversations(x)).find((c) => c.conversation.id === channelKey(channel.id))?.unread).toBe(3);
    // Once read, nothing unread.
    await chat.markRead(x, channelKey(channel.id));
    expect((await chat.page(x, channelKey(channel.id), 10)).unread).toBe(0);
    // Only the newest page carries it; an older page (`before` set) leaves it out rather than miscount.
    expect((await chat.page(x, channelKey(channel.id), 2, 2)).unread).toBeUndefined();
  });

  it('counts unread across many channels with batched message queries', async () => {
    const { owner, workspace, members } = await crew(registry, 'chat-summary-batch', ['summary-reader']);
    const reader = members[0]!;
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) {
      const ch = await registry.createChannel(owner, workspace.id, `batch-${i}`);
      await registry.addToChannel(owner, ch.id, reader.id);
      ids.push(channelKey(ch.id));
      await chat.post(owner, { channelId: ch.id }, say(`hello @${reader.name}`));
    }
    const get = vi.spyOn(Object.getPrototypeOf(db.collection('messages').where('seq', '>', 0)), 'get');
    try {
      const summaries = await chat.conversations(await fresh(reader));
      expect(summaries.filter((s) => ids.includes(s.conversation.id)).map((s) => [s.unread, s.mentions])).toEqual(ids.map(() => [1, 1]));
      // Includes the one membership query; message reads must grow by batches, not by channel.
      expect(get.mock.calls.length).toBeGreaterThan(0);
      expect(get.mock.calls.length).toBeLessThanOrEqual(3);
      get.mockClear();
      const inbox = await chat.newFor(await fresh(reader));
      expect(inbox.filter((i) => ids.includes(i.conversation.id))).toHaveLength(ids.length);
      expect(get.mock.calls.length).toBeGreaterThan(0);
      expect(get.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      get.mockRestore();
    }
  });

  it('keeps the newest 50 surviving unread messages when a conversation has holes', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-summary-holes', ['holes-reader']);
    const reader = members[0]!;
    let lastId = '';
    for (let i = 1; i <= 55; i++) {
      lastId = (await chat.post(owner, { channelId: channel.id }, say(i <= 6 ? `@${reader.name}` : `message ${i}`))).message.id;
    }
    const summary = async () => (await chat.conversations(reader)).find((s) => s.conversation.id === channelKey(channel.id));
    expect(await summary()).toMatchObject({ unread: 50, mentions: 1 });
    await db.collection('messages').doc(lastId).delete();
    expect(await summary()).toMatchObject({ unread: 50, mentions: 2 });
    const window = { id: channelKey(channel.id), seen: 0, seq: 55 };
    expect((await chat.store.sinceMany([window], 50)).get(window.id)).toEqual(await chat.store.since(window.id, 0, 50));
    await chat.markRead(reader, window.id);
    expect(await summary()).toMatchObject({ unread: 0, mentions: 0 });
    expect(await chat.store.sinceMany([], 50)).toEqual(new Map());
  });

  it('sinceEach reads exactly what since() does, read by read', async () => {
    const { owner, channel } = await crew(registry, 'chat-since-each', []);
    const ch = channelKey(channel.id);
    const posts: string[] = [];
    for (let i = 0; i < 32; i++) posts.push((await chat.post(owner, { channelId: channel.id }, say(`post ${i}`))).message.id);
    // 31 threads (more than one 30-branch batch); the 32nd post has none, so no conversation doc.
    for (const [i, post] of posts.slice(0, 31).entries()) {
      for (let j = 0; j <= i % 3; j++) await chat.post(owner, { channelId: channel.id, thread: post }, say(`reply ${j}`));
    }
    // More than 50 after the early posts, with a hole.
    let hole = '';
    for (let i = 0; i < 60; i++) hole = (await chat.post(owner, { channelId: channel.id }, say(`later ${i}`))).message.id;
    await db.collection('messages').doc(hole).delete();
    const reads = [
      ...posts.map((p, i) => ({ id: threadKey(channel.id, p), after: i % 2 })),
      // The same channel from several points: one shared window, each cut to its own.
      { id: ch, after: 1 },
      { id: ch, after: 20 },
      { id: ch, after: 40 },
      { id: ch, after: 91 },
      { id: ch, after: 500 },
      { id: 'thread:nowhere', after: 0 },
    ];
    const get = vi.spyOn(chat.store, 'since');
    const batched = await chat.store.sinceEach(reads, 50);
    // since() only to refill a holed window, never per read.
    expect(get.mock.calls.length).toBeLessThanOrEqual(1);
    get.mockRestore();
    expect(batched).toEqual(await Promise.all(reads.map((r) => chat.store.since(r.id, r.after, 50))));
    expect(batched.some((ms) => ms.length === 50)).toBe(true);
    expect(await chat.store.sinceEach([], 50)).toEqual([]);
  });

  it('a thread reply reaches the thread: its post author, those who wrote, and those mentioned', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-thread', ['chat-thread-x', 'chat-thread-y', 'chat-thread-z']);
    const [x, y, z] = members;
    const post = (await chat.post(owner, { channelId: channel.id }, say('question'))).message;
    for (const m of members) await chat.take(m);

    await chat.post(x!, { channelId: channel.id, thread: post.id }, say('answer from x'));
    // The post's author hears it; y and z weren't in the thread.
    expect(texts((await chat.newFor(await fresh(owner))).map((i) => i.message))).toEqual(['answer from x']);
    expect(await chat.newFor(y!)).toEqual([]);

    await chat.post(owner, { channelId: channel.id, thread: post.id }, say('@chat-thread-z what do you think?'));
    const [forZ] = await chat.take(z!);
    expect(forZ!.conversation.id).toBe(threadKey(channel.id, post.id));
    // New to the thread: it gets what was said there before.
    expect(texts(forZ!.earlier)).toEqual(['answer from x']);
    expect(await chat.newFor(y!)).toEqual([]);
    expect((await chat.store.conversation(threadKey(channel.id, post.id)))!.participants.sort()).toEqual([owner.id, x!.id, z!.id].sort());
  });

  it('take() will not drain a thread or DM the agent never joined', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-take-gate', ['chat-take-x', 'chat-take-y']);
    const [x, y] = members;
    // owner posts, x replies in the thread: participants = {owner, x}. y is in the channel but not the thread.
    const post = (await chat.post(owner, { channelId: channel.id }, say('question'))).message;
    for (const m of members) await chat.take(m);
    await chat.post(x!, { channelId: channel.id, thread: post.id }, say('answer from x'));
    const thread = threadKey(channel.id, post.id);

    // y is a channel member but never joined the thread: take() on it gets nothing and moves no cursor.
    expect(await chat.take(y!, 20, thread)).toEqual([]);
    expect(await chat.store.seenIn(thread, [y!.id])).toEqual({});
    // A participant still takes it.
    expect(texts((await chat.take(owner, 20, thread)).map((i) => i.message))).toEqual(['answer from x']);

    // A DM between owner and x: a third bot cannot take it (regression guard).
    await chat.post(owner, { dm: x!.id }, say('private'));
    const dm = dmKey(owner.id, x!.id);
    expect(await chat.take(y!, 20, dm)).toEqual([]);
    expect(await chat.store.seenIn(dm, [y!.id])).toEqual({});
    expect(texts((await chat.take(x!, 20, dm)).map((i) => i.message))).toEqual(['private']);
  });

  it('the first reply to your own post, mentioning nobody, goes to the whole channel', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-own');
    const post = (await chat.post(owner, { channelId: channel.id }, say('plan'))).message;
    for (const m of members) await chat.take(m);
    await chat.post(owner, { channelId: channel.id, thread: post.id }, say('one more thing'));
    for (const m of members) expect(texts((await chat.newFor(m)).map((i) => i.message))).toEqual(['one more thing']);
  });

  it('check_inbox for one conversation takes only that one and leaves the rest new', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-one-conv');
    const [bot, other] = members;
    await chat.post(owner, { dm: bot!.id }, say('in the DM'));
    await chat.post(other!, { dm: bot!.id }, say('another DM'));
    await chat.post(owner, { channelId: channel.id }, say('first post'));
    await chat.post(owner, { channelId: channel.id }, say('second post'));
    expect(texts((await chat.take(bot!, 20, dmKey(owner.id, bot!.id))).map((i) => i.message))).toEqual(['in the DM']);
    expect(texts((await chat.newFor(bot!)).map((i) => i.message)).sort()).toEqual(['another DM', 'second post']);
    // The channel's new posts come together: one session sees both.
    const [posts] = await chat.take(bot!, 20, channelKey(channel.id));
    expect(texts([...posts!.earlier, posts!.message])).toEqual(['first post', 'second post']);
    expect(texts((await chat.newFor(bot!)).map((i) => i.message))).toEqual(['another DM']);
  });

  it('newFor for one conversation only queries that conversation (not every membership)', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-one-scan');
    const [bot, other] = members;
    const dm = dmKey(owner.id, bot!.id);
    await chat.post(owner, { dm: bot!.id }, say('dm mail'));
    await chat.post(other!, { dm: bot!.id }, say('other dm'));
    await chat.post(owner, { channelId: channel.id }, say('channel mail'));
    const sinceMany = vi.spyOn(chat.store, 'sinceMany');
    expect(texts((await chat.newFor(bot!, dm)).map((i) => i.message))).toEqual(['dm mail']);
    expect(sinceMany.mock.calls.map((c) => c[0].map((w) => w.id))).toEqual([[dm]]);
    sinceMany.mockRestore();
  });

  it('a DM is a two-person conversation, and wait_for_reply finds the answer', async () => {
    const { owner, members } = await crew(registry, 'chat-dm');
    const bot = members[0]!;
    const { message } = await chat.post(owner, { dm: bot.id }, say('ping'));
    expect(message.conversationId).toBe(dmKey(owner.id, bot.id));
    const [item] = await chat.take(bot);
    const target = await chat.replyTarget(bot, item!.message);
    const waiting = chat.waitForReply(owner, message.id, 2000);
    await chat.post(bot, target, say('pong'));
    expect(texts([(await waiting).reply!])).toEqual(['pong']);
  });

  it('a thread says how many of its replies the viewer has not seen, until they open it', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-new-replies');
    const [x, y] = members;
    const post = (await chat.post(owner, { channelId: channel.id }, say('plan?'))).message;
    await chat.post(y!, { channelId: channel.id, thread: post.id }, say('A'));
    await chat.post(x!, { channelId: channel.id, thread: post.id }, say(`B @${owner.name}`));
    const thread = async () => ((await chat.page(owner, `channel:${channel.id}`, 10)).threads as Record<string, { unread?: number }>)[post.id]!;
    expect((await thread()).unread).toBe(2);
    // The channel's own messages are read, and a thread with an unseen @mention stays unread until opened.
    await chat.markRead(owner, `channel:${channel.id}`);
    expect((await chat.conversations(owner)).find((c) => c.conversation.id === `channel:${channel.id}`)).toMatchObject({ unread: 2, mentions: 1, thread: post.id, conversation: { lastText: `B @${owner.name}`, lastFrom: x!.id, lastFromName: x!.name } });
    // If a newer post arrives in the main channel and is read (or posted by the viewer), an older unread thread must not hijack the channel row to open the old thread.
    const newerPost = (await chat.post(owner, { channelId: channel.id }, say('new main topic'))).message;
    const summaryWithNewerMain = (await chat.conversations(owner)).find((c) => c.conversation.id === `channel:${channel.id}`);
    expect(summaryWithNewerMain?.thread).toBeUndefined();
    expect(summaryWithNewerMain?.conversation).toMatchObject({ lastText: 'new main topic', lastFrom: owner.id, lastFromName: owner.name });
    expect(newerPost.seq).toBeGreaterThan(post.seq);
    await chat.markRead(owner, threadKey(channel.id, post.id));
    expect((await thread()).unread).toBeUndefined();
    // A thread they're not in (didn't start it, weren't mentioned in it, didn't write in it): no count, like the sidebar.
    const other = (await chat.post(x!, { channelId: channel.id }, say('an aside'))).message;
    await chat.post(y!, { channelId: channel.id, thread: other.id }, say('reply'));
    expect(((await chat.page(owner, `channel:${channel.id}`, 10)).threads as Record<string, { unread?: number }>)[other.id]!.unread).toBeUndefined();
    // The last word is theirs: nothing new for them.
    await chat.post(owner, { channelId: channel.id, thread: post.id }, say('ok'));
    expect((await thread()).unread).toBeUndefined();
  });

  it("a thread's \"N new\" counts by the sidebar's rule: a reply not for you is not new to you", async () => {
    const { owner, channel, members } = await crew(registry, 'chat-same-unread');
    const [x, y] = members;
    const post = (await chat.post(owner, { channelId: channel.id }, say('plan?'))).message;
    await chat.post(x!, { channelId: channel.id, thread: post.id }, say('A'));
    // Naming only y: x (an agent) isn't handed it, so it is not unread for x anywhere.
    await chat.post(owner, { channelId: channel.id, thread: post.id }, say(`@${y!.name} take this`));
    const xs = await fresh(x!);
    const sidebar = (await chat.conversations(xs)).find((c) => c.conversation.id === channelKey(channel.id))!;
    const badge = ((await chat.page(xs, channelKey(channel.id), 10)).threads as Record<string, { unread?: number }>)[post.id]!.unread ?? 0;
    expect(badge).toBe(sidebar.unread - ((await chat.page(xs, channelKey(channel.id), 10)).unread ?? 0));
    expect(badge).toBe(0);
  });

  it('a mention stops waiting once seen: its thread opened, the channel read past it, or an answer in the channel', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-seen');
    const [x] = members;
    const me = owner.name;
    const mentioned = async () => (await chat.waitingFor(owner)).filter((w) => w.kind === 'mention').map((w) => w.text);

    // Answered in the channel, not in its thread (how people often do it).
    await chat.post(x!, { channelId: channel.id }, say(`@${me} merge it?`));
    expect(await mentioned()).toEqual([`@${me} merge it?`]);
    await chat.post(owner, { channelId: channel.id }, say('yes, go'));
    expect(await mentioned()).toEqual([]);

    // Its thread opened, though nobody has answered there yet.
    const fyi = (await chat.post(x!, { channelId: channel.id }, say(`@${me} fyi`))).message;
    expect(await mentioned()).toEqual([`@${me} fyi`]);
    await chat.markRead(owner, threadKey(channel.id, fyi.id));
    expect(await mentioned()).toEqual([]);

    // The channel read past it.
    await chat.post(x!, { channelId: channel.id }, say(`@${me} one more`));
    expect(await mentioned()).toEqual([`@${me} one more`]);
    await chat.markRead(owner, `channel:${channel.id}`);
    expect(await mentioned()).toEqual([]);
  });

  it("waiting for a person: mentions they haven't answered (one per thread) and DMs whose last word isn't theirs", async () => {
    const { owner, channel, members } = await crew(registry, 'chat-wait');
    const [x, y] = members;
    const me = owner.name;
    const asked = (await chat.post(x!, { channelId: channel.id }, say(`@${me} merge it?`))).message;
    await chat.post(y!, { channelId: channel.id }, say('no mention here'));
    const inThread = (await chat.post(y!, { channelId: channel.id, thread: asked.id }, say(`@${me} and deploy too?`))).message;
    await chat.post(x!, { dm: owner.id }, say('a question for you'));

    const waiting = await chat.waitingFor(owner);
    expect(waiting.map((w) => [w.kind, w.text])).toEqual([
      ['dm', 'a question for you'],
      ['mention', `@${me} and deploy too?`], // the thread's newest mention stands for it
    ]);
    expect(waiting[0]).toMatchObject({ replyTo: `agent:${x!.id}`, open: dmKey(owner.id, x!.id), fromId: x!.id, fromKind: x!.kind });
    expect(waiting[0]!.fromAvatar).toBe(x!.avatar); // its own avatar, as everywhere else
    expect(waiting[1]).toMatchObject({ replyTo: threadKey(channel.id, asked.id), open: threadKey(channel.id, asked.id), messageId: inThread.id, channelId: channel.id });

    // A long DM shows whole, not the 200-character preview.
    const long = `Here is the plan: ${'step, '.repeat(60)}done.`;
    await chat.post(x!, { dm: owner.id }, say(long));
    expect((await chat.waitingFor(owner)).find((w) => w.kind === 'dm')!.text).toBe(long);

    // Answering in the thread and in the DM clears both (even when the thread had multiple mentions).
    await chat.post(owner, { channelId: channel.id, thread: asked.id }, say('yes to both'));
    await chat.post(owner, { dm: x!.id }, say('answered'));
    expect(await chat.waitingFor(owner)).toEqual([]);

    // Seen is read: opening a mention (including a top-level post with no thread replies yet) or a DM clears it, unanswered.
    const topMention = (await chat.post(x!, { channelId: channel.id }, say(`@${me} fyi only`))).message;
    await chat.post(x!, { dm: owner.id }, say('thanks!'));
    expect((await chat.waitingFor(owner)).length).toBe(2);
    await chat.markRead(owner, threadKey(channel.id, topMention.id));
    await chat.markRead(owner, `agent:${x!.id}`);
    expect(await chat.waitingFor(owner)).toEqual([]);

    // A non-mention reply in the opened thread keeps it cleared; a new @mention or DM brings it back.
    await chat.post(y!, { channelId: channel.id, thread: topMention.id }, say('noted'));
    expect(await chat.waitingFor(owner)).toEqual([]);
    await chat.post(y!, { channelId: channel.id, thread: topMention.id }, say(`@${me} actually one question`));
    await chat.post(x!, { dm: owner.id }, say('follow-up question'));
    expect((await chat.waitingFor(owner)).map((w) => [w.kind, w.text])).toEqual([
      ['dm', 'follow-up question'],
      ['mention', `@${me} actually one question`],
    ]);
  });

  it('a reply to a channel post goes into its thread, and the asker waits there', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-reply');
    const { message } = await chat.post(owner, { channelId: channel.id }, say('who is online?'));
    const [item] = await chat.take(members[0]!);
    const waiting = chat.waitForReply(owner, message.id, 2000);
    await chat.post(members[0]!, await chat.replyTarget(members[0]!, item!.message), say('me'));
    const { reply } = await waiting;
    expect(reply!.conversationId).toBe(threadKey(channel.id, message.id));
  });

  it(`stops handing agents messages after ${AGENT_RUN_MAX} agents' messages in a row, until a person writes`, async () => {
    const { owner, channel, members } = await crew(registry, 'chat-cap');
    const [x, y] = members;
    const post = (await chat.post(owner, { channelId: channel.id }, say('talk'))).message;
    const thread = { channelId: channel.id, thread: post.id };
    await chat.post(owner, thread, say(`@${x!.name} @${y!.name} over to you`));
    await chat.take(y!);
    for (let i = 1; i <= AGENT_RUN_MAX + 2; i++) await chat.post(x!, thread, say(`x ${i}`));
    // y is handed the last of x's messages within the run, and nothing past it.
    const [forY] = await chat.take(y!);
    expect(forY!.message.agentRun).toBe(AGENT_RUN_MAX);
    expect(await chat.newFor(y!)).toEqual([]);
    // People see everything.
    expect((await chat.newFor(owner)).find((i) => i.conversation.kind === 'thread')!.message.agentRun).toBe(AGENT_RUN_MAX + 2);

    await chat.post(owner, thread, say('go on'));
    const [back] = await chat.newFor(y!);
    expect(texts([back!.message])).toEqual(['go on']);
    // What it missed comes with it.
    expect(texts(back!.earlier)).toEqual([`x ${AGENT_RUN_MAX + 1}`, `x ${AGENT_RUN_MAX + 2}`]);
  });

  it(`delivers a direct @mention past ${AGENT_RUN_MAX} up to ${AGENT_RUN_MAX_MENTIONED}, and suppresses past ${AGENT_RUN_MAX_MENTIONED}`, async () => {
    const { owner, channel, members } = await crew(registry, 'chat-mention-cap');
    const [x, y] = members;
    const post = (await chat.post(owner, { channelId: channel.id }, say('start'))).message;
    const thread = { channelId: channel.id, thread: post.id };
    await chat.post(owner, thread, say(`@${x!.name} @${y!.name} go`));
    await chat.take(y!);

    // Advance agentRun to 14 with unmentioned messages; y takes up to AGENT_RUN_MAX (10) and sees nothing after.
    for (let i = 1; i <= 14; i++) await chat.post(x!, thread, say(`x ${i}`));
    const [upToCap] = await chat.take(y!);
    expect(upToCap!.message.agentRun).toBe(AGENT_RUN_MAX);
    expect(await chat.newFor(y!)).toEqual([]);

    // At agentRun = 15, an unmentioned message is NOT delivered to y.
    const unmentioned15 = (await chat.post(x!, thread, say('unmentioned at 15'))).message;
    expect(unmentioned15.agentRun).toBe(15);
    expect(isFor(y!, unmentioned15)).toBe(false);
    expect(await chat.newFor(y!)).toEqual([]);

    // A direct @mention past AGENT_RUN_MAX (at agentRun = 16) IS delivered to y.
    woken.length = 0;
    const mentioned16 = (await chat.post(x!, thread, say(`@${y!.name} review this`))).message;
    expect(mentioned16.agentRun).toBe(16);
    expect(isFor(y!, mentioned16)).toBe(true);
    expect(woken).toContain(y!.id);
    const [handed] = await chat.take(y!);
    expect(handed!.message.id).toBe(mentioned16.id);

    // Advance past AGENT_RUN_MAX_MENTIONED (to agentRun = 45): even a direct @mention is suppressed.
    for (let r = 17; r < 45; r++) await chat.post(x!, thread, say(`x ${r}`));
    woken.length = 0;
    const mentioned45 = (await chat.post(x!, thread, say(`@${y!.name} loop at 45`))).message;
    expect(mentioned45.agentRun).toBe(45);
    expect(mentioned45.agentRun).toBeGreaterThan(AGENT_RUN_MAX_MENTIONED);
    expect(isFor(y!, mentioned45)).toBe(false);
    expect(woken).not.toContain(y!.id);
    expect(await chat.newFor(y!)).toEqual([]);
  });

  it('a message addressed to some members (a room turn) is handed only to them, but everyone can read it', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-to');
    const [x, y] = members;
    await chat.post(owner, { channelId: channel.id }, { ...say('for x only'), to: [x!.id] });
    expect(texts((await chat.newFor(x!)).map((i) => i.message))).toEqual(['for x only']);
    expect(await chat.newFor(y!)).toEqual([]);
    expect(texts((await chat.page(y!, channelKey(channel.id), 10)).messages)).toEqual(['for x only']);
  });

  it('pushes to endpoint agents and wakes mailbox agents, each once per message', async () => {
    const { owner, workspace, channel, members } = await crew(registry, 'chat-push');
    const { agent: ep } = await registry.createBot(owner, { name: 'chat-push-ep', url: 'http://remote.test' });
    await registry.addToWorkspace(owner, workspace.id, ep.id);
    await registry.addToChannel(owner, channel.id, ep.id);
    const { message } = await chat.post(owner, { channelId: channel.id }, say('hi'));
    await queue.idle();
    expect(pushed.filter((j) => j.agentId === ep.id)).toEqual([{ agentId: ep.id, conversationId: message.conversationId }]);
    // Mailbox bots without a Routine are still handed to onMailbox; HubService decides whether to wake.
    expect(woken.filter((id) => members.some((m) => m.id === id))).toHaveLength(members.length);
  });

  it("a reply in a thread you're in is activity in its channel (the channel's time moves)", async () => {
    const { owner, channel } = await crew(registry, 'chat-activity');
    const { message: post } = await chat.post(owner, { channelId: channel.id }, say('a post'));
    const before = (await chat.conversations(owner)).find((c) => c.conversation.id === channelKey(channel.id))!.conversation.lastAt;
    await new Promise((r) => setTimeout(r, 15));
    await chat.post(owner, { channelId: channel.id, thread: post.id }, say('a reply'));
    const after = (await chat.conversations(owner)).find((c) => c.conversation.id === channelKey(channel.id))!.conversation.lastAt;
    expect(after > before).toBe(true);
  });

  it("a reply in a thread you're not in doesn't move the channel for you (only for those in it)", async () => {
    const { owner, channel, members } = await crew(registry, 'chat-activity-hidden');
    const [x, y] = members as [AgentRecord, AgentRecord];
    const time = async (who: AgentRecord) => (await chat.conversations((await registry.get(who.id))!)).find((c) => c.conversation.id === channelKey(channel.id))!.conversation.lastAt;
    const { message: post } = await chat.post(x, { channelId: channel.id }, say('x posts'));
    const ownerBefore = await time(owner);
    const yBefore = await time(y);
    await new Promise((r) => setTimeout(r, 15));
    await chat.post(x, { channelId: channel.id, thread: post.id }, say(`a reply for @${y.name}`));
    expect(await time(owner)).toBe(ownerBefore);
    expect((await time(y)) > yBefore).toBe(true);
  });

  it('unread is what is past your cursor; reading moves it; a new member starts at the end', async () => {
    const { owner, workspace, channel } = await crew(registry, 'chat-unread');
    await chat.post(owner, { channelId: channel.id }, say('one'));
    await chat.post(owner, { channelId: channel.id }, say('two'));
    const { agent: late } = await registry.createBot(owner, { name: 'chat-unread-late' });
    await registry.addToWorkspace(owner, workspace.id, late.id);
    await registry.addToChannel(owner, channel.id, late.id);
    await chat.joined(late.id, channel.id);
    const joined = await fresh(late);
    expect((await chat.conversations(joined)).find((c) => c.conversation.id === channelKey(channel.id))!.unread).toBe(0);

    const { message: three } = await chat.post(owner, { channelId: channel.id }, say(`three, @${late.name}`));
    await chat.post(owner, { channelId: channel.id, thread: three.id }, say('and a thread reply without a mention'));
    const summary = (await chat.conversations(joined)).find((c) => c.conversation.id === channelKey(channel.id))!;
    expect(summary).toMatchObject({ unread: 2, mentions: 1 });
    await chat.markRead(joined, channelKey(channel.id));
    expect((await chat.conversations(joined)).find((c) => c.conversation.id === channelKey(channel.id))).toMatchObject({ unread: 0, mentions: 0 });
  });

  it('the event feed pages through every conversation without gaps or repeats', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-feed');
    const bot = members[0]!;
    const start = await chat.events(owner, undefined, 0);
    await chat.post(bot, { channelId: channel.id }, say('c1'));
    await chat.post(bot, { dm: owner.id }, say('d1'));
    await chat.post(bot, { channelId: channel.id }, say('c2'));
    const first = await chat.events(await fresh(owner), start.cursor, 0);
    expect(texts(first.events)).toEqual(['c1', 'd1', 'c2']);
    const again = await chat.events(await fresh(owner), first.cursor, 0);
    expect(again.events).toEqual([]);
  });

  it('only members read a channel, and only the two sides (and a bot owner) read a DM', async () => {
    const { owner, channel, members } = await crew(registry, 'chat-read');
    const stranger = await testPerson(registry, 'stranger');
    const post = (await chat.post(owner, { channelId: channel.id }, say('inside'))).message;
    await expect(chat.readable(stranger, post.id)).rejects.toThrow(/not found/);
    const other = await crew(registry, 'chat-read-2');
    const dm = (await chat.post(members[0]!, { dm: members[1]!.id }, say('between bots'))).message;
    await expect(chat.readable(owner, dm.id)).resolves.toBeTruthy();
    await expect(chat.readable(other.owner, dm.id)).rejects.toThrow(/not found/);
  });

  it('an answer stored with a fixed id twice is one message', async () => {
    const { owner, members } = await crew(registry, 'chat-once');
    const a = await chat.post(members[0]!, { dm: owner.id }, { ...say('answer'), id: 'fixed-answer-id' });
    const b = await chat.post(members[0]!, { dm: owner.id }, { ...say('answer'), id: 'fixed-answer-id' });
    expect(b.message.seq).toBe(a.message.seq);
    expect((await chat.page(owner, dmKey(owner.id, members[0]!.id), 10)).messages).toHaveLength(1);
  });

  it(`external messages do not wake agents and do not count toward ${AGENT_RUN_MAX} agent turns`, async () => {
    const { owner, channel, members } = await crew(registry, 'chat-ext-run');
    const [x, y] = members;
    for (let i = 1; i <= AGENT_RUN_MAX + 2; i++) {
      const { message } = await chat.post(owner, { channelId: channel.id }, {
        ...say(`outside ${i}`),
        external: { id: 'slack:T1:U9', name: 'Outside (Slack)' },
      });
      expect(message.agentRun).toBe(0);
    }
    expect(await chat.newFor(x!)).toEqual([]);
    expect(await chat.newFor(y!)).toEqual([]);
    // Agents can still hand messages to each other afterwards because external messages didn't advance agentRun.
    await chat.post(x!, { channelId: channel.id }, say(`@${y!.name} your turn`));
    expect(texts((await chat.take(y!)).map((i) => i.message))).toEqual([`@${y!.name} your turn`]);
  });
});

describe('chat: an inbox item is acked by a reply or the next take, not by handing it out', () => {
  const db = testDb();
  const registry = new Registry(db, { fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
  const queue = new InlineQueue();
  queue.setHandler(async () => {});
  const chat = new ChatService(new ChatStore(db), registry, queue, { maxWaitMs: 2000 });
  // The hand-out lease runs out (as if HAND_MS had passed).
  const expire = (agentId: string, conversationId: string) => db.collection('cursors').doc(`${agentId}_${conversationId}`).update({ handedUntilMs: 1 });

  it('a message handed out and never answered is offered again once its lease runs out', async () => {
    const { owner, members } = await crew(registry, 'ack-lost');
    const bot = members[0]!;
    const { message, conversation } = await chat.post(owner, { dm: bot.id }, say('are you there?'));
    expect((await chat.take(bot)).map((i) => i.message.id)).toEqual([message.id]);
    // The session died before answering.
    await expire(bot.id, conversation.id);
    expect((await chat.take(bot)).map((i) => i.message.id)).toEqual([message.id]);
  });

  it('after a reply it is not offered again, even once the lease would have run out', async () => {
    const { owner, members } = await crew(registry, 'ack-replied');
    const bot = members[0]!;
    const { message, conversation } = await chat.post(owner, { dm: bot.id }, say('ping'));
    await chat.take(bot);
    await chat.reply(bot, message.id, say('pong'));
    await expire(bot.id, conversation.id);
    expect(await chat.take(bot)).toEqual([]);
  });

  it('two readers at once don\'t both get the item', async () => {
    const { owner, members } = await crew(registry, 'ack-race');
    const bot = members[0]!;
    const { message } = await chat.post(owner, { dm: bot.id }, say('one of you'));
    const [a, b] = await Promise.all([chat.take(bot), chat.take(bot)]);
    expect([...a, ...b].map((i) => i.message.id)).toEqual([message.id]);
  });
});

describe('chat: appending a message keeps the conversation fields other writers own', () => {
  it('a field written beside the append survives the next message', async () => {
    const db = testDb();
    const registry = new Registry(db, { fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
    const queue = new InlineQueue();
    queue.setHandler(async () => {});
    const chat = new ChatService(new ChatStore(db), registry, queue, { maxWaitMs: 2000 });
    const { owner, channel } = await crew(registry, 'chat-merge');
    const { conversation } = await chat.post(owner, { channelId: channel.id }, say('one'));
    // Some other writer (a future feature) stores its own field on the conversation doc.
    const ref = db.collection('conversations').doc(conversation.id);
    await ref.update({ otherWriter: 'kept' });
    await chat.post(owner, { channelId: channel.id }, say('two'));
    const stored = (await ref.get()).data()!;
    expect(stored.seq).toBe(2);
    expect(stored.otherWriter).toBe('kept');
  });
});

describe('chat: waits wake on a post here, and still re-read for a post on another instance', () => {
  const setup = (pollMs: number) => {
    const db = testDb();
    const registry = new Registry(db, { fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
    const queue = new InlineQueue();
    queue.setHandler(async () => {});
    return { registry, chat: new ChatService(new ChatStore(db), registry, queue, { maxWaitMs: 10_000, pollMs }) };
  };

  it('a waiter wakes as soon as the message is posted, well before the slow re-read', async () => {
    const { registry, chat } = setup(8_000);
    const { owner, members } = await crew(registry, 'chat-wake');
    const bot = members[0]!;
    const { message } = await chat.post(owner, { dm: bot.id }, say('ping'));
    const started = Date.now();
    const reply = chat.waitForReply(owner, message.id, 10_000);
    const inbox = chat.waitAndTake(owner, 10_000);
    setTimeout(() => void chat.post(bot, { dm: owner.id }, say('pong')), 50);
    expect((await reply).reply?.parts[0]?.text).toBe('pong');
    expect(texts((await inbox).map((i) => i.message))).toEqual(['pong']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('with nothing posted on this instance, the slow re-read still finds it', async () => {
    const { registry, chat } = setup(300);
    const { owner, members } = await crew(registry, 'chat-fallback');
    const bot = members[0]!;
    const { message, conversation } = await chat.post(owner, { dm: bot.id }, say('ping'));
    const started = Date.now();
    const waiting = chat.waitForReply(owner, message.id, 10_000);
    // Stored straight into the store, as another instance would: no emit here.
    setTimeout(() => void chat.store.append(conversation, { id: `other-${Date.now()}`, from: bot.name, fromId: bot.id, human: false, parts: [{ text: 'pong' }], mentions: [] }), 50);
    expect((await waiting).reply?.parts[0]?.text).toBe('pong');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
