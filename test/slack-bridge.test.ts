import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import { MemoryFileStore } from '../src/files/store.js';
import { parseSealingKey } from '../src/lib/sealing.js';
import { SlackBridge } from '../src/slack/bridge.js';
import { SlackStore } from '../src/slack/store.js';
import { MAX_ATTEMPTS, keepBridgeEvent, markBridgeEventFailed, pendingBridgeEvents, claimBridgeEvent } from '../src/lib/bridge.js';
import { crew, testConfig, testDb, testPerson } from './helpers.js';

const SECRET = 'slack-signing-secret';
const key = parseSealingKey(Buffer.alloc(32, 5).toString('base64'))!;
let n = 0;
/** Until the event receive() started handling is done (or failed). */
async function settle(store: SlackStore, eventId: string) {
  for (let i = 0; i < 100; i++) {
    const doc = (await (store as any).db.collection('slack_events').doc(eventId).get()).data();
    if (!doc || doc.done || doc.error) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`.toUpperCase();

/** A hub with the bridge, a fake Slack Web API (its calls recorded), and a way to deliver signed events. */
async function setup() {
  const db = testDb();
  const fileStore = new MemoryFileStore();
  const hub = createHub({ db, config: testConfig({ credentialsKey: key }), fileStore });
  const calls: { method: string; body: Record<string, any>; headers?: Record<string, string> }[] = [];
  /** What Slack answers next (one per call); then ok with a fresh ts. */
  const answers: (Response | (() => Response))[] = [];
  let tsSeq = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const raw = init.body !== undefined ? String(init.body) : '';
    const headers = init.headers ? Object.fromEntries(new Headers(init.headers as Record<string, string>).entries()) : undefined;
    calls.push({
      method: String(url).split('/api/')[1] ?? String(url),
      body: raw.startsWith('{') ? JSON.parse(raw) : raw ? Object.fromEntries(new URLSearchParams(raw)) : {},
      ...(headers ? { headers } : {}),
    });
    const next = answers.shift();
    if (next) return typeof next === 'function' ? next() : next;
    return new Response(JSON.stringify({ ok: true, ts: `1700000000.${String(++tsSeq).padStart(6, '0')}` }), { status: 200 });
  }) as typeof fetch;
  const store = new SlackStore(db, key);
  const bridge = new SlackBridge(store, hub, { signingSecret: SECRET, webUrl: 'https://parly.test', fetchImpl });
  // Mirroring, as the app wires it; `mirrored()` waits for every post to Slack started so far.
  const started: Promise<unknown>[] = [];
  hub.chat.onPosted = (message) => void started.push(bridge.onPosted(message));
  const mirrored = async () => {
    await Promise.all(started);
    for (let i = 0; i < 100 && (await store.dueOut(Date.now() + 1)).length && (await bridge.sweep(), true); i++) await new Promise((r) => setTimeout(r, 20));
  };
  const signed = (body: unknown, now = Date.now()) => {
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(now / 1000));
    return { raw, ts, sig: `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${raw}`).digest('hex')}` };
  };
  /** Delivers a message event the way Slack does, and waits for it to be handled. */
  const deliver = async (teamId: string, event: Record<string, unknown>, eventId = `Ev${uid()}`) => {
    const { raw, ts, sig } = signed({ type: 'event_callback', team_id: teamId, event_id: eventId, event: { type: 'message', ...event } });
    const answer = await bridge.receive(raw, ts, sig);
    await settle(store, eventId); // receive() handles it in the background
    return answer;
  };
  /** What a viewer reads in a conversation (`channel:<id>`), oldest first. */
  const read = async (viewer: Parameters<typeof hub.chat.page>[0], key: string) => (await hub.chat.page(viewer, key, 50)).messages;
  return { db, hub, store, bridge, calls, answers, signed, deliver, read, mirrored };
}

/** A Parly workspace with a channel, connected to a Slack workspace, its channel linked. */
async function linked(s: Awaited<ReturnType<typeof setup>>) {
  const { owner, channel } = await crew(s.hub.registry, `slack-${uid()}`, []);
  const teamId = `T${uid()}`;
  const slackChannel = `C${uid()}`;
  await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: channel.workspaceId, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-test');
  await s.store.linkChannel(channel.id, { teamId, channelId: slackChannel });
  return { owner, channel, teamId, slackChannel };
}

