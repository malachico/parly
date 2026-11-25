import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import type { InboxItem } from '../src/chat/chatService.js';
import type { ForwardResult } from '../src/hub/forward.js';
import type { HubService } from '../src/hub/hubService.js';
import { messageView } from '../src/lib/present.js';
import { textOf, type WireMessage } from '../src/lib/wire.js';
import type { AgentRecord } from '../src/registry/types.js';
import { renderBriefing, ROOM_REMIND_MS, ROOM_TURNS } from '../src/rooms/rooms.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const said = (i: InboxItem | undefined) => textOf({ parts: i?.message.parts ?? [] });

describe("a room's agents negotiate by themselves", () => {
  let hub: HubService;
  const sent: WireMessage[] = [];
  beforeAll(() => {
    const forwarder = {
      send: async (_a: unknown, m: WireMessage): Promise<ForwardResult> => {
        sent.push(m);
        return { kind: 'task', task: { id: `down-${sent.length}`, contextId: m.contextId ?? 'ctx-room', status: { state: 'TASK_STATE_COMPLETED' } } };
      },
      getTask: async (): Promise<never> => {
        throw new Error('unused');
      },
      cancel: async () => {},
    };
    hub = createHub({ db: testDb(), config: testConfig(), forwarder: forwarder as never, fetchCard: async () => ({ name: 'oc', description: '', skills: [] }) });
  });

  const inbox = async (agent: AgentRecord) => hub.chat.take((await hub.registry.get(agent.id))!);
  const answer = (agent: AgentRecord, item: InboxItem | undefined, text: string) => hub.send(agent, { replyTo: item!.message.id }, [{ text }]);

  async function room(name: string) {
    const buyer = await testPerson(hub.registry, `${name}-buyer`);
    const seller = await testPerson(hub.registry, `${name}-seller`);
    const { agent: b } = await hub.registry.createBot(buyer, { name: `${name}-buyer-bot` });
    const { agent: s } = await hub.registry.createBot(seller, { name: `${name}-seller-bot` });
    const { workspace } = await hub.rooms.create(buyer, { goal: 'Agree on a price', invite: seller.email!, side: 'Buyer', bots: [b.id], brief: 'max 100' });
    const info = await hub.rooms.joinSide((await hub.registry.get(seller.id))!, workspace.id, { side: 'Seller', bots: [s.id], brief: 'min 90' });
    await hub.talks.start(workspace.id);
    const get = async (id: string) => (await hub.registry.get(id))!;
    return { ws: workspace.id, shared: info.shared, buyer: await get(buyer.id), seller: await get(seller.id), b: await get(b.id), s: await get(s.id) };
  }

  it('starts by itself, and each answer goes to the other side only, until DONE', async () => {
    const r = await room('talks');
    // The start reaches both agents, from the room's moderator, and is handed to no person.
    const [kb] = await inbox(r.b);
    const [ks] = await inbox(r.s);
    expect(said(kb)).toMatch(/Every side is here/);
    expect(kb!.message.from).toBe('Moderator');
    expect(ks).toBeDefined();
    expect(await inbox(r.buyer)).toHaveLength(0);
    expect((await hub.rooms.briefing(r.b, r.ws))!.rules).toMatch(/DONE/);

    await answer(r.s, ks, 'I ask 120');
    // The room knows whose move it is: the seller spoke, the buyer is next.
    expect((await hub.rooms.document(r.buyer, r.ws)).progress).toMatchObject({ turns: 1, lastSide: r.seller.id });
    const [toBuyer] = await inbox(r.b);
    expect(said(toBuyer)).toBe('I ask 120');
    // Not back to the seller's own agent, nor handed to the people (who read it in the room).
    expect(await inbox(r.s)).toHaveLength(0);
    expect(await inbox(r.seller)).toHaveLength(0);

    await answer(r.b, toBuyer, 'I offer 95');
    const [toSeller] = await inbox(r.s);
    expect(said(toSeller)).toBe('I offer 95');
    const moderator = (await hub.registry.get((await hub.registry.workspaceById(r.ws))!.room!.moderator!))!;
    expect(await inbox(moderator)).toHaveLength(0);

    await answer(r.s, toSeller, 'DONE');
    expect(await inbox(r.b)).toHaveLength(0);
  });

  it(`stops after ${ROOM_TURNS} turns with no new document version, and a person restarts it`, async () => {
    const r = await room('stuck');
    await inbox(r.b);
    let [item] = await inbox(r.s);
    let [who, other] = [r.s, r.b];
    for (let i = 0; i < ROOM_TURNS; i++) {
      await answer(who, item, `turn ${i}`);
      [item] = await inbox(other);
      expect(said(item)).toBe(`turn ${i}`);
      [who, other] = [other, who];
    }
    await answer(who, item, 'one more');
    expect(await inbox(other)).toHaveLength(0);
    expect((await hub.rooms.document(r.buyer, r.ws)).stuck).toBe(true);

    await hub.send(r.buyer, { channel: r.shared }, [{ text: 'carry on, offer 98' }]);
    expect((await hub.rooms.document(r.buyer, r.ws)).stuck).toBeUndefined();
    const [fromPerson] = await inbox(r.b);
    expect(said(fromPerson)).toBe('carry on, offer 98');
    await answer(r.b, fromPerson, 'I offer 98');
    expect((await inbox(r.s)).map(said)).toContain('I offer 98');
  });

  it('once agreed, the talks stop; an approved version is for people to replace, not agents', async () => {
    const r = await room('agreed');
    await inbox(r.b);
    const [ks] = await inbox(r.s);
    const v1 = await hub.rooms.writeDocument(r.s, r.ws, 'Price: 97', 0);
    await hub.rooms.approve(r.seller, r.ws, v1.version);
    await expect(hub.rooms.writeDocument(r.b, r.ws, 'Price: 80', v1.version)).rejects.toMatchObject({ code: 'forbidden' });
    await hub.rooms.approve(r.buyer, r.ws, v1.version);
    expect((await hub.rooms.document(r.buyer, r.ws)).agreed).toBe(true);
    await expect(hub.rooms.writeDocument(r.s, r.ws, 'Price: 99', v1.version)).rejects.toMatchObject({ code: 'forbidden' });

    await answer(r.s, ks, 'Thanks, done deal');
    expect(await inbox(r.b)).toHaveLength(0);
  });

  it('an agent at the limit of its brief asks its side; the decision goes back to it, and on into the room', async () => {
    const r = await room('decide');
    await inbox(r.b); // the start
    const [ks] = await inbox(r.s);
    await answer(r.s, ks, 'I ask 110');
    const [toBuyer] = await inbox(r.b);
    const asking = await answer(r.b, toBuyer, 'ASK MY SIDE: They want 110, our limit is 100. What now?\n- Go to 110\n- Walk away');

    // Not a turn: the seller hears nothing; in the room, the question shows only as asked.
    expect(await inbox(r.s)).toHaveLength(0);
    expect(textOf({ parts: asking.message.parts })).toMatch(/is asking its side/);
    expect(JSON.stringify(asking.message)).not.toMatch(/our limit is 100/);
    // The buyer's person is asked in their corner; the room waits.
    const [asked] = await inbox(r.buyer);
    expect(said(asked)).toMatch(/our limit is 100/);
    expect((await hub.rooms.document(r.buyer, r.ws)).progress.waiting).toEqual({ side: r.buyer.id, question: 'They want 110, our limit is 100. What now?', options: ['Go to 110', 'Walk away'] });
    await expect(hub.talks.decide(r.seller, r.ws, 'Walk away')).rejects.toMatchObject({ code: 'conflict' });

    await hub.talks.decide(r.buyer, r.ws, 'Go to 110');
    expect((await hub.rooms.document(r.buyer, r.ws)).progress.waiting).toBeUndefined();
    const [decision] = await inbox(r.b);
    expect(said(decision)).toMatch(/Decision from Buyer: Go to 110/);
    expect(decision!.message.from).toBe('Moderator');
    await answer(r.b, decision, 'We accept 110');
    const [toSeller] = await inbox(r.s);
    expect(said(toSeller)).toBe('We accept 110');
    // In the room thread the talks were in.
    expect(toSeller!.message.post).toBe(toBuyer!.message.post);

    // A person answering by writing in their corner counts too.
    await answer(r.s, toSeller, 'Deal at 110, and delivery?');
    const [again] = await inbox(r.b);
    await answer(r.b, again, 'ASK MY SIDE: Do we need delivery?\n- Yes\n- No');
    await inbox(r.buyer);
    const corner = (await hub.rooms.briefing(r.b, r.ws))!.side!.corner;
    await hub.send(r.buyer, { channel: corner }, [{ text: 'No, we pick it up' }]);
    const [typed] = await inbox(r.b);
    expect(said(typed)).toBe('No, we pick it up');
    await answer(r.b, typed, 'No delivery needed, we collect');
    expect((await inbox(r.s)).map(said)).toContain('No delivery needed, we collect');
  });

  it('an endpoint agent keeps one conversation for the whole room', async () => {
    const r = await room('memory');
    const { agent: oc } = await hub.registry.createBot(r.seller, { name: 'memory-oc', url: 'http://remote.test' });
    await hub.registry.addToWorkspace(r.seller, r.ws, oc.id);
    await hub.registry.addToChannel(r.seller, r.shared, oc.id);
    sent.length = 0;
    // A person's posts go to everyone in the room, its agents included.
    await hub.send(r.buyer, { channel: r.shared }, [{ text: 'first thread' }]);
    await hub.wakeService.idle();
    const first = sent.find((m) => m.parts.some((p) => p.text === 'first thread'))!;
    expect(first.contextId).toBeUndefined();
    await hub.send(r.buyer, { channel: r.shared }, [{ text: 'a new post, another thread' }]);
    await hub.wakeService.idle();
    expect(sent.at(-1)!.contextId).toBe('ctx-room');
  });

  it("gates a side's own coding tool (followsOwner) until its owner approves in their corner, while waking directly for its owner", async () => {
    const malachi = await testPerson(hub.registry, 'gate-malachi');
    const initech = await testPerson(hub.registry, 'gate-initech');
    const { agent: cline } = await hub.registry.createBot(malachi, { name: "Malachi's Cline", follow: true });
    const { agent: claude } = await hub.registry.createBot(malachi, { name: "Malachi's Claude", follow: true });
    const { agent: partnerBot } = await hub.registry.createBot(initech, { name: 'Initech Bot' });
    const { workspace } = await hub.rooms.create(malachi, {
      goal: 'Integrate Hooli ads',
      invite: initech.email!,
      side: 'Globex',
      bots: [cline.id, claude.id],
      brief: 'Only check webhook schema.',
    });
    const info = await hub.rooms.joinSide((await hub.registry.get(initech.id))!, workspace.id, {
      side: 'Initech',
      bots: [partnerBot.id],
      brief: '',
    });
    const get = async (id: string) => (await hub.registry.get(id))!;
    const globexCorner = info.sides.find((s) => s.id === malachi.id)!.corner;

    // 1. Plain "hi" from Initech (no @mention): Malachi receives the shared message, and NO corner "go?" spam is created.
    await hub.send(await get(initech.id), { channel: info.shared }, [{ text: 'hi Malachi!' }]);
    const malachiItems0 = await inbox(await get(malachi.id));
    expect(malachiItems0.map((i) => said(i))).toEqual(['hi Malachi!']);
    expect(await inbox(await get(cline.id))).toHaveLength(0);

    // 2. Initech @mentions Malachi's Cline in the shared channel: Malachi gets both the shared message AND the corner prompt; Cline is NOT woken.
    const askPost = await hub.send(await get(initech.id), { channel: info.shared }, [{ text: "@Malachi's Cline check our webhook payload" }]);
    expect(await inbox(await get(cline.id))).toHaveLength(0);
    const feed = await hub.eventsView(await get(cline.id), '1970-01-01T00:00:00.000Z', 0);
    expect(feed.events.find((e) => e.id === askPost.message.id)?.forYou).toBe(false);

    const malachiItems1 = await inbox(await get(malachi.id));
    const sharedItem = malachiItems1.find((i) => i.conversation.channelId === info.shared);
    const cornerPrompt = malachiItems1.find((i) => i.conversation.channelId === globexCorner);
    expect(said(sharedItem)).toBe("@Malachi's Cline check our webhook payload");
    expect(said(cornerPrompt)).toMatch(/check our webhook payload/);
    expect(said(cornerPrompt)).toMatch(/What you write here goes to the room\. To ask your side, use ASK MY SIDE/);

    // 3. Malachi replies in the corner prompt's thread: Cline wakes, and if it first asks ASK MY SIDE privately, that stays in the corner.
    await hub.send(await get(malachi.id), { channel: globexCorner, thread: cornerPrompt!.message.id }, [{ text: 'go, only check the schema' }]);
    const [woken] = await inbox(await get(cline.id));
    expect(said(woken)).toBe('go, only check the schema');
    await answer(await get(cline.id), woken, 'ASK MY SIDE: Can I mention field X?');
    expect((await hub.chat.readThread(await get(malachi.id), info.shared, askPost.message.id)).map((m) => m.parts[0]?.text)).not.toContain(
      'ASK MY SIDE: Can I mention field X?',
    );

    // Malachi answers the private question in the corner thread, and Cline's first answer after that goes to the shared room,
    // while a private follow-up without a new "go" stays in the corner.
    await hub.send(await get(malachi.id), { channel: globexCorner, thread: cornerPrompt!.message.id }, [{ text: 'yes, field X is fine' }]);
    const [woken2] = await inbox(await get(cline.id));
    await answer(await get(cline.id), woken2, 'Schema verified: 200 OK (with field X).');
    await answer(await get(cline.id), woken2, 'Private note to Malachi: done checking.');

    const sharedThread = await hub.chat.readThread(await get(malachi.id), info.shared, askPost.message.id);
    expect(sharedThread.map((m) => m.parts[0]?.text)).toContain('Schema verified: 200 OK (with field X).');
    expect(sharedThread.map((m) => m.parts[0]?.text)).not.toContain('Private note to Malachi: done checking.');

    // 4. In a thread where Cline already took part, a follow-up from Initech without an @mention prompts in the corner for Cline (not Claude).
    await inbox(await get(malachi.id)); // clear corner inbox
    await hub.send(await get(initech.id), { channel: info.shared, thread: askPost.message.id }, [{ text: 'what about the timestamp header?' }]);
    const followItems = await inbox(await get(malachi.id));
    const followCorner = followItems.filter((i) => i.conversation.channelId === globexCorner);
    expect(followCorner).toHaveLength(1);
    expect(said(followCorner[0])).toMatch(/wake Malachi's Cline/);

    // 5. Go-prompts never overwrite a pending ASK MY SIDE decision, and replying in a go-prompt thread wakes its agent without consuming waiting.
    const { agent: broker } = await hub.registry.createBot(malachi, { name: 'Globex Broker', follow: true });
    await hub.registry.addToWorkspace(malachi, workspace.id, broker.id);
    await hub.registry.addToChannel(malachi, info.shared, broker.id);
    await hub.registry.addToChannel(malachi, globexCorner, broker.id);
    await hub.send(await get(broker.id), { channel: info.shared }, [{ text: 'ASK MY SIDE: Price 10 or 12?\n- 10\n- 12' }]);
    expect((await hub.rooms.document(await get(malachi.id), workspace.id)).progress.waiting).toEqual({
      side: malachi.id,
      question: 'Price 10 or 12?',
      options: ['10', '12'],
    });

    await hub.send(await get(initech.id), { channel: info.shared }, [{ text: "@Malachi's Cline and @Malachi's Claude compare notes" }]);
    // Pending ASK MY SIDE decision is preserved even after outside @mentions trigger go-prompts.
    expect((await hub.rooms.document(await get(malachi.id), workspace.id)).progress.waiting).toEqual({
      side: malachi.id,
      question: 'Price 10 or 12?',
      options: ['10', '12'],
    });

    const cornerMsgs = (await hub.chat.page(await get(malachi.id), `channel:${globexCorner}`, 20)).messages.slice(-3);
    const askPrompt = cornerMsgs.find((m) => m.fromId === broker.id)!;
    const clinePrompt = cornerMsgs.find((m) => m.meta?.agent === cline.id)!;
    const claudePrompt = cornerMsgs.find((m) => m.meta?.agent === claude.id)!;

    // Replying in Claude's and Cline's prompt threads wakes each agent without consuming the room's waiting decision.
    await hub.send(await get(malachi.id), { channel: globexCorner, thread: claudePrompt.id }, [{ text: 'go Claude' }]);
    expect(said((await inbox(await get(claude.id)))[0])).toBe('go Claude');
    expect((await hub.rooms.document(await get(malachi.id), workspace.id)).progress.waiting?.question).toBe('Price 10 or 12?');

    await hub.send(await get(malachi.id), { channel: globexCorner, thread: clinePrompt.id }, [{ text: 'go Cline' }]);
    expect(said((await inbox(await get(cline.id)))[0])).toBe('go Cline');
    expect((await hub.rooms.document(await get(malachi.id), workspace.id)).progress.waiting?.question).toBe('Price 10 or 12?');

    // Answering the ASK MY SIDE prompt in its own thread resolves and clears the room's waiting decision.
    await hub.send(await get(malachi.id), { channel: globexCorner, thread: askPrompt.id }, [{ text: '12' }]);
    expect((await hub.rooms.document(await get(malachi.id), workspace.id)).progress.waiting).toBeUndefined();
    const brokerItems = await inbox(await get(broker.id));
    const brokerDecision = brokerItems.find((i) => said(i) === '12')!;
    expect(brokerDecision).toBeDefined();
    await answer(await get(broker.id), brokerDecision, 'We offer 12');
    expect((await inbox(await get(partnerBot.id))).map(said)).toContain('We offer 12');

    // A later unrelated top-level message in the corner is not hijacked as a decision for Globex Broker.
    const later = await hub.send(await get(malachi.id), { channel: globexCorner }, [{ text: 'note to self: check invoices' }]);
    expect(later.message.meta).toBeUndefined();
    expect(later.message.to).toBeUndefined();
    expect(await inbox(await get(cline.id))).toHaveLength(1);

    // 6. When Malachi himself writes in the shared channel, his own coding tool wakes immediately without a corner gate.
    await hub.send(await get(malachi.id), { channel: info.shared }, [{ text: "@Malachi's Cline status update please" }]);
    const [direct] = await inbox(await get(cline.id));
    expect(said(direct)).toBe("@Malachi's Cline status update please");
  });

  it('counts a retried post with the same id once', async () => {
    const r = await room('retry');
    await hub.chat.post(r.s, { channelId: r.shared }, { parts: [{ text: 'offer 95' }], id: 'retry-fixed-id' });
    const turns = async () => (await hub.rooms.appView(r.ws, (await hub.registry.workspaceById(r.ws))!.room!)).progress.turns;
    const before = await turns();
    expect(before).toBeGreaterThan(0);
    await hub.chat.post(r.s, { channelId: r.shared }, { parts: [{ text: 'offer 95' }], id: 'retry-fixed-id' });
    expect(await turns()).toBe(before);
  });

  it("tells each agent which side it speaks for, as text and in the structured briefing, without the other side's corner or brief", async () => {
    const r = await room('sides');
    const b = (await hub.rooms.briefing(r.s, r.ws))!;
    expect(b.side!.identity).toContain('"your side", "we" and "us" always mean Seller, and the other side is Buyer');
    const text = renderBriefing(b);
    expect(text).toContain(b.side!.identity);
    expect(text).not.toContain('max 100');
    const buyerSide = (await hub.registry.workspaceById(r.ws))!.room!.sides.find((x) => x.id === r.buyer.id)!;
    expect(text).not.toContain(buyerSide.corner);
  });

  describe('a go-prompt is a room decision', () => {
    async function gated(name: string, botNames = ['tool']) {
      const owner = await testPerson(hub.registry, `${name}-owner`);
      const guest = await testPerson(hub.registry, `${name}-guest`);
      const tools = [];
      for (const n of botNames) tools.push((await hub.registry.createBot(owner, { name: `${name}-${n}`, follow: true })).agent);
      const { workspace } = await hub.rooms.create(owner, { goal: 'Dishes', invite: guest.email!, side: 'Owner', bots: tools.map((t) => t.id), brief: '' });
      const info = await hub.rooms.joinSide((await hub.registry.get(guest.id))!, workspace.id, { side: 'Guest', bots: [], brief: '' });
      const get = async (id: string) => (await hub.registry.get(id))!;
      const view = async () => hub.rooms.appView(workspace.id, (await hub.registry.workspaceById(workspace.id))!.room!);
      const mention = async (who: string) => hub.send(await get(guest.id), { channel: info.shared }, [{ text: `@${who} please wash up` }]);
      const corner = info.sides.find((s) => s.id === owner.id)!;
      return { ws: workspace.id, shared: info.shared, corner, owner: await get(owner.id), guest: await get(guest.id), tools: await Promise.all(tools.map((t) => get(t.id))), view, mention, get };
    }

    it('waits as needs_decision, fires the event, and a reply in the corner thread clears it', async () => {
      const g = await gated('go-status');
      const events: unknown[] = [];
      const sink = hub.rooms.onEvent;
      hub.rooms.onEvent = (_w, type, data) => void events.push([type, data]);
      await g.mention(g.tools[0]!.name);
      hub.rooms.onEvent = sink;
      expect((await g.view()).waiting).toMatchObject({ side: g.owner.id, options: ['go'] });
      expect(events).toMatchObject([['room.needs_decision', { side: g.owner.id, options: ['go'] }]]);
      const prompt = (await inbox(g.owner)).find((i) => i.message.fromId !== g.guest.id)!;
      await hub.send(g.owner, { channel: g.corner.corner, thread: prompt.message.id }, [{ text: 'go' }]);
      expect((await g.view()).waiting).toBeUndefined();
      expect(await inbox(g.tools[0]!)).toHaveLength(1);
    });

    it('answered through the decisions API it wakes the agent, with the room thread', async () => {
      const g = await gated('go-api');
      const posted = await g.mention(g.tools[0]!.name);
      await hub.talks.decideSide(g.ws, g.corner, 'go');
      const [wake] = await inbox(g.tools[0]!);
      expect(said(wake)).toContain('Decision from Owner: go');
      expect(wake!.message.meta).toMatchObject({ roomThread: posted.message.id, agent: g.tools[0]!.id });
    });

    it('keeps the first of several, and leaves an ask alone', async () => {
      const g = await gated('go-two', ['a', 'b']);
      await hub.rooms.ask(g.ws, { side: g.owner.id, agent: g.tools[1]!.id, question: 'Remote?', options: ['yes', 'no'] });
      await g.mention(g.tools[0]!.name);
      expect((await g.view()).waiting!.question).toBe('Remote?');
      const other = await gated('go-three', ['a', 'b']);
      await hub.send(other.guest, { channel: other.shared }, [{ text: `@${other.tools[0]!.name} @${other.tools[1]!.name} wash up` }]);
      const first = (await other.view()).waiting;
      expect(first!.options).toEqual(['go']);
      // The other tool speaking takes nothing from the first tool's prompt.
      await hub.send(other.tools[1]!, { channel: other.shared }, [{ text: 'hello' }]);
      expect((await other.view()).waiting).toEqual(first);
    });

    it("clears when the agent speaks anyway, but an ask doesn't", async () => {
      const g = await gated('go-stale');
      await g.mention(g.tools[0]!.name);
      await hub.send(g.tools[0]!, { channel: g.shared }, [{ text: 'on it' }]);
      expect((await g.view()).waiting).toBeUndefined();
      await hub.rooms.ask(g.ws, { side: g.owner.id, agent: g.tools[0]!.id, question: 'Remote?', options: ['yes', 'no'] });
      await hub.send(g.tools[0]!, { channel: g.shared }, [{ text: 'still here' }]);
      expect((await g.view()).waiting!.question).toBe('Remote?');
    });

    it('clears when its person speaks in the shared channel, not when the other side does', async () => {
      const g = await gated('go-person');
      await g.mention(g.tools[0]!.name);
      await hub.send(g.guest, { channel: g.shared }, [{ text: 'any news?' }]);
      expect((await g.view()).waiting).toBeDefined();
      await inbox(g.owner);
      await hub.send(g.owner, { channel: g.shared }, [{ text: 'I have this one' }]);
      expect((await g.view()).waiting).toBeUndefined();
      await hub.talks.remind(new Date(Date.now() + ROOM_REMIND_MS + 1000));
      expect((await inbox(g.owner)).filter((i) => said(i).includes('still waiting'))).toHaveLength(0);
    });

    it('reminds its people once, after ROOM_REMIND_MS', async () => {
      const g = await gated('go-remind');
      await g.mention(g.tools[0]!.name);
      await inbox(g.owner);
      await hub.talks.remind(new Date());
      expect(await inbox(g.owner)).toHaveLength(0);
      const later = new Date(Date.now() + ROOM_REMIND_MS + 1000);
      await Promise.all([hub.scheduleService.runSchedules(later), hub.talks.remind(later)]);
      const reminders = await inbox(g.owner);
      expect(reminders.map((i) => said(i))).toEqual([expect.stringContaining('The room is still waiting for you')]);
      expect(reminders[0]!.message.channelId).toBe(g.corner.corner);
      // Sent as the waiting agent, marked automatic: it doesn't wake the agent or answer the decision.
      expect(reminders[0]!.message.fromId).toBe(g.tools[0]!.id);
      expect(reminders[0]!.message.meta?.scheduled).toBe(true);
      expect(messageView(reminders[0]!.message).scheduled).toBe(true);
      expect(await inbox(g.tools[0]!)).toHaveLength(0);
      expect((await g.view()).waiting).toBeDefined();
      await hub.talks.remind(new Date(later.getTime() + ROOM_REMIND_MS));
      expect(await inbox(g.owner)).toHaveLength(0);
      // Answered at the top level of the corner, the same as an ask.
      await hub.send(g.owner, { channel: g.corner.corner }, [{ text: 'go' }]);
      expect((await g.view()).waiting).toBeUndefined();
      expect(await inbox(g.tools[0]!)).toHaveLength(1);
    });

    it("reminds from the moderator when the agent isn't in the corner", async () => {
      const g = await gated('go-remind-mod');
      await g.mention(g.tools[0]!.name);
      await inbox(g.owner);
      await hub.registry.leaveChannel(g.tools[0]!, g.corner.corner);
      await hub.talks.remind(new Date(Date.now() + ROOM_REMIND_MS + 1000));
      const [reminder] = await inbox(g.owner);
      expect(said(reminder)).toContain('The room is still waiting for you');
      expect(reminder!.message.fromId).not.toBe(g.tools[0]!.id);
      expect(reminder!.message.meta?.scheduled).toBe(true);
      expect(messageView(reminder!.message).scheduled).toBe(true);
    });
  });
});
