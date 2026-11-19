import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import type { Database } from '../src/db/types.js';
import type { ForwardResult, Forwarder } from '../src/hub/forward.js';
import type { HubService } from '../src/hub/hubService.js';
import type { AgentRecord } from '../src/registry/types.js';
import type { WireMessage } from '../src/lib/wire.js';
import { channelView } from '../src/lib/present.js';
import { crew, newAgent, testConfig, testDb, testPerson } from './helpers.js';

/** Forwarder stub: records calls and answers according to `respond`. */
class StubForwarder implements Forwarder {
  sent: WireMessage[] = [];
  respond: (m: WireMessage) => ForwardResult | Promise<ForwardResult> = (m) => ({
    kind: 'message',
    message: { messageId: 'r', role: 'ROLE_AGENT', parts: [{ text: `stub: ${m.parts[0]?.text}` }] },
  });
  async send(_agent: AgentRecord, m: WireMessage) {
    this.sent.push(m);
    return this.respond(m);
  }
  async getTask(): Promise<ForwardResult & { kind: 'task' }> {
    return {
      kind: 'task',
      task: { id: 'down-1', contextId: 'down-ctx', status: { state: 'TASK_STATE_COMPLETED', message: { messageId: 'd2', role: 'ROLE_AGENT', parts: [{ text: 'done later' }] } } },
    };
  }
  async cancel() {}
}

