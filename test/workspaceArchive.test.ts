import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import type { HubService } from '../src/hub/hubService.js';
import { crew, testConfig, testDb } from './helpers.js';

describe('archiving a workspace', () => {
  let hub: HubService;
  beforeAll(() => {
    hub = createHub({ db: testDb(), config: testConfig() });
  });

  it('an owner archives it when they have another active workspace: history stays, no new posts, until restored', async () => {
    const { owner, workspace, channel, members } = await crew(hub.registry, 'ws-archive', ['ws-archive-bot']);
    const { agent: extraBot } = await hub.registry.createBot(owner, { name: 'ws-archive-extra' });
    await hub.registry.addToWorkspace(owner, workspace.id, extraBot.id);
    await hub.registry.updateChannel(owner, channel.id, { archived: true });
    await expect(hub.registry.addToChannel(owner, channel.id, extraBot.id)).rejects.toThrow(/channel is archived/);
    await hub.registry.updateChannel(owner, channel.id, { archived: false });
    await hub.registry.createWorkspace(owner, 'ws-archive-second');
    await hub.send(owner, { channel: channel.id }, [{ text: 'before' }]);
    await expect(hub.registry.setWorkspaceArchived(members[0]!, workspace.id, true)).rejects.toThrow();

    expect((await hub.registry.setWorkspaceArchived(owner, workspace.id, true)).archived).toBe(true);
    await expect(hub.send(owner, { channel: channel.id }, [{ text: 'after' }])).rejects.toThrow(/workspace is archived/);
    // The history is still there to read.
    expect((await hub.chat.page(owner, `channel:${channel.id}`, 30)).messages.length).toBeGreaterThan(0);

    expect((await hub.registry.setWorkspaceArchived(owner, workspace.id, false)).archived).toBeUndefined();
    await hub.send(owner, { channel: channel.id }, [{ text: 'restored' }]);
  });

  it("blocks archiving a person's last remaining active workspace, and allows archiving either when they have 2", async () => {
    const { agent: user } = await hub.registry.signInWithGoogle('dev:solo-archive@test.local');
    const [first] = await hub.registry.workspacesOf(user);
    expect(first).toBeDefined();

    // (b) With 1 workspace, archiving it is blocked.
    await expect(hub.registry.setWorkspaceArchived(user, first!.id, true)).rejects.toThrow(/last remaining workspace cannot be archived/);

    // (a) With 2 workspaces, either one (including the first workspace made on sign-in) can be archived, then the remaining one is blocked.
    const second = await hub.registry.createWorkspace(user, 'Second');
    expect((await hub.registry.setWorkspaceArchived(user, first!.id, true)).archived).toBe(true);
    await expect(hub.registry.setWorkspaceArchived(user, second.id, true)).rejects.toThrow(/last remaining workspace cannot be archived/);

    // Restore the first, then archive the second instead.
    expect((await hub.registry.setWorkspaceArchived(user, first!.id, false)).archived).toBeUndefined();
    expect((await hub.registry.setWorkspaceArchived(user, second.id, true)).archived).toBe(true);
  });

  it('gives a user who ends up in 0 active workspaces a fresh workspace on sign-in', async () => {
    const { agent: user } = await hub.registry.signInWithGoogle('dev:orphan-check@test.local');
    const [initial] = await hub.registry.workspacesOf(user);
    expect(initial).toBeDefined();

    // Simulate user ending up in 0 active workspaces (both when removed and when their only shared workspace is archived by its owner).
    await (hub.registry as any).col.doc(user.id).update({ workspaces: [] });
    expect(await hub.registry.workspacesOf((await hub.registry.get(user.id))!)).toEqual([]);

    const { agent: signedBackIn } = await hub.registry.signInWithGoogle('dev:orphan-check@test.local');
    const workspaces = await hub.registry.workspacesOf(signedBackIn);
    expect(workspaces.filter((w) => !w.archived)).toHaveLength(1);
    expect(workspaces[0]!.id).not.toBe(initial!.id);
  });

  it('an owner or co-owner renames a workspace; non-owners are forbidden', async () => {
    const { owner, workspace, members } = await crew(hub.registry, 'ws-rename', ['ws-rename-bot']);
    await expect(hub.registry.renameWorkspace(members[0]!, workspace.id, 'hijacked')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.registry.renameWorkspace(owner, workspace.id, '   ')).rejects.toMatchObject({ code: 'invalid' });
    await expect(hub.registry.renameWorkspace(owner, workspace.id, 'x'.repeat(65))).rejects.toMatchObject({ code: 'invalid' });

    const renamed = await hub.registry.renameWorkspace(owner, workspace.id, '  Renamed Crew  ');
    expect(renamed.name).toBe('Renamed Crew');
    expect((await hub.registry.workspaceById(workspace.id))?.name).toBe('Renamed Crew');

    const own = await hub.registry.createWorkspace(owner, 'Personal');
    const renamedOwn = await hub.registry.renameWorkspace(owner, own.id, 'My Studio');
    expect(renamedOwn.name).toBe('My Studio');
  });
});
