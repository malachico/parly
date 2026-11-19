import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createApp, createHub } from '../src/app.js';
import { channelKey, threadKey, type SkillLoad } from '../src/chat/chat.js';
import type { Target } from '../src/chat/chatService.js';
import { inboxItemView, messageView } from '../src/lib/present.js';
import { callMcpTool } from '../src/mcp/inProcess.js';
import type { AgentRecord } from '../src/registry/types.js';
import { DEFAULT_WORKSPACE_SKILL_IDS } from '../src/registry/defaultSkills.js';
import { crew, newAgentOverHttp, testConfig, testDb } from './helpers.js';

const BUILTIN = DEFAULT_WORKSPACE_SKILL_IDS[0]!;
const OTHER_BUILTIN = DEFAULT_WORKSPACE_SKILL_IDS[1]!;

async function team() {
  const db = testDb();
  const hub = createHub({ db, config: testConfig() });
  const { owner, workspace, channel, members } = await crew(hub.registry, 'loads', ['Bot']);
  const bot = members[0]!;
  const load = async (id: string, turn?: { conversationId?: string; messageId?: string }, agent: AgentRecord = bot) => {
    const result = await callMcpTool(hub, agent, 'get_skill', { id }, turn);
    expect(result).toMatchObject({ ok: true });
  };
  const say = async (target: Target, id?: string, agent: AgentRecord = bot) =>
    (await hub.chat.post(agent, target, { parts: [{ text: 'hello' }], ...(id ? { id } : {}) })).message;
  const pending = async (agent: AgentRecord = bot) => ((await db.collection('skill_loads').doc(agent.id).get()).data()?.loads ?? []) as SkillLoad[];
  const skill = (name: string, by: AgentRecord = owner) => hub.registry.createSkill(by, { name, description: 'd', instructions: 'SECRET STEPS' });
  return { db, hub, owner, workspace, channel, bot, load, say, pending, skill, here: { channelId: channel.id } as Target };
}

