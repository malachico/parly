import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import type { ComputerDriver, RunSpec } from '../src/computers/computers.js';
import { buildServer } from '../src/mcp/server.js';
import { crew, testConfig, testDb } from './helpers.js';

const VERTEX = { model: 'gemini-test', project: 'p', location: 'global', prices: { input: 2, output: 12 } };

/** A driver that records what the hub asks of it. */
function fakeDriver() {
  const calls: string[] = [];
  const runs: RunSpec[] = [];
  const driver: ComputerDriver = {
    start: async (id) => void calls.push(`start ${id}`),
    stop: async (id) => void calls.push(`stop ${id}`),
    runAgent: async (id, spec) => void (calls.push(`run ${id} ${spec.agentId}`), runs.push(spec)),
  };
  return { driver, calls, runs };
}

async function setup(name: string, credentialsKey?: Buffer) {
  const db = testDb();
  const fake = fakeDriver();
  const hub = createHub({ db, config: testConfig({ vertex: VERTEX, credentialsKey }), computerDriver: fake.driver });
  const { owner } = await crew(hub.registry, name, []);
  await hub.billing.setPlan(owner.id, { plan: 'pro' });
  const agent = await hub.hire(owner, 'Atlas');
  return { db, hub, owner, agent, ...fake };
}