describe('Slack bridge: Slack → Parly', () => {
  it('answers only requests Slack signed, recently, over exactly this body; and its URL check', async () => {
    const s = await setup();
    const { raw, ts, sig } = s.signed({ type: 'url_verification', challenge: 'abc' });
    expect(await s.bridge.receive(raw, ts, sig)).toEqual({ status: 200, body: { challenge: 'abc' } });
    expect((await s.bridge.receive(Buffer.from(`${raw} `), ts, sig)).status).toBe(401); // the body changed
    expect((await s.bridge.receive(raw, ts, 'v0=forged')).status).toBe(401);
    const old = s.signed({ type: 'url_verification', challenge: 'abc' }, Date.now() - 10 * 60_000);
    expect((await s.bridge.receive(old.raw, old.ts, old.sig)).status).toBe(401); // a replay
  });

  it('records an unlinked Slack user in a channel as external (never waking agents), and prompts to link on @mention or @Parly', async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    const { agent: bot } = await s.hub.registry.createBot(owner, { name: `coda-${uid()}`, follow: true });
    await s.hub.registry.addToWorkspace(owner, channel.workspaceId, bot.id);
    await s.hub.registry.addToChannel(owner, channel.id, bot.id);

    // A plain message from an unlinked user in a regular channel is recorded as external: true with no ephemeral nag.
    s.answers.push(new Response(JSON.stringify({ ok: true, user: { profile: { display_name: 'Dan (Initech)' } } }), { status: 200 }));
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'here is our webhook doc', ts: '1.0001' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ method: 'users.info', body: { user: 'U1' } });
    const posts = await s.read(owner, `channel:${channel.id}`);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      from: 'Dan (Initech)',
      fromId: `slack:${teamId}:U1`,
      external: true,
      parts: [{ text: 'here is our webhook doc' }],
    });

    // When an unlinked user @mentions an agent in a regular channel, the message is still external: true (never waking the bot)
    // AND they get an ephemeral askToLink prompt (once per hour).
    s.answers.push(new Response(JSON.stringify({ ok: true, user: { profile: { display_name: 'Dan (Initech)' } } }), { status: 200 }));
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: `hello @${bot.name}, check payload`, ts: '1.00015', thread_ts: '1.0001' });
    const refreshedBot = (await s.hub.registry.get(bot.id))!;
    expect(await s.hub.chat.take(refreshedBot)).toHaveLength(0);
    const feed = await s.hub.eventsView(refreshedBot, '1970-01-01T00:00:00.000Z', 0);
    expect(feed.events.find((e) => 'id' in e && e.id === posts[0]!.id)).toMatchObject({ external: true, forYou: false });
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2]).toMatchObject({ method: 'chat.postEphemeral', body: { channel: slackChannel, user: 'U1' } });
    const code = /code=([\w-]+)/.exec(s.calls[2]!.body.text)![1]!;

    // Addressing @Parly within the same hour does not send a second link prompt.
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: '<@UBOT> help', ts: '1.0002' });
    expect(s.calls).toHaveLength(3); // prompted once an hour, not on every command

    await expect(s.bridge.link(owner, 'not-a-real-code-123')).rejects.toThrow(/expired|used/);
    expect(await s.bridge.link(owner, code)).toEqual({ teamName: 'Acme' });
    await expect(s.bridge.link(owner, code)).rejects.toThrow(/expired|used/); // once

    // Now that the owner replies in the thread, the bot wakes and sees the earlier external thread reply (and full thread) marked external: true.
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: `@${bot.name} go ahead`, ts: '1.0004', thread_ts: '1.0001' });
    const items = await s.hub.inboxView(refreshedBot, await s.hub.chat.take(refreshedBot));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      fromId: owner.id,
      text: `@${bot.name} go ahead`,
      earlier: [expect.objectContaining({ from: 'Dan (Initech)', external: true, text: `hello @${bot.name}, check payload` })],
    });
    const fullThread = await s.hub.chat.readThread(refreshedBot, channel.id, posts[0]!.id);
    expect(fullThread.map((m) => ({ from: m.from, external: m.external, text: m.parts[0]?.text }))).toEqual([
      { from: 'Dan (Initech)', external: true, text: 'here is our webhook doc' },
      { from: 'Dan (Initech)', external: true, text: `hello @${bot.name}, check payload` },
      { from: owner.name, external: undefined, text: `@${bot.name} go ahead` },
    ]);
  });

  it('posts a linked person\'s Slack message on Parly as them, once, with its thread', async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    await s.store.linkIdentity(teamId, 'U2', owner.id);

    const eventId = `Ev${uid()}`;
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'ship it &amp; tell <@U2>', ts: '2.0001' }, eventId);
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'ship it &amp; tell <@U2>', ts: '2.0001' }, eventId); // Slack's retry
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'ship it', ts: '2.0001' }); // the same message, another event
    const posts = await s.read(owner, `channel:${channel.id}`);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ fromId: owner.id, parts: [{ text: `ship it & tell @${owner.name}` }] });
    expect(posts[0]!.slack).toEqual([{ teamId, channelId: slackChannel, ts: '2.0001' }]);

    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'a reply', ts: '2.0002', thread_ts: '2.0001' });
    const thread = await s.hub.chat.readThread(owner, channel.id, posts[0]!.id);
    expect(thread.map((m) => m.parts[0]!.text)).toContain('a reply');
  });

  it("ignores the bridge's own posts, edits and other channels", async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    await s.deliver(teamId, { user: 'UBOT', channel: slackChannel, text: 'mirror', ts: '3.1' });
    await s.deliver(teamId, { bot_id: 'B1', channel: slackChannel, text: 'mirror', ts: '3.2' });
    await s.deliver(teamId, { subtype: 'message_changed', user: 'U1', channel: slackChannel, text: 'edit', ts: '3.3' });
    await s.deliver(teamId, { user: 'U1', channel: 'C-not-linked', text: 'elsewhere', ts: '3.4' });
    expect(await s.read(owner, `channel:${channel.id}`)).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it("speaks for a room side only when Parly says the writer is on that side", async () => {
    const s = await setup();
    const a = await testPerson(s.hub.registry, 'SideA');
    const b = await testPerson(s.hub.registry, 'SideB');
    const { workspace, room } = await s.hub.rooms.create(a, { goal: 'Deal', invite: b.email!, side: 'Acme', bots: [], brief: '' });
    await s.hub.rooms.joinSide((await s.hub.registry.get(b.id))!, workspace.id, { side: 'Northwind', bots: [], brief: '' });
    const teamId = `T${uid()}`;
    const slackChannel = `C${uid()}`;
    await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: workspace.id, sideId: a.id, botUserId: 'UBOT', installedBy: a.id }, 'xoxb-test');
    await s.store.linkChannel(room.shared, { teamId, channelId: slackChannel, sideId: a.id });
    await s.store.linkIdentity(teamId, 'UA', a.id);
    await s.store.linkIdentity(teamId, 'UB', b.id); // someone from the other side, in Acme's Slack

    await s.deliver(teamId, { user: 'UB', channel: slackChannel, text: 'as Acme?', ts: '4.1' });
    expect(s.calls.at(-1)).toMatchObject({ method: 'chat.postEphemeral', body: { user: 'UB' } });
    await s.deliver(teamId, { user: 'UA', channel: slackChannel, text: 'from Acme', ts: '4.2' });
    const posts = await s.read((await s.hub.registry.get(a.id))!, `channel:${room.shared}`);
    expect(posts.map((m) => [m.fromId, m.parts[0]!.text])).toContainEqual([a.id, 'from Acme']);
    expect(posts.map((m) => m.parts[0]!.text)).not.toContain('as Acme?');
  });

  it('marks an installation that Slack removed, and the sweep handles events left unhandled', async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    const eventId = `Ev${uid()}`;
    const { raw, ts, sig } = s.signed({ type: 'event_callback', team_id: teamId, event_id: eventId, event: { type: 'message', user: 'U1', channel: slackChannel, text: 'kept', ts: '5.1' } });
    await s.store.keepEvent(eventId, JSON.parse(raw.toString())); // kept, then the process stopped before handling it
    expect(await s.store.pendingEvents(0, 5)).toContain(eventId);
    for (const id of await s.store.pendingEvents(0, 5)) await s.bridge.process(id);
    expect((await s.read(owner, `channel:${channel.id}`)).map((m) => m.parts[0]!.text)).toContain('kept');
    void ts;
    void sig;

    await s.deliver(teamId, { type: 'app_uninstalled' } as never);
    const removed = s.signed({ type: 'event_callback', team_id: teamId, event_id: `Ev${uid()}`, event: { type: 'app_uninstalled' } });
    const id = JSON.parse(removed.raw.toString()).event_id;
    await s.bridge.receive(removed.raw, removed.ts, removed.sig);
    await s.bridge.process(id);
    expect((await s.store.install(teamId))!.problem).toMatch(/removed/);
  });
});