describe('HubService', () => {
  let hub: HubService;
  let db: Database;
  let forwarder: StubForwarder;
  let alice: AgentRecord;
  let bob: AgentRecord;
  let carol: AgentRecord;

  beforeAll(async () => {
    forwarder = new StubForwarder();
    db = testDb();
    hub = createHub({
      db,
      config: testConfig(),
      forwarder,
      fetchCard: async () => ({ name: 'remote', description: '', skills: [{ id: 'remote-skill', name: 'Remote' }] }),
      // "<email>|<sub>" stands in for a verified Google credential.
      verifyGoogle: async (idToken) => {
        const [email = '', sub = ''] = idToken.split('|');
        return { email, sub, name: email.split('@')[0]! };
      },
    });
    alice = (await newAgent(hub.registry, { name: 'alice', public: true })).agent;
    bob = (await newAgent(hub.registry, { name: 'bob', public: true, skills: [{ id: 'shout', name: 'Shout' }] })).agent;
    carol = (await newAgent(hub.registry, { name: 'carol', public: true })).agent;
    await newAgent(hub.registry, { url: 'http://remote.test', public: true }); // a public endpoint in the directory
  });

  describe('visibility, workspaces and channels', () => {
    const fresh = async (a: AgentRecord) => (await hub.registry.get(a.id))!;

    it('hides private agents from strangers, and shows them to everyone in a shared workspace', async () => {
      const keeper = await testPerson(hub.registry, 'keeper');
      const phantom = (await newAgent(hub.registry, { name: 'phantom', skills: [{ id: 'haunt', name: 'Haunt' }] }, undefined, keeper)).agent;
      const friend = (await newAgent(hub.registry, { name: 'friend' }, undefined, keeper)).agent;
      expect(phantom.public).toBe(false);

      // Strangers (and anonymous callers) can't find, address, or skill-route to a private agent. Nor can a sibling bot.
      expect((await hub.registry.search(undefined)).map((a) => a.name)).not.toContain('phantom');
      expect((await hub.registry.search(alice)).map((a) => a.name)).not.toContain('phantom');
      expect((await hub.registry.search(friend)).map((a) => a.name)).not.toContain('phantom');
      await expect(hub.send(alice, { to: phantom.id }, [{ text: 'boo' }])).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.send(friend, { skill: 'haunt' }, [{ text: 'boo' }])).rejects.toMatchObject({ code: 'not_found' });

      // Same workspace, no channel needed: they see and can message each other; others still can't.
      const workspace = await hub.registry.createWorkspace(keeper, 'spooky');
      await hub.registry.addToWorkspace(keeper, workspace.id, phantom.id);
      await hub.registry.addToWorkspace(keeper, workspace.id, friend.id);
      expect((await hub.registry.search(await fresh(friend), { workspace: workspace.id })).map((a) => a.name).sort()).toEqual(['friend', 'keeper', 'phantom']);
      const sent = await hub.send(await fresh(friend), { skill: 'haunt' }, [{ text: 'hi' }]);
      expect(sent.recipients.map((r) => r.name)).toEqual(['phantom']);
      expect((await hub.registry.search(alice)).map((a) => a.name)).not.toContain('friend');

      // Going public lists the agent for everyone.
      await hub.registry.register({ name: 'phantom', public: true }, await fresh(phantom));
      expect((await hub.registry.search(undefined)).map((a) => a.name)).toContain('phantom');
    });

    it('gives super admins owner rights on every workspace and channel', async () => {
      const { owner, workspace, channel, members: [worker] } = await crew(hub.registry, 'shop', ['worker']);
      const admin = { ...worker!, id: 'not-a-member', workspaces: [], channels: [], email: 'root@example.com', googleSub: 'root-sub' };
      await expect(hub.registry.setWorkspaceDomains(admin, workspace.id, ['acme.test'])).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.registry.removeFromChannel(admin, channel.id, worker!.id)).rejects.toMatchObject({ code: 'not_found' });
      process.env.SUPER_ADMIN_EMAILS = 'someone@else.com Root@Example.com';
      try {
        expect((await hub.registry.setWorkspaceDomains(admin, workspace.id, [])).domains).toEqual([]);
        await hub.registry.removeFromChannel(admin, channel.id, worker!.id);
        expect((await fresh(worker!)).channels).toEqual([]);
        await hub.registry.removeFromWorkspace(admin, workspace.id, worker!.id);
        expect((await fresh(worker!)).workspaces).toEqual([]);
        expect((await fresh(owner)).workspaces).toContain(workspace.id);
      } finally {
        delete process.env.SUPER_ADMIN_EMAILS;
      }
    });

    it('lets owners appoint channel co-owners, who can leave but not remove the creator; workspace owners manage every channel', async () => {
      const { owner, workspace, channel, members: [deputy, other] } = await crew(hub.registry, 'duo', ['deputy', 'other']);
      await expect(hub.registry.addChannelOwner(deputy!, channel.id, deputy!.id)).rejects.toMatchObject({ code: 'forbidden' });
      await hub.registry.addChannelOwner(owner, channel.id, deputy!.id);
      const promoted = await fresh(deputy!);
      await expect(hub.registry.removeFromChannel(promoted, channel.id, owner.id)).rejects.toMatchObject({ code: 'forbidden' });
      await hub.registry.removeFromChannel(promoted, channel.id, other!.id);
      expect((await fresh(other!)).channels).toEqual([]);
      await hub.registry.leaveChannel(promoted, channel.id);
      expect((await hub.registry.channelsOf(owner))[0]!.ownerIds).toEqual([]);

      // A channel made by a member: the workspace owner can manage it without being in it.
      const side = await hub.registry.createChannel(await fresh(deputy!), workspace.id, 'side');
      await hub.registry.addToChannel(await fresh(deputy!), side.id, other!.id);
      expect((await hub.registry.channelsOf(await fresh(owner))).map((c) => c.id)).not.toContain(side.id);
      await hub.registry.removeFromChannel(await fresh(owner), side.id, other!.id);
      expect((await fresh(other!)).channels).toEqual([]);
      await expect(hub.registry.leaveChannel(await fresh(deputy!), side.id)).rejects.toMatchObject({ code: 'conflict' });
    });

    it('archives a bot everywhere: hidden, unreachable, token frozen; only owners see and restore it', async () => {
      const owner = await testPerson(hub.registry, 'keeper');
      const reg = await hub.registry.createBot(owner, { name: 'oldbot', skills: [{ id: 'dust', name: 'dust' }] });
      const bot = reg.agent;
      const peer = (await hub.registry.createBot(owner, { name: 'peerbot' })).agent;
      const workspace = await hub.registry.createWorkspace(owner, 'attic');
      const channel = await hub.registry.createChannel(owner, workspace.id, 'attic');
      for (const b of [bot, peer]) {
        await hub.registry.addToWorkspace(owner, workspace.id, b.id);
        await hub.registry.addToChannel(owner, channel.id, b.id);
      }
      const names = async (viewer: typeof bot) => (await hub.registry.search(await fresh(viewer), { workspace: workspace.id })).map((a) => a.name);

      await expect(hub.registry.setArchived(await fresh(peer), bot.id, true)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(hub.registry.setArchived(await fresh(owner), owner.id, true)).rejects.toMatchObject({ code: 'invalid' });
      await hub.registry.setArchived(await fresh(bot), bot.id, true);

      expect(await names(peer)).not.toContain('oldbot');
      expect((await hub.registry.search(await fresh(owner))).map((a) => a.name)).not.toContain('oldbot');
      expect(await names(owner)).toContain('oldbot');
      await expect(hub.send(await fresh(peer), { to: bot.id }, [{ text: 'hi' }])).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.send(await fresh(owner), { skill: 'dust' }, [{ text: 'hi' }])).rejects.toMatchObject({ code: 'not_found' });
      expect((await hub.send(await fresh(owner), { channel: channel.id }, [{ text: 'all' }])).recipients.map((r) => r.id)).toEqual([peer.id]);
      await expect(hub.registry.authenticate(reg.token!)).rejects.toMatchObject({ code: 'forbidden' });

      await hub.registry.setArchived(await fresh(owner), bot.id, false);
      expect(await names(peer)).toContain('oldbot');
      expect((await hub.registry.authenticate(reg.token!))?.id).toBe(bot.id);
    });

    it('lets the owner remove members; leaving a workspace drops its channels too', async () => {
      const { owner, workspace, channel, members: [member, peer] } = await crew(hub.registry, 'crew', ['member', 'peer']);
      const outsider = (await newAgent(hub.registry, { name: 'outsider' })).agent;

      await expect(hub.registry.removeFromWorkspace(member!, workspace.id, owner.id)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(hub.registry.removeFromWorkspace(outsider, workspace.id, member!.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.registry.leaveWorkspace(owner, workspace.id)).rejects.toMatchObject({ code: 'conflict' });
      await expect(hub.registry.addToWorkspace(owner, workspace.id, outsider.id)).rejects.toMatchObject({ code: 'not_found' });

      await hub.registry.addChannelOwner(owner, channel.id, member!.id);
      await hub.registry.removeFromWorkspace(owner, workspace.id, member!.id);
      const gone = await fresh(member!);
      expect(gone).toMatchObject({ workspaces: [], channels: [] });
      expect((await hub.registry.channelsOf(owner))[0]!.ownerIds).toEqual([]);
      // Its owner it can always reach; the rest of the workspace is gone from view.
      await expect(hub.send(gone, { to: peer!.id }, [{ text: 'still here?' }])).rejects.toMatchObject({ code: 'not_found' });

      // Adding again is idempotent, and leaving (not as creator) works for a co-owner.
      await hub.registry.addToWorkspace(await fresh(owner), workspace.id, member!.id);
      await hub.registry.addToWorkspace(await fresh(owner), workspace.id, member!.id);
      expect((await fresh(member!)).workspaces).toEqual([workspace.id]);
      await hub.registry.addWorkspaceOwner(owner, workspace.id, member!.id);
      await hub.registry.leaveWorkspace(await fresh(member!), workspace.id);
      expect((await hub.registry.workspacesOf(owner))[0]!.ownerIds).toEqual([]);
      expect((await hub.registry.workspacesOf(await fresh(member!)))).toEqual([]);
    });

    it('fills channels from the workspace: bots are added by id, people invited by email', async () => {
      const { owner, workspace, channel } = await crew(hub.registry, 'fill', []);
      const { agent: bot } = await hub.registry.createBot(owner, { name: 'fill-bot' });
      await expect(hub.registry.addToChannel(owner, channel.id, bot.id)).rejects.toThrow(/workspace yet/);
      await hub.registry.addToWorkspace(owner, workspace.id, bot.id);
      expect((await hub.registry.addToChannel(await fresh(owner), 'fill', bot.id)).agent.channels).toEqual([channel.id]);

      const guest = await testPerson(hub.registry, 'guest');
      await expect(hub.registry.addToWorkspace(owner, workspace.id, guest.id)).rejects.toMatchObject({ code: 'not_found' });
      await hub.registry.inviteToWorkspace(owner, workspace.id, guest.email!.toUpperCase());
      expect((await fresh(guest)).workspaces).toEqual([workspace.id]);
      await expect(hub.registry.addToWorkspace(await fresh(owner), workspace.id, guest.id)).rejects.toThrow(/is a person/);
      await hub.registry.addToChannel(await fresh(owner), channel.id, guest.id);
      expect((await fresh(guest)).channels).toEqual([channel.id]);

      // Channel names are resolved among the caller's channels; a name in two workspaces needs the workspace.
      const second = await hub.registry.createWorkspace(await fresh(owner), 'fill-two');
      await hub.registry.createChannel(await fresh(owner), second.id, 'fill');
      await expect(hub.registry.resolveMemberChannel(await fresh(owner), 'fill')).rejects.toThrow(/several channels/);
      expect((await hub.registry.resolveMemberChannel(await fresh(owner), 'fill', 'fill-two')).workspaceId).toBe(second.id);
      expect((await hub.registry.resolveMemberChannel(await fresh(owner), channel.id)).id).toBe(channel.id);
    });

    it('channel roles: owners (people or bots) set and clear them; members see their current one', async () => {
      const { owner, workspace, channel, members } = await crew(hub.registry, 'roles');
      const [x, y] = members as [AgentRecord, AgentRecord];
      // A plain member can't set roles; a member made co-owner can, bot or not.
      await expect(hub.registry.setChannelRole(await fresh(x), channel.id, y.id, 'reviewer')).rejects.toMatchObject({ code: 'forbidden' });
      await hub.registry.addChannelOwner(owner, channel.id, x.id);
      expect((await hub.registry.setChannelRole(await fresh(x), channel.id, y.id, ' reviewer ')).roles).toEqual({ [y.id]: 'reviewer' });
      expect((await hub.registry.setChannelRole(await fresh(x), channel.id, owner.id, 'architect')).roles?.[owner.id]).toBe('architect');
      await expect(hub.registry.setChannelRole(owner, channel.id, y.id, 'x'.repeat(41))).rejects.toMatchObject({ code: 'invalid' });
      const outsider = await testPerson(hub.registry, 'roles-outsider');
      await expect(hub.registry.setChannelRole(owner, channel.id, outsider.id, 'qa')).rejects.toMatchObject({ code: 'not_found' });
      expect(channelView(await hub.registry.resolveMemberChannel(await fresh(y), channel.id), await fresh(y)).myRole).toBe('reviewer');

      // Roles are per channel: the same member can hold another one elsewhere.
      const side = await hub.registry.createChannel(await fresh(owner), workspace.id, 'roles-side');
      await hub.registry.addToChannel(await fresh(owner), side.id, y.id);
      await hub.registry.setChannelRole(await fresh(owner), side.id, y.id, 'implementer');

      // A delivered message shows the role current when it's read, not when it was sent.
      await hub.send(await fresh(owner), { channel: channel.id }, [{ text: 'look at this' }]);
      await hub.registry.setChannelRole(await fresh(owner), channel.id, y.id, 'qa');
      const [item] = await hub.inboxView(await fresh(y), await hub.chat.take(await fresh(y)));
      expect(item).toMatchObject({ role: 'qa', roleNote: 'Your role in roles: qa.' });

      // Empty clears; leaving, being removed and leaving the workspace all clear it, and rejoining doesn't bring it back.
      await hub.registry.setChannelRole(await fresh(owner), channel.id, owner.id, '');
      expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.roles?.[owner.id]).toBeUndefined();
      await hub.registry.removeFromChannel(await fresh(owner), channel.id, y.id);
      expect((await hub.registry.channelsById([channel.id])).get(channel.id)?.roles?.[y.id]).toBeUndefined();
      expect((await hub.registry.channelsById([side.id])).get(side.id)?.roles?.[y.id]).toBe('implementer');
      await hub.registry.removeFromWorkspace(await fresh(owner), workspace.id, y.id);
      expect((await hub.registry.channelsById([side.id])).get(side.id)?.roles?.[y.id]).toBeUndefined();
      await hub.registry.addToWorkspace(await fresh(owner), workspace.id, y.id);
      await hub.registry.addToChannel(await fresh(owner), side.id, y.id);
      expect((await hub.registry.channelsById([side.id])).get(side.id)?.roles?.[y.id]).toBeUndefined();
    });

    it('a role set while the member is being removed never outlives the membership', async () => {
      const { owner, channel, members } = await crew(hub.registry, 'race');
      const target = members[0]!;
      await Promise.allSettled([hub.registry.setChannelRole(owner, channel.id, target.id, 'reviewer'), hub.registry.removeFromChannel(owner, channel.id, target.id)]);
      const roles = (await hub.registry.channelsById([channel.id])).get(channel.id)?.roles ?? {};
      expect((await fresh(target)).channels ?? []).not.toContain(channel.id);
      expect(roles[target.id]).toBeUndefined();
    });

    it('who reads a message: its sides, a member of its channel, the owner of a bot in a DM; not the rest of the workspace', async () => {
      const { owner, workspace, channel, members } = await crew(hub.registry, 'reads', ['reads-x', 'reads-y', 'reads-z']);
      const [x, y, z] = members as [AgentRecord, AgentRecord, AgentRecord];
      await hub.registry.removeFromChannel(owner, channel.id, z.id);
      const outsiderOwner = await testPerson(hub.registry, 'reads-other');
      await hub.registry.inviteToWorkspace(await fresh(owner), workspace.id, outsiderOwner.email!);

      // A direct message between x and y.
      const dm = (await hub.send(await fresh(x), { to: y.id }, [{ text: 'just us' }])).message;
      await expect(hub.chat.readable(await fresh(z), dm.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.chat.readable(await fresh(outsiderOwner), dm.id)).rejects.toMatchObject({ code: 'not_found' });
      // owner made x and y: the owner of a bot on either side sees it.
      expect((await hub.chat.readable(await fresh(owner), dm.id)).message.id).toBe(dm.id);

      // A channel post is read by every member of the channel, not by z who left.
      const post = (await hub.send(await fresh(x), { channel: channel.id }, [{ text: 'all' }])).message;
      expect((await hub.chat.readable(await fresh(y), post.id)).message.id).toBe(post.id);
      await expect(hub.chat.readable(await fresh(z), post.id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it("an owner sees their bot's conversations, read-only; nobody else does", async () => {
      const { owner, channel, members } = await crew(hub.registry, 'watch', ['watch-bot', 'watch-peer']);
      const [bot, peer] = members as [AgentRecord, AgentRecord];
      const stranger = await testPerson(hub.registry, 'watch-stranger');
      const dm = (await hub.send(await fresh(peer), { to: bot.id }, [{ text: 'can you look?' }])).message;
      await hub.send(await fresh(bot), { channel: channel.id }, [{ text: 'hello channel' }]);

      const convos = await hub.conversationViews(await hub.ownedBot(await fresh(owner), bot.id));
      expect(convos.map((c) => c.key).sort()).toEqual([`agent:${peer.id}`, `channel:${channel.id}`].sort());
      expect(convos.find((c) => c.key === `agent:${peer.id}`)).toMatchObject({ kind: 'direct', with: { id: peer.id } });
      const page = await hub.chat.page(await hub.ownedBot(await fresh(owner), bot.id), `agent:${peer.id}`, 10);
      expect(page.messages.map((m) => m.id)).toEqual([dm.id]);

      await expect(hub.ownedBot(await fresh(stranger), bot.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.ownedBot(await fresh(peer), bot.id)).rejects.toMatchObject({ code: 'not_found' });

      // A mailbox bot is online while it has a wait open.
      expect(await hub.online(await fresh(bot))).toBe(false);
      await hub.registry.markListening(await fresh(bot));
      expect(await hub.online(await fresh(bot))).toBe(true);
    });

    it('renames and archives a channel: owners only, archived takes no posts until restored', async () => {
      const { owner, channel, members } = await crew(hub.registry, 'ren');
      const bot = await fresh(members[0]!);
      await expect(hub.registry.updateChannel(bot, channel.id, { name: 'nope' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(hub.registry.updateChannel(owner, channel.id, {})).rejects.toMatchObject({ code: 'invalid' });
      expect((await hub.registry.updateChannel(owner, channel.id, { name: '  ren-two ' })).name).toBe('ren-two');
      expect((await hub.registry.resolveMemberChannel(bot, 'ren-two')).id).toBe(channel.id);

      await hub.registry.updateChannel(owner, channel.id, { archived: true });
      await expect(hub.send(bot, { channel: channel.id }, [{ text: 'hi' }])).rejects.toThrow(/archived/);
      await hub.registry.updateChannel(owner, channel.id, { archived: false });
      expect((await hub.send(bot, { channel: channel.id }, [{ text: 'hi' }])).recipients).toHaveLength(2);
    });

    it('keeps a direct message with an archived or deleted bot, marked so the web shows it read-only', async () => {
      const { owner, members } = await crew(hub.registry, 'gone', ['gone-a', 'gone-b']);
      const [a, b] = members as [AgentRecord, AgentRecord];
      const me = await fresh(owner);
      for (const to of [a.id, b.id]) await hub.send(me, { to }, [{ text: 'hi' }]);
      await hub.registry.setArchived(me, a.id, true);
      await hub.registry.unregister((await hub.registry.get(b.id))!);

      const withOf = async (id: string) => (await hub.conversationViews(await fresh(owner))).find((c) => c.key === `agent:${id}`)?.with;
      expect(await withOf(a.id)).toMatchObject({ id: a.id, name: 'gone-a', status: 'archived' });
      expect(await withOf(b.id)).toMatchObject({ id: b.id, name: 'gone-b', status: 'deleted' });
      await hub.registry.setArchived(await fresh(owner), a.id, false);
      expect(await withOf(a.id)).not.toHaveProperty('status');
    });

    it('scopes conversations to a workspace: its channels and direct messages with its members', async () => {
      const { owner, workspace: one, channel, members: [x] } = await crew(hub.registry, 'scope-one', ['scope-x']);
      const two = await hub.registry.createWorkspace(await fresh(owner), 'scope-two');
      const { agent: z } = await hub.registry.createBot(await fresh(owner), { name: 'scope-z' });
      await hub.registry.addToWorkspace(await fresh(owner), two.id, z.id);
      const kim = (await newAgent(hub.registry, { name: 'scope-kim', public: true })).agent;
      const me = await fresh(owner);
      for (const to of [x!.id, z.id, kim.id]) await hub.send(me, { to }, [{ text: 'hi' }]);
      await hub.send(me, { channel: channel.id }, [{ text: 'post' }]);

      const keys = async (workspace?: string) => (await hub.conversationViews(me, { workspace })).map((c) => c.key).sort();
      expect(await keys()).toEqual([`agent:${kim.id}`, `agent:${x!.id}`, `agent:${z.id}`, `channel:${channel.id}`].sort());
      expect(await keys(one.id)).toEqual([`agent:${kim.id}`, `agent:${x!.id}`, `channel:${channel.id}`].sort());
      expect(await keys(two.id)).toEqual([`agent:${kim.id}`, `agent:${z.id}`].sort());
      const row = (await hub.conversationViews(me, { workspace: one.id })).find((c) => c.kind === 'channel')!;
      expect(row.channel).toEqual({ id: channel.id, workspaceId: one.id, name: 'scope-one' });
    });
  });

  it('an agent posting just PASS (once or repeated) posts nothing; people can say it', async () => {
    const { owner, channel, members } = await crew(hub.registry, `pass-${Date.now()}`);
    const [bot] = members;
    for (const text of ['PASS', 'PASS PASS', ' NO_REPLY ']) await expect(hub.send(bot!, { channel: channel.id }, [{ text }])).rejects.toThrow(/Nothing posted/);
    await hub.send(bot!, { channel: channel.id }, [{ text: 'PASS on the left, then shoot' }]); // a sentence is a message
    await hub.send(owner, { channel: channel.id }, [{ text: 'PASS' }]); // a person is never swallowed
    const texts = (await hub.chat.page(owner, `channel:${channel.id}`, 10)).messages.map((m) => m.parts[0]!.text);
    expect(texts).toEqual(['PASS on the left, then shoot', 'PASS']);
  });

  describe('workspaces on sign-in', () => {
    const fresh = async (a: AgentRecord) => (await hub.registry.get(a.id))!;
    const signIn = async (email: string) => (await hub.registry.signInWithGoogle(`${email}|g-${email}`)).agent;

    it('makes a home workspace once for a person with nowhere to go', async () => {
      const ida = await signIn('ida@solo.test');
      const [home] = await hub.registry.workspacesOf(ida);
      expect(home).toMatchObject({ name: "ida's workspace", ownerId: ida.id });
      expect(home).not.toHaveProperty('personalFor');
      expect((await signIn('ida@solo.test')).workspaces).toEqual([home!.id]);
      expect((await hub.registry.workspacesOf(await fresh(ida))).length).toBe(1);
    });

    it('invited people land in the inviting workspace, and get no personal one', async () => {
      const host = await signIn('host@invite.test');
      const workspace = await hub.registry.createWorkspace(host, 'invite-co');
      await hub.registry.inviteToWorkspace(host, workspace.id, 'newbie@invite.test');
      expect((await hub.registry.listWorkspaceInvites(host, workspace.id)).map((i) => i.email)).toEqual(['newbie@invite.test']);
      const newbie = await signIn('newbie@invite.test');
      expect(newbie.workspaces).toEqual([workspace.id]);
      expect(await hub.registry.listWorkspaceInvites(host, workspace.id)).toEqual([]);
      await hub.registry.inviteToWorkspace(host, workspace.id, 'later@invite.test');
      await hub.registry.revokeWorkspaceInvite(host, workspace.id, 'later@invite.test');
      expect(await hub.registry.listWorkspaceInvites(host, workspace.id)).toEqual([]);
    });

    it('a referral: whoever invited a new person, and both get 100 credits once that person has an agent answer (up to 10 for the inviter)', async () => {
      const host = await signIn('host@referral.test');
      const workspace = await hub.registry.createWorkspace(host, 'referral-co');
      await hub.registry.inviteToWorkspace(host, workspace.id, 'friend@referral.test');
      const friend = await signIn('friend@referral.test');
      expect((await fresh(friend)).referredBy).toBe(host.id);
      const extra = async (id: string) => (await hub.billing.get(id))?.extraMicros ?? 0;
      expect(await extra(host.id)).toBe(0);
      // Their agent answers them: both get 100 credits (1¢ each), once.
      await hub.llm.add(friend.id, 1000, { id: 'agent-1', usage: {} });
      await hub.llm.add(friend.id, 1000, { id: 'agent-1', usage: {} });
      expect([await extra(host.id), await extra(friend.id)]).toEqual([1_000_000, 1_000_000]);
      expect((await hub.billing.get(host.id))?.referrals).toBe(1);
      // At 10 friends, the inviter gets no more; the friend still does.
      await db.collection('billing').doc(host.id).set({ referrals: 10 }, { merge: true });
      await hub.registry.inviteToWorkspace(host, workspace.id, 'eleventh@referral.test');
      const eleventh = await signIn('eleventh@referral.test');
      await hub.llm.add(eleventh.id, 1000, { id: 'agent-2', usage: {} });
      expect([await extra(host.id), await extra(eleventh.id)]).toEqual([1_000_000, 1_000_000]);
      // Someone already on Parly isn't anyone's referral.
      await signIn('already@referral.test');
      await hub.registry.inviteToWorkspace(host, workspace.id, 'already@referral.test');
      expect((await fresh(await signIn('already@referral.test'))).referredBy).toBeUndefined();
    });

    it('joins people by their email domain, never by a public mail provider', async () => {
      const founder = await signIn('founder@domain-join.test');
      const [acme] = await hub.registry.workspacesOf(founder);
      await expect(hub.registry.setWorkspaceDomains(founder, acme!.id, ['gmail.com'])).rejects.toThrow(/public mail provider/);
      await expect(hub.registry.setWorkspaceDomains(founder, acme!.id, ['not a domain'])).rejects.toMatchObject({ code: 'invalid' });
      await expect(hub.registry.setWorkspaceDomains(founder, acme!.id, ['domain-join.test', 'acme.example'])).rejects.toMatchObject({ code: 'invalid' });
      expect((await hub.registry.setWorkspaceDomains(founder, acme!.id, ['@Domain-join.test', 'domain-join.test'])).domains).toEqual(['domain-join.test']);
      const member = (await hub.registry.createBot(founder, { name: 'acme-bot' })).agent;
      await expect(hub.registry.setWorkspaceDomains(member, acme!.id, ['x.test'])).rejects.toMatchObject({ code: 'not_found' });

      const hire = await signIn('hire@domain-join.test');
      expect(hire.workspaces).toEqual([acme!.id]);
      expect((await signIn('hire@domain-join.test')).workspaces).toEqual([acme!.id]);
      const stranger = await signIn('stranger@other.test');
      expect(stranger.workspaces).not.toContain(acme!.id);
      const gmailer = await signIn('someone@gmail.com');
      expect(gmailer.workspaces).not.toContain(acme!.id);
    });

    it('bills people who join by domain to the company pool, and unlinks them on leave, removal or domain removal', async () => {
      const boss = await signIn('boss@pool-co.test');
      const [ws] = await hub.registry.workspacesOf(boss);
      await hub.registry.setWorkspaceDomains(boss, ws!.id, ['pool-co.test']);

      const dev = await signIn('dev@pool-co.test');
      expect((await fresh(dev)).billingAccountId).toBe(ws!.id);
      const { agent: bot } = await hub.registry.createBot(dev, { name: 'dev bot' });
      expect(await hub.llm.payerOf(bot)).toBe(ws!.id);
      // An outsider invited by email keeps paying for themselves.
      await hub.registry.inviteToWorkspace(boss, ws!.id, 'guest@elsewhere.test');
      const guest = await signIn('guest@elsewhere.test');
      expect(guest.workspaces).toContain(ws!.id);
      expect((await fresh(guest)).billingAccountId).toBeUndefined();
      expect(await hub.llm.payerOf(guest)).toBe(guest.id);
      // An unbought pool has the Free allowance.
      expect((await hub.llm.limits(ws!.id)).plan).toBe('free');

      await hub.registry.leaveWorkspace(await fresh(dev), ws!.id);
      expect((await fresh(dev)).billingAccountId).toBeUndefined();
      expect(await hub.llm.payerOf(bot)).toBe(dev.id);

      const ops = await signIn('ops@pool-co.test');
      expect((await fresh(ops)).billingAccountId).toBe(ws!.id);
      await hub.registry.removeFromWorkspace(boss, ws!.id, ops.id);
      expect((await fresh(ops)).billingAccountId).toBeUndefined();

      const qa = await signIn('qa@pool-co.test');
      expect((await fresh(qa)).billingAccountId).toBe(ws!.id);
      await hub.registry.setWorkspaceDomains(boss, ws!.id, []);
      expect((await fresh(qa)).billingAccountId).toBeUndefined();
      expect((await fresh(qa)).workspaces).toContain(ws!.id);
    });

    it('auto-joins a domain only while a verified owner holds an email on it', async () => {
      const founder = await signIn('founder@owned-domain.test');
      const [ws] = await hub.registry.workspacesOf(founder);
      await expect(hub.registry.setWorkspaceDomains(founder, ws!.id, ['someone-else.test'])).rejects.toMatchObject({ code: 'invalid' });
      // A domain stored without proof (older data) doesn't let anyone in either.
      await hub.registry.workspaceCol.doc(ws!.id).update({ domains: ['someone-else.test'] });
      expect((await signIn('ceo@someone-else.test')).workspaces).not.toContain(ws!.id);
      // Nor does an archived workspace.
      expect((await hub.registry.setWorkspaceDomains(founder, ws!.id, ['owned-domain.test'])).domains).toEqual(['owned-domain.test']);
      await hub.registry.workspaceCol.doc(ws!.id).update({ archived: true });
      expect((await signIn('late@owned-domain.test')).workspaces).not.toContain(ws!.id);
    });
  });

  describe('owned bots that follow their owner', () => {
    const fresh = async (a: AgentRecord) => (await hub.registry.get(a.id))!;
    /** A Google-signed-in person ("<email>|<sub>" stands in for the credential, see beforeAll). */
    const person = async (email: string) => (await hub.registry.signInWithGoogle(`${email}|g-${email}`)).agent;

    it('is a private mailbox in no workspace, not dragged into the owner\'s, and always visible to the owner', async () => {
      const michal = await person('michal@example.com');
      const first = await hub.registry.createWorkspace(michal, 'first');
      const { agent: code, token } = await hub.registry.createBot(michal, { name: "Michal's Claude Code", follow: true, public: true });
      expect(code).toMatchObject({ kind: 'mailbox', public: false, ownerId: michal.id, ownerName: michal.name, followsOwner: true, workspaces: [], channels: [] });
      expect(code.description).toMatch(/Coding agent owned by/);
      expect((await hub.registry.authenticate(token))?.id).toBe(code.id);
      const { agent: plain } = await hub.registry.createBot(michal, { name: 'plain bot' });
      expect(plain).toMatchObject({ ownerId: michal.id, workspaces: [] });
      // An A2A agent with its own server: an endpoint the hub pushes to.
      const { agent: remote } = await hub.registry.createBot(michal, { name: "Michal's A2A agent", follow: true, url: 'http://remote.test' });
      expect(remote).toMatchObject({ kind: 'endpoint', url: 'http://remote.test', public: false, followsOwner: true, workspaces: [] });

      // Visible to each other with no workspace in common, and to nobody else.
      const outsider = (await newAgent(hub.registry, { name: 'outsider' })).agent;
      expect((await hub.registry.search(michal)).map((a) => a.id)).toEqual(expect.arrayContaining([code.id, plain.id]));
      expect((await hub.registry.search(code)).map((a) => a.id)).toContain(michal.id);
      expect((await hub.registry.search(outsider)).map((a) => a.id)).not.toContain(code.id);
      const dm = await hub.send(michal, { to: code.id }, [{ text: 'hi, me' }]);
      expect(dm.recipients.map((r) => r.name)).toEqual(["Michal's Claude Code"]);

      // The owner's workspace changes stay the owner's: create, get invited, invite.
      const other = await person('other@example.com');
      const joined = await hub.registry.createWorkspace(other, 'joined');
      await hub.registry.inviteToWorkspace(other, joined.id, 'michal@example.com');
      await hub.registry.createWorkspace(await fresh(michal), 'created');
      expect((await fresh(code)).workspaces).toEqual([]);
      const dana = await person('dana@example.com');
      const { agent: danaCodex } = await hub.registry.createBot(dana, { name: "Dana's Codex", follow: true });
      await hub.registry.inviteToWorkspace(await fresh(other), joined.id, 'dana@example.com');
      expect((await fresh(danaCodex)).workspaces).toEqual([]);

      // Any member adds a bot they can see, by id: Michal adds her own; a stranger's private bot is unknown.
      const { agent: added } = await hub.registry.addToWorkspace(await fresh(michal), first.id, code.id);
      expect(added.id).toBe(code.id);
      expect((await fresh(code)).workspaces).toEqual([first.id]);
      await expect(hub.registry.addToWorkspace(await fresh(michal), first.id, danaCodex.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.registry.addToWorkspace(outsider, first.id, code.id)).rejects.toMatchObject({ code: 'not_found' });
      // Leaving a workspace doesn't take the owner's bots with it.
      await hub.registry.addToWorkspace(await fresh(michal), joined.id, code.id);
      await hub.registry.leaveWorkspace(await fresh(michal), joined.id);
      expect((await fresh(code)).workspaces.sort()).toEqual([first.id, joined.id].sort());

      // The owner deletes it (DELETE /agents/:id) and its token dies; strangers can't reach it.
      await expect(hub.registry.requireSelfOrOwned(outsider, code.id)).rejects.toMatchObject({ code: 'not_found' });
      await hub.registry.unregister(await hub.registry.requireSelfOrOwned(await fresh(michal), code.id));
      expect(await hub.registry.authenticate(token)).toBeUndefined();
      expect((await hub.registry.botsOf(michal)).map((b) => b.id)).toEqual([plain.id, remote.id]);

      // Unregistering the owner takes its bots with it (they never expire on their own).
      await hub.registry.unregister(await fresh(dana));
      expect(await hub.registry.get(danaCodex.id)).toBeUndefined();
    });

    it('needs a Google sign-in', async () => {
      const bot = (await newAgent(hub.registry, { name: 'not a person' })).agent;
      await expect(hub.registry.createBot(bot, { name: 'x', follow: true })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(hub.registry.createWorkspace(bot, 'bots cannot')).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('presence', () => {
    it('warns about recipients with no wait open, and stops once they listen', async () => {
      const kim = (await newAgent(hub.registry, { name: 'kim', public: true })).agent;
      const sent = await hub.send(alice, { to: kim.id }, [{ text: 'hi' }]);
      expect(hub.listeningWarnings(sent.recipients, sent.message)).toMatchObject([{ code: 'not_listening', agentId: kim.id }]);

      await hub.eventsView(kim, undefined, 1);
      const listening = (await hub.registry.get(kim.id))!;
      expect(listening.listeningUntil! > new Date().toISOString()).toBe(true);
      expect(hub.listeningWarnings([listening], sent.message)).toEqual([]);
    });

    it('never moves listeningUntil backwards', async () => {
      const lee = (await newAgent(hub.registry, { name: 'lee', public: true })).agent;
      const later = new Date(Date.now() + 10 * 60_000).toISOString();
      await db.collection('agents').doc(lee.id).update({ listeningUntil: later });
      await hub.registry.markListening(lee); // a stale in-memory record: no listeningUntil
      expect((await hub.registry.get(lee.id))!.listeningUntil).toBe(later);
    });
  });

  describe('access control', () => {
    it('hides messages from agents that are not party to them', async () => {
      const sent = (await hub.send(alice, { to: bob.id }, [{ text: 'private' }])).message;
      await expect(hub.chat.readable(carol, sent.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.send(carol, { replyTo: sent.id }, [{ text: 'x' }])).rejects.toMatchObject({ code: 'not_found' });
      expect((await hub.chat.newFor(carol)).map((i) => i.message.id)).not.toContain(sent.id);
      expect((await hub.chat.newFor(bob)).map((i) => i.message.id)).toContain(sent.id);
    });

    it('routes by skill', async () => {
      const sent = await hub.send(alice, { skill: 'shout' }, [{ text: 'hey' }]);
      expect(sent.recipients.map((r) => r.id)).toEqual([bob.id]);
    });

    it('rejects unknown targets and empty messages', async () => {
      await expect(hub.send(alice, { to: 'ghost' }, [{ text: 'x' }])).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.send(alice, {}, [{ text: 'x' }])).rejects.toMatchObject({ code: 'invalid' });
      await expect(hub.send(alice, { to: bob.id }, [])).rejects.toMatchObject({ code: 'invalid' });
    });
  });
});
