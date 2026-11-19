import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import { threadKey } from '../src/chat/chat.js';
import type { HubService } from '../src/hub/hubService.js';
import { crew, testConfig, testDb } from './helpers.js';

const say = (text: string) => [{ text }];

describe('live agent activity', () => {
  let hub: HubService;
  beforeAll(() => {
    hub = createHub({ db: testDb(), config: testConfig() });
  });

  it('reading once it takes a message, working with its own words, gone when it answers', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'act-flow', ['coder']);
    const coder = members[0]!;
    const key = `channel:${channel.id}`;
    const post = (await hub.send(owner, { channel: channel.id }, say(`@${coder.name} fix the build`))).message;
    expect((await hub.chat.page(owner, key, 20)).activity).toEqual([]);

    await hub.chat.take(coder);
    expect((await hub.chat.page(owner, key, 20)).activity).toMatchObject([{ agentId: coder.id, state: 'reading' }]);

    await hub.setStatus(coder, key, 'running the tests');
    expect((await hub.chat.page(owner, key, 20)).activity).toMatchObject([{ agentId: coder.id, state: 'working', text: 'running the tests' }]);

    // It answers in the post's thread: done, in the channel and its threads.
    await hub.send(coder, { channel: channel.id, thread: post.id }, say('fixed'));
    expect((await hub.chat.page(owner, key, 20)).activity).toEqual([]);
  });

  it("posting where it said it was working clears its card's status, but not one about another channel", async () => {
    const { owner, workspace, channel, members } = await crew(hub.registry, 'act-card', ['carder']);
    const coder = members[0]!;
    const post = (await hub.send(owner, { channel: channel.id }, say('help'))).message;
    await hub.setStatus(coder, `channel:${channel.id}`, 'on it');
    await hub.send(coder, { channel: channel.id, thread: post.id }, say('done'));
    expect((await hub.registry.get(coder.id))!.status).toBeUndefined();

    const other = await hub.registry.createChannel(owner, workspace.id, 'act-card-other');
    await hub.registry.addToChannel((await hub.registry.get(owner.id))!, other.id, coder.id);
    await hub.setStatus((await hub.registry.get(coder.id))!, `channel:${other.id}`, 'elsewhere');
    await hub.send(coder, { channel: channel.id }, say('unrelated'));
    expect((await hub.registry.get(coder.id))!.status).toMatchObject({ text: 'elsewhere' });
  });

  it("shows a thread's activity on its channel (saying which thread), and only its own on the thread", async () => {
    const { owner, channel, members } = await crew(hub.registry, 'act-thread', ['helper', 'other']);
    const [helper, other] = members as [typeof members[0], typeof members[0]];
    const post = (await hub.send(owner, { channel: channel.id }, say('question'))).message;
    await hub.setStatus(helper!, threadKey(channel.id, post.id), 'looking into it');
    await hub.setStatus(other!, `channel:${channel.id}`, 'reviewing');
    const onChannel = (await hub.chat.page(owner, `channel:${channel.id}`, 20)).activity;
    expect(onChannel).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: helper!.id, thread: post.id, text: 'looking into it' }), expect.objectContaining({ agentId: other!.id })]));
    expect((await hub.chat.page(owner, threadKey(channel.id, post.id), 20)).activity.map((a) => a.agentId)).toEqual([helper!.id]);
    await hub.setStatus(helper!, threadKey(channel.id, post.id), undefined, true); // done, without answering
    expect((await hub.chat.page(owner, threadKey(channel.id, post.id), 20)).activity).toEqual([]);
  });

  it('an agent removed from the channel while at it is no longer shown at it there', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'act-removed', ['reader']);
    const reader = members[0]!;
    const post = (await hub.send(owner, { channel: channel.id }, say('question'))).message;
    await hub.setStatus(reader, threadKey(channel.id, post.id), 'reading it');
    expect((await hub.chat.page(owner, `channel:${channel.id}`, 20)).activity.map((a) => a.agentId)).toEqual([reader.id]);
    // It wrote in the thread, so it's one of the thread's people.
    await hub.send(reader, { channel: channel.id, thread: post.id }, say('on it'));
    await hub.registry.removeFromChannel(owner, channel.id, reader.id);
    expect((await hub.chat.page(owner, `channel:${channel.id}`, 20)).activity).toEqual([]);
    expect((await hub.chat.page(owner, threadKey(channel.id, post.id), 20)).activity).toEqual([]);
    // Removed, it no longer hears the thread: a new reply doesn't reach its inbox or its events.
    await hub.send(owner, { channel: channel.id, thread: post.id }, say('one more thing'));
    const after = (await hub.registry.get(reader.id))!;
    expect((await hub.chat.newFor(after)).map((i) => i.conversation.id)).not.toContain(threadKey(channel.id, post.id));
  });

  it('wakes the live feed of those who can see it, and only them', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'act-feed', ['busy']);
    const outsider = (await crew(hub.registry, 'act-outsider', [])).owner;
    const start = await hub.chat.events(owner, undefined, 0, true);
    const outsiderStart = await hub.chat.events(outsider, undefined, 0, true);
    await new Promise((r) => setTimeout(r, 5));
    await hub.setStatus(members[0]!, `channel:${channel.id}`, 'deploying');
    const seen = await hub.chat.events(owner, start.cursor, 0, true);
    expect(seen.activity).toBe(1);
    expect(seen.events).toEqual([]);
    expect((await hub.chat.events(owner, seen.cursor, 0, true)).activity).toBe(0); // not twice
    expect((await hub.chat.events(outsider, outsiderStart.cursor, 0, true)).activity).toBe(0);
    expect((await hub.chat.events(owner, start.cursor, 0)).activity).toBe(0); // an agent's feed doesn't wake for it
  });

  it('reading in one tab wakes the others with a read event, once', async () => {
    const { owner, members } = await crew(hub.registry, 'act-read', ['pinger']);
    await hub.send(members[0]!, { to: owner.id }, say('ping'));
    const start = await hub.chat.events(owner, undefined, 0, true);
    await new Promise((r) => setTimeout(r, 5));
    await hub.chat.markRead(owner, `agent:${members[0]!.id}`);
    const read = await hub.chat.events(owner, start.cursor, 0, true);
    expect(read.reads).toHaveLength(1);
    expect((await hub.chat.events(owner, read.cursor, 0, true)).reads).toEqual([]); // not twice
    expect((await hub.chat.events(owner, start.cursor, 0)).reads).toEqual([]); // an agent's feed doesn't get it
  });

  it('refuses people and conversations the agent cannot read', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'act-refuse', ['bot']);
    const elsewhere = await crew(hub.registry, 'act-elsewhere', []);
    await expect(hub.setStatus(owner, `channel:${channel.id}`, 'x')).rejects.toThrow(/Agents report/);
    await expect(hub.setStatus(members[0]!, `channel:${elsewhere.channel.id}`, 'x')).rejects.toThrow(/No conversation/);
    await expect(hub.setStatus(members[0]!, `channel:${channel.id}`, 'x'.repeat(121))).rejects.toThrow(/120/);
  });

  it('includes listening and wakes presence on direct conversation peers', async () => {
    const { owner, members } = await crew(hub.registry, 'act-dm-presence', ['peer']);
    const peer = members[0]!;
    await hub.send(owner, { to: peer.id }, say('hey there'));
    const before = (await hub.conversationViews(owner)).find((c) => c.key === `agent:${peer.id}`);
    expect(before?.with?.listening).toBe(false);

    await hub.registry.markListening(peer);
    const during = (await hub.conversationViews(owner)).find((c) => c.key === `agent:${peer.id}`);
    expect(during?.with?.listening).toBe(true);
  });
});

describe('live agent activity, one per agent in a channel', () => {
  it('a thread state replaces the channel one, and stopping wakes the feed', async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, channel, members } = await crew(hub.registry, 'act-one', ['solo']);
    const bot = members[0]!;
    const post = (await hub.send(owner, { channel: channel.id }, say(`@${bot.name} hi`))).message;
    await hub.chat.take(bot);
    await hub.setStatus(bot, threadKey(channel.id, post.id), 'on it');
    expect((await hub.chat.page(owner, `channel:${channel.id}`, 20)).activity).toMatchObject([{ agentId: bot.id, state: 'working', thread: post.id }]);
    const before = await hub.chat.events(owner, undefined, 0, true);
    await new Promise((r) => setTimeout(r, 5));
    await hub.setStatus(bot, threadKey(channel.id, post.id), undefined, true);
    expect((await hub.chat.events(owner, before.cursor, 0, true)).activity).toBe(1);
    expect((await hub.chat.page(owner, `channel:${channel.id}`, 20)).activity).toEqual([]);
  });
});
