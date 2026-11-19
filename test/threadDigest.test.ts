import { beforeAll, describe, expect, it } from 'vitest';
import type { DigestFoldInput, ThreadDigestFolder } from '../src/chat/catchup.js';
import { threadKey } from '../src/chat/chat.js';
import { ChatService } from '../src/chat/chatService.js';
import { InlineQueue } from '../src/chat/queue.js';
import { ChatStore } from '../src/chat/store.js';
import { Registry } from '../src/registry/registry.js';
import { crew, testDb } from './helpers.js';

const say = (text: string) => ({ parts: [{ text }] });

describe('THREAD_DIGEST: fold older replies, serve digest + verbatim tail', () => {
  let registry: Registry;
  let chat: ChatService;

  beforeAll(() => {
    const db = testDb();
    registry = new Registry(db, { fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
    const queue = new InlineQueue();
    queue.setHandler(async () => {});
    chat = new ChatService(new ChatStore(db), registry, queue, { maxWaitMs: 2000 });
  });

  it('folds (base, seq-EARLIER_MAX] into the digest and serves it with the verbatim tail', async () => {
    const { owner, channel, members } = await crew(registry, 'tdg');
    const viewer = members[0]!;
    const post = (await chat.post(owner, { channelId: channel.id }, say('root'))).message;
    const thread = { channelId: channel.id, thread: post.id };
    // Reply 1 @mentions the viewer so it joins the thread; the rest are plain owner replies. All from a
    // person, so AGENT_RUN_MAX never caps delivery. 15 replies => conv.seq 15, targetSeq = 15 - 10 = 5.
    await chat.post(owner, thread, say(`@${viewer.name} over to the thread`));
    for (let i = 2; i <= 15; i++) await chat.post(owner, thread, say(`r ${i}`));

    // fold is set only now, so post()'s fire-and-forget auto-fold never raced during the loop: this call is the
    // one deterministic fold. The stub records its input and returns a digest tagged with the last folded seq.
    const folds: DigestFoldInput[] = [];
    const fold: ThreadDigestFolder = async (input) => {
      folds.push(input);
      return `digest@${input.chunk[input.chunk.length - 1]!.seq}`;
    };
    chat.fold = fold;

    const key = threadKey(channel.id, post.id);
    const conv = (await chat.store.conversation(key))!;
    expect(conv.seq).toBe(15);

    await chat.foldDigest(conv);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.chunk.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]); // base+1 .. conv.seq-EARLIER_MAX
    expect(folds[0]!.root?.seq).toBe(0); // root post cited [#0] on the first fold

    const after = (await chat.store.conversation(key))!;
    expect(after.digestUpToSeq).toBe(5); // advanced to the last folded seq
    expect(after.threadDigest).toBe('digest@5');

    // The viewer's wake now carries the digest in place of seqs 1..5, the tail (6..14) verbatim, newest 15.
    const item = (await chat.newFor(viewer)).find((i) => i.conversation.kind === 'thread')!;
    expect(item.digest).toBe('digest@5');
    expect(item.earlier.map((m) => m.seq)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]); // tail, minus the newest and the folded head
    expect(item.message.seq).toBe(15);

    // THREAD_DIGEST=off: the stored digest is ignored on reads, back to the plain last-EARLIER_MAX window.
    chat.fold = undefined;
    const off = (await chat.newFor(viewer)).find((i) => i.conversation.kind === 'thread')!;
    expect(off.digest).toBeUndefined();
    expect(off.earlier.map((m) => m.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    chat.fold = fold;
  });

  it('shared DB fold lease prevents concurrent foldDigest calls from double-folding', async () => {
    const { owner, channel } = await crew(registry, 'tdg-lock');
    const post = (await chat.post(owner, { channelId: channel.id }, say('root'))).message;
    const thread = { channelId: channel.id, thread: post.id };
    chat.fold = undefined;
    for (let i = 1; i <= 15; i++) await chat.post(owner, thread, say(`r ${i}`));

    const key = threadKey(channel.id, post.id);
    const conv = (await chat.store.conversation(key))!;
    // Simulate a second hub instance holding the shared DB fold lease.
    const leased = await chat.store.leaseDigestFold(key, 30_000);
    expect(leased).toBeDefined();
    expect(await chat.store.leaseDigestFold(key, 30_000)).toBeUndefined();

    let calls = 0;
    chat.fold = async (input) => {
      calls++;
      return `digest@${input.chunk[input.chunk.length - 1]!.seq}`;
    };
    await chat.foldDigest(conv);
    expect(calls).toBe(0);

    // Once the lease is released, foldDigest acquires it, folds once, and clears the lease in setDigest.
    await chat.store.releaseDigestFold(key);
    await chat.foldDigest(conv);
    expect(calls).toBe(1);
    const after = (await chat.store.conversation(key))!;
    expect(after.digestUpToSeq).toBe(5);
    expect(after.digestFoldUntilMs).toBeUndefined();
  });
});
