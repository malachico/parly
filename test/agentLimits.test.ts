import { describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import { MAX_LIVE_BOTS } from '../src/registry/registry.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const CLOUD = { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } };

describe('live bot cap', () => {
  it(`stops one person at ${MAX_LIVE_BOTS} live bots, connected and cloud alike, and archiving frees a slot`, async () => {
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }) });
    const person = await testPerson(hub.registry);
    const first = (await hub.registry.createBot(person, { name: 'Bot 0' })).agent;
    await hub.createCloudAgent(person, { name: 'Cloud 0' });
    for (let i = 2; i < MAX_LIVE_BOTS; i++) await hub.registry.createBot(person, { name: `Bot ${i}` });
    const full = new RegExp(`You have ${MAX_LIVE_BOTS} agents, the most one person can have`);
    await expect(hub.registry.createBot(person, { name: 'One more' })).rejects.toThrow(full);
    await expect(hub.registry.createPairing(person, 'One more')).rejects.toThrow(full);
    await expect(hub.createCloudAgent(person, { name: 'Cloud 1' })).rejects.toThrow(full);
    // An agent you already have can still be reconnected.
    await hub.registry.createPairing(person, undefined, first.id);

    await hub.registry.setArchived(person, first.id, true);
    await hub.registry.createBot(person, { name: 'One more' });
    await expect(hub.registry.setArchived(person, first.id, false)).rejects.toThrow(full);
  }, 60_000);
});
