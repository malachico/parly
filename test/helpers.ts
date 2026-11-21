import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/db/types.js';
import { afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { createMongoDb } from '../src/db/mongo.js';
import type { HubConfig } from '../src/config.js';
import type { RegisterInput, Registry } from '../src/registry/registry.js';
import type { AgentRecord, ChannelRecord, WorkspaceRecord } from '../src/registry/types.js';

const mongoDbs: { db: Database; name: string }[] = [];
afterAll(async () => {
  if (!mongoDbs.length) return;
  const client = new MongoClient(process.env.TEST_MONGODB_URI!);
  try { for (const { db, name } of mongoDbs) { await client.db(name).dropDatabase(); await db.terminate(); } }
  finally { await client.close(); }
});


/** A throwaway Mongo database, so tests never share data. */
export function testDb(): Database {
  const uri = process.env.TEST_MONGODB_URI;
  if (!uri) throw new Error('TEST_MONGODB_URI is required for database tests');
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const db = createMongoDb(uri, name);
  mongoDbs.push({ db, name });
  return db;
}

export function testConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    maxWaitMs: 3_000,
    forwardTimeoutMs: 3_000,
    turnDeadlineMs: 270_000,
    allowPrivateAgentUrls: true,
    requireCredentialsKey: false,
    registerLimitPerHour: 1000,
    sendLimitPerMinute: 1000,
    // Tests sign people in with "dev:<email>" (see newAgentOverHttp).
    googleAuthDev: true,
    googleAuthLimitPerHour: 1000,
    inviteLimitPerHour: 1000,
    maxFileBytes: 25 * 1024 * 1024,
    fileTtlMs: 90 * 24 * 60 * 60 * 1000,
    oauthAccessTtlMs: 60 * 60 * 1000,
    oauthRefreshTtlMs: 90 * 24 * 60 * 60 * 1000,
    deviceLimitPerHour: 1000,
    wakeStaleMs: 5 * 60_000,
    wakeRetryMs: 10 * 60_000,
    wakeTimeoutMs: 3_000,
    wakeSweepMs: 60_000,
    llmMonthlyAllowanceUsd: 5,
    publicTurnLimitPerHour: 20,
    publicDailySpendCeilingUsd: 25,
    showcaseJudgeAgentIds: [],
    showcasePoolId: 'default',
    showcasePoolCredits: 0,
    showcaseUserCeiling: 0,
    channelRouter: true,
    channelRouterModel: 'flash-lite',
    searchModel: 'flash-lite',
    threadDeltaRule: false,
    threadDigest: false,
    contextGraphEnabled: true,
    contextGraphDailyCapUsd: 0.25,
    contextGraphEmbedding: { model: 'gemini-embedding-001', location: 'us-central1', dimensions: 768, pricePerMTok: 0.15 },
    graphChannelQuietMinutes: 30,
    computerIdleMs: 30 * 60_000,
    githubAppSlug: 'parly-dev',
    ...overrides,
  };
}

let seq = 0;
const unique = () => `${randomUUID().slice(0, 8)}${(seq++).toString(36)}`;

/** A person, as their first Google sign-in makes them. Every agent belongs to one. */
export async function testPerson(registry: Registry, name = 'Owner'): Promise<AgentRecord> {
  const u = unique();
  return (await registry.personFor({ sub: `test-${u}`, email: `${u}@people.test`, name })).agent;
}

/** A new agent, the way tests want one: a bot owned by a fresh person (there is no anonymous registration), or by `owner`. */
export async function newAgent(registry: Registry, input: RegisterInput, clientIp?: string, owner?: AgentRecord): Promise<{ agent: AgentRecord; token: string }> {
  return registry.createBot(owner ?? (await testPerson(registry)), input, clientIp);
}

/**
 * A person with a workspace, a channel in it, and bots they own in both: the smallest Slack.
 * Records come back fresh from the store, so membership arrays are current.
 */
export async function crew(
  registry: Registry,
  name: string,
  botNames: string[] = [`${name}-x`, `${name}-y`],
): Promise<{ owner: AgentRecord; workspace: WorkspaceRecord; channel: ChannelRecord; members: AgentRecord[] }> {
  const owner = await testPerson(registry, `${name}-owner`);
  const workspace = await registry.createWorkspace(owner, name);
  const channel = await registry.createChannel(owner, workspace.id, name);
  const members: AgentRecord[] = [];
  for (const botName of botNames) {
    const { agent } = await registry.createBot(owner, { name: botName });
    await registry.addToWorkspace(owner, workspace.id, agent.id);
    await registry.addToChannel(owner, channel.id, agent.id);
    members.push((await registry.get(agent.id))!);
  }
  return { owner: (await registry.get(owner.id))!, workspace, channel, members };
}

/**
 * Over HTTP: a person signs in with Google and makes a bot (POST /agents/bots); returns the bot's
 * token, and the owner's token and personal workspace (made on first sign-in). `idToken` defaults
 * to the dev bypass ("dev:<email>", on in testConfig); suites that fake Google their own way pass
 * a credential their verifier accepts.
 */
export async function newAgentOverHttp(
  hubUrl: string,
  fields: { name?: string; description?: string; skills?: { id: string; name: string; description?: string; tags?: string[] }[]; public?: boolean; url?: string },
  idToken = `dev:${unique()}@people.test`,
): Promise<{ token: string; agent: { id: string; name: string }; owner: { token: string; id: string; email: string; workspaceId: string } }> {
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${hubUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(`${path}: ${json.error ?? `HTTP ${res.status}`}`);
    return json;
  };
  const person = await post('/auth/google', { idToken });
  const bot = await post('/agents/bots', fields, person.token as string);
  const me = (await (await fetch(`${hubUrl}/me`, { headers: { authorization: `Bearer ${person.token}` } })).json()) as { workspaces: { id: string }[] };
  return {
    token: bot.token as string,
    agent: bot.agent as { id: string; name: string },
    owner: { token: person.token as string, id: person.agent.id as string, email: person.agent.email as string, workspaceId: me.workspaces[0]!.id },
  };
}

/**
 * Over HTTP: puts bots of different people in one workspace and channel. The first bot's owner
 * hosts: they invite each other owner by email (who joins at once, being signed in), each owner
 * adds their own bot to the workspace, and the host adds every bot to the channel.
 */
export async function crewOverHttp(hubUrl: string, bots: Awaited<ReturnType<typeof newAgentOverHttp>>[], channelName = 'crew'): Promise<{ workspaceId: string; channelId: string }> {
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? `HTTP ${res.status}`}`);
    return json;
  };
  const host = bots[0]!.owner;
  const workspaceId = host.workspaceId;
  const channel = await call(host.token, 'POST', `/workspaces/${workspaceId}/channels`, { name: channelName });
  for (const bot of bots) {
    if (bot.owner.id !== host.id) await call(host.token, 'POST', `/workspaces/${workspaceId}/invites`, { email: bot.owner.email });
    await call(bot.owner.token, 'POST', `/workspaces/${workspaceId}/members`, { agentId: bot.agent.id });
    await call(host.token, 'POST', `/channels/${channel.id}/members`, { agentId: bot.agent.id });
  }
  return { workspaceId, channelId: channel.id as string };
}

/** A free local port: bind to 0, read the port, close. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * `call(token, method, path, body?, headers?)` against the hub at `base()` (read on each call, since tests set
 * it in beforeAll): the status, the raw text and the parsed JSON (`{}` for an empty body).
 */
export function httpCaller(base: () => string) {
  return async (token: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text || '{}') as Record<string, any> };
  };
}