describe('Slack bridge: Parly → Slack', () => {
  it("mirrors what's posted on Parly into the linked Slack channel, as its sender, with mentions and threads", async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    const { agent: mate } = await s.hub.registry.createBot(owner, { name: `mate-${uid()}` });
    await s.hub.registry.addToWorkspace(owner, channel.workspaceId, mate.id);
    await s.hub.registry.addToChannel(owner, channel.id, mate.id);
    await s.store.linkIdentity(teamId, 'UMATE', mate.id); // whoever is linked to a Slack user is mentioned as them
    const { message: post } = await s.hub.send(owner, { channel: channel.id }, [{ text: `a <b> & c, @${mate.name}` }]);
    await s.mirrored();
    const out = s.calls.filter((c) => c.method === 'chat.postMessage');
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toMatchObject({ channel: slackChannel, username: owner.name, text: 'a &lt;b&gt; &amp; c, <@UMATE>', icon_url: expect.stringMatching(/^https:\/\/parly\.test\/avatar\/.+\?kind=human$/) });
    const copy = (await s.store.message(post.id))!.slack![0]!;
    expect(await s.store.messageAt(copy)).toBe(post.id);

    await s.hub.send(owner, { channel: channel.id, thread: post.id }, [{ text: 'in the thread' }]);
    await s.mirrored();
    expect(s.calls.filter((c) => c.method === 'chat.postMessage').at(-1)!.body).toMatchObject({ text: 'in the thread', thread_ts: copy.ts });
  });

  it('never posts a Slack message back where it came from; in a room, it goes to the other side, signed with the side', async () => {
    const s = await setup();
    const a = await testPerson(s.hub.registry, 'Ana');
    const b = await testPerson(s.hub.registry, 'Ben');
    const { workspace, room } = await s.hub.rooms.create(a, { goal: 'Deal', invite: b.email!, side: 'Acme', bots: [], brief: '' });
    await s.hub.rooms.joinSide((await s.hub.registry.get(b.id))!, workspace.id, { side: 'Northwind', bots: [], brief: '' });
    const [TA, TB, CA, CB] = [`TA${uid()}`, `TB${uid()}`, `CA${uid()}`, `CB${uid()}`];
    await s.store.saveInstall({ teamId: TA, teamName: 'Acme', workspaceId: workspace.id, sideId: a.id, botUserId: 'UBOT', installedBy: a.id }, 'xoxb-a');
    await s.store.saveInstall({ teamId: TB, teamName: 'Northwind', workspaceId: workspace.id, sideId: b.id, botUserId: 'UBOT', installedBy: b.id }, 'xoxb-b');
    await s.store.linkChannel(room.shared, { teamId: TA, channelId: CA, sideId: a.id });
    await s.store.linkChannel(room.shared, { teamId: TB, channelId: CB, sideId: b.id });
    await s.store.linkIdentity(TA, 'UA', a.id);

    await s.deliver(TA, { user: 'UA', channel: CA, text: 'offer: 10 units', ts: '6.1' });
    await s.mirrored();
    const out = s.calls.filter((c) => c.method === 'chat.postMessage');
    expect(out.map((c) => c.body.channel)).toEqual([CB]); // not back to Acme's channel
    expect(out[0]!.body).toMatchObject({ text: 'offer: 10 units', username: 'Ana · Acme' });
    const [offer] = (await s.read((await s.hub.registry.get(a.id))!, `channel:${room.shared}`)).filter((m) => m.parts[0]?.text === 'offer: 10 units');
    const northwindCopy = (await s.store.message(offer!.id))!.slack!.find((c) => c.teamId === TB)!;
    // Northwind's copy comes back from Slack (as an event, even without bot_id): it's ours, nothing is posted twice.
    await s.store.linkIdentity(TB, 'UB', b.id);
    await s.deliver(TB, { user: 'UB', channel: CB, text: 'offer: 10 units', ts: northwindCopy.ts });
    const posts = await s.read((await s.hub.registry.get(a.id))!, `channel:${room.shared}`);
    expect(posts.filter((m) => m.parts[0]?.text === 'offer: 10 units')).toHaveLength(1);
  });

  it('keeps a claimed outbox post until its numeric retry deadline, then makes it due', async () => {
    const store = new SlackStore(testDb(), key);
    const job = { messageId: 'retry-post', teamId: 'retry-team', channelId: 'retry-channel', parlyChannelId: 'retry-parly' };
    expect(await store.queueOut(job)).toBe(true);
    const [id] = await store.dueOut();
    expect(id).toBeDefined();
    expect(await store.claimOut(id!)).toMatchObject({ attempts: 0 });
    const deadline = Date.now() + 120_000;
    await store.retryOut(id!, deadline, false);
    expect(await store.dueOut(deadline - 1)).toEqual([]);
    expect(await store.dueOut(deadline)).toEqual([id]);
    await store.doneOut(id!);
    expect(await store.dueOut(deadline)).toEqual([]);
  });

  it('waits when Slack says so, unlinks a channel Slack lost, and stops an installation Slack refuses', async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    s.answers.push(new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
    await s.hub.send(owner, { channel: channel.id }, [{ text: 'slow down' }]);
    await s.mirrored();
    const waiting = await s.store.dueOut(Date.now() + 121_000);
    expect(waiting).toHaveLength(1);
    expect(await s.store.dueOut()).toHaveLength(0); // not due before Slack's Retry-After

    s.answers.push(new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }));
    await s.hub.send(owner, { channel: channel.id }, [{ text: 'gone' }]);
    for (let i = 0; i < 50 && (await s.store.linkedChannel(teamId, slackChannel)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await s.store.linkedChannel(teamId, slackChannel)).toBeUndefined();

    await s.store.linkChannel(channel.id, { teamId, channelId: slackChannel });
    s.answers.push(new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }));
    await s.hub.send(owner, { channel: channel.id }, [{ text: 'refused' }]);
    for (let i = 0; i < 50 && !(await s.store.install(teamId))!.problem; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await s.store.install(teamId))!.problem).toMatch(/invalid_auth/);
  });

  it('pauses a link whose Slack channel is archived (not unlinked), resumes it once the channel is back, and tells a refusal once a day', async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);

    // Slack: the channel is archived. The link waits; it isn't removed.
    s.answers.push(new Response(JSON.stringify({ ok: false, error: 'is_archived' }), { status: 200 }));
    await s.hub.send(owner, { channel: channel.id }, [{ text: 'anyone there?' }]);
    for (let i = 0; i < 50 && !(await s.store.linkedChannel(teamId, slackChannel))?.paused; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await s.store.linkedChannel(teamId, slackChannel)).toMatchObject({ parlyChannelId: channel.id, paused: true });
    expect((await s.hub.registry.channelsById([channel.id])).get(channel.id)!.slack).toEqual([{ teamId, channelId: slackChannel, paused: true }]);

    // Someone writes there again: it was unarchived, so the link is back.
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'we are back', ts: '9.0001' });
    expect((await s.store.linkedChannel(teamId, slackChannel))!.paused).toBeUndefined();
    expect((await s.hub.registry.channelsById([channel.id])).get(channel.id)!.slack).toEqual([{ teamId, channelId: slackChannel }]);

    // The Parly channel is archived: a Slack message isn't posted, and the person is told so once, not every time.
    await s.hub.registry.updateChannel(owner, channel.id, { archived: true });
    const before = s.calls.length;
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'one', ts: '9.0002' });
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: 'two', ts: '9.0003' });
    const told = s.calls.slice(before).filter((c) => c.method === 'chat.postEphemeral');
    expect(told).toHaveLength(1);
    expect(told[0]!.body.text).toMatch(/archived/);
  });
});

