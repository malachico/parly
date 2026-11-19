import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseSealingKey } from '../src/lib/sealing.js';
import { MAX_AUTO_TOPIC_CHANNELS } from '../src/telegram/bridge.js';
import { TelegramStore, telegramKey, telegramLinkKey } from '../src/telegram/store.js';
import { crew, testConfig, testDb, testPerson } from './helpers.js';

const BOT_TOKEN = '123456:ABC-DEF-telegram-test-token';
const WEBHOOK_SECRET = 'tg-webhook-secret-token-xyz';
const key = parseSealingKey(Buffer.alloc(32, 7).toString('base64'))!;

describe('Telegram bridge core relay', () => {
  it('links Parly channels to Telegram chats/topics two-way, deduplicates update_id, and tracks message copies', async () => {
    const db = testDb();
    const store = new TelegramStore(db);
    const n = Date.now();
    const chatId = `-100${n}`;
    const chA = `ch-a-${n}`;
    const chB = `ch-b-${n}`;
    await db.collection('channels').doc(chA).set({ id: chA, name: 'general' });
    await db.collection('channels').doc(chB).set({ id: chB, name: 'dev-topic' });

    await store.linkChannel(chA, { chatId });
    await store.linkChannel(chB, { chatId, topicId: 42 });

    expect((await db.collection('channels').doc(chA).get()).data()!.telegram).toEqual([{ chatId }]);
    expect((await db.collection('channels').doc(chB).get()).data()!.telegram).toEqual([{ chatId, topicId: 42 }]);
    expect(await store.linkedChannel(chatId)).toMatchObject({ parlyChannelId: chA, chatId });
    expect(await store.linkedChannel(chatId, 42)).toMatchObject({ parlyChannelId: chB, chatId, topicId: 42 });
    // Topic without its own binding falls back to the whole-chat link.
    expect(await store.linkedChannel(chatId, 99)).toMatchObject({ parlyChannelId: chA, chatId });

    const chOther = `ch-other-${n}`;
    await db.collection('channels').doc(chOther).set({ id: chOther, name: 'other' });
    await expect(store.linkChannel(chOther, { chatId, topicId: 42 })).rejects.toThrow(/already linked/);

    await store.unlinkChannel(chB, { chatId, topicId: 42 });
    expect(await store.linkedChannel(chatId, 42)).toMatchObject({ parlyChannelId: chA, chatId });

    const updateId = `900${n}`;
    expect(await store.keepEvent(updateId, { update_id: Number(updateId) })).toBe(true);
    expect(await store.keepEvent(updateId, { update_id: Number(updateId) })).toBe(false);
    expect(telegramLinkKey({ chatId, topicId: 42 })).toBe(`${chatId}:42`);
    expect(telegramKey({ chatId, messageId: 77 })).toBe(`${chatId}:77`);
  });

  it('throttles bot-minted /start link codes unless force is set (review #19)', async () => {
    const store = new TelegramStore(testDb());
    const now = Date.now();
    const first = await store.linkCode('tg-throttle-1', { name: 'A' }, false, now);
    expect(first).toBeTruthy();
    expect(await store.linkCode('tg-throttle-1', { name: 'A' }, false, now + 60_000)).toBeUndefined();
    expect(await store.linkCode('tg-throttle-1', { name: 'A' }, true, now + 60_000)).toBeTruthy();
  });

  it('verifies X-Telegram-Bot-Api-Secret-Token, relays inbound chat/topic updates to Parly, and fans out outbound posts to both Slack and Telegram', async () => {
    const db = testDb();
    const tgCalls: { url: string; body: Record<string, unknown> }[] = [];
    let tgMsgSeq = 500;
    const telegramFetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      tgCalls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: ++tgMsgSeq,
            ...(typeof body.message_thread_id === 'number' ? { message_thread_id: body.message_thread_id } : {}),
            chat: { id: body.chat_id },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { app, hub } = createApp({
      db,
      config: testConfig({
        credentialsKey: key,
        slack: { signingSecret: 'slack-sec' },
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
      telegramFetch,
    });

    const slackOutIds: string[] = [];
    if (hub.slack) {
      const origSlackOnPosted = hub.slack.onPosted.bind(hub.slack);
      hub.slack.onPosted = async (msg) => {
        slackOutIds.push(msg.id);
        return origSlackOnPosted(msg);
      };
    }

    const { owner, channel, members } = await crew(hub.registry, 'tg-relay');
    const [bot] = members;
    const chatId = `-100${Date.now()}`;
    await hub.telegram!.store.linkChannel(channel.id, { chatId });
    await hub.telegram!.store.linkIdentity('777001', owner.id);

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const postWebhook = async (body: unknown, secret?: string) =>
        fetch(`${baseUrl}/telegram/webhook`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(secret !== undefined ? { 'x-telegram-bot-api-secret-token': secret } : {}),
          },
          body: JSON.stringify(body),
        });

      // 1. Missing or wrong secret header is rejected with 401.
      const unauth = await postWebhook({ update_id: 1001, message: { message_id: 10, chat: { id: chatId }, text: 'nope' } });
      expect(unauth.status).toBe(401);
      const badSec = await postWebhook({ update_id: 1001, message: { message_id: 10, chat: { id: chatId }, text: 'nope' } }, 'wrong-secret');
      expect(badSec.status).toBe(401);
      expect((await hub.chat.page(owner, `channel:${channel.id}`, 10)).messages).toHaveLength(0);

      // 2. Signed webhook update in a group topic (`message_thread_id: 88`) relays into the linked Parly channel, and duplicate `update_id` is ignored.
      const u1 = {
        update_id: 1002,
        message: {
          message_id: 11,
          message_thread_id: 88,
          from: { id: 777001, first_name: 'Malachi' },
          chat: { id: chatId, type: 'supergroup' },
          text: 'Hello from Telegram topic 88!',
        },
      };
      const ok1 = await postWebhook(u1, WEBHOOK_SECRET);
      expect(ok1.status).toBe(200);
      await hub.telegram!.idle();
      // Duplicate delivery of update_id 1002 is deduplicated.
      await postWebhook(u1, WEBHOOK_SECRET);
      await hub.telegram!.idle();

      const posts = (await hub.chat.page(owner, `channel:${channel.id}`, 10)).messages;
      expect(posts).toHaveLength(1);
      expect(posts[0]!.parts[0]?.text).toBe('Hello from Telegram topic 88!');
      expect(posts[0]!.telegram).toEqual([{ chatId, messageId: 11, topicId: 88 }]);
      // Inbound message from Telegram is NOT echoed back to the same Telegram chat, while Slack still receives the fan-out!
      expect(tgCalls).toHaveLength(0);
      expect(slackOutIds).toContain(posts[0]!.id);

      // 3. Follow-up message in the same Telegram topic (`message_thread_id: 88`) maps to that Parly post's thread!
      const u2 = {
        update_id: 1003,
        message: {
          message_id: 12,
          message_thread_id: 88,
          from: { id: 999002, first_name: 'Alice', last_name: 'TG' },
          chat: { id: chatId, type: 'supergroup' },
          text: 'Second message in topic 88',
        },
      };
      await postWebhook(u2, WEBHOOK_SECRET);
      await hub.telegram!.idle();
      const threadMsgs = await hub.chat.readThread(owner, channel.id, posts[0]!.id);
      expect(threadMsgs.map((m) => ({ from: m.from, external: m.external, text: m.parts[0]?.text }))).toEqual([
        { from: owner.name, external: undefined, text: 'Hello from Telegram topic 88!' },
        { from: 'Alice TG', external: true, text: 'Second message in topic 88' },
      ]);

      // 4. Outbound Parly reply in that thread calls Telegram `sendMessage` with `chat_id`, `message_thread_id: 88`, `reply_to_message_id: 11`, `parse_mode: 'HTML'`, and bold sender header.
      const replyPosted = await hub.send(bot!, { channel: channel.id, thread: posts[0]!.id }, [{ text: 'Agent reply to topic 88' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]).toEqual({
        url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        body: {
          chat_id: chatId,
          text: `<b>${bot!.name}</b>\nAgent reply to topic 88`,
          parse_mode: 'HTML',
          message_thread_id: 88,
          reply_to_message_id: 11,
        },
      });
      expect(slackOutIds).toContain(replyPosted.message.id);
      const updatedReply = await hub.telegram!.store.message(replyPosted.message.id);
      expect(updatedReply?.telegram).toEqual([{ chatId, messageId: 501, topicId: 88 }]);

      // 5. In a topic-linked channel, a normal topic post carries `reply_to_message.message_id === message_thread_id`
      // and must NOT be threaded as a reply; only `reply_to_message.message_id !== message_thread_id` threads as a reply.
      const topicChannel = await hub.registry.createChannel(owner, channel.workspaceId, 'topic-only');
      await hub.telegram!.store.linkChannel(topicChannel.id, { chatId, topicId: 42 });
      await postWebhook(
        {
          update_id: 1004,
          message: {
            message_id: 21,
            message_thread_id: 42,
            reply_to_message: { message_id: 42 },
            from: { id: 777001, first_name: 'Malachi' },
            chat: { id: chatId, type: 'supergroup' },
            text: 'First top-level post in topic 42',
          },
        },
        WEBHOOK_SECRET,
      );
      await hub.telegram!.idle();
      await postWebhook(
        {
          update_id: 1005,
          message: {
            message_id: 22,
            message_thread_id: 42,
            reply_to_message: { message_id: 42 },
            from: { id: 777001, first_name: 'Malachi' },
            chat: { id: chatId, type: 'supergroup' },
            text: 'Second top-level post in topic 42 (not a thread reply)',
          },
        },
        WEBHOOK_SECRET,
      );
      await hub.telegram!.idle();
      const topicPosts = (await hub.chat.page(owner, `channel:${topicChannel.id}`, 10)).messages;
      expect(topicPosts.map((m) => m.parts[0]?.text)).toEqual([
        'First top-level post in topic 42',
        'Second top-level post in topic 42 (not a thread reply)',
      ]);
      // Replying to message 21 (`reply_to_message.message_id: 21 !== 42`) DOES thread under post 21.
      await postWebhook(
        {
          update_id: 1006,
          message: {
            message_id: 23,
            message_thread_id: 42,
            reply_to_message: { message_id: 21, message_thread_id: 42 },
            from: { id: 777001, first_name: 'Malachi' },
            chat: { id: chatId, type: 'supergroup' },
            text: 'Actual reply to message 21 in topic 42',
          },
        },
        WEBHOOK_SECRET,
      );
      await hub.telegram!.idle();
      const topicThread = await hub.chat.readThread(owner, topicChannel.id, topicPosts[0]!.id);
      expect(topicThread.map((m) => m.parts[0]?.text)).toEqual([
        'First top-level post in topic 42',
        'Actual reply to message 21 in topic 42',
      ]);
    } finally {
      server.close();
    }
  });

  it('links/unlinks via POST/DELETE /channels/:id/telegram, surfaces telegram in channelView/whoami, and auto-links new forum topics', async () => {
    const db = testDb();
    const tgCalls: { url: string; body: Record<string, unknown> }[] = [];
    let tgMsgSeq = 900;
    const telegramFetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      tgCalls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: ++tgMsgSeq, chat: { id: body.chat_id } },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { app, hub } = createApp({
      db,
      config: testConfig({
        credentialsKey: key,
        googleAuthDev: true,
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
      telegramFetch,
    });

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const signIn = async (email: string) => {
        const res = await fetch(`${baseUrl}/auth/google`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken: `dev:${email}` }),
        });
        return (await res.json()) as { token: string; agent: { id: string; workspaces: string[] } };
      };

      const ownerAuth = await signIn('owner-tg2@people.test');
      const owner = (await hub.registry.get(ownerAuth.agent.id))!;
      const wsId = owner.workspaces![0]!;
      await hub.registry.inviteToWorkspace(owner, wsId, 'member-tg2@people.test');
      const memberAuth = await signIn('member-tg2@people.test');
      const member = (await hub.registry.get(memberAuth.agent.id))!;
      const devChannel = await hub.registry.createChannel(owner, wsId, 'Parly dev');
      await hub.registry.addToChannel(owner, devChannel.id, member.id);

      const chatId = `-100998877${Date.now()}`;

      // Non-owner cannot link a Telegram chat.
      const forbiddenRes = await fetch(`${baseUrl}/channels/${devChannel.id}/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${memberAuth.token}` },
        body: JSON.stringify({ chatId, topicId: 10 }),
      });
      expect(forbiddenRes.status).toBe(403);

      // Owner links `Parly dev` ↔ `(chatId, topicId: 10)` via REST.
      const linkRes = await fetch(`${baseUrl}/channels/${devChannel.id}/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ chatId, topicId: 10 }),
      });
      expect(linkRes.status).toBe(200);
      expect(await linkRes.json()).toEqual({ telegram: [{ chatId, topicId: 10 }] });

      // GET /me (whoami presentation) includes `telegram` on the channel.
      const meRes = await fetch(`${baseUrl}/me`, {
        headers: { authorization: `Bearer ${ownerAuth.token}` },
      });
      const meBody = (await meRes.json()) as { workspaces: { id: string; channels: { id: string; telegram?: unknown[] }[] }[] };
      const wsView = meBody.workspaces.find((w) => w.id === wsId)!;
      expect(wsView.channels.find((c) => c.id === devChannel.id)?.telegram).toEqual([{ chatId, topicId: 10 }]);

      // Creating a new forum topic (`forum_topic_created: { name: "Parly marketing" }`, `message_thread_id: 25`) in the same supergroup
      // auto-creates and links the `#Parly marketing` channel in `wsId` and relays messages into it.
      const postWebhook = async (body: unknown) =>
        fetch(`${baseUrl}/telegram/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
          body: JSON.stringify(body),
        });

      await postWebhook({
        update_id: 2001,
        message: {
          message_id: 25,
          message_thread_id: 25,
          from: { id: 888111, first_name: 'Malachi' },
          chat: { id: chatId, type: 'supergroup', title: 'Parly' },
          forum_topic_created: { name: 'Parly marketing' },
        },
      });
      await hub.telegram!.idle();

      const freshOwner = (await hub.registry.get(owner.id))!;
      const allChannels = await hub.registry.channelsOf(freshOwner, wsId);
      const marketingCh = allChannels.find((c) => c.name === 'Parly marketing');
      expect(marketingCh).toBeDefined();
      expect(marketingCh?.telegram).toEqual([{ chatId, topicId: 25 }]);
      expect(tgCalls.at(-1)?.body).toMatchObject({
        chat_id: chatId,
        message_thread_id: 25,
        text: expect.stringContaining('This topic is now linked to #Parly marketing on Parly'),
      });

      // Subsequent message in topic 25 relays into `#Parly marketing`.
      await postWebhook({
        update_id: 2002,
        message: {
          message_id: 26,
          message_thread_id: 25,
          reply_to_message: { message_id: 25 },
          from: { id: 888111, first_name: 'Malachi' },
          chat: { id: chatId, type: 'supergroup', title: 'Parly' },
          text: 'Launch video ready for Reddit!',
        },
      });
      await hub.telegram!.idle();
      const mktPosts = (await hub.chat.page(freshOwner, `channel:${marketingCh!.id}`, 10)).messages;
      expect(mktPosts.map((m) => m.parts[0]?.text)).toEqual(['Launch video ready for Reddit!']);

      // Near-simultaneous events in a brand-new topic (`forum_topic_created` + first message) race in `autoLink`:
      // both return the winning link, leave one active channel, and post only one Telegram notice.
      const callsBeforeRace = tgCalls.length;
      const [raceA, raceB] = await Promise.all([
        hub.telegram!.autoLink(chatId, 77, 'Parly ops'),
        hub.telegram!.autoLink(chatId, 77, 'Parly ops'),
      ]);
      expect(raceA).toBeDefined();
      expect(raceB).toBeDefined();
      expect(raceA!.parlyChannelId).toBe(raceB!.parlyChannelId);

      const ownerAfterRace = (await hub.registry.get(owner.id))!;
      const opsChannels = (await hub.registry.channelsOf(ownerAfterRace, wsId)).filter((c) => c.name === 'Parly ops');
      const activeOps = opsChannels.filter((c) => !c.archived);
      expect(activeOps).toHaveLength(1);
      expect(activeOps[0]!.id).toBe(raceA!.parlyChannelId);
      expect(activeOps[0]!.telegram).toEqual([{ chatId, topicId: 77 }]);
      const linkedNotices = tgCalls
        .slice(callsBeforeRace)
        .filter((c) => String(c.body.text ?? '').includes('This topic is now linked to #Parly ops on Parly'));
      expect(linkedNotices).toHaveLength(1);

      // Cross-instance `linkChannel` conflict when `autoLink` created a new channel (`created === true`):
      // if another instance links the topic while `createChannel` is in flight, `autoLink` catches the conflict,
      // archives its newly created orphan channel, skips the duplicate notice, and returns the winning link.
      const winnerCh = await hub.registry.createChannel(ownerAfterRace, wsId, 'Parly sec winner');
      const origCreateChannel = hub.registry.createChannel.bind(hub.registry);
      hub.registry.createChannel = async (...args) => {
        const created = await origCreateChannel(...args);
        await hub.telegram!.store.linkChannel(winnerCh.id, { chatId, topicId: 78 });
        return created;
      };
      let conflictResult: Awaited<ReturnType<NonNullable<typeof hub.telegram>['autoLink']>>;
      try {
        conflictResult = await hub.telegram!.autoLink(chatId, 78, 'Parly sec orphan');
      } finally {
        hub.registry.createChannel = origCreateChannel;
      }
      expect(conflictResult?.parlyChannelId).toBe(winnerCh.id);
      const ownerAfterConflict = (await hub.registry.get(owner.id))!;
      const orphanCh = (await hub.registry.channelsOf(ownerAfterConflict, wsId)).find((c) => c.name === 'Parly sec orphan');
      expect(orphanCh).toBeDefined();
      expect(orphanCh!.archived).toBe(true);

      // When a pre-existing unlinked channel matches by name (`created === false`) and loses a `linkChannel` race,
      // `autoLink` must NOT archive the pre-existing channel.
      const preExisting = await hub.registry.createChannel(ownerAfterConflict, wsId, 'Parly design');
      const designWinner = await hub.registry.createChannel(ownerAfterConflict, wsId, 'Parly design winner');
      const origChannelsOf = hub.registry.channelsOf.bind(hub.registry);
      hub.registry.channelsOf = async (...args) => {
        const list = await origChannelsOf(...args);
        await hub.telegram!.store.linkChannel(designWinner.id, { chatId, topicId: 88 });
        return list;
      };
      let existingConflictResult: Awaited<ReturnType<NonNullable<typeof hub.telegram>['autoLink']>>;
      try {
        existingConflictResult = await hub.telegram!.autoLink(chatId, 88, 'Parly design');
      } finally {
        hub.registry.channelsOf = origChannelsOf;
      }
      expect(existingConflictResult?.parlyChannelId).toBe(designWinner.id);
      const refreshedDesign = (await hub.registry.channelsById([preExisting.id])).get(preExisting.id)!;
      expect(refreshedDesign.archived).toBeFalsy();

      // DELETE /channels/:id/telegram unlinks the channel.
      const unlinkRes = await fetch(`${baseUrl}/channels/${devChannel.id}/telegram`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ chatId, topicId: 10 }),
      });
      expect(unlinkRes.status).toBe(200);
      expect(await unlinkRes.json()).toEqual({ telegram: [] });
    } finally {
      server.close();
    }
  });

  it('auto-creates a Telegram forum topic per Parly thread, relays thread ↔ topic both ways, coalesces concurrent first replies, and falls back when createForumTopic fails', async () => {
    const db = testDb();
    const tgCalls: { method: string; body: Record<string, unknown> }[] = [];
    let tgMsgSeq = 1200;
    let tgTopicSeq = 300;
    let failCreateForumTopic = false;
    let onCreateForumTopic: ((topicId: number, body: Record<string, unknown>) => Promise<void>) | undefined;

    const telegramFetch = (async (url: string, init?: RequestInit) => {
      const method = String(url).split('/').pop() ?? '';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      tgCalls.push({ method, body });

      if (method === 'createForumTopic') {
        if (failCreateForumTopic) {
          return new Response(
            JSON.stringify({ ok: false, description: 'Bad Request: not enough rights to manage chat topics' }),
            { status: 400 },
          );
        }
        const topicId = ++tgTopicSeq;
        if (onCreateForumTopic) await onCreateForumTopic(topicId, body);
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_thread_id: topicId, name: String(body.name ?? ''), icon_color: 7322096 },
          }),
          { status: 200 },
        );
      }

      if (method === 'deleteForumTopic') {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: ++tgMsgSeq,
            ...(typeof body.message_thread_id === 'number' ? { message_thread_id: body.message_thread_id } : {}),
            chat: { id: body.chat_id },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { app, hub } = createApp({
      db,
      config: testConfig({
        credentialsKey: key,
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
      telegramFetch,
    });

    const { owner, channel, members } = await crew(hub.registry, 'tg-thread-topics');
    const [botA, botB] = members;
    const chatId = `-100554433${Date.now()}`;
    await hub.telegram!.store.linkChannel(channel.id, { chatId, topicId: 10 });
    await hub.telegram!.store.saveChat(chatId, { workspaceId: channel.workspaceId, title: 'Parly Forum' });
    await hub.telegram!.store.linkIdentity('888777', owner.id);

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const postWebhook = async (body: unknown) =>
        fetch(`${baseUrl}/telegram/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
          body: JSON.stringify(body),
        });

      // 1. Top-level post goes to the channel's own topic (10) without creating a new forum topic.
      const root = await hub.send(owner, { channel: channel.id }, [{ text: 'Ship auto Telegram topic per Parly thread' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          method: 'sendMessage',
          body: {
            chat_id: chatId,
            message_thread_id: 10,
            text: `<b>${owner.name}</b>\nShip auto Telegram topic per Parly thread`,
            parse_mode: 'HTML',
          },
        },
      ]);

      // 2. First reply in `root`'s thread creates a dedicated Telegram topic (301) named `<channel.name>: <root>`, links it with `threadId`,
      // and sends the reply into topic 301.
      tgCalls.length = 0;
      await hub.send(botA!, { channel: channel.id, thread: root.message.id }, [{ text: 'Taking it! Opening PR now.' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          method: 'createForumTopic',
          body: {
            chat_id: chatId,
            name: `${channel.name}: Ship auto Telegram topic per Parly thread`,
          },
        },
        {
          method: 'sendMessage',
          body: {
            chat_id: chatId,
            message_thread_id: 301,
            text: `<b>${botA!.name}</b>\nTaking it! Opening PR now.`,
            parse_mode: 'HTML',
          },
        },
      ]);

      const chAfterThread = (await hub.registry.channelsById([channel.id])).get(channel.id)!;
      expect(chAfterThread.telegram).toEqual([
        { chatId, topicId: 10 },
        { chatId, topicId: 301, threadId: root.message.id },
      ]);

      // 3. Second outbound reply in the same thread reuses topic 301 without calling `createForumTopic` again.
      tgCalls.length = 0;
      await hub.send(botB!, { channel: channel.id, thread: root.message.id }, [{ text: 'LGTM, reviewed the diff.' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          method: 'sendMessage',
          body: {
            chat_id: chatId,
            message_thread_id: 301,
            text: `<b>${botB!.name}</b>\nLGTM, reviewed the diff.`,
            parse_mode: 'HTML',
          },
        },
      ]);

      // 4. Inbound message in topic 301 lands in Parly thread `root.message.id` (not top-level, and does not auto-create a channel).
      tgCalls.length = 0;
      await postWebhook({
        update_id: 3001,
        message: {
          message_id: 40,
          message_thread_id: 301,
          reply_to_message: {
            message_id: 301,
            forum_topic_created: { name: 'Ship auto Telegram topic per Parly thread' },
          },
          from: { id: 888777, first_name: 'Malachi' },
          chat: { id: chatId, type: 'supergroup', title: 'Parly Forum' },
          text: 'Merged and deployed from Telegram!',
        },
      });
      await hub.telegram!.idle();
      expect(tgCalls).toHaveLength(0);

      const threadMsgs = await hub.chat.readThread(owner, channel.id, root.message.id);
      expect(threadMsgs.map((m) => m.parts[0]?.text)).toEqual([
        'Ship auto Telegram topic per Parly thread',
        'Taking it! Opening PR now.',
        'LGTM, reviewed the diff.',
        'Merged and deployed from Telegram!',
      ]);

      // Top-level post in the channel still goes to the channel's own topic (10), NOT topic 301.
      tgCalls.length = 0;
      await hub.send(owner, { channel: channel.id }, [{ text: 'Unrelated top-level announcement' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          method: 'sendMessage',
          body: {
            chat_id: chatId,
            message_thread_id: 10,
            text: `<b>${owner.name}</b>\nUnrelated top-level announcement`,
            parse_mode: 'HTML',
          },
        },
      ]);

      // 5. Long root text is trimmed to 128 chars; empty/data-only root text falls back to "<channel.name>: Thread".
      const longTitle = 'A'.repeat(160);
      const longRoot = await hub.send(owner, { channel: channel.id }, [{ text: longTitle }]);
      const dataOnlyRoot = await hub.send(owner, { channel: channel.id }, [{ data: { kind: 'metric' } }]);
      await hub.telegram!.idle();
      tgCalls.length = 0;
      await hub.send(botA!, { channel: channel.id, thread: longRoot.message.id }, [{ text: 'Reply on long root' }]);
      await hub.send(botA!, { channel: channel.id, thread: dataOnlyRoot.message.id }, [{ text: 'Reply on data root' }]);
      await hub.telegram!.idle();
      const createdNames = tgCalls.filter((c) => c.method === 'createForumTopic').map((c) => c.body.name);
      expect(createdNames).toEqual([`${channel.name}: ${longTitle}`.slice(0, 128), `${channel.name}: Thread`]);

      // 6. Concurrent first-messages in a new thread coalesce in-process: `createForumTopic` runs once and both land in that topic.
      const raceRoot = await hub.send(owner, { channel: channel.id }, [{ text: 'Concurrent thread race' }]);
      await hub.telegram!.idle();
      tgCalls.length = 0;
      await Promise.all([
        hub.send(botA!, { channel: channel.id, thread: raceRoot.message.id }, [{ text: 'Concurrent reply 1' }]),
        hub.send(botB!, { channel: channel.id, thread: raceRoot.message.id }, [{ text: 'Concurrent reply 2' }]),
      ]);
      await hub.telegram!.idle();
      const raceTopicCreates = tgCalls.filter((c) => c.method === 'createForumTopic');
      expect(raceTopicCreates).toHaveLength(1);
      expect(raceTopicCreates[0]!.body).toEqual({ chat_id: chatId, name: `${channel.name}: Concurrent thread race` });
      const raceSendThreads = tgCalls.filter((c) => c.method === 'sendMessage').map((c) => c.body.message_thread_id);
      expect(raceSendThreads).toEqual([304, 304]);

      // 7. Cross-instance conflict recovery: if another instance links a topic for the same thread while `createForumTopic` is in flight,
      // `ensureThreadTopic` deletes the orphan topic and returns the winning link.
      const conflictRoot = await hub.send(owner, { channel: channel.id }, [{ text: 'Cross-instance thread race' }]);
      await hub.telegram!.idle();
      tgCalls.length = 0;
      onCreateForumTopic = async () => {
        await hub.telegram!.store.linkChannel(channel.id, {
          chatId,
          topicId: 777,
          threadId: conflictRoot.message.id,
        });
      };
      try {
        await hub.send(botA!, { channel: channel.id, thread: conflictRoot.message.id }, [{ text: 'Reply after conflict' }]);
        await hub.telegram!.idle();
      } finally {
        onCreateForumTopic = undefined;
      }
      expect(tgCalls.find((c) => c.method === 'deleteForumTopic')?.body).toEqual({
        chat_id: chatId,
        message_thread_id: 305,
      });
      expect(tgCalls.find((c) => c.method === 'sendMessage')?.body).toMatchObject({
        chat_id: chatId,
        message_thread_id: 777,
        text: `<b>${botA!.name}</b>\nReply after conflict`,
        parse_mode: 'HTML',
      });

      // 8. Fallback when `createForumTopic` fails (e.g. bot lacks Manage Topics permission):
      // catches the error and relays the reply inside the channel's topic (10) as a reply to the root message copy.
      const fallbackRoot = await hub.send(owner, { channel: channel.id }, [{ text: 'Thread when createForumTopic fails' }]);
      await hub.telegram!.idle();
      const fallbackRootDoc = await hub.telegram!.store.message(fallbackRoot.message.id);
      const fallbackRootTgId = fallbackRootDoc?.telegram?.[0]?.messageId;
      expect(typeof fallbackRootTgId).toBe('number');

      tgCalls.length = 0;
      failCreateForumTopic = true;
      await hub.send(botA!, { channel: channel.id, thread: fallbackRoot.message.id }, [{ text: 'Still delivered via fallback!' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          method: 'createForumTopic',
          body: {
            chat_id: chatId,
            name: `${channel.name}: Thread when createForumTopic fails`,
          },
        },
        {
          method: 'sendMessage',
          body: {
            chat_id: chatId,
            message_thread_id: 10,
            reply_to_message_id: fallbackRootTgId,
            text: `<b>${botA!.name}</b>\nStill delivered via fallback!`,
            parse_mode: 'HTML',
          },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('Connect Telegram web UI + REST link parser: validates chatId/topicId or pasted t.me links and renders owner-only ChannelPanel controls', async () => {
    const db = testDb();
    const { app, hub } = createApp({
      db,
      config: testConfig({
        credentialsKey: key,
        googleAuthDev: true,
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
    });

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const signIn = async (email: string) => {
        const res = await fetch(`${baseUrl}/auth/google`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken: `dev:${email}` }),
        });
        return (await res.json()) as { token: string; agent: { id: string; workspaces: string[] } };
      };

      const ownerAuth = await signIn('owner-tgui@people.test');
      const owner = (await hub.registry.get(ownerAuth.agent.id))!;
      const wsId = owner.workspaces![0]!;
      await hub.registry.inviteToWorkspace(owner, wsId, 'member-tgui@people.test');
      const memberAuth = await signIn('member-tgui@people.test');
      const member = (await hub.registry.get(memberAuth.agent.id))!;
      const ch = await hub.registry.createChannel(owner, wsId, 'tg-ui-channel');
      await hub.registry.addToChannel(owner, ch.id, member.id);

      const postTg = (token: string, body: Record<string, unknown>) =>
        fetch(`${baseUrl}/channels/${ch.id}/telegram`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      const delTg = (token: string, body: Record<string, unknown>) =>
        fetch(`${baseUrl}/channels/${ch.id}/telegram`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

      // 1. Rejects invalid chatId or invite links with 400, and non-owners with 403.
      expect((await postTg(ownerAuth.token, { chatId: 'not a valid chat id' })).status).toBe(400);
      expect((await postTg(ownerAuth.token, { chatId: 'https://t.me/+inviteHash123' })).status).toBe(400);
      expect((await postTg(ownerAuth.token, { chatId: '-100123456', topicId: 'abc' })).status).toBe(400);
      expect((await postTg(memberAuth.token, { chatId: 'https://t.me/c/1234567890/42' })).status).toBe(403);

      // 2. Accepts a pasted private group topic URL (`https://t.me/c/<internalId>/<topicId>`) and normalizes to `-100<internalId>` + `topicId`.
      const pastedPrivate = await postTg(ownerAuth.token, { chatId: 'https://t.me/c/1234567890/42/99' });
      expect(pastedPrivate.status).toBe(200);
      expect(await pastedPrivate.json()).toEqual({
        telegram: [{ chatId: '-1001234567890', topicId: 42 }],
      });

      // 3. Accepts a pasted public group topic URL (`https://t.me/<group>/<topicId>`).
      const pastedPublic = await postTg(ownerAuth.token, { chatId: 'https://t.me/parly_community/15' });
      expect(pastedPublic.status).toBe(200);
      expect(await pastedPublic.json()).toEqual({
        telegram: [
          { chatId: '-1001234567890', topicId: 42 },
          { chatId: '@parly_community', topicId: 15 },
        ],
      });

      // 4. Unlinks one link via chatId + topicId and reflects the remaining link.
      const unlinkedOne = await delTg(ownerAuth.token, { chatId: '@parly_community', topicId: 15 });
      expect(unlinkedOne.status).toBe(200);
      expect(await unlinkedOne.json()).toEqual({
        telegram: [{ chatId: '-1001234567890', topicId: 42 }],
      });

      // 5. Verify workspace-level Telegram status/connect/disconnect (`GET/POST/DELETE /workspaces/:id/telegram`),
      // omitted `chatId` resolution on `POST /channels/:id/telegram`, `parseTelegramLinkInput`, and UI separation
      // (`WorkspacePanel.tsx` Integrations vs. `ChannelPanel.tsx` lightweight topic link + status badge).
      const wsConnectRes = await fetch(`${baseUrl}/workspaces/${ch.workspaceId}/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ chatId: 'https://t.me/c/555666777', title: 'Parly Supergroup' }),
      });
      expect(wsConnectRes.status).toBe(200);
      const wsStatus1 = (await wsConnectRes.json()) as {
        configured: boolean;
        canManage: boolean;
        chats: Array<{ chatId: string; title?: string }>;
        links: Array<{ channelId: string; channelName: string; chatId: string; topicId?: number }>;
      };
      expect(wsStatus1.configured).toBe(true);
      expect(wsStatus1.canManage).toBe(true);
      expect(wsStatus1.chats[0]).toEqual(expect.objectContaining({ chatId: '-100555666777', title: 'Parly Supergroup' }));

      // Channel topic link with omitted chatId automatically uses the workspace's connected Telegram supergroup.
      await delTg(ownerAuth.token, {});
      const topicOnlyRes = await postTg(ownerAuth.token, { topicId: 88 });
      expect(topicOnlyRes.status).toBe(200);
      expect(await topicOnlyRes.json()).toEqual({
        telegram: [{ chatId: '-100555666777', topicId: 88 }],
      });

      const wsGetRes = await fetch(`${baseUrl}/workspaces/${ch.workspaceId}/telegram`, {
        headers: { authorization: `Bearer ${ownerAuth.token}` },
      });
      expect(wsGetRes.status).toBe(200);
      const wsStatus2 = (await wsGetRes.json()) as typeof wsStatus1;
      expect(wsStatus2.links).toEqual([
        { channelId: ch.id, channelName: ch.name, chatId: '-100555666777', topicId: 88 },
      ]);

      const wsDisconnectRes = await fetch(`${baseUrl}/workspaces/${ch.workspaceId}/telegram`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ chatId: '-100555666777' }),
      });
      expect(wsDisconnectRes.status).toBe(200);
      const wsStatus3 = (await wsDisconnectRes.json()) as typeof wsStatus1;
      expect(wsStatus3.chats.map((c) => c.chatId)).not.toContain('-100555666777');
      expect(wsStatus3.links).toEqual([]);

      const { parseTelegramLinkInput } = await import('../src/telegram/bridge.js');
      expect(parseTelegramLinkInput({ chatId: 'https://t.me/c/9876543210/77' })).toEqual({
        chatId: '-1009876543210',
        topicId: 77,
      });
      expect(parseTelegramLinkInput({ chatId: 'https://t.me/c/9876543210' })).toEqual({
        chatId: '-1009876543210',
      });
      expect(parseTelegramLinkInput({ chatId: '-1009876543210:12' })).toEqual({
        chatId: '-1009876543210',
        topicId: 12,
      });

      const { readFileSync } = await import('node:fs');
      const panelSrc = readFileSync(new URL('../web/components/ChannelPanel.tsx', import.meta.url), 'utf8');
      const wsPanelSrc = readFileSync(new URL('../web/components/WorkspacePanel.tsx', import.meta.url), 'utf8');
      expect(wsPanelSrc).toContain('Integrations');
      expect(wsPanelSrc).toContain('WorkspaceTelegramSection');
      expect(wsPanelSrc).toContain('@ParlyBot');
      expect(wsPanelSrc).toContain('Topics');
      expect(wsPanelSrc).toContain('connectWorkspaceTelegram');
      expect(wsPanelSrc).toContain('Channel ↔ Topic mappings');
      expect(panelSrc).toContain('TelegramChannelSection');
      expect(panelSrc).toContain('if (!channel.owner) return null;');
      expect(panelSrc).toContain('Bridged to Telegram');
      expect(panelSrc).toContain('Manage in Workspace Settings');
      expect(panelSrc).toContain('linkChannelTelegram');
      expect(panelSrc).toContain('unlinkChannelTelegram');

      // 6. Verify ChannelPanel tab separation:
      // - `skillsTab` (`id: 'skills'`) holds `SkillsSection`
      // - `automationsTab` (`id: 'automations'`) holds `Scheduled messages` & `Incoming webhooks` (not Skills, Slack, or Telegram)
      // - `settingsTab` (`id: 'settings'`) holds `SlackChannelSection` & `TelegramChannelSection`
      const skillsIdx = panelSrc.indexOf('const skillsTab =');
      const autoIdx = panelSrc.indexOf('const automationsTab =');
      const settingsIdx = panelSrc.indexOf('const settingsTab =');
      const customActiveIdx = panelSrc.indexOf('const customActiveSkills =');
      expect(skillsIdx).toBeGreaterThan(0);
      expect(autoIdx).toBeGreaterThan(skillsIdx);
      expect(settingsIdx).toBeGreaterThan(autoIdx);
      expect(customActiveIdx).toBeGreaterThan(settingsIdx);

      const skillsBlock = panelSrc.slice(skillsIdx, autoIdx);
      const autoBlock = panelSrc.slice(autoIdx, settingsIdx);
      const settingsBlock = panelSrc.slice(settingsIdx, customActiveIdx);

      expect(skillsBlock).toContain('<SkillsSection');
      expect(autoBlock).not.toContain('<SkillsSection');
      expect(autoBlock).not.toContain('<SlackChannelSection');
      expect(autoBlock).not.toContain('<TelegramChannelSection');
      expect(autoBlock).toContain('Scheduled messages');
      expect(autoBlock).toContain('Incoming webhooks');
      expect(settingsBlock).toContain('<SlackChannelSection');
      expect(settingsBlock).toContain('<TelegramChannelSection');
      expect(panelSrc).toContain("{ id: 'skills', label: 'Skills', badge: customActiveSkills, content: skillsTab }");
      expect(panelSrc).toContain('const automations = schedules.length + webhooks.length;');
    } finally {
      server.close();
    }
  });

  it('Telegram user → Parly identity mapping: links via web-generated /start <code> or bot link code, and posts inbound messages as the linked Parly agent (real name + avatar) instead of synthetic telegram:<id>', async () => {
    const db = testDb();
    const tgCalls: { method: string; body: Record<string, unknown> }[] = [];
    let tgMsgSeq = 2000;
    const telegramFetch = (async (url: string, init?: RequestInit) => {
      const method = String(url).split('/').pop() ?? '';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      tgCalls.push({ method, body });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: ++tgMsgSeq,
            ...(typeof body.message_thread_id === 'number' ? { message_thread_id: body.message_thread_id } : {}),
            chat: { id: body.chat_id },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { app, hub } = createApp({
      db,
      config: testConfig({
        credentialsKey: key,
        googleAuthDev: true,
        webUrl: 'https://parly.test',
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
      telegramFetch,
    });

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const signIn = async (email: string) => {
        const res = await fetch(`${baseUrl}/auth/google`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken: `dev:${email}` }),
        });
        return (await res.json()) as { token: string; agent: { id: string; name: string; avatar?: string; workspaces: string[] } };
      };
      const postWebhook = async (body: unknown) =>
        fetch(`${baseUrl}/telegram/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
          body: JSON.stringify(body),
        });

      const ownerAuth = await signIn('owner-tgid@people.test');
      const owner = (await hub.registry.get(ownerAuth.agent.id))!;
      const wsId = owner.workspaces![0]!;
      await hub.registry.inviteToWorkspace(owner, wsId, 'dana-tgid@people.test');
      const danaAuth = await signIn('dana-tgid@people.test');
      const danaInitial = (await hub.registry.get(danaAuth.agent.id))!;
      await hub.registry.register({ name: 'Dana Scully' }, danaInitial);
      await hub.registry.newAvatar(danaInitial, 'avatar-dana-seed-99');
      const dana = (await hub.registry.get(danaAuth.agent.id))!;

      const channel = await hub.registry.createChannel(owner, wsId, 'tg-identity-ch');
      await hub.registry.updateChannel(owner, channel.id, { publicFromSeq: 0 });
      const { agent: bot } = await hub.registry.createBot(owner, { name: `helper-${Date.now()}`, follow: true });
      await hub.registry.addToWorkspace(owner, wsId, bot.id);
      await hub.registry.addToChannel(owner, channel.id, bot.id);

      const chatId = `-100445566${Date.now()}`;
      await hub.telegram!.store.linkChannel(channel.id, { chatId });

      // 1. Before linking: Dana (Telegram user 555111) posts in the group and @mentions the bot.
      await postWebhook({
        update_id: 4001,
        message: {
          message_id: 1,
          from: { id: 555111, first_name: 'TgDana', username: 'dana_tg' },
          chat: { id: chatId, type: 'supergroup' },
          text: `hello @${bot.name}`,
        },
      });
      await hub.telegram!.idle();

      const beforeMsgs = (await hub.chat.page(owner, `channel:${channel.id}`, 10)).messages;
      expect(beforeMsgs).toHaveLength(1);
      expect(beforeMsgs[0]).toMatchObject({
        from: 'TgDana',
        fromId: 'telegram:555111',
        external: true,
      });
      const refreshedBot = (await hub.registry.get(bot.id))!;
      expect(await hub.chat.take(refreshedBot)).toHaveLength(0);

      // 2. Flow A (web-generated one-time code confirmed via bot DM `/start <code>`):
      const codeRes = await fetch(`${baseUrl}/telegram/link/code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${danaAuth.token}` },
      });
      expect(codeRes.status).toBe(200);
      const { code, command } = (await codeRes.json()) as { code: string; command: string };
      expect(command).toBe(`/start ${code}`);

      // `/start <code>` in a group is refused and burns the leaked code (review #7).
      tgCalls.length = 0;
      await postWebhook({
        update_id: 4010,
        message: {
          message_id: 10,
          from: { id: 555333, first_name: 'Lurker' },
          chat: { id: chatId, type: 'supergroup' },
          text: `/start ${code}`,
        },
      });
      await hub.telegram!.idle();
      expect(await hub.telegram!.store.identity('555333')).toBeUndefined();
      expect(tgCalls).toHaveLength(1);
      expect(String(tgCalls[0]!.body.text)).toContain('private chat');

      // A group member replaying the leaked code in a DM can't link to Dana.
      tgCalls.length = 0;
      await postWebhook({
        update_id: 4011,
        message: {
          message_id: 11,
          from: { id: 555333, first_name: 'Lurker' },
          chat: { id: 555333, type: 'private' },
          text: `/start ${code}`,
        },
      });
      await hub.telegram!.idle();
      expect(await hub.telegram!.store.identity('555333')).toBeUndefined();
      expect(String(tgCalls[0]!.body.text)).toContain('expired');

      // Dana generates a fresh code and links in private.
      const freshRes = await fetch(`${baseUrl}/telegram/link/code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${danaAuth.token}` },
      });
      expect(freshRes.status).toBe(200);
      const { code: freshCode } = (await freshRes.json()) as { code: string };

      tgCalls.length = 0;
      await postWebhook({
        update_id: 4002,
        message: {
          message_id: 2,
          from: { id: 555111, first_name: 'TgDana', username: 'dana_tg' },
          chat: { id: 555111, type: 'private' },
          text: `/start ${freshCode}`,
        },
      });
      await hub.telegram!.idle();

      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]!.body).toMatchObject({
        chat_id: '555111',
        text: expect.stringContaining('Dana Scully'),
      });
      expect((await hub.telegram!.store.identity('555111'))?.agentId).toBe(dana.id);

      // Code is single-use: replaying `/start <code>` from another Telegram user fails to link.
      await postWebhook({
        update_id: 4003,
        message: {
          message_id: 3,
          from: { id: 555222, first_name: 'Intruder' },
          chat: { id: 555222, type: 'private' },
          text: `/start ${freshCode}`,
        },
      });
      await hub.telegram!.idle();
      expect(await hub.telegram!.store.identity('555222')).toBeUndefined();

      // 3. After linking: Dana writes in the linked Telegram group (even though she wasn't explicitly added to `channel.id` beforehand!).
      // Her message posts as her real Parly agent (`from: "Dana Scully"`, `fromId: dana.id`, `external: undefined`),
      // wakes the mentioned bot, and surfaces her real Parly name + avatar in `publicPeople`.
      await postWebhook({
        update_id: 4004,
        message: {
          message_id: 4,
          from: { id: 555111, first_name: 'TgDana', username: 'dana_tg' },
          chat: { id: chatId, type: 'supergroup' },
          text: `now linked @${bot.name} please check`,
        },
      });
      await hub.telegram!.idle();

      const afterMsgs = (await hub.chat.page(owner, `channel:${channel.id}`, 10)).messages;
      expect(afterMsgs).toHaveLength(2);
      expect(afterMsgs[1]).toMatchObject({
        from: 'Dana Scully',
        fromId: dana.id,
      });
      expect(afterMsgs[1]!.external).toBeUndefined();

      const pubRes = await fetch(`${baseUrl}/public/channels/${channel.id}`);
      const pubBody = (await pubRes.json()) as { people: Record<string, { id: string; name: string; avatar?: string }> };
      expect(pubBody.people[dana.id]).toMatchObject({
        id: dana.id,
        name: 'Dana Scully',
        avatar: 'avatar-dana-seed-99',
      });

      const inbox = await hub.inboxView(refreshedBot, await hub.chat.take(refreshedBot));
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        from: 'Dana Scully',
        fromId: dana.id,
        text: `now linked @${bot.name} please check`,
      });

      // 4. Flow B (bot DM `/start` -> `GET /telegram/link?code=` inspect -> `POST /telegram/link` approve, plus `GET/DELETE /me/telegram`):
      const myTgRes = await fetch(`${baseUrl}/me/telegram`, {
        headers: { authorization: `Bearer ${danaAuth.token}` },
      });
      expect(myTgRes.status).toBe(200);
      expect(await myTgRes.json()).toEqual([
        expect.objectContaining({ telegramUserId: '555111', agentId: dana.id, username: 'dana_tg' }),
      ]);

      const delRes = await fetch(`${baseUrl}/me/telegram/555111`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${danaAuth.token}` },
      });
      expect(delRes.status).toBe(200);
      expect(await hub.telegram!.store.identity('555111')).toBeUndefined();

      // Clear the hourly prompt throttle from the earlier mention-prompted link code (review #19: /start no longer force-bypasses it).
      await db.collection('telegram_link_codes').doc('prompt:555111').delete();
      tgCalls.length = 0;
      await postWebhook({
        update_id: 4005,
        message: {
          message_id: 5,
          from: { id: 555111, first_name: 'TgDana', username: 'dana_tg' },
          chat: { id: 555111, type: 'private' },
          text: '/start',
        },
      });
      await hub.telegram!.idle();
      expect(tgCalls).toHaveLength(1);
      const botCode = /code=([A-Za-z0-9_-]+)/.exec(String(tgCalls[0]!.body.text))?.[1];
      expect(botCode).toBeTruthy();

      const inspectRes = await fetch(`${baseUrl}/telegram/link?code=${encodeURIComponent(botCode!)}`, {
        headers: { authorization: `Bearer ${danaAuth.token}` },
      });
      expect(inspectRes.status).toBe(200);
      expect(await inspectRes.json()).toMatchObject({
        telegramUserId: '555111',
        telegramUserName: 'TgDana',
        telegramUsername: 'dana_tg',
      });

      const approveRes = await fetch(`${baseUrl}/telegram/link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${danaAuth.token}` },
        body: JSON.stringify({ code: botCode }),
      });
      expect(approveRes.status).toBe(200);
      expect((await hub.telegram!.store.identity('555111'))?.agentId).toBe(dana.id);
    } finally {
      server.close();
    }
  });

  it('a linked Telegram user who is not in the channel workspace posts as external, not as their Parly agent (review #6)', async () => {
    const telegramFetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }), { status: 200 })) as unknown as typeof fetch;
    const { app, hub } = createApp({
      db: testDb(),
      config: testConfig({ credentialsKey: key, telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET } }),
      telegramFetch,
    });
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { owner, channel } = await crew(hub.registry, `tg6-${Date.now()}`, []);
      const outsider = await testPerson(hub.registry, `tg6-outsider-${Date.now()}`);
      const chatId = `-100667788${Date.now()}`;
      await hub.telegram!.store.linkChannel(channel.id, { chatId });
      await hub.telegram!.store.linkIdentity('777001', outsider!.id, { name: 'Out Sider' });

      const res = await fetch(`${baseUrl}/telegram/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        body: JSON.stringify({
          update_id: 6001,
          message: { message_id: 1, from: { id: 777001, first_name: 'Out' }, chat: { id: chatId, type: 'supergroup' }, text: 'hi' },
        }),
      });
      expect(res.status).toBe(200);
      await hub.telegram!.idle();

      const msgs = (await hub.chat.page(owner, `channel:${channel.id}`, 10)).messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ fromId: 'telegram:777001', external: true });
      expect((await hub.registry.get(outsider!.id))!.channels ?? []).not.toContain(channel.id);
    } finally {
      server.close();
    }
  });

  it('posts outbound messages with parse_mode: HTML, bold sender header, HTML-escaped body, and safe 4096 truncation', async () => {
    const db = testDb();
    const tgCalls: { url: string; body: Record<string, unknown> }[] = [];
    let tgMsgSeq = 3000;
    const telegramFetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      tgCalls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: ++tgMsgSeq,
            ...(typeof body.message_thread_id === 'number' ? { message_thread_id: body.message_thread_id } : {}),
            chat: { id: body.chat_id },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { hub } = createApp({
      db,
      config: testConfig({
        credentialsKey: key,
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
      telegramFetch,
    });

    const { owner, channel } = await crew(hub.registry, 'tg-html-header');
    const { agent: gititCreated } = await hub.registry.createBot(owner, { name: 'Gitit <R&D>', follow: true });
    await hub.registry.addToWorkspace(owner, channel.workspaceId, gititCreated.id);
    await hub.registry.addToChannel(owner, channel.id, gititCreated.id);
    const gitit = (await hub.registry.get(gititCreated.id))!;

    const chatId = `-100778899${Date.now()}`;
    await hub.telegram!.store.linkChannel(channel.id, { chatId, topicId: 55 });

    // 1. Outbound message uses `parse_mode: 'HTML'`, bold sender header `<b>...</b>\n`, and escapes `<`, `>`, `&` in both sender and body.
    const root = await hub.send(gitit, { channel: channel.id }, [
      { text: 'Compare a < b & c > d with <b>raw tags</b>' },
    ]);
    await hub.telegram!.idle();
    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.body).toEqual({
      chat_id: chatId,
      message_thread_id: 55,
      parse_mode: 'HTML',
      text: '<b>Gitit &lt;R&amp;D&gt;</b>\nCompare a &lt; b &amp; c &gt; d with &lt;b&gt;raw tags&lt;/b&gt;',
    });

    // 2. Overlong plain message and entity-heavy message stay within Telegram's 4096-character limit without splitting HTML entities.
    tgCalls.length = 0;
    await hub.send(gitit, { channel: channel.id, thread: root.message.id }, [{ text: 'x'.repeat(5000) }]);
    await hub.telegram!.idle();
    const sentLong = tgCalls.find((c) => c.url.endsWith('/sendMessage'))?.body;
    expect(sentLong).toBeDefined();
    expect(sentLong!.parse_mode).toBe('HTML');
    const longText = String(sentLong!.text);
    expect(longText.startsWith('<b>Gitit &lt;R&amp;D&gt;</b>\n')).toBe(true);
    expect(longText.length).toBeLessThanOrEqual(4096);

    tgCalls.length = 0;
    await hub.send(gitit, { channel: channel.id, thread: root.message.id }, [{ text: '<&>'.repeat(2000) }]);
    await hub.telegram!.idle();
    const sentEntities = tgCalls.find((c) => c.url.endsWith('/sendMessage'))?.body;
    expect(sentEntities).toBeDefined();
    const entityText = String(sentEntities!.text);
    expect(entityText.startsWith('<b>Gitit &lt;R&amp;D&gt;</b>\n')).toBe(true);
    expect(entityText.length).toBeLessThanOrEqual(4096);
    // Ensure no trailing partial HTML entity (every `&` after the header is followed by `amp;`, `lt;`, or `gt;`).
    const bodyAfterHeader = entityText.slice('<b>Gitit &lt;R&amp;D&gt;</b>\n'.length);
    expect(bodyAfterHeader.replace(/&(amp|lt|gt);/g, '')).toBe('');
  });

  it('opt-in per-agent Telegram bot token: seals token, enforces owner-only REST, sends via agent bot without header, and falls back to @ParlyBot when agent bot is not a group member', async () => {
    const db = testDb();
    const AGENT_BOT_TOKEN = '987654321:XYZ-agent-own-telegram-bot-token';
    const tgCalls: { url: string; body: Record<string, unknown> }[] = [];
    let tgMsgSeq = 4000;
    let agentBotNotInGroup = false;

    const telegramFetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      tgCalls.push({ url: String(url), body });
      if (agentBotNotInGroup && String(url).includes(`/bot${AGENT_BOT_TOKEN}/`)) {
        return new Response(
          JSON.stringify({ ok: false, description: 'Forbidden: bot is not a member of the supergroup chat' }),
          { status: 403 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: ++tgMsgSeq,
            ...(typeof body.message_thread_id === 'number' ? { message_thread_id: body.message_thread_id } : {}),
            chat: { id: body.chat_id },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { app, hub } = createApp({
      db,
      config: testConfig({
        credentialsKey: key,
        requireCredentialsKey: true,
        googleAuthDev: true,
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
      telegramFetch,
    });

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const signIn = async (email: string) => {
        const res = await fetch(`${baseUrl}/auth/google`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken: `dev:${email}` }),
        });
        return (await res.json()) as { token: string; agent: { id: string; workspaces: string[] } };
      };

      const ownerAuth = await signIn('owner-agentbot@people.test');
      const owner = (await hub.registry.get(ownerAuth.agent.id))!;
      const wsId = owner.workspaces![0]!;
      await hub.registry.inviteToWorkspace(owner, wsId, 'other-agentbot@people.test');
      const otherAuth = await signIn('other-agentbot@people.test');
      const other = (await hub.registry.get(otherAuth.agent.id))!;

      const channel = await hub.registry.createChannel(owner, wsId, 'tg-agent-bot-ch');
      await hub.registry.addToChannel(owner, channel.id, other.id);

      const { agent: nativeBotCreated } = await hub.registry.createBot(owner, { name: 'Gitit', follow: true });
      const { agent: sharedBotCreated } = await hub.registry.createBot(owner, { name: 'Reviewer', follow: true });
      for (const b of [nativeBotCreated, sharedBotCreated]) {
        await hub.registry.addToWorkspace(owner, wsId, b.id);
        await hub.registry.addToChannel(owner, channel.id, b.id);
      }
      const nativeBot = (await hub.registry.get(nativeBotCreated.id))!;
      const sharedBot = (await hub.registry.get(sharedBotCreated.id))!;

      const chatId = `-100665544${Date.now()}`;
      await hub.telegram!.store.linkChannel(channel.id, { chatId, topicId: 77 });
      // 1. Non-owner is rejected with 403; invalid token format is rejected with 400.
      const forbiddenPut = await fetch(`${baseUrl}/agents/${nativeBot.id}/telegram`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${otherAuth.token}` },
        body: JSON.stringify({ botToken: AGENT_BOT_TOKEN }),
      });
      expect(forbiddenPut.status).toBe(403);

      const badFormatPut = await fetch(`${baseUrl}/agents/${nativeBot.id}/telegram`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ botToken: 'not-a-valid-bot-token' }),
      });
      expect(badFormatPut.status).toBe(400);

      // 2. Owner saves the agent's Telegram bot token: stored sealed in the DB and never leaked in views.
      const saveRes = await fetch(`${baseUrl}/agents/${nativeBot.id}/telegram`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({ botToken: AGENT_BOT_TOKEN }),
      });
      expect(saveRes.status).toBe(200);
      const saveBody = (await saveRes.json()) as { agent: Record<string, unknown>; telegramBot: { configured: boolean } };
      expect(saveBody.telegramBot).toEqual({ configured: true });
      expect(JSON.stringify(saveBody)).not.toContain(AGENT_BOT_TOKEN);

      const rawDoc = (await db.collection('agents').doc(nativeBot.id).get()).data()!;
      expect(rawDoc.telegramBot?.sealed).toMatch(/^v1\./);
      expect(rawDoc.telegramBot?.token).toBeUndefined();

      const otherViewRes = await fetch(`${baseUrl}/agents/${nativeBot.id}`, {
        headers: { authorization: `Bearer ${otherAuth.token}` },
      });
      expect(((await otherViewRes.json()) as Record<string, unknown>).telegramBot).toBeUndefined();

      // 3. Path A: Agent WITH a token posts via its own bot token (`AGENT_BOT_TOKEN`) with NO sender header.
      tgCalls.length = 0;
      await hub.send(nativeBot, { channel: channel.id }, [{ text: 'Shipped <PR #2> & tests green' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          url: `https://api.telegram.org/bot${AGENT_BOT_TOKEN}/sendMessage`,
          body: {
            chat_id: chatId,
            message_thread_id: 77,
            parse_mode: 'HTML',
            text: 'Shipped &lt;PR #2&gt; &amp; tests green',
          },
        },
      ]);
      // 4. Path B: Agent WITHOUT a token falls back to shared @ParlyBot (`BOT_TOKEN`) + PR-1 bold HTML sender header.
      tgCalls.length = 0;
      await hub.send(sharedBot, { channel: channel.id }, [{ text: 'Reviewing <diff> now' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          body: {
            chat_id: chatId,
            message_thread_id: 77,
            parse_mode: 'HTML',
            text: '<b>Reviewer</b>\nReviewing &lt;diff&gt; now',
          },
        },
      ]);

      // 5. Graceful fallback: when the agent's bot is NOT a member of the Telegram group (403 Forbidden),
      // `send` tries the agent's bot token first and automatically falls back to @ParlyBot + bold HTML header.
      tgCalls.length = 0;
      agentBotNotInGroup = true;
      const fallbackPost = await hub.send(nativeBot, { channel: channel.id }, [{ text: 'Fallback when bot not in group' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          url: `https://api.telegram.org/bot${AGENT_BOT_TOKEN}/sendMessage`,
          body: {
            chat_id: chatId,
            message_thread_id: 77,
            parse_mode: 'HTML',
            text: 'Fallback when bot not in group',
          },
        },
        {
          url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          body: {
            chat_id: chatId,
            message_thread_id: 77,
            parse_mode: 'HTML',
            text: '<b>Gitit</b>\nFallback when bot not in group',
          },
        },
      ]);
      const storedFallback = await hub.telegram!.store.message(fallbackPost.message.id);
      expect(storedFallback?.telegram).toEqual([{ chatId, messageId: 4003, topicId: 77 }]);

      // 6. Owner removes the token via DELETE /agents/:id/telegram; subsequent posts use @ParlyBot directly.
      const delRes = await fetch(`${baseUrl}/agents/${nativeBot.id}/telegram`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ownerAuth.token}` },
      });
      expect(delRes.status).toBe(200);
      expect(((await delRes.json()) as { agent: { telegramBot?: unknown } }).agent.telegramBot).toBeUndefined();

      tgCalls.length = 0;
      agentBotNotInGroup = false;
      await hub.send(nativeBot, { channel: channel.id }, [{ text: 'Back to shared bot' }]);
      await hub.telegram!.idle();
      expect(tgCalls).toEqual([
        {
          url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          body: {
            chat_id: chatId,
            message_thread_id: 77,
            parse_mode: 'HTML',
            text: '<b>Gitit</b>\nBack to shared bot',
          },
        },
      ]);

      // 7. Verify agent settings page and account page wire the owner-only Telegram bot token controls.
      const { readFileSync } = await import('node:fs');
      const agentPageSrc = readFileSync(new URL('../web/app/(window)/w/[ws]/agents/[id]/page.tsx', import.meta.url), 'utf8');
      expect(agentPageSrc).toContain('TelegramBotCard');
      expect(agentPageSrc).toContain('updateAgentTelegramBot');
      expect(agentPageSrc).toContain('removeAgentTelegramBot');
      const accountPageSrc = readFileSync(new URL('../web/app/(site)/account/page.tsx', import.meta.url), 'utf8');
      expect(accountPageSrc).toContain('Per-agent Telegram bot tokens');
      expect(accountPageSrc).toContain('updateAgentTelegramBot');
      expect(accountPageSrc).toContain('removeAgentTelegramBot');
    } finally {
      server.close();
    }
  });

  it('refuses /start <code> from a group and burns the leaked code (review #92)', async () => {
    const tgCalls: { body: Record<string, unknown> }[] = [];
    const telegramFetch = (async (_url: string, init?: RequestInit) => {
      tgCalls.push({ body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }), { status: 200 });
    }) as typeof fetch;
    const { app, hub } = createApp({
      db: testDb(),
      config: testConfig({
        credentialsKey: key,
        googleAuthDev: true,
        telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET },
      }),
      telegramFetch,
    });
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const signIn = await fetch(`${baseUrl}/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'dev:start-group@people.test' }),
      });
      const { token } = (await signIn.json()) as { token: string };
      const codeRes = await fetch(`${baseUrl}/telegram/link/code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const { code } = (await codeRes.json()) as { code: string };

      const chatId = `-10092001${Date.now()}`;
      await fetch(`${baseUrl}/telegram/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        body: JSON.stringify({
          update_id: 92001,
          message: {
            message_id: 1,
            from: { id: 424242, first_name: 'Lurker' },
            chat: { id: chatId, type: 'supergroup' },
            text: `/start ${code}`,
          },
        }),
      });
      await hub.telegram!.idle();

      expect(await hub.telegram!.store.identity('424242')).toBeUndefined();
      expect(String(tgCalls[0]!.body.text)).toContain('private chat');

      tgCalls.length = 0;
      await fetch(`${baseUrl}/telegram/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        body: JSON.stringify({
          update_id: 92002,
          message: {
            message_id: 2,
            from: { id: 424242, first_name: 'Lurker' },
            chat: { id: 424242, type: 'private' },
            text: `/start ${code}`,
          },
        }),
      });
      await hub.telegram!.idle();
      expect(await hub.telegram!.store.identity('424242')).toBeUndefined();
      expect(String(tgCalls[0]!.body.text)).toContain('expired');
    } finally {
      server.close();
    }
  });

  it('a linked non-member cannot bypass membership via chat.post (review #92)', async () => {
    const telegramFetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }), { status: 200 })) as unknown as typeof fetch;
    const { app, hub } = createApp({
      db: testDb(),
      config: testConfig({ credentialsKey: key, telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET } }),
      telegramFetch,
    });
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { owner, channel } = await crew(hub.registry, `tg92-nm-${Date.now()}`, []);
      const outsider = await testPerson(hub.registry, `tg92-out-${Date.now()}`);
      const chatId = `-10092002${Date.now()}`;
      await hub.telegram!.store.linkChannel(channel.id, { chatId });
      await hub.telegram!.store.linkIdentity('920002', outsider!.id, { name: 'Out Sider' });

      await fetch(`${baseUrl}/telegram/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        body: JSON.stringify({
          update_id: 92003,
          message: {
            message_id: 1,
            from: { id: 920002, first_name: 'Out' },
            chat: { id: chatId, type: 'supergroup' },
            text: 'should stay external',
          },
        }),
      });
      await hub.telegram!.idle();

      const msgs = (await hub.chat.page(owner, `channel:${channel.id}`, 10)).messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ fromId: 'telegram:920002', external: true, from: 'Out' });
      expect(msgs[0]!.fromId).not.toBe(outsider!.id);
      expect((await hub.registry.get(outsider!.id))!.channels ?? []).not.toContain(channel.id);
    } finally {
      server.close();
    }
  });

  it('stops auto-creating Parly channels once the topic-spam limit is hit (review #92)', async () => {
    const db = testDb();
    const telegramFetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 0 } } }), { status: 200 })) as unknown as typeof fetch;
    const { hub } = createApp({
      db,
      config: testConfig({ credentialsKey: key, telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET } }),
      telegramFetch,
    });
    const { owner, workspace, channel } = await crew(hub.registry, `tg92-spam-${Date.now()}`, []);
    const chatId = `-10092003${Date.now()}`;
    await hub.telegram!.store.linkChannel(channel.id, { chatId });
    await hub.telegram!.store.saveChat(chatId, { workspaceId: workspace.id });

    for (let i = 0; i < MAX_AUTO_TOPIC_CHANNELS - 1; i++) {
      await db.collection('telegram_links').doc(`${chatId}:${3000 + i}`).set({
        chatId,
        topicId: 3000 + i,
        parlyChannelId: channel.id,
      });
    }

    const stillRoom = await hub.telegram!.autoLink(chatId, 8888, 'Still room');
    expect(stillRoom).toMatchObject({ chatId, topicId: 8888 });
    expect((await hub.registry.channelsById([stillRoom!.parlyChannelId])).get(stillRoom!.parlyChannelId)?.name).toBe('Still room');

    const overflow = await hub.telegram!.autoLink(chatId, 9999, 'Spam overflow');
    expect(overflow).toBeUndefined();
    const after = await hub.registry.channelsOf((await hub.registry.get(owner.id))!, workspace.id);
    expect(after.some((c) => c.name === 'Spam overflow')).toBe(false);
  });
});
