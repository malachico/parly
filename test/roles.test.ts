import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { HubService } from '../src/hub/hubService.js';
import type { ChannelRecord } from '../src/registry/types.js';
import { crew, testConfig, testDb, testPerson, freePort } from './helpers.js';

/** Channel roles where they meet the outside: who may read them, and what the REST route accepts. */
describe('channel roles over REST and to outsiders', () => {
  let hubUrl: string;
  let server: Server;
  let hub: HubService;

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const made = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl }) });
    hub = made.hub;
    server = await new Promise<Server>((resolve) => {
      const s = made.app.listen(port, '127.0.0.1', () => resolve(s));
    });
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  async function call(token: string | undefined, method: string, path: string, body?: unknown) {
    const res = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('shows roles only to those who may read the channel, and rejects a malformed role', async () => {
    const { owner, workspace, channel } = await crew(hub.registry, 'rest-roles', []);
    // A public bot owner in the channel, with a token, so it can call REST.
    const { agent: bot, token } = await hub.registry.createBot(owner, { name: 'rest-roles-bot', public: true });
    await hub.registry.addToWorkspace(owner, workspace.id, bot.id);
    await hub.registry.addToChannel(owner, channel.id, bot.id);
    await hub.registry.addChannelOwner(owner, channel.id, bot.id);
    expect((await call(token, 'PUT', `/channels/${channel.id}/roles/${bot.id}`, { role: 'architect' })).status).toBe(200);

    const roleOf = (list: any[]) => list.find((a) => a.id === bot.id)?.role;
    expect(roleOf((await call(token, 'GET', `/agents?channel=${channel.id}`)).body)).toBe('architect');
    // No caller, or a caller outside the channel, sees the bot (it's public) but not its role.
    expect(roleOf((await call(undefined, 'GET', `/agents?channel=${channel.id}`)).body)).toBeUndefined();
    const { token: outsiderToken } = await hub.registry.createBot(await testPerson(hub.registry, 'rest-roles-out'), { name: 'rest-roles-outsider' });
    expect(roleOf((await call(outsiderToken, 'GET', `/agents?channel=${channel.id}`)).body)).toBeUndefined();
    expect(await hub.registry.channelRolesFor((await hub.registry.get(owner.id))!, channel.id)).toEqual({ [bot.id]: 'architect' });

    // A non-string role is a mistake, not a clear: 400 and the role stays. An explicit "" clears.
    for (const bad of [{ role: 123 }, {}, { role: null }]) {
      expect((await call(token, 'PUT', `/channels/${channel.id}/roles/${bot.id}`, bad)).status).toBe(400);
    }
    expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.roles?.[bot.id]).toBe('architect');
    expect((await call(token, 'PUT', `/channels/${channel.id}/roles/${bot.id}`, { role: '' })).status).toBe(200);
    expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.roles?.[bot.id]).toBeUndefined();
  });

  it('rechecks the setter inside the write: a co-owner removed after the first check cannot set a role', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'rest-roles-race');
    const [coOwner, target] = members as [NonNullable<(typeof members)[0]>, NonNullable<(typeof members)[1]>];
    await hub.registry.addChannelOwner(owner, channel.id, coOwner.id);
    const stale = (await hub.registry.get(coOwner.id))!;
    // Let the first check pass as it did before the removal, then remove the co-owner before the write.
    const registry = hub.registry as unknown as { requireChannelOwner: (a: unknown, id: string) => Promise<ChannelRecord> };
    const original = registry.requireChannelOwner;
    registry.requireChannelOwner = async () => {
      registry.requireChannelOwner = original; // the removal below checks its own owner
      const passed = (await hub.registry.channelsById([channel.id])).get(channel.id)!;
      await hub.registry.removeFromChannel((await hub.registry.get(owner.id))!, channel.id, coOwner.id);
      return passed;
    };
    try {
      await expect(hub.registry.setChannelRole(stale, channel.id, target.id, 'reviewer')).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      registry.requireChannelOwner = original;
    }
    expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.roles?.[target.id]).toBeUndefined();
  });
});