describe('skill loads', () => {
  it('a load shows on the next message in scope, once, with no instructions anywhere', async () => {
    const { hub, channel, load, say, pending, skill, owner, here } = await team();
    const custom = await skill('Attached');
    await hub.registry.attachSkill(owner, 'channel', channel.id, custom.id);
    await load(custom.id);
    await load(BUILTIN);
    expect((await pending())[0]).toMatchObject({ id: custom.id, name: 'Attached', type: 'skill' });
    expect(JSON.stringify(await pending())).not.toContain('SECRET');
    const first = await say(here);
    expect(first.meta?.skills?.map((s) => s.id).sort()).toEqual([custom.id, BUILTIN].sort());
    expect(Object.keys(first.meta!.skills![0]!).sort()).toEqual(['id', 'name', 'type']);
    expect(messageView(first).skills).toEqual(first.meta!.skills);
    // It reaches readers, stored, and stays out of inbox items: `skills` there is the [Skills] list.
    const read = await hub.chat.page(owner, channelKey(channel.id), 10);
    expect(read.messages.at(-1)!.meta?.skills).toHaveLength(2);
    expect(inboxItemView({ message: first, earlier: [] } as never)).not.toHaveProperty('skills');
    expect(await pending()).toEqual([]);
    expect((await say(here)).meta).toBeUndefined();
  });

  it("a skill attached to the agent itself shows, in a channel and in a DM", async () => {
    const { hub, owner, bot, load, say, pending, skill, here } = await team();
    const onAgent = await skill('On agent');
    await hub.registry.attachSkill(owner, 'agent', bot.id, onAgent.id);
    await load(onAgent.id);
    expect((await say(here)).meta?.skills?.map((s) => s.id)).toEqual([onAgent.id]);
    await load(onAgent.id);
    expect((await say({ dm: owner.id })).meta?.skills?.map((s) => s.id)).toEqual([onAgent.id]);
    expect(await pending()).toEqual([]);
  });

  it('private and other-workspace skills never show and stay pending, even in a DM', async () => {
    const { hub, owner, bot, load, say, pending, skill, here } = await team();
    const mine = await skill('Private', bot);
    const elsewhere = await skill('Elsewhere');
    const other = await hub.registry.createWorkspace(owner, 'Other');
    await hub.registry.addToWorkspace(owner, other.id, bot.id);
    await hub.registry.attachSkill((await hub.registry.get(owner.id))!, 'workspace', other.id, elsewhere.id);
    for (const s of [mine, elsewhere]) await load(s.id);

    expect((await say(here)).meta?.skills).toBeUndefined();
    expect((await say({ dm: owner.id })).meta?.skills).toBeUndefined();
    expect((await pending()).map((l) => l.id).sort()).toEqual([mine.id, elsewhere.id].sort());
  });

  it('a message with nothing to take has no skills field at all', async () => {
    const { say, here } = await team();
    const m = await say(here);
    expect(m.meta).toBeUndefined();
    expect(messageView(m)).not.toHaveProperty('skills');
  });

  it("a person's message takes nothing", async () => {
    const { owner, load, say, pending, here } = await team();
    await load(BUILTIN);
    expect((await say(here, undefined, owner)).meta).toBeUndefined();
    expect(await pending()).toHaveLength(1);
  });

  it('shows one entry per id, and clears every load of that id', async () => {
    const { load, say, pending, channel, here } = await team();
    await load(BUILTIN);
    await load(BUILTIN);
    await load(BUILTIN, { conversationId: channelKey(channel.id), messageId: 'm1' });
    expect((await say(here)).meta?.skills).toHaveLength(1);
    expect(await pending()).toEqual([]);
  });

  it('expires after 30 minutes', async () => {
    const { db, bot, say, pending, here } = await team();
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    await db.collection('skill_loads').doc(bot.id).set({
      loads: [
        { id: BUILTIN, name: 'old', type: 'skill', at: at(31) },
        { id: OTHER_BUILTIN, name: 'recent', type: 'skill', at: at(29) },
      ],
    });
    expect((await say(here)).meta?.skills?.map((s) => s.id)).toEqual([OTHER_BUILTIN]);
    expect(await pending()).toEqual([]);
  });

  it('a load from a channel wake shows on that post\'s thread only, and waits there', async () => {
    const { channel, owner, load, say, pending, here } = await team();
    const asked = await say(here, undefined, owner);
    const another = await say(here, undefined, owner);
    await load(BUILTIN, { conversationId: channelKey(channel.id), messageId: asked.id });

    expect((await say({ channelId: channel.id, thread: another.id })).meta?.skills).toBeUndefined();
    expect(await pending()).toHaveLength(1);
    const answer = await say({ channelId: channel.id, thread: asked.id });
    expect(answer.conversationId).toBe(threadKey(channel.id, asked.id));
    expect(answer.meta?.skills?.map((s) => s.id)).toEqual([BUILTIN]);
    expect(await pending()).toEqual([]);
  });

  it('the same load also shows on the channel itself', async () => {
    const { channel, load, say, here } = await team();
    await load(BUILTIN, { conversationId: channelKey(channel.id), messageId: 'm1' });
    expect((await say(here)).meta?.skills).toHaveLength(1);
  });

  it('a load tagged with a thread matches that thread exactly', async () => {
    const { channel, owner, load, say, pending, here } = await team();
    const post = await say(here, undefined, owner);
    const key = threadKey(channel.id, post.id);
    await load(BUILTIN, { conversationId: key, messageId: 'm1' });
    expect((await say(here)).meta?.skills).toBeUndefined();
    expect(await pending()).toHaveLength(1);
    expect((await say({ channelId: channel.id, thread: post.id })).meta?.skills).toHaveLength(1);
  });

  it('a load with no conversation matches any conversation in scope', async () => {
    const { channel, owner, load, say, pending, here } = await team();
    const post = await say(here, undefined, owner);
    await load(BUILTIN);
    expect((await pending())[0]).not.toHaveProperty('conversation');
    expect((await say({ channelId: channel.id, thread: post.id })).meta?.skills).toHaveLength(1);
  });

  it('a retried answer neither loses nor repeats a load', async () => {
    const { load, say, pending, hub, here } = await team();
    await load(BUILTIN);
    const first = await say(here, 'a2a_fixed');
    await load(OTHER_BUILTIN);
    const again = await say(here, 'a2a_fixed');
    expect(again.id).toBe(first.id);
    expect(again.meta?.skills?.map((s) => s.id)).toEqual([BUILTIN]);
    // Past post's own check: two racing the same id, the loser's transaction finds the message.
    expect((await hub.chat.store.message('a2a_fixed'))!.meta?.skills).toHaveLength(1);
    expect((await pending()).map((l) => l.id)).toEqual([OTHER_BUILTIN]);
  });

  it('two messages at once: one takes the load', async () => {
    const { load, say, pending, here } = await team();
    await load(BUILTIN);
    const posted = await Promise.all([say(here, 'race_a'), say(here, 'race_b')]);
    expect(posted.filter((m) => m.meta?.skills).length).toBe(1);
    expect(await pending()).toEqual([]);
  });

  it('a failure recording never fails get_skill, and one taking never fails the post', async () => {
    const { db, hub, bot, load, say, here } = await team();
    const spy = vi.spyOn(hub.chat.store, 'addSkillLoad').mockRejectedValueOnce(new Error('down'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await load(BUILTIN);
    expect(spy).toHaveBeenCalledOnce();
    await db.collection('skill_loads').doc(bot.id).set({ loads: 1 }); // can't be read as a list: the take throws
    const m = await say(here);
    expect(m.meta?.skills).toBeUndefined();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("a cloud turn's load goes through the real tool once and shows on its answer", async () => {
    let round = 0;
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const system = JSON.parse(String(init.body)).systemInstruction.parts[0].text as string;
      if (!system.startsWith('You are Reader')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'PASS' }] } }] }));
      const parts = round++ === 0 ? [{ functionCall: { name: 'get_skill', args: { id: BUILTIN } } }] : [{ text: 'Done.' }];
      return new Response(JSON.stringify({ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } }));
    }) as typeof fetch;
    const config = testConfig({ cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } } });
    const hub = createHub({ db: testDb(), config, cloudFetch, cloudToken: async () => 'ya29.test' });
    const { owner, workspace, channel } = await crew(hub.registry, 'cloudloads', []);
    await hub.createCloudAgent(owner, { name: 'Reader', workspaceId: workspace.id, channelId: channel.id });
    const record = vi.spyOn(hub.chat.store, 'addSkillLoad');

    await hub.send(owner, { channel: channel.id }, [{ text: '@Reader read the guide' }]);
    await hub.wakeService.idle();

    const post = (await hub.chat.page(owner, channelKey(channel.id), 10)).messages.at(-1)!;
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![1]).toMatchObject({ id: BUILTIN, conversation: channelKey(channel.id), messageId: post.id });
    const thread = await hub.chat.page(owner, threadKey(channel.id, post.id), 10);
    const answer = thread.messages.find((m) => m.parts[0]!.text === 'Done.')!;
    expect(answer.meta?.skills?.map((s) => s.id)).toEqual([BUILTIN]);
  });

  it("REST: an agent's read of a skill is a load, a person's is not", async () => {
    const port = 18000 + Math.floor(Math.random() * 10000);
    const hubUrl = `http://127.0.0.1:${port}`;
    const db = testDb();
    const { app } = createApp({ db, config: testConfig({ port, publicUrl: hubUrl }) });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    try {
      const made = await newAgentOverHttp(hubUrl, { name: 'rest-loads' });
      const read = (token: string) => fetch(`${hubUrl}/me/skills/${encodeURIComponent(BUILTIN)}`, { headers: { authorization: `Bearer ${token}` } });
      expect((await read(made.owner.token)).status).toBe(200);
      expect((await db.collection('skill_loads').doc(made.owner.id).get()).exists).toBe(false);
      expect((await read(made.token)).status).toBe(200);
      expect((await db.collection('skill_loads').doc(made.agent.id).get()).data()!.loads).toHaveLength(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