describe('Slack bridge: DMs with agents', () => {
  it('talks to the agent named with @, keeps it, follows its threads, and mirrors only its answers', async () => {
    const s = await setup();
    const name = `atlas${uid().toLowerCase()}`;
    const { owner, members, workspace } = await crew(s.hub.registry, `dm-${uid()}`, [name, `${name} pro`]);
    const [atlas, pro] = members as [any, any];
    const teamId = `T${uid()}`;
    const dm = `D${uid()}`;
    await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: workspace.id, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-test');
    await s.store.linkIdentity(teamId, 'U1', owner.id);

    await s.deliver(teamId, { user: 'U1', channel: dm, channel_type: 'im', text: 'hello?', ts: '7.1' });
    expect(s.calls.at(-1)).toMatchObject({ method: 'chat.postMessage', body: { channel: dm, text: expect.stringMatching(/Start with @/) } });

    await s.deliver(teamId, { user: 'U1', channel: dm, text: `@${name} pro: status?`, ts: '7.2' }); // the longest name that fits
    await s.deliver(teamId, { user: 'U1', channel: dm, text: 'and then?', ts: '7.3' }); // still Pro
    const withPro = await s.read(owner, `dm:${[owner.id, pro.id].sort().join('_')}`);
    expect(withPro.map((m) => m.parts[0]!.text)).toEqual(['status?', 'and then?']);
    await s.deliver(teamId, { user: 'U1', channel: dm, text: `@${name} hi`, ts: '7.4' });
    const withAtlas = await s.read(owner, `dm:${[owner.id, atlas.id].sort().join('_')}`);
    expect(withAtlas.map((m) => m.parts[0]!.text)).toEqual(['hi']);
    await s.mirrored();
    const before = s.calls.length;

    // The agent answers on Parly: it's posted in the Slack DM under its name. The person's own messages aren't echoed.
    const answer = await s.hub.send(pro, { to: owner.id }, [{ text: 'all **green**' }]);
    await s.mirrored();
    const out = s.calls.slice(before).filter((c) => c.method === 'chat.postMessage');
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toMatchObject({ channel: dm, text: 'all *green*', username: pro.name });
    // A reply in that message's Slack thread goes to Pro, though Atlas is the DM's agent now.
    const copy = (await s.store.message(answer.message.id))!.slack!.find((c) => c.channelId === dm)!;
    await s.deliver(teamId, { user: 'U1', channel: dm, text: 'thanks', ts: '7.5', thread_ts: copy.ts });
    expect((await s.read(owner, `dm:${[owner.id, pro.id].sort().join('_')}`)).map((m) => m.parts[0]!.text)).toContain('thanks');

    // Once the Slack account is unlinked (or the workspace disconnected), nothing more goes to that DM.
    await s.store.unlinkIdentity(teamId, 'U1');
    await s.hub.send(pro, { to: owner.id }, [{ text: 'after unlink' }]);
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    await s.store.removeInstall(teamId);
    await s.hub.send(pro, { to: owner.id }, [{ text: 'after removal' }]);
    await s.mirrored();
    expect(s.calls.map((c) => c.body.text)).not.toContain('after unlink');
    expect(s.calls.map((c) => c.body.text)).not.toContain('after removal');

    // A DM post already waiting (Slack was slow) is dropped if the person unlinks before it goes out.
    await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: workspace.id, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-test');
    const waiting = `D${uid()}`;
    const job = { messageId: answer.message.id, teamId, channelId: waiting, parlyChannelId: '', dm: { slackUserId: 'U1', personId: owner.id } };
    await s.store.queueOut(job);
    await s.store.unlinkIdentity(teamId, 'U1');
    await s.bridge.send(`${job.messageId}:${teamId}:${waiting}`);
    expect(s.calls.filter((c) => c.body.channel === waiting)).toHaveLength(0);
  });
});

