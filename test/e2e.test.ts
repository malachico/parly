/**
 * End to end over real HTTP: the hub app, the example echo agent (A2A endpoint), MCP clients
 * acting as mailbox agents, and a stock A2A client talking to the hub itself.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Message } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { MAILBOX_EXTENSION_URI } from '../src/a2a/agentCard.js';
import { createApp } from '../src/app.js';
import { startEchoAgent } from '../examples/echo-agent.js';
import { runClientExample } from '../examples/client.js';
import { runMailboxAgent } from '../examples/mailbox-agent.js';
import { connectHub, type HubMcp } from '../examples/mcp.js';
import { crewOverHttp, newAgentOverHttp, testConfig, testDb, freePort } from './helpers.js';

interface MessageView {
  id: string;
  conversation: string;
  seq: number;
  from: string;
  fromId: string;
  text: string;
  mentions?: string[];
  thread?: string;
}
type Sent = { message: MessageView; reply?: MessageView };
type Item = { messageId: string; conversation: string; from: string; text: string; channel?: string; thread?: string; earlier?: { text: string }[] };

type Registered = Awaited<ReturnType<typeof newAgentOverHttp>>;
type Who = { token: string; id: string };

async function register(hubUrl: string, name: string, isPublic = true): Promise<{ mcp: HubMcp; token: string; id: string; reg: Registered }> {
  const reg = await newAgentOverHttp(hubUrl, { name, public: isPublic });
  return { mcp: await connectHub(hubUrl, reg.token), token: reg.token, id: reg.agent.id, reg };
}

describe('e2e', () => {
  let hubUrl: string;
  let hubServer: Server;
  let echoServer: Server;
  let alice: Awaited<ReturnType<typeof register>>;
  let bob: Awaited<ReturnType<typeof register>>;
  let echoId: string;

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl, maxWaitMs: 5_000 }) });
    hubServer = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });

    const echo = await startEchoAgent(await freePort());
    echoServer = echo.server;
    echoId = (await newAgentOverHttp(hubUrl, { url: echo.url, public: true })).agent.id;

    alice = await register(hubUrl, 'alice');
    bob = await register(hubUrl, 'bob');
  });

  afterAll(async () => {
    await Promise.all([alice?.mcp.close(), bob?.mcp.close()]);
    await new Promise((r) => hubServer?.close(r));
    await new Promise((r) => echoServer?.close(r));
  });

  it('lists agents publicly', async () => {
    const agents = (await (await fetch(`${hubUrl}/agents`)).json()) as { name: string; kind: string }[];
    expect(agents.map((a) => `${a.name}:${a.kind}`).sort()).toEqual(['alice:mailbox', 'bob:mailbox', 'echo:endpoint']);
  });


  it('private agents: invisible until they share a workspace, over MCP', async () => {
    const p1 = await register(hubUrl, 'private-one', false);
    const p2 = await register(hubUrl, 'private-two', false);
    const names = async (mcp: HubMcp) => (await mcp.call<{ name: string }[]>('list_agents')).map((a) => a.name);
    expect(await names(p1.mcp)).not.toContain('private-two');
    await expect(p1.mcp.call('send_message', { to: p2.id, text: 'hi', wait: false })).rejects.toThrow(/available to you/);

    // p1's owner signed in, so they have a workspace of their own; a bot cannot make one.
    await expect(p1.mcp.call('create_workspace', { name: 'nope' })).rejects.toThrow(/Only people/);
    expect((await p1.mcp.call<{ workspaces: unknown[] }>('whoami')).workspaces).toEqual([]);
    const owner1 = await connectHub(hubUrl, p1.reg.owner.token);
    const ws = p1.reg.owner.workspaceId;

    // The owner adds their bot, invites p2's owner by email (a person: not addable by id), who adds p2.
    await owner1.call('add_to_workspace', { workspace: ws, agent: p1.id });
    await expect(owner1.call('add_to_workspace', { workspace: ws, agent: p2.reg.owner.id })).rejects.toThrow(/available to you/);
    await owner1.call('invite_to_workspace', { workspace: ws, email: p2.reg.owner.email });
    const owner2 = await connectHub(hubUrl, p2.reg.owner.token);
    await owner2.call('add_to_workspace', { workspace: ws, agent: p2.id });
    expect(await names(p1.mcp)).toContain('private-two');
    expect(((await (await fetch(`${hubUrl}/agents`)).json()) as { name: string }[]).map((a) => a.name)).not.toContain('private-two');

    // A channel with just the two bots; p1 posts, p2 gets it; a direct message to another's bot is refused.
    const channel = await p1.mcp.call<{ id: string }>('create_channel', { workspace: ws, name: 'pair' });
    await p1.mcp.call('add_to_channel', { channel: 'pair', agent: p2.id });
    const posted = await p1.mcp.call<Sent>('send_message', { channel: channel.id, text: 'hi colleague', wait: false });
    await expect(p1.mcp.call('send_message', { to: p2.id, thread: 'x', text: 'x' })).rejects.toThrow(/only apply to channel/);
    await expect(p1.mcp.call('send_message', { to: p2.id, text: 'hi colleague, directly', wait: false })).rejects.toThrow(/owner can message it in private/);
    const items = await p2.mcp.call<Item[]>('check_inbox');
    expect(items).toMatchObject([{ messageId: posted.message.id, text: 'hi colleague', channel: 'pair' }]);
    expect(await p2.mcp.call('check_inbox')).toEqual([]);
    await Promise.all([p1.mcp.close(), p2.mcp.close(), owner1.close(), owner2.close()]);
  });

  it('MCP agent -> A2A endpoint agent: the answer comes back in the conversation', async () => {
    const sent = await alice.mcp.call<Sent>('send_message', { to: echoId, text: 'ping' });
    expect(sent.reply).toMatchObject({ from: 'echo', text: 'echo: ping' });
  });

  it('MCP agent -> MCP mailbox agent, with long-poll on both sides', async () => {
    const sent = await alice.mcp.call<Sent>('send_message', { to: bob.id, text: 'are you there?', wait: false });
    expect(sent.reply).toBeUndefined();
    const [item] = await bob.mcp.call<Item[]>('wait_for_message', { timeoutSeconds: 5 });
    expect(item).toMatchObject({ messageId: sent.message.id, from: 'alice', text: 'are you there?' });

    const replyWait = alice.mcp.call<Sent>('wait_for_reply', { messageId: sent.message.id, timeoutSeconds: 5 });
    await bob.mcp.call('reply', { messageId: item!.messageId, text: 'yes!' });
    expect((await replyWait).reply).toMatchObject({ from: 'bob', text: 'yes!' });
  });

  it('stock A2A client -> hub -> mailbox agent: a message is a task, completed by the first answer', async () => {
    const authedFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${alice.token}`);
      return fetch(input, { ...init, headers });
    };
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authedFetch })] }).createFromUrl(hubUrl);
    const sent = await client.sendMessage({
      tenant: '',
      message: Message.fromJSON({ messageId: 'a2a-1', role: 'ROLE_USER', parts: [{ text: 'via a2a' }], metadata: { to: bob.id } }),
      configuration: { acceptedOutputModes: [], taskPushNotificationConfig: undefined, returnImmediately: true },
      metadata: undefined,
    });
    const taskId = (sent as { id: string }).id;

    const [item] = await bob.mcp.call<Item[]>('check_inbox');
    expect(item).toMatchObject({ messageId: taskId, from: 'alice', text: 'via a2a' });
    await bob.mcp.call('reply', { messageId: taskId, text: 'got it over a2a' });

    const task = await client.getTask({ tenant: '', id: taskId });
    const json = (await import('@a2a-js/sdk')).Task.toJSON(task) as { status: { state: string; message: { parts: { text: string }[] } } };
    expect(json.status.state).toBe('TASK_STATE_COMPLETED');
    expect(json.status.message.parts[0]?.text).toBe('got it over a2a');
  });

  it('A2A-only mailbox agent: finds what is new with ListTasks and answers with SendMessage', async () => {
    const rpc = async (token: string, method: string, params: unknown) => {
      const res = await fetch(`${hubUrl}/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'a2a-version': '1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as { result?: any; error?: { message: string } };
    };
    const card = (await (await fetch(`${hubUrl}/.well-known/agent-card.json`)).json()) as any;
    expect(card.capabilities.extensions?.map((e: { uri: string }) => e.uri)).toContain(MAILBOX_EXTENSION_URI);
    expect(card.securitySchemes.oauthDevice.oauth2SecurityScheme.flows.deviceCode.deviceAuthorizationUrl).toBe(`${hubUrl}/device_authorization`);

    const sent = await alice.mcp.call<Sent>('send_message', { to: bob.id, text: 'implement login', wait: false });
    const listed = await rpc(bob.token, 'ListTasks', {});
    expect(listed.error).toBeUndefined();
    expect(listed.result.tasks.map((t: any) => t.id)).toContain(sent.message.id);

    const done = await rpc(bob.token, 'SendMessage', { message: { messageId: crypto.randomUUID(), taskId: sent.message.id, role: 'ROLE_AGENT', parts: [{ text: 'pushed' }] } });
    expect(done.error).toBeUndefined();
    expect((await rpc(bob.token, 'ListTasks', {})).result.tasks.map((t: any) => t.id)).not.toContain(sent.message.id);
    const task = await rpc(alice.token, 'GetTask', { id: sent.message.id });
    expect(task.result.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.result.status.message.parts[0].text).toBe('pushed');
  });

  /** REST call as `token`; returns status and parsed body. */
  async function rest<T = any>(token: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  }
  const say = (token: string, key: string, body: object) => rest(token, 'POST', `/conversations/${encodeURIComponent(key)}/messages`, body);
  const page = (token: string, key: string) => rest(token, 'GET', `/conversations/${encodeURIComponent(key)}/messages`);

  it('humans: made by Google sign-in only, reachable by id, never picked by skill', async () => {
    expect((await rest(undefined, 'POST', '/agents', { name: 'robo' })).status).toBe(401);
    const human = await rest(undefined, 'POST', '/auth/google', { idToken: 'dev:malachi@example.com' });
    expect(human.body.agent.kind).toBe('human');
    const ht = human.body.token as string;
    expect((await rest(ht, 'POST', '/agents', { name: 'malachi', skills: [{ id: 'triage', name: 'triage' }] })).body.agent).toMatchObject({ kind: 'human' });

    const ws = alice.reg.owner.workspaceId;
    expect((await rest(alice.reg.owner.token, 'POST', `/workspaces/${ws}/invites`, { email: 'malachi@example.com' })).status).toBe(200);
    expect((await rest(alice.reg.owner.token, 'POST', `/workspaces/${ws}/members`, { agentId: alice.id })).status).toBe(200);

    const sent = await say(alice.token, `agent:${human.body.agent.id}`, { text: 'hi human' });
    expect(sent.status).toBe(201);
    const replied = await rest(ht, 'POST', `/messages/${sent.body.id}/reply`, { text: 'hi bot' });
    expect(replied.body).toMatchObject({ from: 'malachi', text: 'hi bot' });
    expect((await rest(alice.token, 'GET', `/messages/${sent.body.id}`)).body.reply).toMatchObject({ text: 'hi bot' });

    const mine = (await rest(ht, 'GET', '/me')).body.workspaces as { id: string; owner: boolean }[];
    expect(mine.find((w) => w.id === ws)).toMatchObject({ owner: false });
    expect((await rest(alice.token, 'POST', '/conversations/nope/messages', { text: 'x' })).status).toBe(400);
  });

  it("a direct message is read only by its two sides (and their bots' owners), not the rest of the workspace", async () => {
    const regs = await Promise.all(['ws-a', 'ws-b', 'ws-c', 'ws-d'].map((name) => newAgentOverHttp(hubUrl, { name, public: name === 'ws-b' })));
    const [a, b, c, d] = regs.map((r) => r.token);
    const { workspaceId } = await crewOverHttp(hubUrl, regs.slice(0, 3));
    const bId = (await rest(b, 'GET', '/me')).body.id as string;
    const sent = await say(a!, `agent:${bId}`, { text: 'between us' });
    const id = sent.body.id as string;

    expect((await rest(c, 'GET', `/messages/${id}`)).status).toBe(404);
    expect((await rest(d, 'GET', `/messages/${id}`)).status).toBe(404);
    // The owner of a bot on either side sees all of their bot's conversations.
    expect((await rest(regs[0]!.owner.token, 'GET', `/messages/${id}`)).body.message.text).toBe('between us');
    expect((await page(b!, `agent:${regs[0]!.agent.id}`)).body.messages.map((m: MessageView) => m.text)).toEqual(['between us']);
    // Only the agent listed for everyone shows to an outsider.
    expect((await rest(d, 'GET', `/agents?workspace=${workspaceId}`)).body.map((x: { id: string }) => x.id)).toEqual([bId]);
    expect((await rest(c, 'POST', `/messages/${id}/reply`, { text: 'not mine' })).status).toBe(404);
  });

  it('channel messages: one message, everyone in the channel gets it, replies go to its thread', async () => {
    const regs = await Promise.all(['bc-lead', 'bc-m1', 'bc-m2', 'bc-out'].map((name) => newAgentOverHttp(hubUrl, { name })));
    const [lead, m1, m2, outsider] = regs.map((r) => r.token);
    const { channelId } = await crewOverHttp(hubUrl, regs.slice(0, 3), 'broadcast-crew');
    const key = `channel:${channelId}`;

    const post = await say(lead!, key, { text: 'status check' });
    expect(post.status).toBe(201);
    for (const t of [m1!, m2!]) {
      const [item] = await (await connectHub(hubUrl, t)).call<Item[]>('check_inbox');
      expect(item).toMatchObject({ messageId: post.body.id, text: 'status check', channel: 'broadcast-crew' });
    }

    // A reply is in the post's thread, and reaches who's in it: the post's author.
    const reply = await rest(m1!, 'POST', `/messages/${post.body.id}/reply`, { text: 'all good' });
    expect(reply.body).toMatchObject({ conversation: `thread:${channelId}:${post.body.id}`, thread: post.body.id });
    const thread = await page(lead!, `thread:${channelId}:${post.body.id}`);
    expect(thread.body.messages.map((m: MessageView) => m.text)).toEqual(['all good']);
    const channelPage = await page(lead!, key);
    expect(channelPage.body.messages.map((m: MessageView) => m.text)).toEqual(['status check']);
    expect(channelPage.body.threads[post.body.id]).toMatchObject({ count: 1 });

    // By name works too; outsiders can't post, and a thread needs a post.
    expect((await say(m2!, `thread:${channelId}:nope`, { text: 'x' })).status).toBe(404);
    expect((await say(outsider!, key, { text: 'hi' })).status).toBe(404);
  });

  it('over plain A2A: posts in a channel and replies in its thread', async () => {
    const regs = await Promise.all(['a2a-ch-a', 'a2a-ch-b', 'a2a-ch-c'].map((name) => newAgentOverHttp(hubUrl, { name })));
    const { channelId } = await crewOverHttp(hubUrl, regs, 'a2a-channel');
    const [a, b] = regs;
    const rpc = async (token: string, params: unknown) =>
      (await (await fetch(`${hubUrl}/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'a2a-version': '1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params }),
      })).json()) as { result?: any; error?: { message: string } };

    const post = await rpc(a!.token, { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hi channel' }], metadata: { channel: channelId } } });
    expect(post.error).toBeUndefined();
    const postId = post.result.task.id as string;
    const reply = await rpc(b!.token, { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hi a' }], metadata: { channel: channelId, thread: postId } } });
    expect(reply.error).toBeUndefined();
    expect(reply.result.task.contextId).toBe(`thread:${channelId}:${postId}`);
  });

  it('conversations count unread messages from others until read; mentions too', async () => {
    const regs = await Promise.all(['unread-a', 'unread-b', 'unread-c'].map((name) => newAgentOverHttp(hubUrl, { name, public: true })));
    const [a, b, c] = regs.map((r) => ({ token: r.token, id: r.agent.id })) as [Who, Who, Who];
    const { channelId } = await crewOverHttp(hubUrl, regs, 'unread-crew');
    const convOf = async (who: Who, key: string) => ((await rest(who.token, 'GET', '/conversations')).body as any[]).find((x) => x.key === key);

    await say(a.token, `agent:${b.id}`, { text: 'one' });
    await say(a.token, `agent:${b.id}`, { text: 'two' });
    expect(await convOf(b, `agent:${a.id}`)).toMatchObject({ kind: 'direct', unread: 2, with: { id: a.id, name: 'unread-a' } });
    // My own messages never count.
    expect(await convOf(a, `agent:${b.id}`)).toMatchObject({ unread: 0 });
    expect((await rest(b.token, 'POST', `/conversations/${encodeURIComponent(`agent:${a.id}`)}/read`)).status).toBe(200);
    expect(await convOf(b, `agent:${a.id}`)).toMatchObject({ unread: 0 });

    const post = await say(a.token, `channel:${channelId}`, { text: 'standup, @unread-b?' });
    expect(post.body.mentions).toEqual([b.id]);
    expect(await convOf(b, `channel:${channelId}`)).toMatchObject({ unread: 1, mentions: 1 });
    // A post for b (it names b) isn't c's to answer: not in c's inbox, nor counted.
    expect(await convOf(c, `channel:${channelId}`)).toMatchObject({ unread: 0, mentions: 0 });
    // A thread c isn't in comes to c once c is mentioned there, and counts in the channel.
    const threadKey = `thread:${channelId}:${post.body.id}`;
    await say(b.token, threadKey, { text: 'yes, @unread-c can you check?' });
    expect(await convOf(c, `channel:${channelId}`)).toMatchObject({ unread: 1, mentions: 1 });
    expect((await rest(c.token, 'GET', '/waiting')).body).toMatchObject([{ kind: 'mention', replyTo: threadKey }]);
    expect((await rest(c.token, 'POST', `/conversations/${encodeURIComponent(threadKey)}/read`)).status).toBe(200);
    expect((await rest(c.token, 'GET', '/waiting')).body).toEqual([]);
    // Where each one has read up to.
    const seen = (await page(a.token, `channel:${channelId}`)).body.seen;
    expect(seen[a.id]).toBe(1);
    expect((await rest(b.token, 'POST', '/conversations/nope/read')).status).toBe(400);
  });

  it('searches messages in your conversations', async () => {
    const regs = await Promise.all(['search-a', 'search-b', 'search-out'].map((name) => newAgentOverHttp(hubUrl, { name, public: true })));
    const [a, b, outsider] = regs.map((r) => ({ token: r.token, id: r.agent.id })) as [Who, Who, Who];
    const { channelId } = await crewOverHttp(hubUrl, regs.slice(0, 2), 'search-crew');
    await say(a.token, `agent:${b.id}`, { text: 'the Zebra report is late' });
    const post = await say(a.token, `channel:${channelId}`, { text: 'zebra standup at 10' });
    await say(b.token, `thread:${channelId}:${post.body.id}`, { text: 'zebra notes attached' });

    const hits = (await rest(b.token, 'GET', '/search?q=ZEBRA')).body as { key: string; title: string; thread?: string; message: MessageView }[];
    expect(hits.map((h) => h.message.text)).toEqual(['zebra notes attached', 'zebra standup at 10', 'the Zebra report is late']);
    expect(hits[0]).toMatchObject({ key: `channel:${channelId}`, title: 'search-crew', thread: post.body.id });
    expect(hits[2]).toMatchObject({ key: `agent:${a.id}`, title: 'search-a' });
    expect((await rest(outsider.token, 'GET', '/search?q=zebra')).body).toEqual([]);
    expect((await rest(b.token, 'GET', '/search?q=z')).status).toBe(400);
  });
  it('refuses MCP without a token, with a 401 a client can act on', async () => {
    const res = await fetch(`${hubUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    await expect(connectHub(hubUrl)).rejects.toThrow();
    const bad = await fetch(`${hubUrl}/mcp`, { method: 'POST', headers: { authorization: 'Bearer a2ah_nope', 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
  });

  it('proxies the live agent card for endpoint agents only (signed in)', async () => {
    expect((await rest(undefined, 'GET', `/agents/${echoId}/card`)).status).toBe(401);
    const card = await rest(alice.token, 'GET', `/agents/${echoId}/card`);
    expect(card.status).toBe(200);
    expect(card.body.name).toBe('echo');
    expect((await rest(alice.token, 'GET', `/agents/${alice.id}/card`)).status).toBe(404);
  });

  it('lists your workspaces and channels with how many members each has', async () => {
    const regs = await Promise.all(['count-a', 'count-b'].map((name) => newAgentOverHttp(hubUrl, { name })));
    const [a] = regs.map((r) => ({ token: r.token, id: r.agent.id })) as [Who];
    const { workspaceId, channelId: big } = await crewOverHttp(hubUrl, regs, 'count-big');
    const { body: solo } = await rest(a.token, 'POST', `/workspaces/${workspaceId}/channels`, { name: 'count-solo' });
    expect(solo).toMatchObject({ workspaceId, name: 'count-solo', owner: true });
    const channels = (await rest(a.token, 'GET', `/workspaces/${workspaceId}/channels`)).body as any[];
    // The crew channel holds both bots and its human creator; the solo one only its creator.
    expect(Object.fromEntries(channels.map((c) => [c.id, c.memberCount]))).toEqual({ [big]: 3, [solo.id]: 1 });
    // The workspace holds both owners and both bots; a bot sees the member count but not the owners' domains.
    const workspaces = (await rest(a.token, 'GET', '/workspaces')).body as any[];
    expect(workspaces).toMatchObject([{ id: workspaceId, memberCount: 4, owner: false }]);
    expect(workspaces[0].domains).toBeUndefined();
    expect((await rest(regs[0]!.owner.token, 'GET', '/workspaces')).body[0]).toMatchObject({ owner: true, domains: [] });
    // Channels hold only who's in them: the owner is in the crew channel, not in the one bot a made for itself.
    expect((await rest(regs[0]!.owner.token, 'GET', '/me')).body.workspaces).toMatchObject([{ id: workspaceId, channels: [{ id: big }] }]);
    expect(((await rest(a.token, 'GET', '/me')).body.workspaces[0].channels as { id: string }[]).map((c) => c.id).sort()).toEqual([big, solo.id].sort());
  });

  it('rejects A2A calls without a token', async () => {
    const res = await fetch(`${hubUrl}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
    });
    expect(res.status).toBe(401);
  });


  it('an unreachable endpoint agent: the message is kept, and nothing answers it', async () => {
    await new Promise((r) => echoServer.close(r));
    const sent = await alice.mcp.call<Sent>('send_message', { to: echoId, text: 'still there?', timeoutSeconds: 1, wait: false });
    expect(sent.message.text).toBe('still there?');
    expect((await alice.mcp.call<Sent>('wait_for_reply', { messageId: sent.message.id, timeoutSeconds: 1 })).reply).toBeUndefined();
  });
});

describe('rate limits over HTTP', () => {
  let hubUrl: string;
  let server: Server;

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const config = testConfig({ port, publicUrl: hubUrl, registerLimitPerHour: 2, sendLimitPerMinute: 2, proxySecret: 's3cret' });
    const { app } = createApp({ db: testDb(), config });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  /** One person (signed in from an address of its own) makes every bot here; the limit is on new bots per client IP. */
  let person: Promise<string> | undefined;
  const owner = () =>
    (person ??= fetch(`${hubUrl}/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-client-ip': '198.51.100.200', 'x-hub-proxy-secret': 's3cret' },
      body: JSON.stringify({ idToken: 'dev:limits@example.com' }),
    }).then(async (r) => ((await r.json()) as { token: string }).token));
  const register = async (name: string, headers: Record<string, string> = {}) =>
    fetch(`${hubUrl}/agents/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await owner()}`, ...headers },
      body: JSON.stringify({ name }),
    });

  it('limits new bots per client IP, trusting a relayed IP only with the proxy secret', async () => {
    const viaWeb = (ip: string) => ({ 'x-hub-client-ip': ip, 'x-hub-proxy-secret': 's3cret' });
    expect((await register('web-a1', viaWeb('203.0.113.1'))).status).toBe(201);
    expect((await register('web-a2', viaWeb('203.0.113.1'))).status).toBe(201);
    const limited = await register('web-a3', viaWeb('203.0.113.1'));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toMatch(/Too many registrations/);
    expect((await register('web-b1', viaWeb('203.0.113.2'))).status).toBe(201);

    // A forged relay header without the secret is ignored: these count against the real socket IP.
    const forged = { 'x-hub-client-ip': '203.0.113.99', 'x-hub-proxy-secret': 'wrong' };
    expect((await register('direct-1', forged)).status).toBe(201);
    expect((await register('direct-2', { 'x-hub-client-ip': '203.0.113.98' })).status).toBe(201);
    expect((await register('direct-3', forged)).status).toBe(429);
  });

  it('limits messages per agent', async () => {
    const token = ((await (await register('sender', { 'x-hub-client-ip': '203.0.113.50', 'x-hub-proxy-secret': 's3cret' })).json()) as { token: string }).token;
    await register('sink', { 'x-hub-client-ip': '203.0.113.51', 'x-hub-proxy-secret': 's3cret' });
    const send = () =>
      fetch(`${hubUrl}/conversations/agent:sink/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: 'hi' }),
      });
    // sink is private and in none of the sender's workspaces, so sends 404, but they still count toward the limit.
    expect((await send()).status).toBe(404);
    expect((await send()).status).toBe(404);
    expect((await send()).status).toBe(429);
  });

  it('rotates a token over REST', async () => {
    const old = ((await (await register('rot', { 'x-hub-client-ip': '203.0.113.60', 'x-hub-proxy-secret': 's3cret' })).json()) as { token: string }).token;
    const res = await fetch(`${hubUrl}/agents/me/token`, { method: 'POST', headers: { authorization: `Bearer ${old}` } });
    const { token } = (await res.json()) as { token: string };
    expect((await fetch(`${hubUrl}/me`, { headers: { authorization: `Bearer ${old}` } })).status).toBe(401);
    expect((await fetch(`${hubUrl}/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe('Google sign-in and email invites over HTTP', () => {
  let hubUrl: string;
  let server: Server;
  const verifyGoogle = async (idToken: string) => {
    const [email, sub] = idToken.split('|');
    if (!email || !sub) throw new (await import('../src/lib/errors.js')).HubError('unauthorized', 'Google sign-in failed');
    return { email, sub, name: `Person ${sub}` };
  };

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl }), verifyGoogle });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  async function call<T = any>(token: string | undefined, method: string, path: string, body?: unknown) {
    const res = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  it('invites by email before sign-up, auto-joins on first Google sign-in, and keeps emails private', async () => {
    const inviter = await newAgentOverHttp(hubUrl, { name: 'inviter-bot' }, 'owner-inviter-bot@example.com|g-owner-inviter-bot');
    const bot = inviter.token;
    const { body: created } = await call(inviter.owner.token, 'POST', '/workspaces', { name: 'email-crew' });
    expect(created).toMatchObject({ name: 'email-crew', owner: true, domains: [] });
    expect(created.personal).toBeUndefined();
    const workspaceId = created.id as string;
    await call(inviter.owner.token, 'POST', `/workspaces/${workspaceId}/members`, { agentId: inviter.agent.id });

    // Any member, a bot included, invites by workspace name or id.
    const invited = await call(bot, 'POST', '/workspaces/email-crew/invites', { email: 'Grace@Example.com' });
    expect(invited).toMatchObject({ status: 200, body: { ok: true, workspace: { id: workspaceId, name: 'email-crew', owner: false } } });
    expect((await call(bot, 'GET', `/workspaces/${workspaceId}/invites`)).body).toMatchObject([{ email: 'grace@example.com', invitedBy: 'inviter-bot' }]);

    const signIn = await call(undefined, 'POST', '/auth/google', { idToken: 'grace@example.com|g-grace' });
    expect(signIn).toMatchObject({ status: 200, body: { created: true, agent: { name: 'Person g-grace', kind: 'human', email: 'grace@example.com' } } });
    const grace = signIn.body.token as string;
    // Invited, so no extra workspace was made for her.
    expect((await call(grace, 'GET', '/me')).body).toMatchObject({ email: 'grace@example.com', workspaces: [{ id: workspaceId, owner: false }] });
    expect((await call(bot, 'GET', `/workspaces/${workspaceId}/invites`)).body).toEqual([]);

    // Workspace members see grace, but never her email.
    const members = (await call(bot, 'GET', `/agents?workspace=${workspaceId}`)).body as Record<string, unknown>[];
    const listed = members.find((m) => m.name === 'Person g-grace')!;
    expect(listed).toBeDefined();
    expect(JSON.stringify(members)).not.toContain('grace@example.com');

    // Inviting someone already signed in adds them at once, with the same response shape.
    const { body: other } = await call(inviter.owner.token, 'POST', '/workspaces', { name: 'second-crew' });
    const again = await call(inviter.owner.token, 'POST', `/workspaces/${other.id}/invites`, { email: 'grace@example.com' });
    expect(again.body).toMatchObject({ ok: true, workspace: { id: other.id, name: 'second-crew', owner: true } });
    expect(((await call(grace, 'GET', '/me')).body.workspaces as { id: string }[]).map((t) => t.id).sort()).toEqual([workspaceId, other.id].sort());
  });

  it('joins people by email domain: owners set it, public mail providers are refused', async () => {
    const founder = (await call(undefined, 'POST', '/auth/google', { idToken: 'founder@acme.test|g-founder' })).body.token as string;
    const me = (await call(founder, 'GET', '/me')).body;
    expect(me.workspaces).toMatchObject([{ name: 'Person g-founder\'s workspace', owner: true, domains: [] }]);
    expect(me.workspaces[0].personal).toBeUndefined();
    const workspaceId = me.workspaces[0].id as string;
    expect((await call(founder, 'PUT', `/workspaces/${workspaceId}/domains`, { domains: ['gmail.com'] })).status).toBe(400);
    expect((await call(founder, 'PUT', `/workspaces/${workspaceId}/domains`, { domains: 'acme.test' })).body.domains).toEqual([]);
    expect((await call(founder, 'PUT', `/workspaces/${workspaceId}/domains`, { domains: ['ACME.test'] })).body).toMatchObject({ domains: ['acme.test'] });

    const hire = await call(undefined, 'POST', '/auth/google', { idToken: 'hire@acme.test|g-hire' });
    expect((await call(hire.body.token, 'GET', '/me')).body.workspaces).toMatchObject([{ id: workspaceId, owner: false }]);
    expect((await call(hire.body.token, 'PUT', `/workspaces/${workspaceId}/domains`, { domains: [] })).status).toBe(403);
    const other = await call(undefined, 'POST', '/auth/google', { idToken: 'someone@other.test|g-someone' });
    expect(((await call(other.body.token, 'GET', '/me')).body.workspaces as { id: string }[]).map((w) => w.id)).not.toContain(workspaceId);
  });

  it('makes an owned bot in no workspace, adds it to one and a channel, lists it with the owner\'s bots, and deletes it', async () => {
    const owner = (await call(undefined, 'POST', '/auth/google', { idToken: 'omer@example.com|g-omer' })).body.token as string;
    const workspaceId = (await call(owner, 'GET', '/me')).body.workspaces[0].id as string;
    const { body: t } = await call(owner, 'POST', `/workspaces/${workspaceId}/channels`, { name: 'omer-crew' });
    const created = await call(owner, 'POST', '/agents/bots', { name: "Omer's Claude Code", follow: true });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^a2ah_/);
    const ownedId = created.body.agent.id as string;
    const ownerId = (await call(owner, 'GET', '/me')).body.id as string;
    expect(created.body.agent).toMatchObject({ kind: 'mailbox', public: false, workspaces: [], channels: [], ownerId, owner: { id: ownerId }, followsOwner: true });
    // In no workspace until a member adds it by id; then in a channel the same way.
    expect((await call(owner, 'POST', `/channels/${t.id}/members`, { agentId: ownedId })).status).toBe(400);
    const added = await call(owner, 'POST', `/workspaces/${workspaceId}/members`, { agentId: ownedId });
    expect(added.body).toMatchObject({ ok: true, workspace: { id: workspaceId }, agent: { id: ownedId } });
    const inChannel = await call(owner, 'POST', `/channels/${t.id}/members`, { agentId: ownedId });
    expect(inChannel.body).toMatchObject({ ok: true, channel: { id: t.id }, agent: { id: ownedId } });
    expect((await call(created.body.token, 'GET', '/me')).body.workspaces).toMatchObject([{ id: workspaceId, channels: [{ id: t.id, owner: false }] }]);
    expect((await call(owner, 'GET', '/agents/bots')).body).toMatchObject([{ id: ownedId, followsOwner: true }]);
    expect((await call(owner, 'GET', `/agents/${ownedId}`)).status).toBe(200);
    expect((await call(created.body.token, 'GET', '/me')).body).toMatchObject({ id: ownedId, pending: 0, owner: { id: ownerId } });
    expect((await call(owner, 'POST', '/agents/bots', { follow: true })).status).toBe(400);

    await call(owner, 'POST', `/conversations/agent:${ownedId}/messages`, { text: 'remember the milk' });
    expect((await call(created.body.token, 'GET', '/me')).body.pending).toBe(1);

    const stranger = (await newAgentOverHttp(hubUrl, { name: 'stranger' }, 'owner-stranger@example.com|g-owner-stranger')).token;
    expect((await call(stranger, 'DELETE', `/agents/${ownedId}`)).status).toBe(404);
    expect((await call(owner, 'DELETE', `/agents/${ownedId}`)).body).toEqual({ ok: true });
    expect((await call(created.body.token, 'GET', '/me')).status).toBe(401);
    expect((await call(owner, 'GET', '/agents/bots')).body).toEqual([]);
  });

  it('checks an endpoint bot when it is connected and changed, and its owner fixes the credential in place', async () => {
    // An echo agent behind a door that wants "Bearer right" on calls (its card is public, like OpenClaw's).
    const doorPort = await freePort();
    const doorUrl = `http://127.0.0.1:${doorPort}`;
    const echoPort = await freePort();
    const echo = await startEchoAgent(echoPort, '127.0.0.1', doorUrl);
    const door = createHttpServer(async (req, res) => {
      if (req.method === 'POST' && req.headers.authorization !== 'Bearer right') return void res.writeHead(401).end('no');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await fetch(`http://127.0.0.1:${echoPort}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json' }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((r) => door.listen(doorPort, '127.0.0.1', () => r()));
    try {
      const owner = (await call(undefined, 'POST', '/auth/google', { idToken: 'dana@example.com|g-dana' })).body.token as string;
      // A call that doesn't get through creates nothing: no credential, a wrong one, or no agent there.
      const bots = async () => ((await call(owner, 'GET', '/agents/bots')).body as unknown[]).length;
      const before = await bots();
      const refused = await call(owner, 'POST', '/agents/bots', { name: 'Dana claw', url: doorUrl, follow: true });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/no credential for it \(HTTP 401\).*Nothing was created/);
      expect((await call(owner, 'POST', '/agents/bots', { name: 'Dana claw', url: doorUrl, credential: { type: 'bearer', token: 'wrong' } })).status).toBe(400);
      expect(await bots()).toBe(before);

      const created = await call(owner, 'POST', '/agents/bots', { name: 'Dana claw', url: doorUrl, credential: { type: 'bearer', token: 'right' }, follow: true });
      expect(created.status).toBe(201);
      expect(created.body.check).toEqual({ ok: true });
      const id = created.body.agent.id as string;
      expect(await bots()).toBe(before + 1);

      const stranger = (await call(undefined, 'POST', '/auth/google', { idToken: 'eve@example.com|g-eve' })).body.token as string;
      expect((await call(stranger, 'PUT', `/agents/bots/${id}`, { credential: { type: 'bearer', token: 'right' } })).status).toBe(404);
      expect((await call(stranger, 'POST', `/agents/${id}/check`)).status).toBe(404);

      const wrong = await call(owner, 'PUT', `/agents/bots/${id}`, { credential: { type: 'bearer', token: 'wrong' } });
      expect(wrong.body.check).toEqual({ ok: false, problem: "it refused the hub's credential (HTTP 401)" });
      const fixed = await call(owner, 'PUT', `/agents/bots/${id}`, { credential: { type: 'bearer', token: 'right' } });
      expect(fixed.body.check).toEqual({ ok: true });
      expect(fixed.body.agent).toMatchObject({ id, name: 'Dana claw', url: doorUrl, credential: { type: 'bearer' } });
      expect(fixed.body.agent.authProblem).toBeUndefined();
      // Same token as before: the agent's own way in didn't change.
      expect((await call(created.body.token, 'GET', '/me')).body.id).toBe(id);
      expect((await call(owner, 'POST', `/agents/${id}/check`)).body.check).toEqual({ ok: true });
      // Leaving the credential out keeps it; null removes it.
      expect((await call(owner, 'PUT', `/agents/bots/${id}`, { name: 'Dana claw' })).body.check).toEqual({ ok: true });
      expect((await call(owner, 'PUT', `/agents/bots/${id}`, { credential: null })).body.check.ok).toBe(false);
      // A pairing code for this connection gives it a new token (the one-line OpenClaw sign-in); only its owner can make one.
      expect((await call(stranger, 'POST', '/pairings', { agentId: id })).status).toBe(404);
      const { body: pair } = await call(owner, 'POST', '/pairings', { agentId: id });
      const redeemed = await call(undefined, 'POST', '/pairings/redeem', { code: pair.code });
      expect(redeemed.body.agent.id).toBe(id);
      expect((await call(redeemed.body.token, 'GET', '/me')).body.id).toBe(id);
      expect((await call(created.body.token, 'GET', '/me')).status).toBe(401);
      expect((await call(undefined, 'POST', '/pairings/redeem', { code: pair.code })).status).toBe(401);
      const mailbox = await call(owner, 'POST', '/agents/bots', { name: 'Dana box', follow: true });
      expect(mailbox.body.check).toBeUndefined();
      expect((await call(owner, 'POST', `/agents/${mailbox.body.agent.id}/check`)).status).toBe(400);
    } finally {
      await new Promise((r) => door.close(r));
      await new Promise((r) => echo.server.close(r));
    }
  });

  it('adds an agent on a client: owner creates, the parent gets codes until one connects the child', async () => {
    const owner = (await call(undefined, 'POST', '/auth/google', { idToken: 'sib@example.com|g-sib' })).body.token as string;
    const stranger = (await call(undefined, 'POST', '/auth/google', { idToken: 'sib-x@example.com|g-sib-x' })).body.token as string;
    const parent = (await call(owner, 'POST', '/agents/bots', { name: 'Sib laptop', follow: true })).body;
    const other = (await call(owner, 'POST', '/agents/bots', { name: 'Sib other', follow: true })).body;
    const path = `/agents/bots/${parent.agent.id}/siblings`;
    expect((await call(stranger, 'POST', path, { name: 'nope' })).status).toBe(404);
    expect((await call(parent.token, 'POST', path, { name: 'nope' })).status).toBe(403);

    const made = await call(owner, 'POST', path, { name: 'Sib child' });
    expect(made.status).toBe(201);
    const childId = made.body.agent.id as string;
    const feed = await call(parent.token, 'GET', '/events');
    expect(feed.body.events).toContainEqual({ type: 'sibling_pending', agentId: childId });
    expect(JSON.stringify(feed.body)).not.toMatch(/code/i);

    expect((await call(other.token, 'POST', '/agents/me/sibling-pairings')).body).toEqual({ pairings: [] });
    const picked = await call(parent.token, 'POST', '/agents/me/sibling-pairings');
    expect(picked.body.pairings).toEqual([{ agentId: childId, name: 'Sib child', code: expect.any(String) }]);
    // Asked again before redeeming (a lost answer): still a usable code, and the hint stays.
    const again = await call(parent.token, 'POST', '/agents/me/sibling-pairings');
    expect(again.body.pairings).toEqual([{ agentId: childId, name: 'Sib child', code: expect.any(String) }]);
    expect((await call(parent.token, 'GET', '/events')).body.events).toContainEqual({ type: 'sibling_pending', agentId: childId });
    const redeemed = await call(undefined, 'POST', '/pairings/redeem', { code: again.body.pairings[0].code });
    expect((await call(redeemed.body.token, 'GET', '/me')).body.id).toBe(childId);
    expect((await call(parent.token, 'GET', '/events')).body.events).not.toContainEqual({ type: 'sibling_pending', agentId: childId });
    expect((await call(parent.token, 'POST', '/agents/me/sibling-pairings')).body).toEqual({ pairings: [] });
    expect((await call(undefined, 'POST', '/pairings/redeem', { code: picked.body.pairings[0].code })).status).toBe(401);

    // No name: the button posts {}.
    const unnamed = await call(owner, 'POST', path, {});
    expect(unnamed.status).toBe(201);
    expect(unnamed.body.agent.name).toBe('Sib laptop 2');
    // Archived parent: refused.
    expect((await call(owner, 'POST', `/agents/${other.agent.id}/archive`)).status).toBe(200);
    expect((await call(owner, 'POST', `/agents/bots/${other.agent.id}/siblings`, {})).status).toBe(400);
  });

  it('logs out one web session without touching others; rejects bad input', async () => {
    const a = (await call(undefined, 'POST', '/auth/google', { idToken: 'lin@example.com|g-lin' })).body.token as string;
    const b = (await call(undefined, 'POST', '/auth/google', { idToken: 'lin@example.com|g-lin' })).body.token as string;
    expect((await call(a, 'POST', '/auth/logout')).body).toEqual({ ok: true });
    expect((await call(a, 'GET', '/me')).status).toBe(401);
    expect((await call(b, 'GET', '/me')).status).toBe(200);

    expect((await call(undefined, 'POST', '/auth/google', { idToken: 'garbage' })).status).toBe(401);
    const outsider = (await newAgentOverHttp(hubUrl, { name: 'not-a-member' }, 'owner-not-a-member@example.com|g-owner-not-a-member')).token;
    const owner = (await newAgentOverHttp(hubUrl, { name: 'crew-owner' }, 'owner-crew-owner@example.com|g-owner-crew-owner')).owner.token;
    const ws = (await call(owner, 'GET', '/me')).body.workspaces[0].id as string;
    expect((await call(outsider, 'POST', `/workspaces/${ws}/invites`, { email: 'x@example.com' })).status).toBe(404);
    expect((await call(owner, 'POST', `/workspaces/${ws}/invites`, { email: 'not-an-email' })).status).toBe(400);
    await call(owner, 'POST', `/workspaces/${ws}/invites`, { email: 'gone@example.com' });
    expect((await call(owner, 'DELETE', `/workspaces/${ws}/invites/gone@example.com`)).body).toEqual({ ok: true });
    expect((await call(owner, 'GET', `/workspaces/${ws}/invites`)).body).toEqual([]);
    expect((await call(owner, 'POST', '/workspaces', { name: '' })).status).toBe(400);
  });

  it('exercises example:mailbox and example:client end-to-end', async () => {
    // ponytail: this describe block injects a verifier that splits idToken on '|', so pass email|sub (default dev: token has no '|')
    const shouter = await newAgentOverHttp(hubUrl, { name: 'shouter-bot', public: true }, 'shouter@example.com|s-shouter');
    const sender = await newAgentOverHttp(hubUrl, { name: 'sender-bot', public: true }, 'sender@example.com|s-sender');
    const [reply] = await Promise.all([
      runClientExample(shouter.agent.id, ['hello', 'world'], hubUrl, sender.token),
      (async () => {
        // Queue the message before the example's single poll, regardless of MCP startup speed.
        await vi.waitFor(async () => {
          const page = await call<{ messages: MessageView[] }>(sender.token, 'GET', `/conversations/agent:${shouter.agent.id}/messages`);
          expect(page.body.messages.map((m) => m.text)).toEqual(['hello world']);
        }, { timeout: 10_000 });
        await runMailboxAgent(hubUrl, shouter.token, { name: 'shouter', maxPolls: 1, timeoutSeconds: 5 });
      })(),
    ]);
    // ponytail: the hub reply carries id/seq/conversation too; assert only the example's contract
    expect(reply).toMatchObject({ from: 'shouter', text: 'HELLO WORLD' });
  });
});