describe('Parly computers', () => {
  it.each([undefined, Buffer.alloc(32, 2)])('records unreadable hosted credentials without retrying every ready event (%s)', async (credentialsKey) => {
    const key = Buffer.alloc(32, 1);
    const { db, owner, agent, driver, runs } = await setup('comp-key', key);
    const restarted = createHub({ db, config: testConfig({ vertex: VERTEX, credentialsKey }), computerDriver: driver });
    await restarted.computers.wake(agent);
    await expect(restarted.computers.onState(owner.id, 'ready')).resolves.toBeUndefined();
    expect(await restarted.computers.get(owner.id)).toMatchObject({ pendingAgents: [], problem: expect.stringMatching(/CREDENTIALS_KEY/) });
    await expect(restarted.computers.onState(owner.id, 'ready')).resolves.toBeUndefined();
    expect((await restarted.computers.get(owner.id))!.problem).toMatch(/CREDENTIALS_KEY/);
    expect(runs).toEqual([]);

    const restored = createHub({ db, config: testConfig({ vertex: VERTEX, credentialsKey: key }), computerDriver: driver });
    await restored.computers.wake(agent);
    expect(runs.map((r) => r.agentId)).toEqual([agent.id]);
    expect((await restored.computers.get(owner.id))!.problem).toBeUndefined();
  });

  it('mail for a hosted agent starts its computer, and the agent runs once it is ready', async () => {
    const { hub, owner, agent, calls, runs } = await setup('comp-wake');
    await hub.send(owner, { to: agent.id }, [{ text: 'research our competitors' }]);
    await hub.wakeService.idle();
    expect(calls).toEqual([`start ${owner.id}`]);
    expect((await hub.computers.get(owner.id))!.state).toBe('starting');

    await hub.computers.onState(owner.id, 'ready');
    expect(calls.at(-1)).toBe(`run ${owner.id} ${agent.id}`);
    expect(runs[0]).toMatchObject({ agentName: 'Atlas', llmBaseUrl: expect.stringMatching(/\/llm\/vertex$/) });
    expect(await hub.llm.resolve(runs[0]!.llmKey)).toEqual({ agentId: agent.id, ownerId: owner.id });
    expect((await hub.computers.get(owner.id))!.pendingAgents).toEqual([]);

    // A second hosted agent on the same ready computer runs straight away.
    const other = await hub.hire(owner, 'Scout');
    await hub.computers.wake((await hub.registry.get(other.id))!);
    expect(runs.at(-1)).toMatchObject({ agentId: other.id });
    expect(calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
  });

  it('stops after a quiet spell, and starts again for mail that came while stopping', async () => {
    const { hub, owner, agent, calls } = await setup('comp-sleep');
    await hub.computers.wake(agent);
    await hub.computers.onState(owner.id, 'ready');
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    expect(await hub.computers.sweep(later(10))).toBe(0);
    expect(await hub.computers.sweep(later(31))).toBe(1);
    expect(calls.at(-1)).toBe(`stop ${owner.id}`);
    expect((await hub.computers.get(owner.id))!.state).toBe('stopping');

    await hub.computers.wake(agent); // mail while it stops: no second start yet
    expect(calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
    await hub.computers.onState(owner.id, 'stopped');
    expect(calls.at(-1)).toBe(`start ${owner.id}`);
    expect((await hub.computers.get(owner.id))!.state).toBe('starting');
  });

  it('a model or MCP call keeps a working agent\'s computer up long after its last mail', async () => {
    const { db, hub, owner, agent, calls } = await setup('comp-busy');
    await hub.send(owner, { to: agent.id }, [{ text: 'build the feature' }]);
    await hub.wakeService.idle();
    await hub.computers.onState(owner.id, 'ready');
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    await hub.computers.touch(owner.id, later(25));
    expect(await hub.computers.sweep(later(40))).toBe(0);
    // The next write is a minute away, so a call this soon doesn't move it on.
    await hub.computers.touch(owner.id, later(25.5));
    expect(await hub.computers.sweep(later(56))).toBe(1);
    expect(calls.at(-1)).toBe(`stop ${owner.id}`);
    // Nobody with a computer: nothing to keep up, and it doesn't fail.
    await expect(hub.computers.touch('nobody')).resolves.toBeUndefined();

    // Active MCP tool calls (like whoami) also touch the computer, while an empty wait_for_message poll does not.
    await hub.computers.onState(owner.id, 'stopped');
    await hub.computers.wake(agent);
    await hub.computers.onState(owner.id, 'ready');
    const past = new Date(Date.now() - 25 * 60_000).toISOString();
    await db.collection('computers').doc(owner.id).update({ lastActivityAt: past });

    const server = buildServer(hub, (await hub.registry.get(agent.id))!);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    await client.callTool({ name: 'whoami', arguments: {} });
    expect(await hub.computers.sweep(later(6))).toBe(0);

    await db.collection('computers').doc(owner.id).update({ lastActivityAt: past });
    await client.callTool({ name: 'wait_for_message', arguments: { timeoutSeconds: 0.05 } });
    expect(await hub.computers.sweep(later(6))).toBe(1);
    await client.close();
  });

  it("records why a computer couldn't start, for its owner", async () => {
    const { hub, owner, agent } = await setup('comp-fail');
    await hub.computers.wake(agent);
    await hub.computers.onState(owner.id, 'error', 'out of capacity');
    expect(await hub.computers.get(owner.id)).toMatchObject({ state: 'stopped', problem: 'out of capacity' });
    // A computer stuck starting is given up on by the sweep.
    await hub.computers.wake(agent);
    await hub.computers.sweep(new Date(Date.now() + 4 * 60_000));
    expect(await hub.computers.get(owner.id)).toMatchObject({ state: 'stopped', problem: expect.stringMatching(/in time/) });
  });

  it('hiring is on where the hub hosts agents, until an admin switches it off', async () => {
    const db = testDb();
    const hub = createHub({ db, config: testConfig({ vertex: VERTEX }), computerDriver: fakeDriver().driver });
    const { owner } = await crew(hub.registry, 'comp-hire-switch', []);
    expect(await hub.canHire()).toBe(true);
    await db.collection('settings').doc('connect').set({ shown: { hire: false } }, { merge: true });
    expect(await hub.canHire()).toBe(false);
    await expect(hub.hire(owner, 'Atlas')).rejects.toThrow(/switched off/);
    // Super admins still hire, on any plan, to try computer agents before everyone gets them.
    const before = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = owner.email;
    try {
      expect(await hub.canHire(owner)).toBe(true);
      expect((await hub.hire(owner, 'Atlas')).wake).toEqual({ type: 'computer' });
    } finally {
      process.env.SUPER_ADMIN_EMAILS = before;
    }
    await db.collection('settings').doc('connect').set({ shown: { hire: true } }, { merge: true });
    // A hub that doesn't host agents never offers it.
    expect(await createHub({ db, config: testConfig() }).canHire()).toBe(false);
  });

  it('without a driver, waking a hosted agent leaves its mail waiting and says why', async () => {
    const hub = createHub({ db: testDb(), config: testConfig({ vertex: VERTEX }) });
    const { owner } = await crew(hub.registry, 'comp-none', []);
    await hub.billing.setPlan(owner.id, { plan: 'pro' });
    const agent = await hub.hire(owner, 'Atlas');
    await hub.send(owner, { to: agent.id }, [{ text: 'hello?' }]);
    await hub.wakeService.idle();
    expect((await hub.computers.get(owner.id))!.problem).toMatch(/aren't running/);
    expect((await hub.registry.get(agent.id))!.wake!.problem).toMatch(/aren't running/);
  });

  it('the /tick sweep can recover hosted agents: wakeable() includes computer wakes', async () => {
    // Regression: the every-minute /tick wakeSweep uses registry.wakeable(). It once filtered to
    // ['claude-routine','webhook'] only, so a hosted (computer) agent whose fire-and-forget on-message
    // wake was missed (the instance scaled to zero before it ran) was never recovered and stayed asleep.
    const { hub, agent } = await setup('comp-sweep');
    expect((await hub.registry.get(agent.id))!.wake).toEqual({ type: 'computer' });
    expect((await hub.registry.wakeable()).map((a) => a.id)).toContain(agent.id);
  });
});
