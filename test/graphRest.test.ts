import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { channelKey, threadKey } from '../src/chat/chat.js';
import type { GraphStore } from '../src/graph/store.js';
import type { HubService } from '../src/hub/hubService.js';
import { crew, freePort, testConfig, testDb } from './helpers.js';

/** A hub over HTTP; `get(token, path)` the status and body. */
async function serve(config = testConfig()) {
  const port = await freePort();
  const made = createApp({ db: testDb(), config: { ...config, port, publicUrl: `http://127.0.0.1:${port}` } });
  const server = await new Promise<Server>((resolve) => {
    const s = made.app.listen(port, '127.0.0.1', () => resolve(s));
  });
  const get = async (token: string | undefined, path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { hub: made.hub, server, get };
}
const titles = (body: { decisions: { title: string }[] }) => body.decisions.map((d) => d.title).sort();

describe('graph web routes', () => {
  let app: Awaited<ReturnType<typeof serve>>;
  let hub: HubService;
  let tokens: Record<'member' | 'outsider' | 'elsewhere', string>;
  let channel: string;
  let privateChannel: string;

  beforeAll(async () => {
    app = await serve();
    hub = app.hub;
    const w = await crew(hub.registry, 'graph-rest');
    const other = await crew(hub.registry, 'graph-rest-other');
    const bot = async (o: typeof w, name: string) => {
      const { agent, token } = await hub.registry.createBot(o.owner, { name });
      await hub.registry.addToWorkspace(o.owner, o.workspace.id, agent.id);
      await hub.registry.addToChannel(o.owner, o.channel.id, agent.id);
      return { agent, token };
    };
    const member = await bot(w, 'graph-rest-member');
    const outsider = await bot(w, 'graph-rest-outsider');
    const elsewhere = await bot(other, 'graph-rest-elsewhere');
    tokens = { member: member.token, outsider: outsider.token, elsewhere: elsewhere.token };
    channel = w.channel.id;
    privateChannel = (await hub.registry.createChannel(w.owner, w.workspace.id, 'graph-rest-private')).id;
    await hub.registry.addToChannel(w.owner, privateChannel, member.agent.id);
    await hub.registry.updateChannel(w.owner, privateChannel, { open: false });

    const graph = hub.graph as GraphStore;
    const ws = w.workspace.id;
    const pub = { id: '', conversationId: channelKey(channel) };
    const priv = { id: '', conversationId: threadKey(privateChannel, 'p1') };
    pub.id = (await graph.upsertNode({ workspaceId: ws, conversationId: pub.conversationId, kind: 'decision', title: 'Use Mongo for storage', text: 'public reasoning' }))!;
    priv.id = (await graph.upsertNode({ workspaceId: ws, conversationId: priv.conversationId, kind: 'decision', title: 'Mongo secret migration plan', text: 'private reasoning' }))!;
    await graph.upsertEdge({ workspaceId: ws, kind: 'relates_to', from: pub, to: priv });
    await graph.upsertNode({ workspaceId: other.workspace.id, conversationId: channelKey(other.channel.id), kind: 'decision', title: 'Mongo elsewhere', text: 'other reasoning' });
  });

  afterAll(async () => {
    await new Promise((r) => app?.server.close(r));
  });

  it('search: a member sees the private decision, with a link to its thread; an outsider and another workspace never do', async () => {
    const mine = await app.get(tokens.member, '/decisions?q=mongo');
    expect(titles(mine.body)).toEqual(['Mongo secret migration plan', 'Use Mongo for storage']);
    expect(mine.body.decisions.find((d: any) => d.title === 'Mongo secret migration plan').sources).toEqual([{ key: `channel:${privateChannel}`, thread: 'p1', text: 'private reasoning' }]);
    const out = await app.get(tokens.outsider, '/decisions?q=mongo');
    expect(titles(out.body)).toEqual(['Use Mongo for storage']);
    expect(JSON.stringify(out.body)).not.toContain('private');
    expect(titles((await app.get(tokens.elsewhere, '/decisions?q=mongo')).body)).toEqual(['Mongo elsewhere']);
    // Scoped to the private channel: the member gets it, the outsider gets what a missing channel gets.
    expect(titles((await app.get(tokens.member, `/decisions?q=mongo&channel=${privateChannel}`)).body)).toEqual(['Mongo secret migration plan']);
    const scoped = await app.get(tokens.outsider, `/decisions?q=mongo&channel=${privateChannel}`);
    expect(scoped.status).toBe(404);
    expect(JSON.stringify(scoped.body)).not.toContain('private reasoning');
  });

  it("recent: a channel's decisions with their threads', for its members only", async () => {
    expect(titles((await app.get(tokens.member, `/decisions?channel=${privateChannel}`)).body)).toEqual(['Mongo secret migration plan']);
    expect(titles((await app.get(tokens.outsider, `/decisions?channel=${channel}`)).body)).toEqual(['Use Mongo for storage']);
    expect((await app.get(tokens.outsider, `/decisions?channel=${privateChannel}`)).status).toBe(404);
    expect((await app.get(tokens.elsewhere, `/decisions?channel=${channel}`)).status).toBe(404);
  });

  it('related: a thread\'s decisions and what they link to, only where the caller can read', async () => {
    const mine = await app.get(tokens.member, `/decisions/related?channel=${privateChannel}&thread=p1`);
    expect(titles(mine.body)).toEqual(['Mongo secret migration plan', 'Use Mongo for storage']);
    const out = await app.get(tokens.outsider, `/decisions/related?channel=${privateChannel}&thread=p1`);
    expect(out.status).toBe(404);
    expect(JSON.stringify(out.body)).not.toContain('private reasoning');
    expect((await app.get(tokens.elsewhere, `/decisions/related?channel=${privateChannel}&thread=p1`)).status).toBe(404);
  });

  it('needs a token', async () => {
    expect((await app.get(undefined, '/decisions?q=mongo')).status).toBe(401);
    expect((await app.get(undefined, `/decisions/related?channel=${channel}&thread=p1`)).status).toBe(401);
  });

  it('graph off: every route is a quiet empty 200', async () => {
    const off = await serve({ ...testConfig(), contextGraphEnabled: false });
    try {
      const w = await crew(off.hub.registry, 'graph-rest-off', []);
      const { token } = await off.hub.registry.createBot(w.owner, { name: 'graph-rest-off-bot' });
      for (const path of ['/decisions?q=mongo', `/decisions?channel=${w.channel.id}`, `/decisions/related?channel=${w.channel.id}&thread=p1`]) {
        expect(await off.get(token, path)).toEqual({ status: 200, body: { decisions: [] } });
      }
    } finally {
      await new Promise((r) => off.server.close(r));
    }
  });
});

describe('graph explorer routes', () => {
  let app: Awaited<ReturnType<typeof serve>>;
  let tokens: Record<'member' | 'outsider' | 'elsewhere', string>;
  let ids: Record<'pub' | 'priv' | 'dana' | 'storage' | 'hidden' | 'docs', string>;
  let channel: string;
  let privateChannel: string;
  const titlesOf = (nodes: { title: string }[]) => nodes.map((n) => n.title).sort();

  beforeAll(async () => {
    app = await serve();
    const hub = app.hub;
    const w = await crew(hub.registry, 'graph-ex');
    const other = await crew(hub.registry, 'graph-ex-other');
    const bot = async (o: typeof w, name: string) => {
      const { agent, token } = await hub.registry.createBot(o.owner, { name });
      await hub.registry.addToWorkspace(o.owner, o.workspace.id, agent.id);
      await hub.registry.addToChannel(o.owner, o.channel.id, agent.id);
      return { agent, token };
    };
    const member = await bot(w, 'graph-ex-member');
    const outsider = await bot(w, 'graph-ex-outsider');
    const elsewhere = await bot(other, 'graph-ex-elsewhere');
    tokens = { member: member.token, outsider: outsider.token, elsewhere: elsewhere.token };
    channel = w.channel.id;
    privateChannel = (await hub.registry.createChannel(w.owner, w.workspace.id, 'graph-ex-private')).id;
    await hub.registry.addToChannel(w.owner, privateChannel, member.agent.id);
    await hub.registry.updateChannel(w.owner, privateChannel, { open: false });

    const graph = hub.graph as GraphStore;
    const ws = w.workspace.id;
    const at = (conversationId: string) => async (kind: 'decision' | 'person' | 'topic' | 'doc', title: string, text?: string, sourceMessageIds?: string[]) =>
      ({ id: (await graph.upsertNode({ workspaceId: ws, conversationId, kind, title, text, sourceMessageIds }))!, conversationId });
    const pubAt = at(channelKey(channel));
    const pub = await pubAt('decision', 'Use Mongo for storage', 'public reasoning', ['m1']);
    const priv = await at(threadKey(privateChannel, 'p1'))('decision', 'Mongo secret migration plan', 'private reasoning', ['m2']);
    const dana = await pubAt('person', 'Dana');
    const storage = await pubAt('topic', 'Storage');
    // Public, but linked only from the private decision: an outsider must not reach it through that hop.
    const hidden = await pubAt('topic', 'Hidden path');
    const docs = await pubAt('topic', 'Docs hub');
    const edge = (kind: string, from: typeof pub, to: typeof pub) => graph.upsertEdge({ workspaceId: ws, kind, from, to });
    await edge('supersedes', priv, pub);
    await edge('involves', pub, dana);
    await edge('about', dana, storage);
    await edge('about', priv, hidden);
    await edge('about', docs, storage);
    for (let i = 0; i < 35; i++) await edge('about', docs, await pubAt('doc', `Doc ${i}`));
    await graph.upsertNode({ workspaceId: other.workspace.id, conversationId: channelKey(other.channel.id), kind: 'decision', title: 'Mongo elsewhere' });
    ids = { pub: pub.id, priv: priv.id, dana: dana.id, storage: storage.id, hidden: hidden.id, docs: docs.id };
  });

  afterAll(async () => {
    await new Promise((r) => app?.server.close(r));
  });

  it('entries: newest first with per-kind counts, and an unreadable conversation is never listed or counted', async () => {
    const mine = await app.get(tokens.member, '/graph/entries?limit=100');
    expect(mine.status).toBe(200);
    expect(mine.body.counts).toEqual({ decision: 2, person: 1, topic: 3, doc: 35 });
    expect(mine.body.entries[0].title).toBe('Doc 34');
    expect(mine.body.entries.map((e: any) => e.title)).toContain('Mongo secret migration plan');
    const out = await app.get(tokens.outsider, '/graph/entries?limit=100');
    expect(out.body.counts).toEqual({ decision: 1, person: 1, topic: 3, doc: 35 });
    expect(out.body.entries).toHaveLength(40);
    expect(JSON.stringify(out.body)).not.toContain('private');
    expect(JSON.stringify(out.body)).not.toContain('secret');
    expect((await app.get(tokens.elsewhere, '/graph/entries')).body.entries.map((e: any) => e.title)).toEqual(['Mongo elsewhere']);
    expect((await app.get(tokens.outsider, `/graph/entries?channel=${privateChannel}`)).status).toBe(404);
  });

  it('entries: kind filter, channel scope and cursor paging', async () => {
    const decisions = await app.get(tokens.member, '/graph/entries?kind=decision');
    expect(titlesOf(decisions.body.entries)).toEqual(['Mongo secret migration plan', 'Use Mongo for storage']);
    expect(decisions.body.entries.find((e: any) => e.id === ids.priv).sources).toEqual([{ channelId: privateChannel, thread: 'p1', messageIds: ['m2'] }]);
    expect(decisions.body.entries.find((e: any) => e.id === ids.pub)).toMatchObject({ kind: 'decision', summary: 'public reasoning', sources: [{ channelId: channel, messageIds: ['m1'] }] });
    expect(titlesOf((await app.get(tokens.member, `/graph/entries?channel=${privateChannel}`)).body.entries)).toEqual(['Mongo secret migration plan']);
    const p1 = await app.get(tokens.member, '/graph/entries?kind=doc&limit=20');
    expect(p1.body.entries).toHaveLength(20);
    expect(p1.body.nextCursor).toBe('20');
    const p2 = await app.get(tokens.member, `/graph/entries?kind=doc&limit=20&cursor=${p1.body.nextCursor}`);
    expect(p2.body.entries).toHaveLength(15);
    expect(p2.body.nextCursor).toBeNull();
    expect(new Set([...p1.body.entries, ...p2.body.entries].map((e: any) => e.id)).size).toBe(35);
    expect((await app.get(tokens.member, '/graph/entries?kind=nope')).status).toBe(400);
    expect((await app.get(tokens.member, '/graph/entries?cursor=-1')).status).toBe(400);
  });

  it('entries: q searches every kind (or one), only where the caller can read', async () => {
    expect(titlesOf((await app.get(tokens.member, '/graph/entries?q=mongo')).body.entries)).toEqual(['Mongo secret migration plan', 'Use Mongo for storage']);
    expect(titlesOf((await app.get(tokens.outsider, '/graph/entries?q=mongo')).body.entries)).toEqual(['Use Mongo for storage']);
    expect(titlesOf((await app.get(tokens.member, '/graph/entries?q=dana')).body.entries)).toEqual(['Dana']);
    expect((await app.get(tokens.member, '/graph/entries?q=dana&kind=topic')).body.entries).toEqual([]);
  });

  it('node: summary, sources and neighbours by relation; unreadable or unknown is 404', async () => {
    const mine = await app.get(tokens.member, `/graph/node/${ids.pub}`);
    expect(mine.status).toBe(200);
    expect(mine.body.node).toMatchObject({ id: ids.pub, title: 'Use Mongo for storage', summary: 'public reasoning' });
    expect(mine.body.neighbours.supersedes).toEqual([{ id: ids.priv, direction: 'in' }]);
    expect(mine.body.neighbours.involves).toEqual([{ id: ids.dana, direction: 'out' }]);
    const out = await app.get(tokens.outsider, `/graph/node/${ids.pub}`);
    expect(out.body.neighbours.supersedes).toBeUndefined();
    expect(JSON.stringify(out.body)).not.toContain(ids.priv);
    for (const id of [ids.priv, 'no-such-node']) {
      const res = await app.get(tokens.outsider, `/graph/node/${id}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('private reasoning');
    }
    expect((await app.get(tokens.elsewhere, `/graph/node/${ids.pub}`)).status).toBe(404);
    expect((await app.get(tokens.member, `/graph/node/${ids.pub}?depth=3`)).status).toBe(400);
  });

  it('node depth 2: reaches neighbours of neighbours through readable hops only, 30 entries at most', async () => {
    const mine = await app.get(tokens.member, `/graph/node/${ids.pub}?depth=2`);
    const reached = mine.body.nodes.map((n: any) => n.id);
    expect(reached.sort()).toEqual([ids.priv, ids.dana, ids.storage, ids.hidden].sort());
    const kept = new Set([ids.pub, ...reached]);
    expect(mine.body.edges.every((e: any) => kept.has(e.from) && kept.has(e.to))).toBe(true);
    const out = await app.get(tokens.outsider, `/graph/node/${ids.pub}?depth=2`);
    const seen = JSON.stringify(out.body);
    expect(out.body.nodes.map((n: any) => n.id)).toContain(ids.storage);
    expect(seen).not.toContain(ids.priv);
    expect(seen).not.toContain(ids.hidden);
    for (const depth of [1, 2]) {
      const big = await app.get(tokens.member, `/graph/node/${ids.docs}?depth=${depth}`);
      expect(big.body.nodes).toHaveLength(29);
      const capped = new Set([ids.docs, ...big.body.nodes.map((n: any) => n.id)]);
      expect(big.body.edges.every((e: any) => capped.has(e.from) && capped.has(e.to))).toBe(true);
    }
  });

  it('needs a token; graph off is an empty list and a 404 node', async () => {
    expect((await app.get(undefined, '/graph/entries')).status).toBe(401);
    expect((await app.get(undefined, `/graph/node/${ids.pub}`)).status).toBe(401);
    const off = await serve({ ...testConfig(), contextGraphEnabled: false });
    try {
      const w = await crew(off.hub.registry, 'graph-ex-off', []);
      const { token } = await off.hub.registry.createBot(w.owner, { name: 'graph-ex-off-bot' });
      expect(await off.get(token, '/graph/entries?q=mongo')).toEqual({ status: 200, body: { entries: [], counts: {}, nextCursor: null } });
      expect((await off.get(token, '/graph/node/x')).status).toBe(404);
    } finally {
      await new Promise((r) => off.server.close(r));
    }
  });
});
