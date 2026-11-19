import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { COLLECTIONS, Timestamp } from '../src/db/types.js';
import { testConfig, testDb } from './helpers.js';

async function setup() {
  const { app, hub } = createApp({ db: testDb(), config: testConfig() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, key: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
  };
  const owner = await hub.registry.signInWithGoogle('dev:maker@talent.test');
  const ws = await hub.registry.createWorkspace(owner.agent, 'Talent');
  const { key } = await hub.apps.create(owner.agent, ws.id, { name: 'Talent' });
  for (const [k, name] of [['candidate', 'Candidate rep'], ['hiring-team', 'Hiring team']]) {
    expect((await call('/v1/agents', key, { method: 'POST', body: { key: k, name, instructions: `You represent the ${k}.` } })).status).toBe(201);
  }
  const room = {
    goal: 'Check fit for a senior backend role',
    sides: [
      { ref: 'company:41c2', name: 'Hiring team', brief: 'COMPANY-BRIEF budget 180k', agent: 'hiring-team' },
      { ref: 'candidate:9a7f', name: 'Candidate #9a7f', brief: 'CANDIDATE-BRIEF minimum 170k', agent: 'candidate' },
    ],
    metadata: { company: 'u-41c2', candidate: 'u-9a7f' },
  };
  return { hub, call, owner, key, room, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('/v1/rooms', () => {
  it('returns the newest shared messages when a channel exceeds the 500-message limit', async () => {
    const { hub, call, key, room, close } = await setup();
    try {
      const { id } = (await call('/v1/rooms', key, { method: 'POST', body: room })).body;
      const info = (await hub.registry.workspaceById(id))!.room!;
      const writer = (await hub.registry.get(info.sides[0]!.agents![0]!))!;
      const { message } = await hub.chat.post(writer, { channelId: info.shared }, { parts: [{ text: 'oldest' }] });
      const db = hub.registry.db;
      const stored = (await hub.chat.store.message(message.id))!;
      const batch = db.batch();
      for (let i = 1; i <= 500; i++) {
        const messageId = `zz-${id}-${String(i).padStart(3, '0')}`;
        const at = new Date(stored.createdAt.seconds * 1000 + Math.round(stored.createdAt.nanoseconds / 1e6) + 1000 + i).toISOString();
        batch.set(db.collection(COLLECTIONS.messages).doc(messageId), {
          ...stored, id: messageId, seq: i + 1, at, createdAt: Timestamp.fromDate(new Date(at)), parts: [{ text: `message ${i}` }],
        });
      }
      await batch.commit();

      const seen = await call(`/v1/rooms/${id}/messages?side=candidate:9a7f`, key);
      expect(seen.status).toBe(200);
      expect(seen.body.messages).toHaveLength(500);
      expect(seen.body.messages[0].text).toBe('message 1');
      expect(seen.body.messages.at(-1).text).toBe('message 500');
    } finally { await close(); }
  });

  it('an app opens a room, reads it, and finds it by its metadata; another app never sees it', async () => {
    const { hub, call, owner, key, room, close } = await setup();
    try {
      const made = await call('/v1/rooms', key, { method: 'POST', body: room });
      expect(made.status).toBe(201);
      expect(made.body.status).toBe('talking');
      const got = await call(`/v1/rooms/${made.body.id}`, key);
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ goal: room.goal, status: 'talking', sides: [{ ref: 'company:41c2', name: 'Hiring team' }, { ref: 'candidate:9a7f', name: 'Candidate #9a7f' }], metadata: room.metadata });
      expect(JSON.stringify(got.body)).not.toMatch(/BRIEF/);
      expect((await call('/v1/rooms?metadata.candidate=u-9a7f', key)).body.rooms.map((r: any) => r.id)).toEqual([made.body.id]);
      expect((await call('/v1/rooms?metadata.candidate=someone-else', key)).body.rooms).toEqual([]);

      const other = await hub.apps.create(owner.agent, (await hub.registry.createWorkspace(owner.agent, 'Other')).id, { name: 'Other' });
      expect((await call(`/v1/rooms/${made.body.id}`, other.key)).status).toBe(404);
      expect((await call(`/v1/rooms/${made.body.id}/messages?side=candidate:9a7f`, other.key)).status).toBe(404);
      expect((await call('/v1/rooms', other.key)).body.rooms).toEqual([]);

      // Its maker sees the room under the app, with no side of their own to set up.
      const mine = (await call('/me', owner.token)).body.workspaces.find((w: any) => w.id === made.body.id);
      expect(mine.room).toMatchObject({ appId: expect.any(String), app: { name: 'Talent', workspaceId: expect.any(String) } });
      expect(mine.room.mySide).toBeUndefined();
    } finally { await close(); }
  });

  it("a side reads the shared talks and its own corner, never the other side's corner or any brief", async () => {
    const { hub, call, key, room, close } = await setup();
    try {
      const { id } = (await call('/v1/rooms', key, { method: 'POST', body: room })).body;
      const info = (await hub.registry.workspaceById(id))!.room!;
      const [company, candidate] = info.sides;
      const companyAgent = (await hub.registry.get(company!.agents![0]!))!;
      const candidateAgent = (await hub.registry.get(candidate!.agents![0]!))!;
      await hub.chat.post(companyAgent, { channelId: info.shared }, { parts: [{ text: 'Shared: we need Go and payments.' }] });
      await hub.chat.post(companyAgent, { channelId: company!.corner }, { parts: [{ text: 'COMPANY-CORNER: can we go to 185k?' }] });
      await hub.chat.post(candidateAgent, { channelId: candidate!.corner }, { parts: [{ text: 'CANDIDATE-CORNER: hold at 170k' }] });

      const seen = await call(`/v1/rooms/${id}/messages?side=candidate:9a7f`, key);
      expect(seen.status).toBe(200);
      const text = JSON.stringify(seen.body);
      expect(text).toContain('Shared: we need Go and payments.');
      expect(text).toContain('CANDIDATE-CORNER');
      expect(text).not.toContain('COMPANY-CORNER');
      expect(text).not.toMatch(/BRIEF/);
      expect((await call(`/v1/rooms/${id}/messages?side=nobody`, key)).status).toBe(404);
    } finally { await close(); }
  });

  it('both sides approving the document is agreed; a closed room says so', async () => {
    const { hub, call, key, room, close } = await setup();
    try {
      const { id } = (await call('/v1/rooms', key, { method: 'POST', body: room })).body;
      const info = (await hub.registry.workspaceById(id))!.room!;
      const writer = (await hub.registry.get(info.sides[0]!.agents![0]!))!;
      await hub.rooms.writeDocument(writer, id, '- [x] Go, payments\n- [x] 175k', 0);
      expect((await call(`/v1/rooms/${id}/sides/company:41c2/approve`, key, { method: 'POST', body: { version: 1 } })).body.agreed).toBe(false);
      expect((await call(`/v1/rooms/${id}/sides/candidate:9a7f/approve`, key, { method: 'POST', body: { version: 1 } })).body.agreed).toBe(true);
      const got = (await call(`/v1/rooms/${id}`, key)).body;
      expect(got.status).toBe('agreed');
      expect(got.document.approvals).toEqual({ 'company:41c2': expect.objectContaining({ version: 1 }), 'candidate:9a7f': expect.objectContaining({ version: 1 }) });

      expect((await call(`/v1/rooms/${id}/close`, key, { method: 'POST' })).status).toBe(200);
      expect((await call(`/v1/rooms/${id}`, key)).body.status).toBe('closed');
      expect(await hub.rooms.turn(id)).toBe('stuck');
    } finally { await close(); }
  });

  it('answers a decision a side was asked for', async () => {
    const { hub, call, key, room, close } = await setup();
    try {
      const { id } = (await call('/v1/rooms', key, { method: 'POST', body: room })).body;
      const info = (await hub.registry.workspaceById(id))!.room!;
      const candidate = info.sides[1]!;
      await hub.rooms.ask(id, { side: candidate.id, agent: candidate.agents![0]!, question: 'They offer 175k remote. Accept?', options: ['yes', 'no'] });
      const got = (await call(`/v1/rooms/${id}`, key)).body;
      expect(got.status).toBe('needs_decision');
      expect(got.pending).toEqual([{ decisionId: 'candidate:9a7f', sideRef: 'candidate:9a7f', question: 'They offer 175k remote. Accept?', options: ['yes', 'no'] }]);
      expect((await call(`/v1/rooms/${id}/decisions/candidate:9a7f`, key, { method: 'POST', body: { choice: 'yes' } })).status).toBe(200);
      expect((await call(`/v1/rooms/${id}`, key)).body.status).toBe('talking');
    } finally { await close(); }
  });

  it('rejects a side whose agent the app never made', async () => {
    const { call, key, room, close } = await setup();
    try {
      const unknown = { ...room, sides: [room.sides[0], { ...room.sides[1], agent: 'nope' }] };
      expect((await call('/v1/rooms', key, { method: 'POST', body: unknown })).status).toBe(400);
    } finally { await close(); }
  });

  it('each room side gets its own agent from the template, in that room only; closing archives them', async () => {
    const { hub, call, key, room, close } = await setup();
    try {
      const first = (await call('/v1/rooms', key, { method: 'POST', body: room })).body.id;
      // The same template on both sides of a second room, too: still one private agent per side.
      const second = (await call('/v1/rooms', key, { method: 'POST', body: { ...room, sides: [room.sides[0], { ...room.sides[1], agent: 'hiring-team' }] } })).body.id;
      const r1 = (await hub.registry.workspaceById(first))!.room!;
      const r2 = (await hub.registry.workspaceById(second))!.room!;
      const ids = [...r1.sides, ...r2.sides].map((s) => s.agents![0]!);
      expect(new Set(ids).size).toBe(4);
      const r2Channels = [r2.shared, ...r2.sides.map((s) => s.corner)];
      for (const side of r1.sides) {
        const agent = (await hub.registry.get(side.agents![0]!))!;
        expect(agent.workspaces).toEqual([first]);
        expect(agent.channels).toEqual(expect.arrayContaining([r1.shared, side.corner]));
        expect(agent.channels).toHaveLength(2);
        expect(agent.channels!.some((c) => r2Channels.includes(c))).toBe(false);
        expect(agent.description).toMatch(/You represent the/);
      }
      await call(`/v1/rooms/${first}/close`, key, { method: 'POST' });
      for (const side of r1.sides) expect((await hub.registry.get(side.agents![0]!))!.archived).toBe(true);
      for (const side of r2.sides) expect((await hub.registry.get(side.agents![0]!))!.archived).toBeFalsy();
    } finally { await close(); }
  });

  it('a room that fails to open is taken apart', async () => {
    const { hub, call, key, room, close } = await setup();
    const agents: string[] = [];
    let workspaceId = '';
    const made = vi.spyOn(hub.registry, 'createAppRoomAgent');
    made.mockImplementation(async function (this: unknown, input) {
      made.mockRestore();
      const agent = await hub.registry.createAppRoomAgent(input);
      agents.push(agent.id);
      workspaceId = input.workspaceId;
      return agent;
    });
    // The first side's agent is made; the second side fails.
    const fail = vi.spyOn(hub.registry, 'setRoomRole').mockResolvedValueOnce().mockRejectedValueOnce(new Error('boom'));
    try {
      expect((await call('/v1/rooms', key, { method: 'POST', body: room })).status).toBe(500);
      expect((await call('/v1/rooms', key)).body.rooms).toEqual([]);
      expect(agents).toHaveLength(1);
      const agent = (await hub.registry.get(agents[0]!))!;
      expect(agent.archived).toBe(true);
      expect(agent.workspaces).toEqual([]);
      expect((await hub.registry.workspaceById(workspaceId))!.archived).toBe(true);
    } finally { fail.mockRestore(); await close(); }
  });

  it('an app has as many agents as it needs (one per user), and updating one keeps it', async () => {
    const { call, key, close } = await setup();
    try {
      for (let i = 0; i < 25; i++) expect((await call('/v1/agents', key, { method: 'POST', body: { key: `t${i}`, name: 'T', instructions: 'x' } })).status).toBe(201);
      expect((await call('/v1/agents', key, { method: 'POST', body: { key: 'candidate', name: 'T', instructions: 'new' } })).status).toBe(200);
    } finally { await close(); }
  });
});
