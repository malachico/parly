import { describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import type { AgentRecord, ChannelRecord } from '../src/registry/types.js';
import { crew, testConfig, testDb, testPerson } from './helpers.js';

let n = 0;
const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

describe('The canvas (PLAN-CANVAS.md)', () => {
  it("writes an agent's messages into its day by itself, shown only to those who can read them", async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, channel, members } = await crew(hub.registry, `log-${uid()}`, ['Scribe']);
    const scribe = members[0]!;
    await hub.send(scribe, { channel: channel.id }, [{ text: 'Shipped the **pricing** page' }]);
    await hub.send(scribe, { to: owner.id }, [{ text: 'Done, take a look' }]);
    await new Promise((r) => setTimeout(r, 300)); // the log is written after the post, not awaited by it
    const day = await hub.canvasService.agentDay(owner, scribe.id);
    expect(day.updates.map((u) => u.text)).toEqual([`Wrote to ${owner.name}: Done, take a look`, `Posted in #${channel.name}: Shipped the pricing page`]);
    // Someone outside the channel and the DM sees neither.
    const stranger = await testPerson(hub.registry, 'Stranger');
    await hub.registry.addToWorkspace(owner, (await hub.registry.workspacesOf(owner))[0]!.id, stranger.id).catch(() => {});
    const theirs = await hub.canvasService.agentDay((await hub.registry.get(stranger.id))!, scribe.id).catch(() => ({ updates: [] }));
    expect(theirs.updates).toEqual([]);
  });

  it("offers the viewer's own agents that aren't in this workspace, until they're added", async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, workspace } = await crew(hub.registry, `cv-${uid()}`, []);
    const { agent: loose } = await hub.registry.createBot(owner, { name: 'Loose', follow: true });
    expect((await hub.canvasService.canvas(owner, workspace.id)).elsewhere?.map((a) => a.name)).toEqual(['Loose']);
    await hub.registry.addToWorkspace(owner, workspace.id, loose.id);
    expect((await hub.canvasService.canvas((await hub.registry.get(owner.id))!, workspace.id)).elsewhere).toBeUndefined();
  });

  it('draws the viewer\'s teams with their members once each, and a status that lasts until the agent changes it', async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, workspace, channel, members } = await crew(hub.registry, `cv-${uid()}`);
    const [x, y] = members as [any, any];

    await hub.setStatus(x, `channel:${channel.id}`, 'Running the tests');
    let view = await hub.canvasService.canvas(owner, workspace.id);
    const team = view.teams.find((t) => t.channelId === channel.id)!;
    expect(team.members).toEqual(expect.arrayContaining([owner.id, x.id, y.id]));
    expect(team.canvas).toEqual({ x: 40, y: 40, w: 580, h: 420 }); // never placed: the grid
    const ax = view.agents.find((a) => a.id === x.id)!;
    expect(ax.status).toMatchObject({ text: 'Running the tests', conversationId: `channel:${channel.id}` });
    expect(ax.teams).toEqual([channel.id]);
    expect(ax.presence.state).toBe('quiet'); // nothing open, no Routine: no invented "listening"
    expect(view.agents.filter((a) => a.id === x.id)).toHaveLength(1);

    // It stays (activity fades, the status doesn't), and is replaced or cleared only by the agent.
    await hub.setStatus((await hub.registry.get(x.id))!, `channel:${channel.id}`, 'Done: PR #12');
    view = await hub.canvasService.canvas(owner, workspace.id);
    expect(view.agents.find((a) => a.id === x.id)!.status!.text).toBe('Done: PR #12');
    const day = await hub.canvasService.agentDay(owner, x.id);
    expect(day.updates.map((u) => u.text)).toEqual(['Done: PR #12', 'Running the tests']);
    // `done` with the same caller object the status was set with (an MCP session keeps one, never reloaded).
    await hub.setStatus(x, `channel:${channel.id}`, undefined, true);
    view = await hub.canvasService.canvas(owner, workspace.id);
    expect(view.agents.find((a) => a.id === x.id)!.status).toBeUndefined();
  });

  it("pages an agent's log: the newest 20, then older ones from `next`", async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, channel, members } = await crew(hub.registry, `cvl-${uid()}`);
    const [x] = members as [any];
    const t0 = Date.now() - 60 * 60_000;
    for (let i = 0; i < 25; i++) {
      await hub.registry.setStatus(x.id, { text: `step ${i}`, at: new Date(t0 + i * 1000).toISOString(), conversationId: `channel:${channel.id}` });
    }
    const first = await hub.canvasService.agentDay(owner, x.id);
    expect(first.updates).toHaveLength(20);
    expect(first.updates[0]!.text).toBe('step 24');
    expect(first.next).toBe(first.updates[19]!.at);
    const second = await hub.canvasService.agentDay(owner, x.id, { before: first.next });
    expect(second.updates.map((u) => u.text)).toEqual(['step 4', 'step 3', 'step 2', 'step 1', 'step 0']);
    expect(second.next).toBeUndefined();
  });

  it('never shows a private channel, or what an agent said about it, to someone outside it', async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, workspace, channel, members } = await crew(hub.registry, `cvp-${uid()}`);
    const [x] = members as [any];
    const secret = await hub.registry.createChannel(owner, workspace.id, `secret-${uid()}`);
    await hub.registry.updateChannel(owner, secret.id, { open: false });
    await hub.registry.addToChannel((await hub.registry.get(owner.id))!, secret.id, x.id);
    await hub.setStatus((await hub.registry.get(x.id))!, `channel:${secret.id}`, 'Drafting the acquisition memo');

    const mate = await testPerson(hub.registry, 'Mate');
    await hub.registry.inviteToWorkspace((await hub.registry.get(owner.id))!, workspace.id, mate.email!);
    await hub.registry.addToChannel((await hub.registry.get(owner.id))!, channel.id, mate.id);
    const view = await hub.canvasService.canvas((await hub.registry.get(mate.id))!, workspace.id);
    expect(view.teams.map((t) => t.channelId)).toEqual([channel.id]);
    expect(view.agents.find((a) => a.id === x.id)!.status).toBeUndefined();
    expect((await hub.canvasService.agentDay((await hub.registry.get(mate.id))!, x.id)).updates).toEqual([]);
    // The owner, who is in it, sees both.
    const mine = await hub.canvasService.canvas((await hub.registry.get(owner.id))!, workspace.id);
    expect(mine.agents.find((a) => a.id === x.id)!.status!.text).toBe('Drafting the acquisition memo');

    const outsider = await testPerson(hub.registry, 'Out');
    await expect(hub.canvasService.canvas(outsider, workspace.id)).rejects.toThrow();
  });

  it("keeps a team's frame where its members put it, within sane bounds", async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, workspace, channel } = await crew(hub.registry, `cvl-${uid()}`, []);
    await hub.canvasService.setChannelCanvas(owner, channel.id, { x: 900.4, y: -20, w: 640, h: 480 });
    expect((await hub.canvasService.canvas(owner, workspace.id)).teams[0]!.canvas).toEqual({ x: 900, y: -20, w: 640, h: 480 });
    await expect(hub.canvasService.setChannelCanvas(owner, channel.id, { x: 0, y: 0, w: 5, h: 480 })).rejects.toThrow(/w and h/);
    const outsider = await testPerson(hub.registry, 'Out2');
    await expect(hub.canvasService.setChannelCanvas(outsider, channel.id, { x: 0, y: 0, w: 600, h: 400 })).rejects.toThrow();
  });

  it('a done for one conversation never erases a newer status about another, however they interleave', async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const { owner, workspace, channel, members } = await crew(hub.registry, `cvr-${uid()}`, [`rr${uid()}`]);
    const [x] = members as [any];
    const other = await hub.registry.createChannel(owner, workspace.id, `other-${uid()}`);
    await hub.registry.addToChannel((await hub.registry.get(owner.id))!, other.id, x.id);
    const me = (await hub.registry.get(x.id))!;
    // The clear is a compare-and-clear in one transaction: about another conversation, it leaves the status alone.
    await hub.setStatus(me, `channel:${other.id}`, 'newer');
    await hub.registry.clearStatusIf(x.id, `channel:${channel.id}`);
    expect((await hub.registry.get(x.id))!.status).toMatchObject({ text: 'newer' });
    // And raced against a newer status, however they land, the newer one stays.
    for (let i = 0; i < 5; i++) {
      await hub.setStatus(me, `channel:${channel.id}`, `first ${i}`);
      await Promise.all([hub.setStatus(me, `channel:${other.id}`, `second ${i}`), hub.setStatus(me, `channel:${channel.id}`, undefined, true)]);
      expect((await hub.registry.get(x.id))!.status).toMatchObject({ text: `second ${i}`, conversationId: `channel:${other.id}` });
    }
  });

  it('channelMembers returns exactly what search({ channel }) does, channel by channel', async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const r = hub.registry;
    const owner = await testPerson(r, 'Host');
    const ws = await r.createWorkspace(owner, `cm-${uid()}`);
    const chans: ChannelRecord[] = [];
    for (let i = 0; i < 32; i++) chans.push(await r.createChannel(owner, ws.id, `t${i}`)); // more than one 30-id query
    const bots: AgentRecord[] = [];
    for (const name of ['Zed', 'Twin', 'Twin', 'Amy', 'Gone']) bots.push((await r.createBot(owner, { name })).agent);
    for (const [i, b] of bots.entries()) {
      await r.addToWorkspace(owner, ws.id, b.id);
      for (const c of [chans[i]!, chans[31 - i]!, chans[29]!, chans[30]!]) await r.addToChannel(owner, c.id, b.id).catch(() => {});
    }
    await r.setArchived(owner, bots[4]!.id, true);
    // A public showcase: a guest sees only the tables they joined; to them every private channel is empty.
    const guest = await testPerson(r, 'Guest');
    const ws2 = await r.createWorkspace(owner, `cm2-${uid()}`);
    const pub = [await r.createChannel(owner, ws2.id, 'open'), await r.createChannel(owner, ws2.id, 'shut')];
    for (const b of bots.slice(0, 2)) await r.addToWorkspace(owner, ws2.id, b.id).then(() => r.addToChannel(owner, pub[0]!.id, b.id));
    await r.addToWorkspace(owner, ws2.id, bots[2]!.id).then(() => r.addToChannel(owner, pub[1]!.id, bots[2]!.id));
    await r.setWorkspacePublicShowcase(owner, ws2.id, true, { publicChannels: [pub[0]!.id] });
    await r.joinPublicWorkspace(guest, ws2.id);
    const all = [...(await r.channelsOf((await r.get(owner.id))!)), ...pub];
    for (const id of [owner.id, guest.id, bots[0]!.id, bots[1]!.id]) {
      const viewer = (await r.get(id))!;
      const one = await Promise.all(all.map((c) => r.search(viewer, { channel: c.id })));
      expect(await r.channelMembers(viewer, all)).toEqual(one);
    }
    expect(await r.channelMembers(owner, [])).toEqual([]);
  });

  it('a showcase guest sees public tables opened after they joined', async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const owner = await testPerson(hub.registry, 'Host');
    const ws = await hub.registry.createWorkspace(owner, 'Party');
    const first = await hub.registry.createChannel(owner, ws.id, 'first-table');
    await hub.registry.setWorkspacePublicShowcase(owner, ws.id, true, { publicChannels: [first.id] });
    const guest = await testPerson(hub.registry, 'Guest');
    await hub.registry.joinPublicWorkspace(guest, ws.id);
    const later = await hub.registry.createChannel(owner, ws.id, 'later-table');
    await hub.registry.setWorkspacePublicShowcase(owner, ws.id, true, { publicChannels: [first.id, later.id] });
    const view = await hub.canvasService.canvas((await hub.registry.get(guest.id))!, ws.id);
    expect(view.teams.map((t) => t.name).sort()).toEqual(['first-table', 'later-table']);
  });

  it('channel members do not trigger outbound endpoint checks for other owners\' agents (review #19)', async () => {
    let probes = 0;
    const hub = createHub({
      db: testDb(),
      config: testConfig(),
      fetchCard: async () => ({ name: 'remote-ep', description: '', skills: [] }),
      forwarder: {
        send: async () => { throw new Error('unused'); },
        getTask: async () => { throw new Error('unused'); },
        cancel: async () => {},
        check: async () => { probes += 1; return { ok: true }; },
      },
    });
    const { owner, workspace, channel } = await crew(hub.registry, `cv-ep-${uid()}`, []);
    const { agent: endpoint } = await hub.registry.createBot(owner, { name: `ep-${uid()}`, url: 'http://remote-ep.test', follow: true });
    await hub.registry.addToWorkspace(owner, workspace.id, endpoint.id);
    await hub.registry.addToChannel(owner, channel.id, endpoint.id);

    const mate = await testPerson(hub.registry, 'MateEp');
    await hub.registry.inviteToWorkspace(owner, workspace.id, mate.email!);
    await hub.registry.addToChannel((await hub.registry.get(owner.id))!, channel.id, mate.id);

    probes = 0;
    await hub.canvasService.canvas((await hub.registry.get(mate.id))!, workspace.id);
    expect(probes).toBe(0);

    probes = 0;
    await hub.canvasService.canvas((await hub.registry.get(owner.id))!, workspace.id);
    expect(probes).toBe(1);
  });
});
