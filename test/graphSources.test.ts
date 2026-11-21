import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/app.js';
import { GraphStore } from '../src/graph/store.js';
import { LlmMeter } from '../src/llm/llm.js';
import { Registry } from '../src/registry/registry.js';
import { crew, testConfig, testDb, testPerson } from './helpers.js';

type Node = { _id: string; kind: string; title: string; text?: string; conversationId: string; workspaceId: string; source?: Record<string, unknown> };

function setup() {
  const db = testDb();
  const hub = createHub({ db, config: testConfig(), fetchCard: async () => ({ name: 'oc', description: '', skills: [] }) });
  const nodes = (filter: object = {}) => db.execute(() => db.mongoDb.collection<Node>('graph_nodes').find(filter).toArray());
  const count = (name: string, filter: object = {}) => db.execute(() => db.mongoDb.collection(name).countDocuments(filter));
  return { db, hub, nodes, count };
}

describe('graph sources', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a workspace skill is one node through create and update; delete drops it and its edges', async () => {
    const { db, hub, nodes, count } = setup();
    const { owner, workspace } = await crew(hub.registry, 'graph-skill', []);
    const skill = await hub.registry.createSkill(owner, { name: 'ship-it', description: 'Use when shipping.', instructions: 'Ship.', scope: 'workspace', id: workspace.id });
    const [node] = await nodes({ 'source.skillId': skill.id });
    expect(node).toMatchObject({ workspaceId: workspace.id, kind: 'skill', title: 'ship-it', text: 'Use when shipping.', source: { kind: 'skill', skillId: skill.id } });

    await hub.registry.updateSkill(owner, skill.id, { name: 'ship-it-now' });
    const after = await nodes({ 'source.skillId': skill.id });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ _id: node!._id, title: 'ship-it-now' });

    const graph = new GraphStore(db, new LlmMeter(db, 1_000_000), { enabled: true, dailyCapMicros: 250_000 });
    const other = (await graph.upsertNode({ workspaceId: workspace.id, conversationId: 'channel:x', kind: 'topic', title: 'deploys' }))!;
    for (const [from, to] of [[node!._id, other], [other, node!._id]]) {
      await graph.upsertEdge({ workspaceId: workspace.id, kind: 'about', from: { id: from!, conversationId: 'channel:x' }, to: { id: to!, conversationId: 'channel:x' } });
    }
    await hub.registry.deleteSkill(owner, skill.id);
    expect(await nodes({ 'source.skillId': skill.id })).toHaveLength(0);
    expect(await count('graph_edges', { workspaceId: workspace.id })).toBe(0);
    expect(await count('graph_nodes', { _id: other })).toBe(1);
  });

  it('a room document is a doc node on the shared channel; side briefs never reach the graph', async () => {
    const { hub, nodes } = setup();
    const a = await testPerson(hub.registry, 'GraphDocA');
    const b = await testPerson(hub.registry, 'GraphDocB');
    const { agent: bot } = await hub.registry.createBot(a, { name: 'graph-doc-bot' });
    const { workspace } = await hub.rooms.create(a, { goal: 'Webhook spec', invite: b.email!, side: 'A', bots: [bot.id], brief: 'SECRET-BRIEF-A' });
    const room = await hub.rooms.joinSide((await hub.registry.get(b.id))!, workspace.id, { side: 'B', bots: [], brief: 'SECRET-BRIEF-B' });
    await hub.rooms.writeBrief((await hub.registry.get(a.id))!, workspace.id, 'SECRET-BRIEF-A2');
    expect(await nodes({ workspaceId: workspace.id })).toHaveLength(0);

    await hub.rooms.writeDocument((await hub.registry.get(bot.id))!, workspace.id, 'POST /events', 0);
    await hub.rooms.writeDocument((await hub.registry.get(b.id))!, workspace.id, 'POST /events with idempotency_key', 1);
    const all = await nodes({ workspaceId: workspace.id });
    expect(all).toHaveLength(1);
    const conversationId = `channel:${room.shared}`;
    expect(all[0]).toMatchObject({ kind: 'doc', conversationId, title: 'Webhook spec', text: 'POST /events with idempotency_key', source: { kind: 'room_doc', workspaceId: workspace.id, conversationId } });
    expect(JSON.stringify(all)).not.toContain('SECRET-BRIEF');

    const owner = (await hub.registry.get(a.id))!;
    await hub.registry.updateChannel(owner, room.shared, { archived: true });
    expect(await nodes({ workspaceId: workspace.id })).toHaveLength(0);
    await hub.registry.updateChannel(owner, room.shared, { archived: false });
    expect(await nodes({ workspaceId: workspace.id })).toEqual([expect.objectContaining({ kind: 'doc', text: 'POST /events with idempotency_key' })]);
  });

  it('a channel-scoped skill is a node tagged with its channel; archiving drops it, restoring brings it back', async () => {
    const { hub, nodes } = setup();
    const { owner, workspace, channel } = await crew(hub.registry, 'graph-chskill', []);
    const skill = await hub.registry.createSkill(owner, { name: 'triage', description: 'Use when triaging.', instructions: 'i', scope: 'channel', id: channel.id });
    const node = { workspaceId: workspace.id, kind: 'skill', source: { kind: 'skill', skillId: skill.id, channelId: channel.id } };
    expect(await nodes({ 'source.skillId': skill.id })).toEqual([expect.objectContaining(node)]);

    await hub.registry.updateChannel(owner, channel.id, { archived: true });
    expect(await nodes({ 'source.skillId': skill.id })).toHaveLength(0);
    await hub.registry.updateChannel(owner, channel.id, { archived: false });
    expect(await nodes({ 'source.skillId': skill.id })).toEqual([expect.objectContaining(node)]);
  });

  it('agent-scoped and unscoped skills get no node', async () => {
    const { hub, nodes } = setup();
    const { owner, members } = await crew(hub.registry, 'graph-noskill', ['graph-noskill-bot']);
    const mine = await hub.registry.createSkill(owner, { name: 'mine', description: 'd', instructions: 'i' });
    const bots = await hub.registry.createSkill(owner, { name: 'bots', description: 'd', instructions: 'i', scope: 'agent', id: members[0]!.id });
    expect(await nodes({ 'source.skillId': { $in: [mine.id, bots.id] } })).toHaveLength(0);
  });

  it('a failing graph sync never breaks the skill write', async () => {
    const registry = new Registry(testDb(), { syncGraph: async () => { throw new Error('graph down'); } });
    const { owner, workspace } = await crew(registry, 'graph-fail', []);
    const skill = await registry.createSkill(owner, { name: 'still-works', description: 'd', instructions: 'i', scope: 'workspace', id: workspace.id });
    await expect(registry.deleteSkill(owner, skill.id)).resolves.toMatchObject({ ok: true });
  });

  it('a failing graph upsert never breaks updateSkill or writeDocument', async () => {
    const { hub } = setup();
    const { owner, workspace } = await crew(hub.registry, 'graph-fail-hub', []);
    const skill = await hub.registry.createSkill(owner, { name: 'sturdy', description: 'd', instructions: 'i', scope: 'workspace', id: workspace.id });
    const a = await testPerson(hub.registry, 'GraphFailA');
    const { workspace: room } = await hub.rooms.create(a, { goal: 'Spec', invite: 'graph-fail-b@example.com', side: 'A', bots: [], brief: 'b' });
    const spy = vi.spyOn(GraphStore.prototype, 'upsertNode').mockRejectedValue(new Error('graph down'));
    await expect(hub.registry.updateSkill(owner, skill.id, { name: 'still-sturdy' })).resolves.toMatchObject({ name: 'still-sturdy' });
    await expect(hub.rooms.writeDocument((await hub.registry.get(a.id))!, room.id, 'text', 0)).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