describe('Slack bridge: inviting the app links the channel', () => {
  it('makes (or finds) the Parly channel of the same name, closed for a private one; never for a room side', async () => {
    const s = await setup();
    const { owner, channel, workspace } = await crew(s.hub.registry, `auto-${uid()}`, []);
    const teamId = `T${uid()}`;
    await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: workspace.id, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-test');
    const info = (name: string, isPrivate = false) => new Response(JSON.stringify({ ok: true, channel: { name, is_private: isPrivate } }), { status: 200 });

    const fresh = `C${uid()}`;
    s.answers.push(info('launch', true));
    await s.deliver(teamId, { subtype: 'channel_join', user: 'UBOT', channel: fresh, ts: '8.1' });
    expect(s.calls[0]).toMatchObject({ method: 'conversations.info', body: { channel: fresh } });
    const made = (await s.store.linkedChannel(teamId, fresh))!;
    const launch = (await s.hub.registry.channelsById([made.parlyChannelId])).get(made.parlyChannelId)!;
    expect(launch).toMatchObject({ name: 'launch', workspaceId: workspace.id, open: false });
    expect(s.calls.at(-1)).toMatchObject({ method: 'chat.postMessage', body: { channel: fresh } });

    const same = `C${uid()}`;
    s.answers.push(info(channel.name.toUpperCase()));
    await s.deliver(teamId, { subtype: 'channel_join', user: 'UBOT', channel: same, ts: '8.2' });
    expect((await s.store.linkedChannel(teamId, same))!.parlyChannelId).toBe(channel.id); // the existing one

    // Someone else joining, and a room side's Slack: nothing is linked.
    const before = s.calls.length;
    await s.deliver(teamId, { subtype: 'channel_join', user: 'U1', channel: `C${uid()}`, ts: '8.3' });
    const roomTeam = `T${uid()}`;
    await s.store.saveInstall({ teamId: roomTeam, teamName: 'Side', workspaceId: workspace.id, sideId: owner.id, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-test');
    const roomChannel = `C${uid()}`;
    await s.deliver(roomTeam, { subtype: 'channel_join', user: 'UBOT', channel: roomChannel, ts: '8.4' });
    expect(s.calls.length).toBe(before);
    expect(await s.store.linkedChannel(roomTeam, roomChannel)).toBeUndefined();
  });
});

describe('Slack bridge: mentions written in Slack', () => {
  it('drops "@Parly" (said to the app), and names a Slack user who has not linked their account', async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    s.answers.push(new Response(JSON.stringify({ ok: true, user: { profile: { display_name: 'dana' } } }), { status: 200 }));
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: '<@UBOT> help <@U9>', ts: '10.1' });
    expect(s.calls[0]).toMatchObject({ method: 'users.info', body: { user: 'U9' } });
    expect((await s.read(owner, `channel:${channel.id}`)).map((m) => m.parts[0]!.text)).toEqual(['help @dana']);
  });
});

