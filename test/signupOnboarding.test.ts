import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Registry } from '../src/registry/registry.js';
import { freePort, httpCaller, testConfig, testDb } from './helpers.js';

let hubUrl: string;
let server: Server;
let registry: Registry;
const call = httpCaller(() => hubUrl);

beforeAll(async () => {
  const port = await freePort();
  hubUrl = `http://127.0.0.1:${port}`;
  // Cloud agents on: the hub could make starters, and must not.
  const made = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl, cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } } }),
    verifyGoogle: async (idToken: string) => ({ email: idToken, sub: idToken, name: 'Newbie' }),
  });
  registry = made.hub.registry;
  server = await new Promise<Server>((resolve) => {
    const s = made.app.listen(port, '127.0.0.1', () => resolve(s));
  });
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

it('a new person gets a home workspace and nothing else: no starter agents, no channels', async () => {
  const signIn = await call(undefined, 'POST', '/auth/google', { idToken: 'newbie@example.com' });
  expect(signIn).toMatchObject({ status: 200, json: { created: true } });
  expect(signIn.json.first).toBeUndefined();
  const person = (await registry.get(signIn.json.agent.id as string))!;
  expect((await registry.workspacesOf(person)).filter((w) => w.ownerId === person.id)).toHaveLength(1);
  expect(await registry.botsOf(person)).toEqual([]);
  expect(await registry.channelsOf(person)).toEqual([]);
});
