import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import type { ForwardResult } from '../src/hub/forward.js';
import type { WireMessage } from '../src/lib/wire.js';
import type { HubService } from '../src/hub/hubService.js';
import { workspaceView } from '../src/lib/present.js';
import { testConfig, testDb, testPerson } from './helpers.js';

describe('shared rooms', () => {
  let hub: HubService;
  const sent: WireMessage[] = [];
  beforeAll(() => {
    const forwarder = {
      send: async (_a: unknown, m: WireMessage): Promise<ForwardResult> => {
        sent.push(m);
        return { kind: 'message', message: { messageId: 'r', role: 'ROLE_AGENT', parts: [{ text: 'ok' }] } };
      },
      getTask: async () => { throw new Error('unused'); },
      cancel: async () => {},
    };
    hub = createHub({ db: testDb(), config: testConfig(), forwarder, fetchCard: async () => ({ name: 'oc', description: '', skills: [] }) });
  });

  it('two companies, each with its corner and brief; nothing of one side reaches the other', async () => {
    const malachi = await testPerson(hub.registry, 'Malachi');
    const dana = await testPerson(hub.registry, 'Dana');
    const { agent: api } = await hub.registry.createBot(malachi, { name: 'Acme API' });
    const { agent: integ } = await hub.registry.createBot(dana, { name: 'Northwind integrations' });

    const { workspace } = await hub.rooms.create(malachi, {
      goal: 'Agree on the order-events webhook',
      invite: dana.email!,
      side: 'Acme',
      bots: [api.id],
      brief: 'Do not commit to an SLA above 99.5%.',
    });
    const room = await hub.rooms.joinSide((await hub.registry.get(dana.id))!, workspace.id, { side: 'Northwind', bots: [integ.id], brief: 'We need idempotency keys.' });
    expect(room.sides.map((s) => s.name)).toEqual(['Acme', 'Northwind']);
    const [acme, northwind] = room.sides;

    // Everyone is in the shared channel, labeled by side; each corner holds its side only.
    const [m, d, a, n] = await Promise.all([malachi, dana, api, integ].map(async (x) => (await hub.registry.get(x.id))!));
    for (const x of [m, d, a, n]) expect(x!.channels).toContain(room.shared);
    expect(a!.channels).toContain(acme!.corner);
    expect(n!.channels).toContain(northwind!.corner);
    expect(d!.channels).not.toContain(acme!.corner);
    const shared = (await hub.registry.channelsById([room.shared])).get(room.shared)!;
    expect(shared.roles).toMatchObject({ [api.id]: 'Acme', [integ.id]: 'Northwind', [dana.id]: 'Northwind' });

    // The other side's corner: not joinable, and the room's creator can't manage it either.
    await expect(hub.registry.joinChannel(d!, acme!.corner)).rejects.toMatchObject({ code: 'not_found' });
    await expect(hub.registry.removeFromChannel(m!, northwind!.corner, integ.id)).rejects.toBeTruthy();

    // Each side sees its own corner; briefs never appear in the view.
    const view = workspaceView((await hub.registry.workspaceById(workspace.id))!, d!);
    expect(view.room).toEqual({ goal: 'Agree on the order-events webhook', shared: room.shared, sides: [{ id: malachi.id, name: 'Acme' }, { id: dana.id, name: 'Northwind' }], mySide: { id: dana.id, name: 'Northwind', corner: northwind!.corner } });
    expect(JSON.stringify(view)).not.toContain('99.5');

    // A message in the room reaches Northwind's agent with Northwind's brief, never Acme's.
    await hub.send(m!, { channel: room.shared }, [{ text: 'Proposal: one POST per event' }]);
    const items = await hub.chat.take(n!);
    const [item] = await hub.inboxView(n!, items);
    expect(item).toMatchObject({ room: { goal: 'Agree on the order-events webhook', side: { name: 'Northwind', brief: 'We need idempotency keys.', corner: northwind!.corner } } });
    expect(JSON.stringify(items)).not.toContain('idempotency keys');
    expect(JSON.stringify(item)).not.toContain('99.5');
  });

  it("an endpoint agent gets its own side's brief ahead of the message", async () => {
    const malachi = await testPerson(hub.registry, 'Malachi2');
    const dana = await testPerson(hub.registry, 'Dana2');
    const { agent: claw } = await hub.registry.createBot(dana, { name: 'Northwind claw', url: 'http://remote.test' });
    const { workspace } = await hub.rooms.create(malachi, { goal: 'Webhook', invite: dana.email!, side: 'Acme', bots: [], brief: 'Acme secret' });
    const room = await hub.rooms.joinSide((await hub.registry.get(dana.id))!, workspace.id, { side: 'Northwind', bots: [claw.id], brief: 'Northwind brief' });
    sent.length = 0;
    await hub.send((await hub.registry.get(malachi.id))!, { channel: room.shared }, [{ text: 'hello room' }]);
    await hub.wakeService.idle();
    const toClaw = sent.find((m) => m.parts.some((p) => p.text === 'hello room'))!;
    expect(toClaw.parts[0]!.text).toContain('Northwind brief');
    expect(JSON.stringify(toClaw)).not.toContain('Acme secret');
  });

  it("a side's own agent: in that room only, paid by that side, and briefed like any other", async () => {
    const malachi = await testPerson(hub.registry, 'OwnA');
    const dana = await testPerson(hub.registry, 'OwnB');
    const { workspace, room } = await hub.rooms.create(malachi, { goal: 'Webhook', invite: dana.email!, side: 'Acme', bots: [], brief: 'Acme secret', ownAgent: true });
    const joined = await hub.rooms.joinSide((await hub.registry.get(dana.id))!, workspace.id, { side: 'Northwind', bots: [], brief: 'Northwind brief', ownAgent: true });
    const [acme, northwind] = joined.sides;
    const mine = (await hub.registry.get(acme!.agents![0]!))!;
    const theirs = (await hub.registry.get(northwind!.agents![0]!))!;
    expect(mine).toMatchObject({ cloud: true, payerId: malachi.id, workspaces: [workspace.id] });
    expect(theirs).toMatchObject({ cloud: true, payerId: dana.id, workspaces: [workspace.id] });
    expect(mine.ownerId).toBeUndefined();
    expect([...mine.channels!].sort()).toEqual([room.shared, acme!.corner].sort());
    const briefing = await hub.rooms.briefing(mine, workspace.id);
    expect(briefing?.side).toMatchObject({ name: 'Acme', brief: 'Acme secret' });
    expect(JSON.stringify(briefing)).not.toContain('Northwind brief');
  });

  it('own agent or chosen bots, not both', async () => {
    const owner = await testPerson(hub.registry, 'OwnC');
    const other = await testPerson(hub.registry, 'OwnD');
    const { agent: bot } = await hub.registry.createBot(owner, { name: 'Mine' });
    await expect(hub.rooms.create(owner, { goal: 'x', invite: other.email!, side: 'A', bots: [bot.id], brief: '', ownAgent: true })).rejects.toMatchObject({ code: 'invalid' });
  });

  it("a failed own agent leaves nothing: opening discards the room, joining can be tried again", async () => {
    const owner = await testPerson(hub.registry, 'OwnE');
    const other = await testPerson(hub.registry, 'OwnF');
    const real = hub.registry.createAppRoomAgent.bind(hub.registry);
    const before = (await hub.registry.get(owner.id))!.workspaces?.length ?? 0;
    hub.registry.createAppRoomAgent = () => Promise.reject(new Error('no agent'));
    try {
      await expect(hub.rooms.create(owner, { goal: 'Fails', invite: other.email!, side: 'A', bots: [], brief: '', ownAgent: true })).rejects.toThrow('no agent');
      expect((await hub.registry.get(owner.id))!.workspaces?.length ?? 0).toBe(before);
      hub.registry.createAppRoomAgent = real;
      const { workspace } = await hub.rooms.create((await hub.registry.get(owner.id))!, { goal: 'Works', invite: other.email!, side: 'A', bots: [], brief: '' });
      hub.registry.createAppRoomAgent = () => Promise.reject(new Error('no agent'));
      const joiner = (await hub.registry.get(other.id))!;
      await expect(hub.rooms.joinSide(joiner, workspace.id, { side: 'B', bots: [], brief: '', ownAgent: true })).rejects.toThrow('no agent');
      hub.registry.createAppRoomAgent = real;
      await expect(hub.rooms.joinSide(joiner, workspace.id, { side: 'B', bots: [], brief: '', ownAgent: true })).resolves.toMatchObject({ sides: [{ name: 'A' }, { name: 'B' }] });
    } finally {
      hub.registry.createAppRoomAgent = real;
    }
  });

  it('a failure after the own agent is made leaves no live agent, and joining can be tried again', async () => {
    const owner = await testPerson(hub.registry, 'OwnG');
    const other = await testPerson(hub.registry, 'OwnH');
    const { workspace } = await hub.rooms.create(owner, { goal: 'Late failure', invite: other.email!, side: 'A', bots: [], brief: 'keep me' });
    const joiner = (await hub.registry.get(other.id))!;
    const real = hub.registry.setRoomRole.bind(hub.registry);
    const made: string[] = [];
    hub.registry.setRoomRole = (_channel, id) => {
      made.push(id);
      return Promise.reject(new Error('role write failed'));
    };
    try {
      await expect(hub.rooms.joinSide(joiner, workspace.id, { side: 'B', bots: [], brief: '', ownAgent: true })).rejects.toThrow('role write failed');
    } finally {
      hub.registry.setRoomRole = real;
    }
    expect((await hub.registry.get(made[0]!))!.archived).toBe(true);
    const room = await hub.rooms.joinSide((await hub.registry.get(other.id))!, workspace.id, { side: 'B', bots: [], brief: '', ownAgent: true });
    expect(room.sides.map((s) => s.name)).toEqual(['A', 'B']);
    expect((await hub.registry.get(room.sides[1]!.agents![0]!))!.archived).toBeFalsy();
  });

  it('a person reads and changes their own side\'s brief, its agent gets the new one, the other side gets neither', async () => {
    const malachi = await testPerson(hub.registry, 'BriefA');
    const dana = await testPerson(hub.registry, 'BriefB');
    const stranger = await testPerson(hub.registry, 'BriefC');
    const { agent: bot } = await hub.registry.createBot(malachi, { name: 'Acme bot' });
    const { workspace } = await hub.rooms.create(malachi, { goal: 'x', invite: dana.email!, side: 'Acme', bots: [bot.id], brief: 'old' });
    await hub.rooms.joinSide((await hub.registry.get(dana.id))!, workspace.id, { side: 'Beta', bots: [], brief: 'Beta brief' });
    const a = (await hub.registry.get(malachi.id))!;
    const d = (await hub.registry.get(dana.id))!;
    expect(await hub.rooms.readBrief(a, workspace.id)).toEqual({ brief: 'old' });
    await hub.rooms.writeBrief(a, workspace.id, '  new  ');
    expect(await hub.rooms.readBrief(a, workspace.id)).toEqual({ brief: 'new' });
    expect((await hub.rooms.briefing((await hub.registry.get(bot.id))!, workspace.id))?.side?.brief).toBe('new');
    expect(await hub.rooms.readBrief(d, workspace.id)).toEqual({ brief: 'Beta brief' });
    await expect(hub.rooms.readBrief(stranger, workspace.id)).rejects.toBeDefined();
    await expect(hub.rooms.writeBrief(stranger, workspace.id, 'x')).rejects.toBeDefined();
    await expect(hub.rooms.writeBrief((await hub.registry.get(bot.id))!, workspace.id, 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.rooms.writeBrief(a, workspace.id, 'x'.repeat(4001))).rejects.toMatchObject({ code: 'invalid' });
    expect(await hub.rooms.readBrief(d, workspace.id)).toEqual({ brief: 'Beta brief' });
  });

  it('a shared document: versions on top of what you read, approvals per side, cleared by any change', async () => {
    const owner = await testPerson(hub.registry, 'DocA');
    const other = await testPerson(hub.registry, 'DocB');
    const { agent: bot } = await hub.registry.createBot(owner, { name: 'doc-bot' });
    const { workspace } = await hub.rooms.create(owner, { goal: 'Spec', invite: other.email!, side: 'A', bots: [bot.id], brief: '' });
    const b = (await hub.registry.get(other.id))!;
    await hub.rooms.joinSide(b, workspace.id, { side: 'B', bots: [], brief: '' });
    const a = (await hub.registry.get(owner.id))!;
    const agent = (await hub.registry.get(bot.id))!;

    const v1 = await hub.rooms.writeDocument(agent, workspace.id, 'POST /events', 0);
    expect(v1.version).toBe(1);
    await expect(hub.rooms.writeDocument(b, workspace.id, 'stale', 0)).rejects.toMatchObject({ code: 'conflict' });
    await expect(hub.rooms.approve(agent, workspace.id, 1)).rejects.toMatchObject({ code: 'forbidden' });

    expect((await hub.rooms.approve(a, workspace.id, 1)).agreed).toBe(false);
    expect((await hub.rooms.approve(b, workspace.id, 1)).agreed).toBe(true);
    // Agents in the room get the document, and who approved it.
    expect(await hub.rooms.briefing(agent, workspace.id)).toMatchObject({ doc: { version: 1, text: 'POST /events', approvedBy: ['A', 'B'] } });

    // A change is a new version: nobody has approved it.
    await hub.rooms.writeDocument(b, workspace.id, 'POST /events with idempotency_key', 1);
    const now = await hub.rooms.document(a, workspace.id);
    expect(now).toMatchObject({ doc: { version: 2, approvals: {} }, agreed: false });
    // The version it replaced is there to compare.
    expect(now.previous).toEqual({ version: 1, text: 'POST /events', updatedByName: 'doc-bot' });
    await expect(hub.rooms.approve(a, workspace.id, 1)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a double submit makes one side and one corner', async () => {
    const owner = await testPerson(hub.registry, 'DoubleOwner');
    const other = await testPerson(hub.registry, 'DoubleOther');
    const { workspace } = await hub.rooms.create(owner, { goal: 'Twice', invite: other.email!, side: 'A', bots: [], brief: '' });
    const b = (await hub.registry.get(other.id))!;
    const results = await Promise.allSettled([0, 1].map(() => hub.rooms.joinSide(b, workspace.id, { side: 'B', bots: [], brief: '' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const room = (await hub.registry.workspaceById(workspace.id))!.room!;
    expect(room.sides.map((s) => s.name)).toEqual(['A', 'B']);
    const mine = await hub.registry.channelsOf((await hub.registry.get(other.id))!, workspace.id);
    expect(mine.filter((c) => c.name === 'B corner')).toHaveLength(1);
  });

  it('refuses a second side from the same person and bots that are not theirs', async () => {
    const owner = await testPerson(hub.registry, 'Owner');
    const other = await testPerson(hub.registry, 'Other');
    const { agent: notMine } = await hub.registry.createBot(other, { name: 'not mine' });
    await expect(hub.rooms.create(owner, { goal: 'x', invite: other.email!, side: 'A', bots: [notMine.id], brief: '' })).rejects.toMatchObject({ code: 'not_found' });
    const { workspace } = await hub.rooms.create(owner, { goal: 'x', invite: other.email!, side: 'A', bots: [], brief: '' });
    await expect(hub.rooms.joinSide((await hub.registry.get(owner.id))!, workspace.id, { side: 'B', bots: [], brief: '' })).rejects.toMatchObject({ code: 'conflict' });
  });
});
