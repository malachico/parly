import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryFileStore } from '../src/files/store.js';
import type { HubService } from '../src/hub/hubService.js';
import { crewOverHttp, newAgentOverHttp, testConfig, testDb, freePort, httpCaller } from './helpers.js';

describe('public channels', () => {
  let hubUrl: string;
  let server: Server;
  let bot: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let channelId: string;
  let hub: HubService;

  const call = httpCaller(() => hubUrl);
  const say = (text: string, thread?: string, files?: string[]) =>
    call(bot.token, 'POST', `/conversations/${thread ? `thread:${channelId}:${thread}` : `channel:${channelId}`}/messages`, { text, ...(files ? { files } : {}) });
  const upload = async (name: string) =>
    (await hub.files.uploadInline((await hub.registry.get(bot.agent.id))!, { name, mediaType: 'image/png', contentBase64: Buffer.from(name).toString('base64') })).id;
  const fetchFile = (fileId: string) => fetch(`${hubUrl}/public/channels/${channelId}/files/${fileId}`, { redirect: 'manual' });

  let app: ReturnType<typeof createApp>['app'];
  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    ({ app, hub } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl }), fileStore: new MemoryFileStore() }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    bot = await newAgentOverHttp(hubUrl, { name: 'Talker' });
    ({ channelId } = await crewOverHttp(hubUrl, [bot], 'showcase'));
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('is private until an owner makes it public, then shows only what came after', async () => {
    const privateFile = await upload('private.png');
    const before = (await say('said in private', undefined, [privateFile])).json.id as string;
    expect((await call(undefined, 'GET', `/public/channels/${channelId}`)).status).toBe(404);

    expect((await call(bot.token, 'PATCH', `/channels/${channelId}`, { public: true })).status).toBe(403); // bots aren't owners here
    const made = await call(bot.owner.token, 'PATCH', `/channels/${channelId}`, { public: true });
    expect(made.json.public).toBe(true);

    const publicFile = await upload('public.png');
    const post = (await say('said in public', undefined, [publicFile])).json.id as string;
    await say('a public reply', post);
    await say('late reply to an old post', before);

    const page = await call(undefined, 'GET', `/public/channels/${channelId}`);
    expect(page.status).toBe(200);
    expect(page.json.channel).toEqual({ id: channelId, name: 'showcase' });
    expect(page.json.messages.map((m: any) => m.text)).toEqual(['said in public']);
    expect(page.json.threads[post].count).toBe(1);
    expect(page.json.people[bot.agent.id]).toMatchObject({ name: 'Talker', kind: 'bot' });
    expect(page.text).not.toContain(bot.owner.email);
    expect(page.json.older).toBe(false);
    expect(page.json.messages[0].files).toEqual([{ id: publicFile, name: 'public.png', mediaType: 'image/png' }]);
    expect((await fetchFile(publicFile)).status).toBe(302);
    expect((await fetchFile(privateFile)).status).toBe(404); // said before it went public

    expect((await call(undefined, 'GET', `/public/channels/${channelId}/threads/${post}`)).json.replies.map((m: any) => m.text)).toEqual(['a public reply']);
    expect((await call(undefined, 'GET', `/public/channels/${channelId}/threads/${before}`)).status).toBe(404);
  });

  it('goes private again; public once more, it shows only what came after that', async () => {
    await call(bot.owner.token, 'PATCH', `/channels/${channelId}`, { public: true }); // already public: no change
    expect((await call(undefined, 'GET', `/public/channels/${channelId}`)).json.messages).toHaveLength(1);
    await call(bot.owner.token, 'PATCH', `/channels/${channelId}`, { public: false });
    expect((await call(undefined, 'GET', `/public/channels/${channelId}`)).status).toBe(404);
    await call(bot.owner.token, 'PATCH', `/channels/${channelId}`, { public: true });
    await say('after going public again');
    expect((await call(undefined, 'GET', `/public/channels/${channelId}`)).json.messages.map((m: any) => m.text)).toEqual(['after going public again']);
  });

  it('shares one thread of a private channel, and only that thread', async () => {
    const { channelId: ch } = await crewOverHttp(hubUrl, [bot], 'private-room');
    const post = (m: string, thread?: string, files?: string[]) =>
      call(bot.token, 'POST', `/conversations/${thread ? `thread:${ch}:${thread}` : `channel:${ch}`}/messages`, { text: m, ...(files ? { files } : {}) });
    const shared = (await post('worth sharing')).json.id as string;
    const other = (await post('stays private')).json.id as string;
    const file = await upload('in-thread.png');
    await post('a reply', shared, [file]);
    await post('private reply', other);
    const thread = (p: string) => call(undefined, 'GET', `/public/channels/${ch}/threads/${p}`);
    expect((await thread(shared)).status).toBe(404);

    expect((await call(bot.token, 'PATCH', `/channels/${ch}/threads/${shared}`, { public: true })).status).toBe(403);
    expect((await call(bot.owner.token, 'PATCH', `/channels/${ch}/threads/nope`, { public: true })).status).toBe(404);
    const made = await call(bot.owner.token, 'PATCH', `/channels/${ch}/threads/${shared}`, { public: true });
    expect(made.json.publicThreads).toEqual([shared]);

    const t = await thread(shared);
    expect(t.json.post.text).toBe('worth sharing');
    expect(t.json.replies.map((m: any) => m.text)).toEqual(['a reply']);
    expect((await fetch(`${hubUrl}/public/channels/${ch}/files/${file}`, { redirect: 'manual' })).status).toBe(302);
    expect((await thread(other)).status).toBe(404);
    expect((await call(undefined, 'GET', `/public/channels/${ch}`)).status).toBe(404); // the channel stays private

    await call(bot.owner.token, 'PATCH', `/channels/${ch}/threads/${shared}`, { public: false });
    expect((await thread(shared)).status).toBe(404);
    expect((await fetch(`${hubUrl}/public/channels/${ch}/files/${file}`, { redirect: 'manual' })).status).toBe(404);
  });
});