describe('Slack bridge: faces', () => {
  it("shows a linked person's own Slack picture on what they write in Parly", async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    s.answers.push(new Response(JSON.stringify({ ok: true, user: { profile: { image_192: 'https://avatars.slack-edge.com/me_192.png' } } }), { status: 200 }));
    await s.hub.send(owner, { channel: channel.id }, [{ text: 'from the web' }]);
    await s.mirrored();
    expect(s.calls.find((c) => c.method === 'chat.postMessage')!.body).toMatchObject({ channel: slackChannel, icon_url: 'https://avatars.slack-edge.com/me_192.png' });
  });
});

describe('Slack bridge: the /parly picker', () => {
  it("opens a picker of the channel's agents, and posts the message to the one picked, as the person", async () => {
    const s = await setup();
    const bot = `atlas${uid().toLowerCase()}`;
    const { owner, channel, members } = await crew(s.hub.registry, `pick-${uid()}`, [bot]);
    const teamId = `T${uid()}`;
    const slackChannel = `C${uid()}`;
    await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: channel.workspaceId, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-test');
    await s.store.linkChannel(channel.id, { teamId, channelId: slackChannel });
    const form = (body: Record<string, string>) => {
      const raw = Buffer.from(new URLSearchParams(body).toString());
      const ts = String(Math.floor(Date.now() / 1000));
      return [raw, ts, `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${raw}`).digest('hex')}`] as const;
    };

    // Not linked yet: told how, privately.
    const unlinked = await s.bridge.command(...form({ team_id: teamId, channel_id: slackChannel, user_id: 'U1', trigger_id: 't0', text: '' }));
    expect(unlinked.body).toMatchObject({ response_type: 'ephemeral', text: expect.stringMatching(/slack\/link\?code=/) });

    await s.store.linkIdentity(teamId, 'U1', owner.id);
    const opened = await s.bridge.command(...form({ team_id: teamId, channel_id: slackChannel, user_id: 'U1', trigger_id: 't1', text: 'status?' }));
    expect(opened.status).toBe(200);
    const view = s.calls.find((c) => c.method === 'views.open')!.body;
    expect(view.trigger_id).toBe('t1');
    expect(view.view.blocks[0].element.options).toEqual([{ text: { type: 'plain_text', text: bot }, value: members[0]!.id }]);
    expect(view.view.blocks[1].element.initial_value).toBe('status?');

    const submit = (agent: string) => ({
      payload: JSON.stringify({
        type: 'view_submission',
        team: { id: teamId },
        user: { id: 'U1' },
        view: { callback_id: 'parly_ask', private_metadata: view.view.private_metadata, state: { values: { agent: { pick: { selected_option: { value: agent } } }, text: { msg: { value: 'status?' } } } } },
      }),
    });
    expect((await s.bridge.interaction(...form(submit('not-in-channel')))).body).toMatchObject({ response_action: 'errors' });
    expect((await s.bridge.interaction(...form(submit(members[0]!.id)))).status).toBe(200);
    const [post] = await s.read(owner, `channel:${channel.id}`);
    expect(post).toMatchObject({ fromId: owner.id, parts: [{ text: `@${bot} status?` }], mentions: [members[0]!.id] });
    expect((await s.bridge.command(Buffer.from('x'), '1', 'v0=forged')).status).toBe(401);
  });
});

describe('Slack bridge: @Parly add <agent> in a channel', () => {
  it('adds a visible bot (by full name, unique short name, or id) and refuses ambiguous or cross-side room additions', async () => {
    const s = await setup();
    const { owner, channel } = await linked(s);
    const teamId = (await s.store.installsFor(channel.workspaceId))[0]!.teamId;
    const slackChannel = (await s.hub.registry.channelsById([channel.id])).get(channel.id)!.slack![0]!.channelId;
    await s.store.linkIdentity(teamId, 'U1', owner.id);

    // A follow bot connected on /connect starts outside every workspace; @Parly add <shortName> matches "<Owner>'s <Name>".
    const shortName = `Hermes-${uid()}`;
    const { agent: bot } = await s.hub.registry.createBot(owner, { name: `Malachi's ${shortName}`, follow: true });
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: '<@UBOT> help', ts: '7.90' });
    expect(s.calls.at(-1)).toMatchObject({
      method: 'chat.postMessage',
      body: { channel: slackChannel, text: expect.stringContaining(bot.name) },
    });
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: `<@UBOT> add ${shortName.toLowerCase()}`, ts: '7.91' });
    const updated = (await s.hub.registry.get(bot.id))!;
    expect(updated.workspaces).toContain(channel.workspaceId);
    expect(updated.channels).toContain(channel.id);
    expect(s.calls.at(-1)).toMatchObject({ method: 'chat.postMessage', body: { channel: slackChannel, text: `${bot.name} is in #${channel.name} now.` } });
    expect(await s.read(owner, `channel:${channel.id}`)).toHaveLength(0); // the command itself is not posted as chat

    // Ambiguous short name is rejected with the matching IDs.
    const dupShort = `Claude-${uid()}`;
    await s.hub.registry.createBot(owner, { name: `Malachi's ${dupShort}`, follow: true });
    await s.hub.registry.createBot(owner, { name: `Dana's ${dupShort}`, follow: true });
    await s.deliver(teamId, { user: 'U1', channel: slackChannel, text: `<@UBOT> add ${dupShort}`, ts: '7.915' });
    expect(s.calls.at(-1)).toMatchObject({
      method: 'chat.postEphemeral',
      body: { channel: slackChannel, user: 'U1', text: expect.stringMatching(/Several agents match/) },
    });

    // Shared room: Side A's owner cannot add an agent to Side B's channel, nor add Side B's bot.
    const a = await testPerson(s.hub.registry, 'SideA');
    const b = await testPerson(s.hub.registry, 'SideB');
    const { agent: botA } = await s.hub.registry.createBot(a, { name: `BotA-${uid()}`, follow: true });
    const { agent: botB } = await s.hub.registry.createBot(b, { name: `BotB-${uid()}`, follow: true });
    const { workspace: roomWs, room } = await s.hub.rooms.create(a, { goal: 'Deal', invite: b.email!, side: 'Acme', bots: [], brief: '' });
    const joinedRoom = await s.hub.rooms.joinSide((await s.hub.registry.get(b.id))!, roomWs.id, { side: 'Northwind', bots: [botB.id], brief: '' });
    const bCorner = joinedRoom.sides.find((x) => x.id === b.id)!.corner;

    const TA = `T${uid()}`;
    const TB = `T${uid()}`;
    const CA = `C${uid()}`;
    const CB = `C${uid()}`;
    await s.store.saveInstall({ teamId: TA, teamName: 'Acme', workspaceId: roomWs.id, sideId: a.id, botUserId: 'UBOT', installedBy: a.id }, 'xoxb-test');
    await s.store.saveInstall({ teamId: TB, teamName: 'Northwind', workspaceId: roomWs.id, sideId: b.id, botUserId: 'UBOT', installedBy: b.id }, 'xoxb-test');
    await s.store.linkChannel(room.shared, { teamId: TA, channelId: CA, sideId: a.id });
    await s.store.linkChannel(bCorner, { teamId: TB, channelId: CB, sideId: b.id });
    await s.store.linkIdentity(TA, 'UA', a.id);
    await s.store.linkIdentity(TB, 'UA_IN_B', a.id);

    // Side A owner in Side B's corner Slack channel: refused by room-side check.
    await s.deliver(TB, { user: 'UA_IN_B', channel: CB, text: `@Parly add ${botA.name}`, ts: '7.92' });
    expect((await s.hub.registry.get(botA.id))!.channels).not.toContain(bCorner);
    expect(s.calls.at(-1)).toMatchObject({ method: 'chat.postEphemeral', body: { channel: CB, user: 'UA_IN_B' } });

    // Even if a link pointed at Side B's corner under Side A's team, membership/side check refuses adding to the other side's corner.
    const CWrong = `C${uid()}`;
    await s.store.linkChannel(bCorner, { teamId: TA, channelId: CWrong, sideId: a.id });
    await s.deliver(TA, { user: 'UA', channel: CWrong, text: `@Parly add ${botA.name}`, ts: '7.93' });
    expect((await s.hub.registry.get(botA.id))!.channels).not.toContain(bCorner);
    expect(s.calls.at(-1)).toMatchObject({ method: 'chat.postEphemeral', body: { channel: CWrong, user: 'UA' } });

    // Side A owner cannot add Side B's bot to the shared room.
    await s.deliver(TA, { user: 'UA', channel: CA, text: `@Parly add ${botB.name}`, ts: '7.94' });
    expect(s.calls.at(-1)).toMatchObject({ method: 'chat.postEphemeral', body: { channel: CA, user: 'UA', text: expect.stringMatching(/own side's agents/) } });

    // Side A owner can add their own bot to the shared room.
    await s.deliver(TA, { user: 'UA', channel: CA, text: `@Parly add ${botA.name}`, ts: '7.95' });
    expect((await s.hub.registry.get(botA.id))!.channels).toContain(room.shared);
  });

  it('mirrors images and files in both directions between Slack and Parly', async () => {
    const s = await setup();
    const { owner, channel, teamId, slackChannel } = await linked(s);
    await s.store.linkIdentity(teamId, 'U1', owner.id);
    const { agent: bot } = await s.hub.registry.createBot(owner, { name: `ImgBot-${uid()}` });
    await s.hub.registry.addToWorkspace(owner, channel.workspaceId, bot.id);
    await s.hub.registry.addToChannel(owner, channel.id, bot.id);
    const botFresh = (await s.hub.registry.get(bot.id))!;

    // 1. Parly → Slack: an uploaded image is attached with a signed GCS image_url (not the raw hub /files/:id URL),
    // and a non-image file is rendered as a signed download link <signedUrl|filename>.
    const png = await s.hub.files.uploadInline(botFresh, {
      name: 'diagram.png',
      mediaType: 'image/png',
      contentBase64: Buffer.from('fake-png-bytes').toString('base64'),
    });
    const pdf = await s.hub.files.uploadInline(botFresh, {
      name: 'report.pdf',
      mediaType: 'application/pdf',
      contentBase64: Buffer.from('fake-pdf-bytes').toString('base64'),
    });
    const outParts = await s.hub.parts(botFresh, 'Here is the diagram & report', undefined, [png.id, pdf.id]);
    await s.hub.send(botFresh, { channel: channel.id }, outParts);
    await s.mirrored();

    const postCall = s.calls.filter((c) => c.method === 'chat.postMessage').at(-1)!;
    expect(postCall.body.text).toContain('Here is the diagram &amp; report');
    expect(postCall.body.text).not.toContain(`/files/${png.id}`);
    expect(postCall.body.text).toMatch(/<memory:\/\/get\/files\/[^|>]+disposition=attachment[^|>]*\|report\.pdf>/);
    expect(postCall.body.attachments).toEqual([
      {
        fallback: 'diagram.png',
        title: 'diagram.png',
        title_link: expect.stringContaining(`memory://get/files/${png.id}`),
        image_url: expect.stringContaining(`memory://get/files/${png.id}`),
      },
    ]);

    // Image-only message from Parly → Slack sends empty text with the image attachment instead of "(no text)".
    const onlyImgParts = await s.hub.parts(botFresh, undefined, undefined, [png.id]);
    await s.hub.send(botFresh, { channel: channel.id }, onlyImgParts);
    await s.mirrored();
    const imgOnlyCall = s.calls.filter((c) => c.method === 'chat.postMessage').at(-1)!;
    expect(imgOnlyCall.body.text).toBe('');
    expect(imgOnlyCall.body.attachments).toHaveLength(1);

    // 2. Slack → Parly: a Slack `file_share` message (even with no caption text) downloads the private file with
    // the bot token, uploads it into Parly's Files, and attaches it to the channel message.
    const inboundBytes = Buffer.from('slack-screenshot-png');
    s.answers.push(
      new Response(inboundBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    await s.deliver(teamId, {
      subtype: 'file_share',
      user: 'U1',
      channel: slackChannel,
      text: '',
      files: [
        {
          id: 'F123',
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: inboundBytes.byteLength,
          url_private_download: 'https://files.slack.com/files-pri/T1-F123/download/screenshot.png',
        },
      ],
      ts: '8.100',
    });

    const downloadCall = s.calls.find((c) => c.method === 'https://files.slack.com/files-pri/T1-F123/download/screenshot.png');
    expect(downloadCall?.headers?.authorization).toBe('Bearer xoxb-test');

    const msgs = await s.read(owner, `channel:${channel.id}`);
    const lastMsg = msgs.at(-1)!;
    const attachedPart = lastMsg.parts.find((p) => typeof p.metadata?.fileId === 'string');
    expect(attachedPart).toMatchObject({
      filename: 'screenshot.png',
      mediaType: 'image/png',
    });
    const downloadedRecord = await s.hub.fileForDownload(botFresh, String(attachedPart!.metadata!.fileId));
    expect(downloadedRecord.name).toBe('screenshot.png');
    expect(downloadedRecord.size).toBe(inboundBytes.byteLength);

    // 3. When an older Slack install lacks `files:read`, Slack returns an HTML login page; an image-only message
    // notifies the sender once with a clear hint to reconnect Slack.
    s.answers.push(
      new Response('<html>login</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    await s.deliver(teamId, {
      subtype: 'file_share',
      user: 'U1',
      channel: slackChannel,
      text: '',
      files: [
        {
          id: 'F124',
          name: 'blocked.png',
          mimetype: 'image/png',
          size: 50,
          url_private_download: 'https://files.slack.com/files-pri/T1-F124/download/blocked.png',
        },
      ],
      ts: '8.200',
    });
    expect(s.calls.at(-1)).toMatchObject({
      method: 'chat.postEphemeral',
      body: {
        channel: slackChannel,
        user: 'U1',
        text: expect.stringMatching(/reconnect Slack/i),
      },
    });
    const badRaw = Buffer.from(
      new URLSearchParams({
        payload: JSON.stringify({
          type: 'view_submission',
          view: { callback_id: 'parly_ask', private_metadata: '{bad-json', state: { values: {} } },
        }),
      }).toString(),
    );
    const badTs = String(Math.floor(Date.now() / 1000));
    const badSig = `v0=${createHmac('sha256', SECRET).update(`v0:${badTs}:${badRaw}`).digest('hex')}`;
    expect(await s.bridge.interaction(badRaw, badTs, badSig)).toEqual({
      status: 400,
      body: { error: 'Invalid private_metadata' },
    });
  });
});

// These shared bridge-event helpers back both the Slack and Telegram sweeps; the terminal-state fix lives here.
describe('bridge events: a poison event goes terminal instead of starving the sweep forever', () => {
  it('drops an event once it exhausts its attempts, and never lets exhausted docs crowd out fresh ones', async () => {
    const db = testDb();
    const coll = `telegram_events_sweep_${uid()}`; // a throwaway collection, so other tests' rows stay out of the 100-doc window
    const now = Date.now() + 60_000; // past every "at" written below, with slack for slow CI between writes

    const poison = `P${uid()}`;
    expect(await keepBridgeEvent(db, coll, poison, {})).toBe(true);
    expect(await claimBridgeEvent(db, coll, poison)).toBeDefined(); // stamp claimedAt so the next line's clear is observable
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await markBridgeEventFailed(db, coll, poison, 'boom');
    // A failure clears the claim (FieldValue.delete under tx.update), so a still-live event is reclaimable and still swept.
    expect(await claimBridgeEvent(db, coll, poison)).toBeDefined();
    expect(await pendingBridgeEvents(db, coll, 0, MAX_ATTEMPTS, now)).toContain(poison);

    // The failure that reaches the max takes it terminal: dropped from the sweep and unclaimable (by `done`, not the claim window).
    await markBridgeEventFailed(db, coll, poison, 'boom');
    expect(await pendingBridgeEvents(db, coll, 0, MAX_ATTEMPTS, now)).not.toContain(poison);
    expect(await claimBridgeEvent(db, coll, poison)).toBeUndefined();

    // 100 legacy exhausted docs (attempts >= max, never flipped done) are the oldest rows: the stable `at` sort puts them
    // first, so without the attempts filter in the query they'd fill the 100-doc window and starve a fresh event.
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => db.collection(coll).doc(`L${i}_${uid()}`).create({ done: false, attempts: MAX_ATTEMPTS, at: new Date(i).toISOString() })),
    );
    const fresh = `F${uid()}`;
    expect(await keepBridgeEvent(db, coll, fresh, {})).toBe(true);
    expect(await pendingBridgeEvents(db, coll, 0, MAX_ATTEMPTS, now)).toContain(fresh);
  });
});
