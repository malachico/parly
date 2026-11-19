import { COLLECTIONS, FieldValue, type Database } from '../src/db/types.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/app.js';
import { threadKey } from '../src/chat/chat.js';
import type { ForwardResult, Forwarder } from '../src/hub/forward.js';
import type { HubService } from '../src/hub/hubService.js';
import type { WireMessage } from '../src/lib/wire.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, testConfig, testDb, testPerson } from './helpers.js';

class StubForwarder implements Forwarder {
  sent: WireMessage[] = [];
  respond: (m: WireMessage) => ForwardResult | Promise<ForwardResult> = (m) => ({
    kind: 'message',
    message: { messageId: `r-${m.messageId}`, role: 'ROLE_AGENT', contextId: 'oc-ctx', parts: [{ text: 'on it' }] },
  });
  async send(_agent: unknown, m: WireMessage): Promise<ForwardResult> {
    this.sent.push(m);
    return await this.respond(m);
  }
  async getTask(): Promise<never> {
    throw new Error('unused');
  }
  async cancel() {}
}

const say = (text: string) => [{ text }];

describe('threads', () => {
  let db: Database;
  let hub: HubService;
  let forwarder: StubForwarder;
  beforeAll(() => {
    db = testDb();
    forwarder = new StubForwarder();
    hub = createHub({ db, config: testConfig(), forwarder, fetchCard: async () => ({ name: 'qa', description: '', skills: [] }) });
  });

  async function withEndpoint(owner: AgentRecord, channelId: string, workspaceId: string, name: string) {
    const { agent } = await hub.registry.createBot(owner, { name, url: 'http://remote.test' });
    await hub.registry.addToWorkspace(owner, workspaceId, agent.id);
    await hub.registry.addToChannel(owner, channelId, agent.id);
    return agent;
  }

  it('gives an endpoint agent what was said since it last heard, ahead of the message, in its own conversation', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'ctx', ['ctx-dev']);
    const [dev] = members;
    await withEndpoint(owner, channel.id, channel.workspaceId, 'qa');
    forwarder.respond = new StubForwarder().respond;

    // qa answers the post in its thread; dev answers there too, and so does a person, before qa is asked again.
    const root = (await hub.send(owner, { channel: channel.id }, say('Plan the staging env'))).message;
    await hub.wakeService.idle();
    const [item] = await hub.chat.take(dev!);
    forwarder.sent = [];
    // Pushes to qa come later: pause it by making it unreachable while the others talk.
    forwarder.respond = () => {
      throw new Error('down');
    };
    await hub.send(dev!, { replyTo: item!.message.id }, say('Four questions: browser? fixes? branches? secrets?'));
    await hub.wakeService.idle();
    forwarder.respond = new StubForwarder().respond;
    await hub.send(owner, { channel: channel.id, thread: root.id }, say('@qa please answer the questions'));
    await hub.wakeService.idle();
    const toQa = forwarder.sent.at(-1)!;
    const context = toQa.parts.slice(0, -1).map((p) => p.text ?? '').join('\n');
    expect(context).toContain('ctx-dev: Four questions');
    expect(context).not.toContain('Plan the staging env');
    expect(toQa.parts.at(-1)!.text).toBe('@qa please answer the questions');
    expect(toQa.contextId).toBe('oc-ctx');
  });

  it('gives an agent new to a thread its last messages, and says how many came before', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'late', ['late-dev', 'late-newbie']);
    const [dev, newbie] = members;
    const root = (await hub.send(owner, { channel: channel.id }, say('post'))).message;
    await hub.send(dev!, { replyTo: root.id }, say('answer'));
    for (let i = 1; i <= 11; i++) await hub.send(owner, { channel: channel.id, thread: root.id }, say(`reply ${i}`));
    await hub.send(owner, { channel: channel.id, thread: root.id }, say('@late-newbie your turn'));
    const [view] = await hub.inboxView(newbie!, (await hub.chat.take(newbie!)).filter((i) => i.conversation.id === threadKey(channel.id, root.id)));
    expect(view).toMatchObject({ text: '@late-newbie your turn', thread: root.id });
    // answer and 11 replies before it: the last 10 shown, 2 more counted.
    expect(view!.earlier).toHaveLength(10);
    expect(view!.earlier!.at(-1)).toMatchObject({ from: 'late-owner', text: 'reply 11' });
    expect(view!.earlierCount).toBe(2);
    // The whole thread, for whoever wants more.
    const all = await hub.chat.readThread(newbie!, channel.id, root.id);
    expect(all.slice(0, 2).map((m) => `${m.from}: ${m.parts[0]?.text}`)).toEqual(['late-owner: post', 'late-dev: answer']);
    expect(all).toHaveLength(14);
    // Or only the newest few, which is what an agent gets by default.
    expect((await hub.chat.readThread(newbie!, channel.id, root.id, 2)).map((m) => m.parts[0]?.text)).toEqual(['post', 'reply 11', '@late-newbie your turn']);
    // A long message is cut in `earlier`, not in the message itself.
    await hub.send(owner, { channel: channel.id, thread: root.id }, say('x'.repeat(5000)));
    await hub.send(owner, { channel: channel.id, thread: root.id }, say('@late-newbie and again'));
    const [next] = await hub.inboxView(newbie!, (await hub.chat.take(newbie!)).filter((i) => i.conversation.id === threadKey(channel.id, root.id)));
    expect(next!.earlier!.at(-1)!.text).toMatch(/^x{2000}… \(cut\)$/);
  });

  it('lets members read a thread, and nobody outside the channel', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'notes', ['notes-dev']);
    const root = (await hub.send(owner, { channel: channel.id }, say('The design'))).message;
    expect((await hub.chat.readThread(members[0]!, channel.id, root.id)).map((m) => m.id)).toEqual([root.id]);
    const { owner: stranger } = await crew(hub.registry, 'notes-out', []);
    await expect(hub.chat.readThread(stranger, channel.id, root.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it("stores an endpoint agent's answer given only as artifacts, or only in its task's history", async () => {
    const { owner, channel } = await crew(hub.registry, 'arts', []);
    await withEndpoint(owner, channel.id, channel.workspaceId, 'qa3');
    forwarder.respond = () => ({ kind: 'task', task: { id: 'oc-a', contextId: 'oc-ctx-a', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'x', parts: [{ text: 'from an artifact' }] }] } });
    const first = (await hub.send(owner, { channel: channel.id }, say('start'))).message;
    await hub.wakeService.idle();
    expect((await hub.chat.readThread(owner, channel.id, first.id)).map((m) => m.parts[0]?.text)).toEqual(['start', 'from an artifact']);

    forwarder.respond = (m) => ({
      kind: 'task',
      task: { id: 'oc-h', contextId: 'oc-ctx-h', status: { state: 'TASK_STATE_COMPLETED' }, history: [m, { messageId: 'h1', role: 'ROLE_AGENT', parts: [{ text: 'answer in history' }] }] },
    });
    const second = (await hub.send(owner, { channel: channel.id, thread: undefined }, say('question'))).message;
    await hub.wakeService.idle();
    expect((await hub.chat.readThread(owner, channel.id, second.id)).map((m) => m.parts[0]?.text)).toEqual(['question', 'answer in history']);
  });

  it('marks a thread as done, clears activity/unread/Needs-you, blocks late agent replies, and auto-reopens on human reply', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'done-flow', ['done-bot', 'other-bot']);
    const [bot, otherBot] = members;
    const secondHuman = await testPerson(hub.registry, 'Teammate');
    await hub.registry.inviteToWorkspace(owner, channel.workspaceId, secondHuman.email!);
    await hub.registry.addToChannel(owner, channel.id, secondHuman.id);
    const refreshedHuman = (await hub.registry.get(secondHuman.id))!;

    // Teammate (non-owner) starts a thread mentioning owner and bot.
    const root = (await hub.send(refreshedHuman, { channel: channel.id }, say(`@${owner.name} @${bot!.name} implement feature X`))).message;
    const reply1 = (await hub.send(bot!, { replyTo: root.id }, say(`@${owner.name} working on feature X`))).message;

    // Bot sets live working status on the thread.
    await hub.setStatus(bot!, threadKey(channel.id, root.id), 'running tests');
    expect((await hub.chat.activityOf(threadKey(channel.id, root.id))).map((a) => a.agentId)).toContain(bot!.id);
    expect((await hub.chat.waitingFor(owner)).some((w) => w.open === threadKey(channel.id, root.id))).toBe(true);

    // An unrelated bot (neither thread starter nor channel owner) cannot mark the thread as done.
    await expect(hub.setThreadDone(otherBot!, channel.id, root.id, true)).rejects.toMatchObject({ code: 'forbidden' });

    // The thread starter (non-owner Teammate) CAN mark their own thread as done.
    const marked = await hub.setThreadDone(refreshedHuman, channel.id, root.id, true);
    expect(marked.doneThreads).toEqual([root.id]);

    // Marking Done clears live activity, hides from Needs you, and skips unread/inbox for agents and humans.
    expect(await hub.chat.activityOf(threadKey(channel.id, root.id))).toEqual([]);
    expect((await hub.chat.waitingFor(owner)).some((w) => w.open === threadKey(channel.id, root.id))).toBe(false);
    expect((await hub.chat.newFor(bot!)).some((i) => i.conversation.id === threadKey(channel.id, root.id) || i.message.id === root.id)).toBe(false);
    const ownerConv = (await hub.chat.conversations(owner)).find((s) => s.conversation.channelId === channel.id);
    expect(ownerConv?.unread ?? 0).toBe(0);
    expect(ownerConv?.thread).toBeUndefined();

    // Channel page thread summary marks the thread as done with 0 unread.
    const chPage = await hub.chat.page(owner, `channel:${channel.id}`, 20);
    expect(chPage.threads[root.id]?.done).toBe(true);
    expect(chPage.threads[root.id]?.unread).toBeUndefined();

    // Race protection: a late agent callback (reply / send_message / set_status) or an incoming webhook event to a Done thread is blocked and does NOT reopen it.
    await expect(hub.send(bot!, { replyTo: reply1.id }, say('late agent callback'))).rejects.toMatchObject({
      code: 'invalid',
      message: 'Thread is marked as done',
    });
    await expect(hub.send(bot!, { channel: channel.id, thread: root.id }, say('late agent thread post'))).rejects.toMatchObject({
      code: 'invalid',
      message: 'Thread is marked as done',
    });
    await expect(hub.setStatus(bot!, threadKey(channel.id, root.id), 'still working')).rejects.toMatchObject({
      code: 'invalid',
      message: 'Thread is marked as done',
    });
    const { webhook } = await hub.createWebhook(owner, channel.id, 'GitHub');
    await expect(hub.postWebhook(webhook, channel.id, 'PR comment event', root.id)).rejects.toMatchObject({
      code: 'invalid',
      message: 'Thread is marked as done',
    });
    expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.doneThreads).toEqual([root.id]);

    // Human reply in the Done thread automatically reopens it, allowing agents to reply again.
    await hub.send(owner, { channel: channel.id, thread: root.id }, say(`@${bot!.name} one more fix needed`));
    expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.doneThreads ?? []).toEqual([]);
    const reopenedPage = await hub.chat.page(owner, `channel:${channel.id}`, 20);
    expect(reopenedPage.threads[root.id]?.done).toBeUndefined();

    // Now the agent receives the new message and can reply normally.
    const followUp = await hub.send(bot!, { channel: channel.id, thread: root.id }, say('fixed!'));
    expect(followUp.message.parts[0]?.text).toBe('fixed!');

    // Channel owner (or a bot owned by the thread opener) can also mark Done and explicitly Reopen.
    const { agent: teammateBot } = await hub.registry.createBot(refreshedHuman, { name: 'teammate-bot' });
    await hub.registry.addToWorkspace(refreshedHuman, channel.workspaceId, teammateBot.id);
    const joinedTeammateBot = (await hub.registry.addToChannel(owner, channel.id, teammateBot.id)).agent;
    expect((await hub.setThreadDone(joinedTeammateBot, channel.id, root.id, true)).doneThreads).toEqual([root.id]);
    expect((await hub.setThreadDone(joinedTeammateBot, channel.id, root.id, false)).doneThreads).toEqual([]);
    expect((await hub.setThreadDone(owner, channel.id, root.id, true)).doneThreads).toEqual([root.id]);
    expect((await hub.setThreadDone(owner, channel.id, root.id, false)).doneThreads).toEqual([]);

    // In-flight endpoint agent callback race: thread marked Done while endpoint agent is answering does not post or reopen.
    const ep = await withEndpoint(owner, channel.id, channel.workspaceId, 'slow-ep');
    let markDoneDuringRun: (() => Promise<void>) | undefined;
    forwarder.respond = async (m) => {
      await markDoneDuringRun?.();
      return {
        kind: 'message',
        message: { messageId: `late-${m.messageId}`, role: 'ROLE_AGENT', contextId: 'slow-ctx', parts: [{ text: 'late endpoint answer' }] },
      };
    };
    const raceRoot = (await hub.send(owner, { channel: channel.id }, say(`@${ep.name} run slow job`))).message;
    markDoneDuringRun = async () => {
      await hub.setThreadDone(owner, channel.id, raceRoot.id, true);
    };
    await hub.wakeService.idle();
    expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.doneThreads).toEqual([raceRoot.id]);
    expect((await hub.chat.readThread(owner, channel.id, raceRoot.id)).map((m) => m.parts[0]?.text)).toEqual([`@${ep.name} run slow job`]);
    expect(await hub.chat.activityOf(threadKey(channel.id, raceRoot.id))).toEqual([]);
  });

  it('channel page with threads=open fills with open posts when the newest ones are Done', async () => {
    const { owner, channel } = await crew(hub.registry, 'open-feed', []);
    // Done at seq 1 so a short open page still has messages[0].seq > 1 (raw older would stay true forever).
    const doneFirst = (await hub.send(owner, { channel: channel.id }, say('done first'))).message;
    await hub.setThreadDone(owner, channel.id, doneFirst.id, true);
    const openOld = (await hub.send(owner, { channel: channel.id }, say('still open older'))).message;
    const doneNewest: string[] = [doneFirst.id];
    for (let i = 0; i < 5; i++) {
      const p = (await hub.send(owner, { channel: channel.id }, say(`done post ${i}`))).message;
      await hub.setThreadDone(owner, channel.id, p.id, true);
      doneNewest.push(p.id);
    }
    const openNew = (await hub.send(owner, { channel: channel.id }, say('still open newest'))).message;

    // Default/all: newest page is mostly Done posts — open feed would look empty after client filter.
    const all = await hub.chat.page(owner, `channel:${channel.id}`, 5);
    expect(all.messages.map((m) => m.id).filter((id) => doneNewest.includes(id)).length).toBeGreaterThan(2);

    // threads=open: skip Done and still fill with the open posts (including older ones).
    const open = await hub.chat.page(owner, `channel:${channel.id}`, 5, undefined, { threads: 'open' });
    expect(open.messages.map((m) => m.id)).toEqual(expect.arrayContaining([openOld.id, openNew.id]));
    expect(open.messages.every((m) => !doneNewest.includes(m.id))).toBe(true);
    // Short open page: no more matching posts — even if raw seq>1 from a Done-only tail (would keep LoadOlder armed).
    expect(open.older).toBe(false);

    const onlyDone = await hub.chat.page(owner, `channel:${channel.id}`, 5, undefined, { threads: 'done' });
    expect(onlyDone.messages.length).toBeGreaterThan(0);
    expect(onlyDone.messages.every((m) => doneNewest.includes(m.id))).toBe(true);
  });

  it('threads=open returns the newest matching posts oldest-first, not the oldest matches in the newest batch', async () => {
    const { owner, channel } = await crew(hub.registry, 'open-order', []);
    const open: string[] = [];
    for (let i = 0; i < 5; i++) {
      const done = (await hub.send(owner, { channel: channel.id }, say(`done ${i}`))).message;
      await hub.setThreadDone(owner, channel.id, done.id, true);
      open.push((await hub.send(owner, { channel: channel.id }, say(`open ${i}`))).message.id);
    }
    // Newest three open posts, oldest-first (same contract as store.page).
    const page = await hub.chat.page(owner, `channel:${channel.id}`, 3, undefined, { threads: 'open' });
    expect(page.messages.map((m) => m.id)).toEqual(open.slice(-3));
    expect(page.older).toBe(true);
  });

  it('threads=open|done queries store.page once by done flag instead of walking batches', async () => {
    const { owner, channel } = await crew(hub.registry, 'open-batches', []);
    const openOlder: string[] = [];
    for (let i = 0; i < 10; i++) openOlder.push((await hub.send(owner, { channel: channel.id }, say(`open ${i}`))).message.id);
    const doneTail: string[] = [];
    for (let i = 0; i < 50; i++) {
      const p = (await hub.send(owner, { channel: channel.id }, say(`done tail ${i}`))).message;
      await hub.setThreadDone(owner, channel.id, p.id, true);
      doneTail.push(p.id);
    }
    const spy = vi.spyOn(hub.chat.store, 'page');
    try {
      const page = await hub.chat.page(owner, `channel:${channel.id}`, 5, undefined, { threads: 'open' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(`channel:${channel.id}`, 6, undefined, false);
      expect(page.messages.map((m) => m.id)).toEqual(openOlder.slice(-5));
      expect(page.older).toBe(true);

      spy.mockClear();
      const firstOpenPage = await hub.chat.page(owner, `channel:${channel.id}`, 10, undefined, { threads: 'open' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(firstOpenPage.messages.map((m) => m.id)).toEqual(openOlder);
      expect(firstOpenPage.older).toBe(false);

      spy.mockClear();
      const donePage = await hub.chat.page(owner, `channel:${channel.id}`, 5, undefined, { threads: 'done' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(`channel:${channel.id}`, 6, undefined, true);
      expect(donePage.messages.map((m) => m.id)).toEqual(doneTail.slice(-5));
      expect(donePage.older).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('backfills legacy channel posts missing done before filtering threads=open|done', async () => {
    const { owner, channel } = await crew(hub.registry, 'legacy-done', []);
    const legacyOpen = (await hub.send(owner, { channel: channel.id }, say('legacy open'))).message;
    const legacyDone = (await hub.send(owner, { channel: channel.id }, say('legacy done'))).message;
    await hub.setThreadDone(owner, channel.id, legacyDone.id, true);
    await db.collection(COLLECTIONS.messages).doc(legacyOpen.id).update({ done: FieldValue.delete() });
    await db.collection(COLLECTIONS.messages).doc(legacyDone.id).update({ done: FieldValue.delete() });
    await db.collection(COLLECTIONS.conversations).doc(`channel:${channel.id}`).update({ doneBackfilled: FieldValue.delete() });

    const openPage = await hub.chat.page(owner, `channel:${channel.id}`, 10, undefined, { threads: 'open' });
    expect(openPage.messages.map((m) => m.id)).toEqual([legacyOpen.id]);
    const donePage = await hub.chat.page(owner, `channel:${channel.id}`, 10, undefined, { threads: 'done' });
    expect(donePage.messages.map((m) => m.id)).toEqual([legacyDone.id]);
  });

  it('done backfill resumes from the persisted cursor instead of re-reading the whole channel', async () => {
    const { owner, channel } = await crew(hub.registry, 'resume-done', []);
    const convId = `channel:${channel.id}`;
    // Five legacy posts (seq 1..5) with no `done` field yet.
    const posts: string[] = [];
    for (let i = 0; i < 5; i++) posts.push((await hub.send(owner, { channel: channel.id }, say(`post ${i}`))).message.id);
    const seqOf = new Map<string, number>();
    for (const id of posts) seqOf.set(id, (await db.collection(COLLECTIONS.messages).doc(id).get()).get('seq') as number);
    for (const id of posts) await db.collection(COLLECTIONS.messages).doc(id).update({ done: FieldValue.delete() });
    // A prior run already covered seq >= 3 and timed out; only seq 1..2 remain. Resume must not re-touch 3..5.
    await db.collection(COLLECTIONS.conversations).doc(convId).update({ doneBackfilled: FieldValue.delete(), doneBackfillSeq: 3 });

    await hub.chat.page(owner, convId, 10, undefined, { threads: 'open' });

    const doneBySeq = new Map<number, unknown>();
    for (const id of posts) doneBySeq.set(seqOf.get(id)!, (await db.collection(COLLECTIONS.messages).doc(id).get()).get('done'));
    // Below the cursor got backfilled; at/above it stayed untouched — proof the run resumed rather than restarted.
    expect(typeof doneBySeq.get(1)).toBe('boolean');
    expect(typeof doneBySeq.get(2)).toBe('boolean');
    expect(doneBySeq.get(3)).toBeUndefined();
    expect(doneBySeq.get(4)).toBeUndefined();
    expect(doneBySeq.get(5)).toBeUndefined();
    const conv = (await db.collection(COLLECTIONS.conversations).doc(convId).get()).data()!;
    expect(conv.doneBackfilled).toBe(true);
    expect(conv.doneBackfillSeq).toBeUndefined();
  });
});
