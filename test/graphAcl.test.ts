import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { channelKey, dmKey, threadKey } from '../src/chat/chat.js';
import { readableGraph } from '../src/graph/acl.js';
import type { HubService } from '../src/hub/hubService.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, testConfig, testDb } from './helpers.js';

const node = (_id: string, workspaceId: string, conversationId: string) => ({ _id, workspaceId, conversationId, kind: 'topic', title: _id });
const edge = (from: { _id: string; workspaceId: string; conversationId: string }, to: { _id: string; conversationId: string }) => ({
  workspaceId: from.workspaceId, kind: 'rel', from: from._id, to: to._id, fromConversationId: from.conversationId, toConversationId: to.conversationId,
});
const ids = (xs: { _id: string }[]) => xs.map((x) => x._id).sort();

describe('graph read-permission filter', () => {
  let hub: HubService;
  /** Workspace W: the owner, bots x and y in channel C; a private channel P with the owner and x only. Workspace W2 elsewhere. */
  let w: Awaited<ReturnType<typeof crew>>;
  let other: Awaited<ReturnType<typeof crew>>;
  let reader: AgentRecord;
  let privateChannel: string;
  const see = (who: AgentRecord, nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[] = []) => readableGraph(who, hub.chat, { nodes, edges });

  beforeAll(async () => {
    hub = createApp({ db: testDb(), config: testConfig() }).hub;
    w = await crew(hub.registry, 'acl');
    other = await crew(hub.registry, 'acl-other');
    privateChannel = (await hub.registry.createChannel(w.owner, w.workspace.id, 'acl-private')).id;
    await hub.registry.addToChannel(w.owner, privateChannel, w.members[0]!.id);
    await hub.registry.updateChannel(w.owner, privateChannel, { open: false });
    w.owner = (await hub.registry.get(w.owner.id))!;
    w.members[0] = (await hub.registry.get(w.members[0]!.id))!;
    reader = w.members[1]!; // bot y: in W and C, not in P
  });

  it('shows what the reader can read: its channel, a thread there, its own DM', async () => {
    const [x, y] = w.members as [AgentRecord, AgentRecord];
    const nodes = [node('c', w.workspace.id, channelKey(w.channel.id)), node('t', w.workspace.id, threadKey(w.channel.id, 'p1')), node('dm', w.workspace.id, dmKey(x.id, y.id))];
    const out = await see(reader, nodes, [edge(nodes[0]!, nodes[1]!), edge(nodes[1]!, nodes[2]!)]);
    expect(ids(out.nodes)).toEqual(['c', 'dm', 't']);
    expect(out.edges).toHaveLength(2);
  });

  it('hides another workspace, even under a conversation id the reader can read', async () => {
    const mine = node('mine', w.workspace.id, channelKey(w.channel.id));
    const out = await see(reader, [
      mine,
      node('theirs', other.workspace.id, channelKey(other.channel.id)),
      node('relabelled', other.workspace.id, channelKey(w.channel.id)), // claims W2, sourced from C
      node('smuggled', w.workspace.id, channelKey(other.channel.id)), // claims W, sourced from C2
    ]);
    expect(ids(out.nodes)).toEqual(['mine']);
    expect(ids((await see(other.members[0]!, [mine])).nodes)).toEqual([]);
  });

  it('hides a private channel and its threads from non-members, not from members', async () => {
    const nodes = [node('c', w.workspace.id, channelKey(w.channel.id)), node('p', w.workspace.id, channelKey(privateChannel)), node('pt', w.workspace.id, threadKey(privateChannel, 'p1'))];
    expect(ids((await see(reader, nodes)).nodes)).toEqual(['c']);
    expect(ids((await see(w.members[0]!, nodes)).nodes)).toEqual(['c', 'p', 'pt']);
  });

  it("hides a DM the reader isn't party to; a bot's owner sees its DMs", async () => {
    const [x, y] = w.members as [AgentRecord, AgentRecord];
    const nodes = [node('xy', w.workspace.id, dmKey(x.id, y.id)), node('x-owner', w.workspace.id, dmKey(x.id, w.owner.id)), node('x-stranger', w.workspace.id, dmKey(x.id, other.owner.id))];
    expect(ids((await see(reader, nodes)).nodes)).toEqual(['xy']);
    expect(ids((await see(w.owner, nodes)).nodes)).toEqual(['x-owner', 'x-stranger', 'xy']);
    expect(ids((await see({ ...other.owner, workspaces: [...other.owner.workspaces, w.workspace.id] }, nodes)).nodes)).toEqual(['x-stranger']); // a human in W who doesn't own x: only its own DM
  });

  it('hides an edge with one hidden end, whether that end is in the result or only named on the edge', async () => {
    const c = node('c', w.workspace.id, channelKey(w.channel.id));
    const c2 = node('c2', w.workspace.id, threadKey(w.channel.id, 'p2'));
    const p = node('p', w.workspace.id, channelKey(privateChannel));
    const out = await see(reader, [c, c2, p], [
      edge(c, c2), // both visible
      edge(c, p), // to a private channel
      edge(p, c), // from one
      { ...edge(c, c2), to: p._id }, // records a readable conversation for an end that is hidden here
    ]);
    expect(ids(out.nodes)).toEqual(['c', 'c2']);
    expect(out.edges).toEqual([edge(c, c2)]);
    // An end missing from the result hides the edge, whatever conversations it records.
    expect((await see(reader, [c], [edge(c, c2)])).edges).toEqual([]);
    // So does an edge that records a readable conversation for an end node that isn't readable.
    expect((await see(reader, [c, p], [{ ...edge(c, p), toConversationId: c.conversationId }])).edges).toEqual([]);
  });

  it("never shows a room side's brief, not even to that side's owner", async () => {
    const brief = node('brief', w.workspace.id, `${w.workspace.id}_${w.owner.id}`); // room_briefs doc id
    const c = node('c', w.workspace.id, channelKey(w.channel.id));
    const out = await see(w.owner, [c, brief], [edge(c, brief)]);
    expect(ids(out.nodes)).toEqual(['c']);
    expect(out.edges).toEqual([]);
  });

  it("hides an edge in another workspace even when both its ends are visible", async () => {
    const c = node('c', w.workspace.id, channelKey(w.channel.id));
    const c2 = node('c2', w.workspace.id, threadKey(w.channel.id, 'p3'));
    expect((await see(reader, [c, c2], [{ ...edge(c, c2), workspaceId: other.workspace.id }])).edges).toEqual([]);
  });

  it('fails closed on missing fields', async () => {
    const c = node('c', w.workspace.id, channelKey(w.channel.id));
    const c2 = node('c2', w.workspace.id, threadKey(w.channel.id, 'p4'));
    const none = undefined as unknown as string;
    const broken = [{ ...c, _id: 'no-conv', conversationId: none }, { ...c, _id: 'no-ws', workspaceId: none }, { ...c, _id: none }];
    const out = await see(reader, [c, c2, ...broken], [
      { ...edge(c, c2), toConversationId: none }, { ...edge(c, c2), to: none }, { ...edge(c, c2), from: none }, { ...edge(c, c2), workspaceId: none },
    ]);
    expect(out.nodes.map((n) => n._id).sort()).toEqual(['c', 'c2']);
    expect(out.edges).toEqual([]);
  });

  it('checks a whole result in one registry lookup', async () => {
    const [x, y] = w.members as [AgentRecord, AgentRecord];
    const nodes = [dmKey(x.id, other.owner.id), dmKey(y.id, other.owner.id), dmKey(x.id, w.owner.id), channelKey(w.channel.id)].map((k, i) => node(`n${i}`, w.workspace.id, k));
    const getMany = vi.spyOn(hub.registry, 'getMany');
    try {
      expect(ids((await see(w.owner, nodes, [edge(nodes[0]!, nodes[1]!), edge(nodes[1]!, nodes[2]!)])).nodes)).toEqual(['n0', 'n1', 'n2', 'n3']);
      expect(getMany).toHaveBeenCalledTimes(1);
    } finally { getMany.mockRestore(); }
  });

  it('readableConversations agrees with canRead', async () => {
    const [x, y] = w.members as [AgentRecord, AgentRecord];
    const convs = [channelKey(w.channel.id), channelKey(privateChannel), dmKey(x.id, y.id), dmKey(x.id, other.owner.id), dmKey(y.id, other.owner.id), dmKey(other.members[0]!.id, other.owner.id)];
    const getMany = vi.spyOn(hub.registry, 'getMany');
    try {
      const readable = await hub.chat.readableConversations(w.owner, [...convs, ...convs, 'not-a-key']);
      expect(getMany).toHaveBeenCalledTimes(1);
      // Pinned, not just compared, since canRead now delegates here: the owner reads its channels and its bots' DMs, not another owner's bot's.
      expect(convs.map((id) => readable.has(id))).toEqual([true, true, true, true, true, false]);
      for (const id of convs) expect(readable.has(id)).toBe(await hub.chat.canRead(w.owner, id));
      expect(readable.has('not-a-key')).toBe(false);
      await expect(hub.chat.canRead(w.owner, 'not-a-key')).rejects.toMatchObject({ code: 'invalid' });
    } finally { getMany.mockRestore(); }
  });
});
