import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryFileStore } from '../src/files/store.js';
import { crewOverHttp, newAgentOverHttp, testConfig, testDb } from './helpers.js';

describe('message quotes', () => {
  const db = testDb();
  const { app, hub } = createApp({ db, config: testConfig(), fileStore: new MemoryFileStore() });
  let server: Server;
  let base: string;
  let bot: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let other: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let channel: string;
  const call = async (token: string | undefined, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() as any };
  };
  const say = (token: string, key: string, text: string, replyTo?: unknown) => call(token, 'POST', `/conversations/${key}/messages`, { text, replyTo });
  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    bot = await newAgentOverHttp(base, { name: 'quote-bot', public: true });
    other = await newAgentOverHttp(base, { name: 'quote-other', public: true });
    channel = (await crewOverHttp(base, [bot, other], 'quotes')).channelId;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('round-trips a trusted snapshot for humans and agents, normalizes long text and rejects forged objects', async () => {
    const original = (await say(bot.token, `channel:${channel}`, 'Hello\n  world ' + 'x'.repeat(240))).body;
    const response = await say(bot.owner.token, `channel:${channel}`, 'yes', original.id);
    expect(response.status).toBe(201);
    expect(response.body.replyTo).toEqual({ id: original.id, fromId: bot.agent.id, from: 'quote-bot', text: ('Hello world ' + 'x'.repeat(240)).slice(0, 180) });
    const agentReply = await say(other.token, `channel:${channel}`, 'ok', response.body.id);
    expect(agentReply.body.replyTo.fromId).toBe(response.body.fromId);
    const page = await call(bot.token, 'GET', `/conversations/channel:${channel}/messages`);
    expect(page.body.messages.find((m: any) => m.id === response.body.id).replyTo).toEqual(response.body.replyTo);
    for (const invalid of ['', 'a/b', '.', '..', { id: original.id, from: 'Admin', text: 'fake' }]) {
      expect((await say(bot.token, `channel:${channel}`, 'forged', invalid)).status).toBe(400);
    }
  });

  it('allows only the same DM/thread, including the thread root exception; routing replyTo remains independent', async () => {
    const post = (await say(bot.token, `channel:${channel}`, 'root')).body;
    const reply = (await say(bot.token, `thread:${channel}:${post.id}`, 'reply', post.id)).body;
    expect(reply.replyTo.id).toBe(post.id);
    const follow = await call(other.token, 'POST', `/messages/${reply.id}/reply`, { text: 'quoted', replyTo: reply.id });
    expect(follow.status).toBe(201);
    expect(follow.body.conversation).toBe(`thread:${channel}:${post.id}`);
    expect(follow.body.replyTo.id).toBe(reply.id);
    const root2 = (await say(bot.token, `channel:${channel}`, 'another root')).body;
    expect((await say(bot.token, `thread:${channel}:${root2.id}`, 'cross-thread', reply.id)).status).toBe(404);
    expect((await say(bot.token, `channel:${channel}`, 'cross-thread', reply.id)).status).toBe(404);
    await call(bot.owner.token, 'PATCH', `/channels/${channel}/threads/${root2.id}`, { done: true });
    expect((await say(bot.owner.token, `thread:${channel}:${root2.id}`, 'invalid quote must not reopen', reply.id)).status).toBe(404);
    expect((await hub.registry.channelsById([channel])).get(channel)?.doneThreads).toContain(root2.id);
    const dm = (await say(bot.token, `agent:${other.agent.id}`, 'private')).body;
    expect((await say(other.token, `agent:${bot.agent.id}`, 'dm quote', dm.id)).body.replyTo.id).toBe(dm.id);
    expect((await say(bot.token, `channel:${channel}`, 'cross-DM', dm.id)).status).toBe(404);
    expect((await say(bot.token, `agent:${other.agent.id}`, 'cross-channel', post.id)).status).toBe(404);
    expect((await say(bot.token, `channel:${channel}`, 'missing', 'missing')).status).toBe(404);
    const otherChannel = (await call(bot.owner.token, 'POST', `/workspaces/${(await hub.registry.channelsById([channel])).get(channel)!.workspaceId}/channels`, { name: 'other quotes' })).body;
    expect((await say(bot.owner.token, `channel:${otherChannel.id}`, 'cross-channel', post.id)).status).toBe(404);
    const outsider = await newAgentOverHttp(base, { name: 'quote-outsider' });
    expect((await say(outsider.token, `channel:${channel}`, 'not a member', post.id)).status).toBe(404);
  });

  it('quotes attachment names without copying file access and keeps snapshots after deletion', async () => {
    const dataOnly = (await call(bot.token, 'POST', `/conversations/channel:${channel}/messages`, { data: { value: 1 } })).body;
    expect((await say(bot.token, `channel:${channel}`, 'structured quote', dataOnly.id)).body.replyTo.text).toBe('Structured message');
    const agent = (await hub.registry.get(bot.agent.id))!;
    const file = await hub.files.uploadInline(agent, { name: 'photo.png', mediaType: 'image/png', contentBase64: Buffer.from('image').toString('base64') });
    const original = (await call(bot.token, 'POST', `/conversations/channel:${channel}/messages`, { files: [file.id] })).body;
    const reply = (await say(bot.token, `channel:${channel}`, 'picture', original.id)).body;
    expect(reply.replyTo.text).toBe('Attachment: photo.png');
    expect(Object.keys(reply.replyTo).sort()).toEqual(['from', 'fromId', 'id', 'text']);
    await db.collection('messages').doc(original.id).delete();
    expect((await hub.chat.store.message(reply.id))?.replyTo?.text).toBe('Attachment: photo.png');
  });

  it('redacts private snapshots at the strict public cutoff, keeps public quotes and separately shared threads', async () => {
    const before = (await say(bot.token, `channel:${channel}`, 'private before cutoff')).body;
    expect((await call(bot.owner.token, 'PATCH', `/channels/${channel}`, { public: true })).status).toBe(200);
    const leaked = (await say(bot.token, `channel:${channel}`, 'public response', before.id)).body;
    const visible = (await say(bot.token, `channel:${channel}`, 'public original')).body;
    const quoted = (await say(bot.token, `channel:${channel}`, 'public quote', visible.id)).body;
    let page = (await call(undefined, 'GET', `/public/channels/${channel}`)).body;
    expect(page.messages.find((m: any) => m.id === leaked.id).replyTo).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain('private before cutoff');
    expect(page.messages.find((m: any) => m.id === quoted.id).replyTo.id).toBe(visible.id);
    const rootReply = (await say(bot.token, `thread:${channel}:${visible.id}`, 'root quote', visible.id)).body;
    const replyQuote = (await say(bot.token, `thread:${channel}:${visible.id}`, 'reply quote', rootReply.id)).body;
    const publicThread = (await call(undefined, 'GET', `/public/channels/${channel}/threads/${visible.id}`)).body;
    expect(publicThread.replies.find((m: any) => m.id === replyQuote.id).replyTo.id).toBe(rootReply.id);
    // A private root can be shared separately; its thread quotes remain public even below the channel cutoff.
    expect((await call(bot.owner.token, 'PATCH', `/channels/${channel}/threads/${before.id}`, { public: true })).status).toBe(200);
    await say(bot.token, `thread:${channel}:${before.id}`, 'shared root quote', before.id);
    const shared = (await call(undefined, 'GET', `/public/channels/${channel}/threads/${before.id}`)).body;
    expect(shared.replies.at(-1).replyTo.id).toBe(before.id);
    await db.collection('messages').doc(visible.id).delete();
    page = (await call(undefined, 'GET', `/public/channels/${channel}`)).body;
    expect(page.messages.find((m: any) => m.id === quoted.id).replyTo).toBeUndefined();
  });
});
