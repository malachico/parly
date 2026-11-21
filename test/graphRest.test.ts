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
