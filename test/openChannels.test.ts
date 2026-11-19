import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import { COLLECTIONS, FieldValue } from '../src/db/types.js';
import type { HubService } from '../src/hub/hubService.js';
import { crew, newAgent, testConfig, testDb } from './helpers.js';

describe('open channels', () => {
  const db = testDb();
  let hub: HubService;
  beforeAll(() => {
    hub = createHub({ db, config: testConfig() });
  });

  it('rejects malformed channel ids and invitation emails without leaking DB errors', async () => {
    const { owner, workspace } = await crew(hub.registry, 'invalid-identifiers', []);
    for (const id of ['', 'missing/channel', 'missing/channel/nested']) {
      await expect(hub.registry.joinChannel(owner, id)).rejects.toMatchObject({ code: 'not_found' });
    }
    for (const email of ['bad/name@example.test', 'bad@example.test/nested']) {
      await expect(hub.registry.inviteToWorkspace(owner, workspace.id, email)).rejects.toMatchObject({ code: 'invalid' });
      await expect(hub.registry.revokeWorkspaceInvite(owner, workspace.id, email)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(await hub.registry.listWorkspaceInvites(owner, workspace.id)).toEqual([]);
  });

  it('rejects malformed member and skill ids without leaking DB errors', async () => {
    const { owner, channel } = await crew(hub.registry, 'invalid-member-skill-ids', []);
    for (const memberId of ['', '.', '..', 'bad/id', '__name__']) {
      await expect(hub.registry.setChannelRole(owner, channel.id, memberId, 'reviewer')).rejects.toMatchObject({
        code: 'not_found',
        message: `Agent '${memberId}' was not found`,
      });
    }
    for (const id of ['.', '..', '__name__']) {
      expect(await hub.registry.getSkill(id)).toBeUndefined();
    }
    expect(await hub.registry.skillsById(['.', '..', '__name__', 'a/b', ''])).toEqual([]);
  });

  it('lists the open channels a workspace member is not in, and lets them join; closed ones stay closed', async () => {
    const { owner, workspace, channel } = await crew(hub.registry, 'open-ws', []);
    const closed = await hub.registry.createChannel(owner, workspace.id, 'secret');
    await hub.registry.updateChannel(owner, closed.id, { open: false });
    // Channels from before the flag: only #general counts as open.
    const general = await hub.registry.createChannel(owner, workspace.id, 'general');
    const legacy = await hub.registry.createChannel(owner, workspace.id, 'legacy');
    for (const c of [general, legacy]) await db.collection(COLLECTIONS.channels).doc(c.id).update({ open: FieldValue.delete() });

    const { agent: bot } = await newAgent(hub.registry, { name: 'open-bot', public: true });
    await hub.registry.addToWorkspace(owner, workspace.id, bot.id);
    const newcomer = (await hub.registry.get(bot.id))!;
    expect((await hub.registry.joinableChannels(newcomer, workspace.id)).map((c) => c.name)).toEqual(['general', channel.name].sort());

    await hub.registry.joinChannel(newcomer, channel.id);
    expect(newcomer.channels).toContain(channel.id);
    expect((await hub.registry.joinableChannels(newcomer, workspace.id)).map((c) => c.name)).toEqual(['general']);
    await expect(hub.registry.joinChannel(newcomer, closed.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(hub.registry.joinChannel(newcomer, legacy.id)).rejects.toMatchObject({ code: 'not_found' });

    // Not in the workspace: nothing to list or join.
    const { agent: stranger } = await newAgent(hub.registry, { name: 'open-stranger', public: true });
    await expect(hub.registry.joinableChannels(stranger, workspace.id)).rejects.toBeTruthy();
    await expect(hub.registry.joinChannel(stranger, channel.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
