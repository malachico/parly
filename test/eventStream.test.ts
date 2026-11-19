import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { crewOverHttp, newAgentOverHttp, testConfig, testDb, freePort } from './helpers.js';

type SseEvent = { event: string; id?: string; data: any };

/** Opens /events/stream (with `token`, or `?ticket=` when token is `{ ticket }`) and collects parsed events until `until` holds or the timeout. */
async function collect(url: string, token: string | { ticket: string }, until: (events: SseEvent[]) => boolean, lastEventId?: string, timeoutMs = 8000) {
  const abort = new AbortController();
  const ticket = typeof token === 'string' ? '' : `?ticket=${encodeURIComponent(token.ticket)}`;
  const auth: Record<string, string> = typeof token === 'string' ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${url}/events/stream${ticket}`, { headers: { ...auth, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: abort.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const fields = Object.fromEntries(block.split('\n').filter((l) => l && !l.startsWith(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
        if (fields.event) events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data ?? '{}') });
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return events;
}

describe('GET /events/stream', () => {
  let hubUrl: string;
  let server: Server;
  let agent: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let stranger: Awaited<ReturnType<typeof newAgentOverHttp>>;

  const send = (token: string, key: string, text: string) =>
    fetch(`${hubUrl}/conversations/${encodeURIComponent(key)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl }) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    agent = await newAgentOverHttp(hubUrl, { name: 'streamer' });
    stranger = await newAgentOverHttp(hubUrl, { name: 'stranger', public: true });
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('pushes a new DM to its person with the whole message, and resumes after Last-Event-ID without repeats', async () => {
    const person = agent.owner;
    const first = collect(hubUrl, person.token, (e) => e.some((x) => x.event === 'message' && x.data.text === 'hello live'));
    await new Promise((r) => setTimeout(r, 300));
    expect((await send(agent.token, `agent:${person.id}`, 'hello live')).status).toBe(201);
    const events = await first;
    const msg = events.find((x) => x.event === 'message' && x.data.text === 'hello live')!;
    expect(msg).toBeDefined();
    expect(msg.data).toMatchObject({ text: 'hello live', fromId: agent.agent.id, conversation: expect.stringMatching(/^dm:/), seq: expect.any(Number), forYou: true });
    const lastId = [...events].reverse().find((x) => x.id)?.id;
    expect(lastId).toBeTruthy();

    // Reconnecting from the last id: only what came after it.
    expect((await send(agent.token, `agent:${person.id}`, 'second')).status).toBe(201);
    const resumed = await collect(hubUrl, person.token, (e) => e.some((x) => x.event === 'message' && x.data.text === 'second'), lastId);
    const texts = resumed.filter((x) => x.event === 'message').map((x) => x.data.text);
    expect(texts).toEqual(['second']);
  }, 30_000);

  it("never streams someone else's conversation", async () => {
    const seen = collect(hubUrl, stranger.token, (e) => e.some((x) => x.event === 'message'), undefined, 3000);
    await new Promise((r) => setTimeout(r, 300));
    expect((await send(agent.token, `agent:${agent.owner.id}`, 'private note')).status).toBe(201);
    expect((await seen).filter((x) => x.event === 'message')).toEqual([]);
  }, 30_000);

  it("streams a reply in a channel's thread to a member who isn't in that thread", async () => {
    const other = await newAgentOverHttp(hubUrl, { name: 'other' });
    const { channelId } = await crewOverHttp(hubUrl, [agent, other], 'live-threads');
    // The person is in the channel (they made it) but never wrote in, or was mentioned in, the thread.
    const root = (await (await send(agent.token, `channel:${channelId}`, 'root post')).json()) as { id: string };
    const seen = collect(hubUrl, agent.owner.token, (e) => e.some((x) => x.event === 'message' && x.data.text === 'in the thread'));
    await new Promise((r) => setTimeout(r, 300));
    expect((await send(other.token, `thread:${channelId}:${root.id}`, 'in the thread')).status).toBe(201);
    const reply = (await seen).find((x) => x.event === 'message' && x.data.text === 'in the thread');
    expect(reply?.data).toMatchObject({ conversation: `thread:${channelId}:${root.id}`, thread: root.id });
  }, 30_000);

  it('refuses without a token', async () => {
    expect((await fetch(`${hubUrl}/events/stream`)).status).toBe(401);
  });
});

describe('GET /events/stream?ticket=', () => {
  let hubUrl: string;
  let server: Server;
  let agent: Awaited<ReturnType<typeof newAgentOverHttp>>;
  const mint = (token: string) => fetch(`${hubUrl}/events/stream/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl, credentialsKey: randomBytes(32) }) });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    agent = await newAgentOverHttp(hubUrl, { name: 'ticketed' });
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it("streams the ticket's person without a token, to any origin", async () => {
    const res = await mint(agent.owner.token);
    expect(res.status).toBe(200);
    const { ticket, url } = (await res.json()) as { ticket: string; url: string };
    expect(url).toBe(`${hubUrl}/events/stream?ticket=${encodeURIComponent(ticket)}`);
    const preflight = await fetch(`${hubUrl}/events/stream`, { method: 'OPTIONS' });
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/Authorization.*Last-Event-ID/);
    const seen = collect(hubUrl, { ticket }, (e) => e.some((x) => x.event === 'message' && x.data.text === 'by ticket'));
    await new Promise((r) => setTimeout(r, 300));
    const sent = await fetch(`${hubUrl}/conversations/${encodeURIComponent(`agent:${agent.owner.id}`)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
      body: JSON.stringify({ text: 'by ticket' }),
    });
    expect(sent.status).toBe(201);
    expect((await seen).find((x) => x.event === 'message' && x.data.text === 'by ticket')?.data.forYou).toBe(true);
  }, 30_000);

  it('refuses a ticket that was changed, or minting without a token', async () => {
    const { ticket } = (await (await mint(agent.owner.token)).json()) as { ticket: string };
    const forged = ticket.slice(0, -4) + (ticket.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const res = await fetch(`${hubUrl}/events/stream?ticket=${encodeURIComponent(forged)}`);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${hubUrl}/events/stream/ticket`, { method: 'POST' })).status).toBe(401);
  });

  it('mints no tickets on a hub without CREDENTIALS_KEY', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: url }) });
    const plain = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    try {
      const person = await newAgentOverHttp(url, { name: 'keyless' });
      expect((await fetch(`${url}/events/stream/ticket`, { method: 'POST', headers: { authorization: `Bearer ${person.owner.token}` } })).status).toBe(404);
    } finally {
      await new Promise((r) => plain.close(r));
    }
  }, 30_000);
});
