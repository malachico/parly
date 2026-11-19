import { expect, it, onTestFailed } from 'vitest';
import { createHub } from '../src/app.js';
import { InlineQueue } from '../src/chat/queue.js';
import type { ForwardResult } from '../src/hub/forward.js';
import type { HubService } from '../src/hub/hubService.js';
import { textOf, type WireMessage } from '../src/lib/wire.js';
import type { AgentRecord } from '../src/registry/types.js';
import { ROOM_REMIND_MS } from '../src/rooms/rooms.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const said = (parts: { text?: string }[]) => textOf({ parts: parts as never }).trim();

/** A whole negotiation: two endpoint agents over real pushes, a push that times out, an ask, a reminder, a deal, a go-prompt. */
it('a room runs from start to agreed, one answer per turn', async () => {
  const log: string[] = [];
  onTestFailed(() => console.error('Room simulation reached:', log));
  const queue = new InlineQueue();
  let hub: HubService;
  let ws = '';
  let buyer: AgentRecord;
  const answers: Record<string, (asked: string, m: WireMessage, me: AgentRecord) => string | undefined | Promise<string | undefined>> = {};
  const forwarder = {
    send: async (me: AgentRecord, m: WireMessage): Promise<ForwardResult> => {
      const asked = said(m.parts.slice(-1));
      log.push(`-> ${me.name}: ${asked.split('\n')[0]}`);
      const answer = await answers[me.id]!(asked, m, me);
      const parts = answer ? [{ text: answer }] : [];
      return { kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', contextId: 'ctx', parts } };
    },
    getTask: async (): Promise<never> => {
      throw new Error('unused');
    },
    cancel: async () => {},
  };
  hub = createHub({ db: testDb(), config: testConfig(), forwarder: forwarder as never, queue, fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
  // A failed job goes again before anything else happens: the worst order for a retry, and one Cloud Tasks can pick.
  let retried!: () => void;
  const retry = new Promise<void>((resolve) => (retried = resolve));
  queue.setHandler((job) => hub.push.run(job).catch(() => hub.push.run(job).finally(retried)));

  buyer = await testPerson(hub.registry, 'sim-buyer');
  const seller = await testPerson(hub.registry, 'sim-seller');
  const { agent: b } = await hub.registry.createBot(buyer, { name: 'sim-buyer-bot', url: 'http://remote.test' });
  const { agent: s } = await hub.registry.createBot(seller, { name: 'sim-seller-bot', url: 'http://remote.test' });
  const { agent: tool } = await hub.registry.createBot(seller, { name: 'sim-seller-tool', follow: true });
  const { workspace } = await hub.rooms.create(buyer, { goal: 'Agree on a price', invite: seller.email!, side: 'Buyer', bots: [b.id], brief: 'max 100' });
  ws = workspace.id;
  const info = await hub.rooms.joinSide((await hub.registry.get(seller.id))!, ws, { side: 'Seller', bots: [s.id, tool.id], brief: 'min 90' });

  answers[b.id] = async (asked, m, me) => {
    if (asked.startsWith('I ask 120')) return 'I offer 95';
    if (asked.startsWith('I ask 110')) {
      // Answers over MCP, then the push times out, as it did in the dishes room. Not its first turn here: with no cursor yet, its answer alone moves it.
      await hub.send(me, { channel: info.shared, thread: (m.metadata as { a2aHub: { conversationId: string } }).a2aHub.conversationId.split(':')[2]! }, [{ text: 'I offer 98' }]);
      throw new Error('timed out');
    }
    if (asked.startsWith('I ask 108')) return 'ASK MY SIDE: They want 108, our limit is 100. What now?\n- Go to 105\n- Walk away';
    if (/Go to 105/.test(asked)) return 'I offer 105';
    if (asked.startsWith('Deal at 105')) {
      const doc = await hub.rooms.writeDocument(me, ws, 'Price: 105', 0);
      version = doc.version;
      return 'Terms are in the document';
    }
    return undefined; // the start: waits for the seller's opening
  };
  let version = 0;
  answers[s.id] = async (asked) => {
    if (asked.startsWith('Every side')) return 'I ask 120';
    if (asked.startsWith('I offer 95')) return 'I ask 110';
    if (asked.startsWith('I offer 98')) {
      await retry;
      return 'I ask 108';
    }
    if (asked.startsWith('I offer 105')) return 'Deal at 105';
    return undefined;
  };

  await hub.talks.start(ws);
  await queue.idle();

  // The room waits on the buyer's person, and only the ask reached them: the seller's agent heard nothing of it.
  const people = (await hub.registry.get(buyer.id))!;
  expect((await hub.rooms.document(people, ws)).progress.waiting).toMatchObject({ side: buyer.id, options: ['Go to 105', 'Walk away'] });
  expect(said((await hub.chat.take(people)).find((i) => i.message.channelId !== info.shared)!.message.parts)).toMatch(/our limit is 100/);
  expect(log.join('\n')).not.toContain('-> sim-seller-bot: ASK');
  expect(JSON.stringify(log)).not.toContain('sim-seller-bot: sim-buyer-bot is asking');

  const later = new Date(Date.now() + ROOM_REMIND_MS + 1000);
  await hub.talks.remind(later);
  expect((await hub.chat.take(people)).map((i) => said(i.message.parts))).toEqual([expect.stringContaining('The room is still waiting for you')]);
  await hub.talks.remind(new Date(later.getTime() + ROOM_REMIND_MS));
  expect(await hub.chat.take(people)).toHaveLength(0);

  await hub.talks.decide(people, ws, 'Go to 105');
  await queue.idle();
  const before = log.length;
  const person2 = (await hub.registry.get(seller.id))!;
  await hub.rooms.approve(people, ws, version);
  const { agreed } = await hub.rooms.approve(person2, ws, version);
  expect(agreed).toBe(true);
  expect((await hub.rooms.document(people, ws)).progress.waiting).toBeUndefined();

  // Agreed: an agent speaking no longer wakes the other side.
  await hub.send((await hub.registry.get(b.id))!, { channel: info.shared }, [{ text: 'Thanks' }]);
  await queue.idle();
  expect(log.length).toBe(before);

  // The buyer's person calls on the seller's coding tool: its owner says go first.
  const toolAgent = (await hub.registry.get(tool.id))!;
  expect((await hub.chat.take(toolAgent)).map((i) => said(i.message.parts))).toEqual([expect.stringContaining('Every side is here')]);
  await hub.send(people, { channel: info.shared }, [{ text: `@${tool.name} please send the invoice` }]);
  await queue.idle();
  expect(await hub.chat.take(toolAgent)).toHaveLength(0);
  expect((await hub.rooms.appView(ws, (await hub.registry.workspaceById(ws))!.room!)).waiting).toMatchObject({ side: seller.id, options: ['go'] });
  const corner = info.sides.find((x) => x.id === seller.id)!.corner;
  await hub.chat.take(person2);
  await hub.send(person2, { channel: corner }, [{ text: 'go' }]);
  await queue.idle();
  expect(await hub.chat.take(toolAgent)).toHaveLength(1);
  expect((await hub.rooms.appView(ws, (await hub.registry.workspaceById(ws))!.room!)).waiting).toBeUndefined();

  console.log(log.join('\n'));
  expect(log.filter((l) => !l.includes('Every side'))).toEqual([
    '-> sim-buyer-bot: I ask 120',
    '-> sim-seller-bot: I offer 95',
    '-> sim-buyer-bot: I ask 110',
    '-> sim-seller-bot: I offer 98',
    '-> sim-buyer-bot: I ask 108',
    expect.stringMatching(/^-> sim-buyer-bot: .*Go to 105/),
    '-> sim-seller-bot: I offer 105',
    '-> sim-buyer-bot: Deal at 105',
    '-> sim-seller-bot: Terms are in the document',
  ]);
});
