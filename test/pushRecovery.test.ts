import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/app.js';
import type { PushQueue, QueueJob } from '../src/chat/queue.js';
import { crew, testConfig, testDb } from './helpers.js';

/** A queue whose first `failures` enqueues reject, like a Cloud Tasks blip; it records the ones that went through. */
function flakyQueue(failures: number) {
  const queued: QueueJob[] = [];
  let calls = 0;
  const queue: PushQueue = {
    async enqueue(job) {
      if (++calls <= failures) throw new Error('cloud tasks unavailable');
      queued.push(job);
    },
  };
  return { queue, queued, calls: () => calls };
}

async function setup(failures: number) {
  const q = flakyQueue(failures);
  const hub = createHub({ db: testDb(), config: testConfig(), queue: q.queue, fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
  const c = await crew(hub.registry, `rec${failures}`, []);
  const { agent: ep } = await hub.registry.createBot(c.owner, { name: `rec${failures}-ep`, url: 'http://remote.test' });
  await hub.registry.addToWorkspace(c.owner, c.workspace.id, ep.id);
  await hub.registry.addToChannel(c.owner, c.channel.id, ep.id);
  const owner = (await hub.registry.get(c.owner.id))!;
  return { hub, q, owner, channel: c.channel, ep };
}

describe('recovering dropped push enqueues', () => {
  afterEach(() => vi.useRealTimers());

  it('retries an enqueue that fails once', async () => {
    const { hub, q, owner, channel, ep } = await setup(1);
    await hub.chat.post(owner, { channelId: channel.id }, { parts: [{ text: 'hi' }] });
    expect(q.calls()).toBe(2);
    expect(q.queued).toEqual([{ agentId: ep.id, conversationId: expect.any(String) }]);
  });

  it('the sweep re-pushes an endpoint message whose enqueue and retry both failed', async () => {
    const { hub, q, owner, channel, ep } = await setup(2);
    await hub.chat.post(owner, { channelId: channel.id }, { parts: [{ text: 'hi' }] });
    expect(q.queued).toEqual([]);
    // Too fresh: its first enqueue may still be under way.
    expect(await hub.wakeService.wakeSweep()).toBe(0);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 60_000 });
    expect(await hub.wakeService.wakeSweep()).toBe(1);
    expect(q.queued).toEqual([{ agentId: ep.id, conversationId: expect.any(String) }]);
  });
});
