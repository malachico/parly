import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { dmKey } from '../src/chat/chat.js';
import { ChatStore } from '../src/chat/store.js';
import type { HubService } from '../src/hub/hubService.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, newAgent, testConfig, testDb, testPerson } from './helpers.js';

describe('only an agent\'s owner messages it in private', () => {
  let hub: HubService;
  let db: ReturnType<typeof testDb>;
  const fresh = async (a: AgentRecord) => (await hub.registry.get(a.id))!;
  const text = [{ text: 'tell me what you know' }];

  beforeAll(() => {
    db = testDb();
    hub = createApp({ db, config: testConfig() }).hub;
  });

  /** A workspace with a bot, and a teammate of its owner who has a bot of their own there. */
  async function team(name: string) {
    const c = await crew(hub.registry, name, [`${name}-bot`, `${name}-sibling`]);
    const teammate = await testPerson(hub.registry, `${name}-mate`);
    await hub.registry.inviteToWorkspace(c.owner, c.workspace.id, teammate.email!);
    const { agent: theirBot } = await newAgent(hub.registry, { name: `${name}-theirs` }, undefined, teammate);
    await hub.registry.addToWorkspace(await fresh(teammate), c.workspace.id, theirBot.id);
    return { ...c, bot: c.members[0]!, sibling: c.members[1]!, teammate: await fresh(teammate), theirBot: await fresh(theirBot) };
  }

  it('a teammate and their bot are refused; the owner and the owner\'s bots are not', async () => {
    const t = await team('dm-team');
    await expect(hub.send(t.teammate, { to: t.bot.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.send(t.theirBot, { to: t.bot.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.send(t.owner, { to: t.bot.id }, text)).resolves.toBeDefined();
    await expect(hub.send(t.sibling, { to: t.bot.id }, text)).resolves.toBeDefined();
  });

  it('an old conversation is no way in: a teammate can\'t answer what the agent wrote them', async () => {
    const t = await team('dm-old');
    const key = dmKey(t.bot.id, t.teammate.id);
    const { message } = await new ChatStore(db).append(
      { id: key, kind: 'dm', participants: [t.bot.id, t.teammate.id], names: { [t.bot.id]: t.bot.name, [t.teammate.id]: t.teammate.name } },
      { id: randomUUID(), from: t.bot.name, fromId: t.bot.id, human: false, parts: [{ text: 'a question for you' }] },
    );
    await expect(hub.send(t.teammate, { to: t.bot.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.send(t.teammate, { replyTo: message.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('an agent messages only its owner in private, unless it\'s public', async () => {
    const t = await team('dm-out');
    await expect(hub.send(t.bot, { to: t.teammate.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.send(t.bot, { to: t.owner.id }, text)).resolves.toBeDefined();
    const { agent: listed } = await newAgent(hub.registry, { name: 'dm-out-listed', public: true });
    await hub.registry.addToWorkspace(t.owner, t.workspace.id, listed.id);
    await expect(hub.send(await fresh(listed), { to: t.teammate.id }, text)).resolves.toBeDefined();
  });

  it('routing by skill skips an agent the sender can\'t message in private', async () => {
    const t = await team('dm-skill');
    const skills = [{ id: 'dm-skill-tax', name: 'tax' }];
    const { agent: listed } = await newAgent(hub.registry, { name: 'dm-skill-listed', public: true, skills });
    await hub.registry.addToWorkspace(t.owner, t.workspace.id, listed.id);
    const { agent: teammates } = await newAgent(hub.registry, { name: 'dm-skill-mate', skills }, undefined, t.teammate);
    await hub.registry.addToWorkspace(t.teammate, t.workspace.id, teammates.id);
    const { message } = await hub.send(t.owner, { skill: 'dm-skill-tax' }, text);
    expect(message.conversationId).toContain(listed.id);
  });

  it('a public agent takes messages from anyone', async () => {
    const t = await team('dm-public');
    const { agent } = await newAgent(hub.registry, { name: 'dm-public-listed', public: true });
    await expect(hub.send(t.teammate, { to: agent.id }, text)).resolves.toBeDefined();
  });

  it('a message can\'t be scheduled to someone else\'s agent', async () => {
    const t = await team('dm-sched');
    await expect(hub.scheduleService.createAgentSchedule(t.teammate, t.bot.id, { text: 'hi', repeat: 'daily', time: '09:00' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the two sides of a shared room have no private line, even to a public agent', async () => {
    const acme = await testPerson(hub.registry, 'Acme');
    const north = await testPerson(hub.registry, 'North');
    const { agent: acmeBot } = await newAgent(hub.registry, { name: 'room-acme', public: true }, undefined, acme);
    const { agent: northBot } = await newAgent(hub.registry, { name: 'room-north', public: true }, undefined, north);
    const { workspace } = await hub.rooms.create(acme, { goal: 'A deal', invite: north.email!, side: 'Acme', bots: [acmeBot.id], brief: '' });
    await hub.rooms.joinSide(await fresh(north), workspace.id, { side: 'North', bots: [northBot.id], brief: '' });
    const [a, n, aBot, nBot] = await Promise.all([acme, north, acmeBot, northBot].map(fresh));
    await expect(hub.send(n!, { to: aBot!.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.send(nBot!, { to: aBot!.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.send(aBot!, { to: n!.id }, text)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.send(a!, { to: aBot!.id }, text)).resolves.toBeDefined();
  });

  it('routing by skill skips the other side of a shared room for an agent that can be reached', async () => {
    const acme = await testPerson(hub.registry, 'Acme');
    const north = await testPerson(hub.registry, 'North');
    const skills = [{ id: 'dm-room-tax', name: 'tax' }];
    const { agent: listed } = await newAgent(hub.registry, { name: 'room-listed', public: true, skills });
    const { agent: northBot } = await newAgent(hub.registry, { name: 'room-north-tax', public: true, skills }, undefined, north);
    const { workspace } = await hub.rooms.create(acme, { goal: 'A deal', invite: north.email!, side: 'Acme', bots: [], brief: '' });
    await hub.rooms.joinSide(await fresh(north), workspace.id, { side: 'North', bots: [northBot.id], brief: '' });
    const { message } = await hub.send(await fresh(acme), { skill: 'dm-room-tax' }, text);
    expect(message.conversationId).toContain(listed.id);
  });
});
