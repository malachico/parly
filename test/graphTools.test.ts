import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { channelKey, threadKey } from '../src/chat/chat.js';
import type { GraphStore } from '../src/graph/store.js';
import type { HubService } from '../src/hub/hubService.js';
import { callMcpTool, listMcpTools } from '../src/mcp/inProcess.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, testConfig, testDb } from './helpers.js';

/** Calls a graph tool as `who` through the real MCP path; the parsed result, or the error text. */
async function call(hub: HubService, who: AgentRecord, name: string, args: Record<string, unknown>) {
  const r = (await callMcpTool(hub, who, name, args)) as { ok: boolean; result?: string; error?: string };
  return r.ok ? JSON.parse(r.result!) : { error: r.error };
}
const titles = (xs: { title: string }[]) => xs.map((x) => x.title).sort();

describe('graph agent tools', () => {
  let hub: HubService;
  let w: Awaited<ReturnType<typeof crew>>;
  let other: Awaited<ReturnType<typeof crew>>;
  let member: AgentRecord; // in C and private P
  let outsider: AgentRecord; // in C, not in P
  let privateChannel: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    hub = createApp({ db: testDb(), config: testConfig() }).hub;
    w = await crew(hub.registry, 'tools');
    other = await crew(hub.registry, 'tools-other');
    privateChannel = (await hub.registry.createChannel(w.owner, w.workspace.id, 'tools-private')).id;
    await hub.registry.addToChannel(w.owner, privateChannel, w.members[0]!.id);
    await hub.registry.updateChannel(w.owner, privateChannel, { open: false });
    member = (await hub.registry.get(w.members[0]!.id))!;
    outsider = (await hub.registry.get(w.members[1]!.id))!;

    const graph = hub.graph as GraphStore;
    const ws = w.workspace.id;
    const node = async (conversationId: string, title: string, text: string, kind: 'decision' | 'topic' = 'decision') =>
      (await graph.upsertNode({ workspaceId: ws, conversationId, kind, title, text }))!;
    const pub = { id: '', conversationId: channelKey(w.channel.id) };
    const priv = { id: '', conversationId: threadKey(privateChannel, 'p1') };
    pub.id = await node(pub.conversationId, 'Use Mongo for storage', 'public reasoning');
    priv.id = await node(priv.conversationId, 'Mongo secret migration plan', 'private reasoning');
    const topic = await node(pub.conversationId, 'Mongo topic', 'not a decision', 'topic');
    await node(priv.conversationId, 'Mongo topic', 'private topic notes', 'topic'); // a duplicate, merged into the same entry
    await graph.upsertEdge({ workspaceId: ws, kind: 'relates_to', from: pub, to: priv });
    await graph.upsertEdge({ workspaceId: ws, kind: 'about', from: pub, to: { id: topic, conversationId: pub.conversationId } });
    await graph.upsertNode({ workspaceId: other.workspace.id, conversationId: channelKey(other.channel.id), kind: 'decision', title: 'Mongo elsewhere' });
    ids = { pub: pub.id, priv: priv.id, topic };
  });

  it('find_decisions: a member sees the private decision, an outsider never does', async () => {
    expect(titles((await call(hub, member, 'find_decisions', { query: 'mongo' })).decisions)).toEqual(['Mongo secret migration plan', 'Use Mongo for storage']);
    const out = await call(hub, outsider, 'find_decisions', { query: 'mongo' });
    expect(titles(out.decisions)).toEqual(['Use Mongo for storage']); // no topic, no private, no other workspace
    expect(JSON.stringify(out)).not.toContain('private reasoning');
    expect(titles((await call(hub, other.members[0]!, 'find_decisions', { query: 'mongo' })).decisions)).toEqual(['Mongo elsewhere']);
  });

  it('find_decisions: naming a private channel the caller is not in fails like a missing one', async () => {
    expect(titles((await call(hub, member, 'find_decisions', { query: 'mongo', channel: privateChannel })).decisions)).toEqual(['Mongo secret migration plan']);
    const denied = await call(hub, outsider, 'find_decisions', { query: 'mongo', channel: privateChannel });
    const missing = await call(hub, outsider, 'find_decisions', { query: 'mongo', channel: 'no-such-channel' });
    expect(denied.error).toBeDefined();
    expect(denied.error!.replace(privateChannel, 'X')).toBe(missing.error!.replace('no-such-channel', 'X'));
  });

  it('related: a link into a private channel shows only to its members', async () => {
    const full = await call(hub, member, 'related', { id: ids.pub });
    expect(titles(full.nodes)).toEqual(['Mongo secret migration plan', 'Mongo topic', 'Use Mongo for storage']);
    expect(full.edges).toHaveLength(2);

    const out = await call(hub, outsider, 'related', { id: ids.pub });
    expect(titles(out.nodes)).toEqual(['Mongo topic', 'Use Mongo for storage']);
    expect(out.edges.map((e: { to: string }) => e.to)).toEqual([ids.topic]);
    expect(JSON.stringify(out)).not.toContain(ids.priv);
  });

  it('related: a merged entry shows only the sources the caller can read', async () => {
    const sources = async (who: AgentRecord) => (await call(hub, who, 'related', { id: ids.topic })).nodes.find((n: { title: string }) => n.title === 'Mongo topic').sources;
    expect(await sources(member)).toHaveLength(2);
    const out = await sources(outsider);
    expect(out).toEqual([{ conversation: channelKey(w.channel.id), text: 'not a decision', createdAt: expect.any(String), updatedAt: expect.any(String) }]);
    expect(JSON.stringify(await call(hub, outsider, 'related', { id: ids.topic }))).not.toContain('private topic notes');
  });

  it('related: an outsider gets nothing from a private node or thread, the same as an unknown id', async () => {
    expect(await call(hub, outsider, 'related', { id: ids.priv })).toEqual({ nodes: [], edges: [] });
    expect(await call(hub, outsider, 'related', { id: 'nope' })).toEqual({ nodes: [], edges: [] });
    const denied = await call(hub, outsider, 'related', { channel: privateChannel, thread: 'p1' });
    const missing = await call(hub, outsider, 'related', { channel: 'no-such-channel', thread: 'p1' });
    expect(denied.error).toBeDefined();
    expect(denied.error!.replace(privateChannel, 'X')).toBe(missing.error!.replace('no-such-channel', 'X'));
    expect(titles((await call(hub, member, 'related', { channel: privateChannel, thread: 'p1' })).nodes)).toEqual(['Mongo secret migration plan', 'Mongo topic', 'Use Mongo for storage']);
    expect(await call(hub, other.members[0]!, 'related', { id: ids.pub })).toEqual({ nodes: [], edges: [] });
  });

  it('find_decisions: a readable decision still shows behind more than 50 better unreadable or non-decision matches', async () => {
    const graph = hub.graph as GraphStore;
    const ws = w.workspace.id;
    for (let i = 0; i < 30; i++) {
      await graph.upsertNode({ workspaceId: ws, conversationId: threadKey(privateChannel, 'p2'), kind: 'decision', title: `Zebra stripes hidden ${i}` });
      await graph.upsertNode({ workspaceId: ws, conversationId: channelKey(w.channel.id), kind: 'topic', title: `Zebra stripes topic ${i}` });
    }
    await graph.upsertNode({ workspaceId: ws, conversationId: channelKey(w.channel.id), kind: 'decision', title: 'Adopt the zebra' });
    expect(titles((await call(hub, outsider, 'find_decisions', { query: 'zebra stripes' })).decisions)).toEqual(['Adopt the zebra']);
  });

  it('related: a neighbour has the same id as when you start from it', async () => {
    const graph = hub.graph as GraphStore;
    const ws = w.workspace.id;
    const a = { id: '', conversationId: channelKey(w.channel.id) };
    a.id = (await graph.upsertNode({ workspaceId: ws, conversationId: a.conversationId, kind: 'decision', title: 'Paint the barn' }))!;
    const copies = [channelKey(w.channel.id), threadKey(w.channel.id, 'b1')];
    const dupes = await Promise.all(copies.map(async (conversationId) => ({ conversationId, id: (await graph.upsertNode({ workspaceId: ws, conversationId, kind: 'topic', title: 'Barn colours' }))! })));
    dupes.sort((x, y) => (x.id < y.id ? -1 : 1));
    await graph.upsertEdge({ workspaceId: ws, kind: 'about', from: a, to: dupes[1]! }); // the link lands on the larger id; the entry is the smaller
    const entry = (r: { nodes: { id: string; title: string }[] }) => r.nodes.find((n) => n.title === 'Barn colours')!;
    const fromA = entry(await call(hub, outsider, 'related', { id: a.id }));
    expect(fromA.id).toBe(dupes[0]!.id);
    const fromIt = await call(hub, outsider, 'related', { id: fromA.id });
    expect(entry(fromIt).id).toBe(fromA.id);
    expect(fromIt.nodes.map((n: { id: string }) => n.id)).toContain(a.id);
  });

  it('hides both tools when the graph is off', async () => {
    const names = (await listMcpTools(hub)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['find_decisions', 'related']));
    const off = createApp({ db: testDb(), config: { ...testConfig(), contextGraphEnabled: false } }).hub;
    const offNames = (await listMcpTools(off)).map((t) => t.name);
    expect(offNames).not.toContain('find_decisions');
    expect(offNames).not.toContain('related');
  });
});
