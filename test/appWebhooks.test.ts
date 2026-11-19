import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import { AppWebhooks } from '../src/apps/webhooks.js';
import { testConfig, testDb } from './helpers.js';

interface Received { headers: IncomingMessage['headers']; body: string }

/** A local receiver answering with the given statuses in turn (then 200). */
async function receiver(statuses: number[] = []) {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.statusCode = statuses.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { got, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

/** A hub with one app whose webhook is `url`, and a room that app opened, with sides "a" (ref cand-1) and "b". */
async function setup(url: string) {
  const db = testDb();
  const hub = createHub({ db, config: testConfig() });
  const owner = await hub.registry.signInWithGoogle('dev:owner@webhooks.test');
  const ws = await hub.registry.createWorkspace(owner.agent, 'Talent Inc');
  const { app } = await hub.apps.create(owner.agent, ws.id, { name: 'Talent', webhookUrl: 'https://talent.example/hooks' });
  await db.collection('apps').doc(app.id).update({ webhookUrl: url });
  const room = await hub.registry.createWorkspace(owner.agent, 'A room');
  await hub.registry.updateRoom(room.id, () => ({ goal: 'Fit?', shared: 'c1', sides: [{ id: 'a', name: 'Candidate', corner: 'c2', ref: 'cand-1' }, { id: 'b', name: 'Hiring', corner: 'c3' }], appId: app.id }));
  return { db, hub, app, room };
}

describe('app webhooks', () => {
  it('sends a room event signed with the app secret, naming the side by its ref', async () => {
    const r = await receiver();
    closers.push(r.close);
    const { hub, app, room } = await setup(r.url);
    await hub.rooms.ask(room.id, { side: 'a', agent: 'x', question: 'Remote OK?', options: ['yes', 'no'] });
    await vi_waitFor(() => r.got.length === 1);
    const { headers, body } = r.got[0]!;
    const [t, v1] = String(headers['parly-signature']).split(',').map((p) => p.split('=')[1]);
    expect(v1).toBe(createHmac('sha256', app.webhookSecret).update(`${t}.${body}`).digest('hex'));
    const event = JSON.parse(body);
    expect(event).toMatchObject({ type: 'room.needs_decision', data: { roomId: room.id, side: 'cand-1', question: 'Remote OK?', options: ['yes', 'no'] } });
    expect(event.id).toMatch(/^evt_/);
    expect(body).not.toContain('"a"'); // Parly's own side id stays inside Parly
  });

  it('a room no app opened sends nothing', async () => {
    const r = await receiver();
    closers.push(r.close);
    const { hub, room } = await setup(r.url);
    await hub.registry.updateRoom(room.id, (now) => ({ ...now!, appId: undefined }));
    await hub.roomEvent(room.id, 'room.agreed', { version: 1 });
    await new Promise((res) => setTimeout(res, 200));
    expect(r.got).toHaveLength(0);
  });

  it('retries a failed send on the sweep, and never delivers one event twice', async () => {
    const r = await receiver([500]);
    closers.push(r.close);
    const { hub, room } = await setup(r.url);
    await hub.roomEvent(room.id, 'room.document_updated', { version: 2 });
    expect(r.got).toHaveLength(1);
    expect(await hub.appEvents.sweep(Date.now())).toBe(0); // not due yet
    await hub.appEvents.sweep(Date.now() + 11_000);
    expect(r.got).toHaveLength(2);
    expect(r.got[1]!.body).toBe(r.got[0]!.body); // the same event, same id
    await hub.appEvents.sweep(Date.now() + 120_000);
    expect(r.got).toHaveLength(2);
  });

  it('the default sender refuses private addresses', async () => {
    const r = await receiver();
    closers.push(r.close);
    const { db, hub, app } = await setup(r.url.replace('http:', 'https:'));
    const strict = new AppWebhooks(db, hub.apps); // publicFetch, as on a deployed hub
    const id = await strict.emit(app.id, 'room.closed', { roomId: 'r1' });
    const stored = (await db.collection('app_events').doc(id!).get()).data()!;
    expect(stored.delivered).toBeUndefined();
    expect(stored.lastError).toMatch(/private/i);
    expect(r.got).toHaveLength(0);
  });
});

async function vi_waitFor(ok: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((res) => setTimeout(res, 20));
  }
}
