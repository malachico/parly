import { describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/app.js';
import { CloudAgents, compact, MAX_CALLS_PER_STEP, MAX_ROUNDS, pick, readFiles, TASK_BUDGET_MICROS, TASK_MAX_ROUNDS, TURN_BUDGET_MICROS, useAppTool } from '../src/hub/cloudAgent.js';
import { vertexRouter } from '../src/chat/router.js';
import { threadKey } from '../src/chat/chat.js';
import type { LlmMeter } from '../src/llm/llm.js';
import type { WireMessage } from '../src/lib/wire.js';
import type { AgentRecord } from '../src/registry/types.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const CLOUD = { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } };

/** A hub whose cloud agents ask a fake Gemini: Planner answers, everyone else passes. */
function cloudHub(cloud: Record<string, unknown> = {}) {
  const calls: { url: string; system: string; text: string; turns: number; generationConfig?: Record<string, unknown> }[] = [];
  const cloudFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const system = body.systemInstruction.parts[0].text as string;
    calls.push({ url, system, text: body.contents[0].parts.map((p: { text?: string }) => p.text ?? '').join('\n'), turns: body.contents.length, generationConfig: body.generationConfig });
    const text = system.startsWith('You are Planner') ? 'Happy to plan with you.' : 'PASS';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } }));
  }) as typeof fetch;
  const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: { ...CLOUD, ...cloud } }), cloudFetch, cloudToken: async () => 'ya29.test' });
  return { hub, calls };
}

describe('cloud agents', () => {
  it("a new person's Guide and Planner talk in #general, on the owner's allowance", async () => {
    const { hub, calls } = cloudHub();
    const person = await testPerson(hub.registry, 'Dana');
    await hub.registry.createWorkspace(person, 'Dana');
    await hub.starterAgents(person);
    await hub.wakeService.idle();

    const channel = (await hub.registry.channelsOf((await hub.registry.get(person.id))!)).find((c) => c.name === 'general')!;
    const posts = await hub.chat.page(person, `channel:${channel.id}`, 10);
    const intro = posts.messages[0]!;
    expect(intro.parts[0]!.text).toMatch(/^Hi Dana, welcome to Parly! I'm Guide, and this is @Planner/);
    const thread = await hub.chat.page(person, threadKey(channel.id, intro.id), 10);
    expect(thread.messages.map((m) => m.parts[0]!.text)).toContain('Happy to plan with you.');
    expect(calls[0]!.url).toBe('https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google/models/gemini-4-argon:generateContent');
    expect(await hub.llm.used(person.id)).toBeGreaterThan(0);
    // Each agent's tokens are counted too: Planner answered once (1000 in, 100 out), Guide passed once.
    const planner = (await hub.registry.botsOf(person)).find((a) => a.name === 'Planner')!;
    expect(await hub.llm.agentUsage(planner.id)).toMatchObject({ calls: 1, input: 1000, output: 100 });
    expect((await hub.llm.topAgents()).filter((r) => r.ownerId === person.id).map((r) => r.agentId)).toContain(planner.id);
    expect((await hub.registry.botsOf(person)).map((a) => [a.name, a.kind, a.cloud])).toEqual(expect.arrayContaining([['Guide', 'endpoint', true], ['Planner', 'endpoint', true]]));
    // Both start with the Parly docs skill.
    for (const bot of await hub.registry.botsOf(person)) expect(bot.attachedSkills).toContain('builtin:parly-docs');
  });

  it("gives no starters in someone else's workspace", async () => {
    const { hub } = cloudHub();
    const host = await testPerson(hub.registry, 'Host');
    const workspace = await hub.registry.createWorkspace(host, 'Theirs');
    const person = await testPerson(hub.registry, 'Invited');
    await hub.registry.inviteToWorkspace(host, workspace.id, person.email!);
    await hub.starterAgents((await hub.registry.get(person.id))!);
    expect(await hub.registry.botsOf(person)).toEqual([]);
  });

  it('is made with its job, straight into the team it was made for', async () => {
    const { hub } = cloudHub();
    let person = await testPerson(hub.registry, 'Gil');
    const workspace = await hub.registry.createWorkspace(person, 'crew');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, workspace.id, 'dev');
    person = (await hub.registry.get(person.id))!;
    const agent = await hub.createCloudAgent(person, { name: 'Scout', description: 'Finds leads', workspaceId: workspace.id, channelId: team.id });
    expect(agent.description).toBe('Finds leads');
    expect((await hub.registry.get(agent.id))!.channels).toContain(team.id);
    // A team that isn't yours: refused before any agent is made.
    const before = (await hub.registry.botsOf(person)).length;
    await expect(hub.createCloudAgent(person, { name: 'Stray', workspaceId: workspace.id, channelId: 'not-mine' })).rejects.toThrow(/No team/);
    expect((await hub.registry.botsOf(person)).length).toBe(before);
  });

  it('reads less of the conversation when woken by an event (a trigger, a webhook) than by a person', async () => {
    const { hub, calls } = cloudHub();
    const person = await testPerson(hub.registry, 'Hal');
    const agent = await hub.createCloudAgent(person, { name: 'Planner' });
    for (let i = 0; i < 8; i++) {
      await hub.send(person, { to: agent.id }, [{ text: `note ${i}` }]);
      await hub.wakeService.idle();
    }
    const byPerson = calls.at(-1)!.turns;
    await hub.chat.post(person, { dm: agent.id }, { parts: [{ text: '📧 New email from a@b.c' }], meta: { webhook: { id: 'l1', name: 'Gmail' } } });
    await hub.wakeService.idle();
    expect(calls.at(-1)!.turns).toBeLessThan(byPerson);
    expect(calls.at(-1)!.turns).toBeLessThanOrEqual(5);
  });

  it('still remembers what came before when many messages wait for it', async () => {
    const { hub, calls } = cloudHub();
    const person = await testPerson(hub.registry, 'Noa');
    const agent = await hub.createCloudAgent(person, { name: 'Backlog' });
    const sent = await hub.send(person, { to: agent.id }, [{ text: 'remember the password is swordfish' }]);
    await hub.wakeService.idle();
    // 20 arrive while it isn't answering (stored without a push), then one more wakes it.
    for (let i = 0; i < 20; i++) await hub.chat.store.append(sent.conversation, { id: `backlog-${i}`, from: person.name, fromId: person.id, human: true, parts: [{ text: `backlog ${i}` }] });
    await hub.send(person, { to: agent.id }, [{ text: 'what was it?' }]);
    await hub.wakeService.idle();
    // Its history (the first turn sent) still holds what it heard before the backlog.
    expect(calls.at(-1)!.text).toContain('swordfish');
  });

  it("shrinks old messages only in a channel thread (read_thread brings them back); a DM keeps them whole", async () => {
    const { hub, calls } = cloudHub();
    let person = await testPerson(hub.registry, 'Tal');
    const agent = await hub.createCloudAgent(person, { name: 'Planner' });
    const old = (secret: string) => `${'background '.repeat(30)}the token is ${secret}`; // past character 200
    // An owner DM: nothing to re-read it with, so a token deep in an old message stays in the request.
    const sent = await hub.send(person, { to: agent.id }, [{ text: old('dm-secret-7731') }]);
    await hub.wakeService.idle();
    for (let i = 0; i < 5; i++) await hub.chat.store.append(sent.conversation, { id: `newer-${i}`, from: agent.name, fromId: agent.id, human: false, parts: [{ text: `newer ${i}` }] });
    await hub.send(person, { to: agent.id }, [{ text: 'what was the token?' }]);
    await hub.wakeService.idle();
    expect(calls.at(-1)!.text).toContain('dm-secret-7731');
    // A channel thread: the old message is cut to its gist.
    const ws = await hub.registry.createWorkspace(person, 'Tal');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, ws.id, 'team');
    await hub.registry.addToWorkspace(person, ws.id, agent.id);
    await hub.registry.addToChannel(person, team.id, agent.id);
    const { message: post } = await hub.chat.post(person, { channelId: team.id }, { parts: [{ text: `@Planner ${old('thread-secret-4410')}` }] });
    await hub.wakeService.idle();
    const self = (await hub.registry.get(agent.id))!;
    for (let i = 0; i < 5; i++) await hub.chat.post(self, { channelId: team.id, thread: post.id }, { parts: [{ text: `newer ${i}` }] });
    await hub.chat.post(person, { channelId: team.id, thread: post.id }, { parts: [{ text: '@Planner what was the token?' }] });
    await hub.wakeService.idle();
    expect(calls.at(-1)!.text).toContain('[truncated]');
    expect(calls.at(-1)!.text).not.toContain('thread-secret-4410');
  });

  it('thinks and writes within the configured limits (none sent when unset)', async () => {
    const limited = cloudHub({ thinkingLevel: 'low', maxOutputTokens: 4096 });
    const person = await testPerson(limited.hub.registry, 'Lia');
    const agent = await limited.hub.createCloudAgent(person, { name: 'Planner' });
    await limited.hub.send(person, { to: agent.id }, [{ text: 'plan my week' }]);
    await limited.hub.wakeService.idle();
    expect(limited.calls.at(-1)!.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 4096 });

    const open = cloudHub();
    const other = await testPerson(open.hub.registry, 'Noa');
    const planner = await open.hub.createCloudAgent(other, { name: 'Planner' });
    await open.hub.send(other, { to: planner.id }, [{ text: 'plan my week' }]);
    await open.hub.wakeService.idle();
    expect(open.calls.at(-1)!.generationConfig).toBeUndefined();
  });

  it("knows today's date: it comes with the newest message", async () => {
    const { hub, calls } = cloudHub();
    const person = await testPerson(hub.registry, 'Ida');
    const agent = await hub.createCloudAgent(person, { name: 'Planner' });
    await hub.send(person, { to: agent.id }, [{ text: 'what day is it?' }]);
    await hub.wakeService.idle();
    const year = String(new Date().getUTCFullYear());
    expect(calls.at(-1)!.text).toMatch(new RegExp(`^\\(Now: .*${year}.*UTC\\)\\nwhat day is it\\?$`));
  });

  it('a channel post that @mentions one agent wakes only it; one that passes on purpose there stays quiet', async () => {
    const { hub, calls } = cloudHub();
    let person = await testPerson(hub.registry, 'Jo');
    const workspace = await hub.registry.createWorkspace(person, 'quiet-co');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, workspace.id, 'team');
    person = (await hub.registry.get(person.id))!;
    const scout = await hub.createCloudAgent(person, { name: 'Scout', workspaceId: workspace.id });
    const planner = await hub.createCloudAgent(person, { name: 'Planner', workspaceId: workspace.id });
    for (const a of [scout, planner]) await hub.registry.addToChannel(person, team.id, a.id);
    calls.length = 0;
    await hub.send(person, { channel: team.id }, [{ text: '@Scout fyi, the release is out' }]);
    await hub.wakeService.idle();
    // Only Scout's model ran (Planner wasn't named); Scout said PASS, so nothing was posted for it.
    expect(calls.map((c) => c.system.split(',')[0])).toEqual(['You are Scout']);
    const page = await hub.chat.page(person, `channel:${team.id}`, 10);
    const threads = Object.keys(page.threads);
    expect(page.messages.filter((m) => m.fromId === scout.id)).toEqual([]);
    for (const t of threads) expect((await hub.chat.page(person, `thread:${team.id}:${t}`, 10)).messages.filter((m) => m.fromId === scout.id)).toEqual([]);
    // In a thread two agents are in, a reply naming one wakes only that one too (Echo, like Scout, passes: no answers to wake anyone).
    const echo = await hub.createCloudAgent(person, { name: 'Echo', workspaceId: workspace.id });
    await hub.registry.addToChannel(person, team.id, echo.id);
    const post = (await hub.send(person, { channel: team.id }, [{ text: '@Scout @Echo a question for you both' }])).message;
    await hub.wakeService.idle();
    await hub.send(person, { channel: team.id, thread: post.id }, [{ text: '@Scout @Echo still there?' }]); // both are in the thread now
    await hub.wakeService.idle();
    calls.length = 0;
    await hub.send(person, { channel: team.id, thread: post.id }, [{ text: '@Echo just you' }]);
    await hub.wakeService.idle();
    expect(calls.map((c) => c.system.split(',')[0])).toEqual(['You are Echo']);
  });

  it("a person's post that names no agent wakes only the ones the router picks (everyone if it can't tell)", async () => {
    const { hub, calls } = cloudHub();
    let person = await testPerson(hub.registry, 'Kai');
    const workspace = await hub.registry.createWorkspace(person, 'routed-co');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, workspace.id, 'team');
    person = (await hub.registry.get(person.id))!;
    const scout = await hub.createCloudAgent(person, { name: 'Scout', workspaceId: workspace.id });
    const planner = await hub.createCloudAgent(person, { name: 'Planner', workspaceId: workspace.id });
    for (const a of [scout, planner]) await hub.registry.addToChannel(person, team.id, a.id);
    const asked: string[][] = [];
    let answer: string[] | undefined = [planner.id];
    let heardBefore: string[] = [];
    hub.chat.route = async (_text, candidates, _from, recent) => (asked.push(candidates.map((c) => c.name).sort()), (heardBefore = (recent ?? []).map((m) => `${m.name}: ${m.text}`)), answer);
    calls.length = 0;
    await hub.send(person, { channel: team.id }, [{ text: "what's the plan for the week?" }]);
    await hub.wakeService.idle();
    expect(asked).toEqual([['Planner', 'Scout']]);
    expect(calls.map((c) => c.system.split(',')[0])).toEqual(['You are Planner']);
    // It can't tell: everyone, as before.
    answer = undefined;
    calls.length = 0;
    await hub.send(person, { channel: team.id }, [{ text: 'anything else?' }]);
    await hub.wakeService.idle();
    expect(calls.map((c) => c.system.split(',')[0]).sort()).toEqual(['You are Planner', 'You are Scout']);

    // A reply in a thread both are in (Scout's post that mentions Planner): the router picks there too.
    const { message: post } = await hub.chat.post((await hub.registry.get(scout.id))!, { channelId: team.id }, { parts: [{ text: 'Hi Kai, @Planner and I are here' }] });
    await hub.wakeService.idle();
    answer = [scout.id];
    asked.length = 0;
    calls.length = 0;
    await hub.send(person, { channel: team.id, thread: post.id }, [{ text: 'I want to hire agents' }]);
    await hub.wakeService.idle();
    expect(asked).toEqual([['Planner', 'Scout']]);
    // It reads what came just before (the post, and Planner's answer to its mention): a short answer is for whoever asked.
    expect(heardBefore).toEqual(['Scout: Hi Kai, @Planner and I are here', 'Planner: Happy to plan with you.']);
    expect(calls.map((c) => c.system.split(',')[0])).toEqual(['You are Scout']);

    // An agent's reply naming nobody goes past the router too: "Thanks!" is for nobody, so Planner isn't woken.
    answer = [];
    asked.length = 0;
    calls.length = 0;
    await hub.chat.post((await hub.registry.get(scout.id))!, { channelId: team.id, thread: post.id }, { parts: [{ text: 'Thanks!' }] });
    await hub.wakeService.idle();
    expect(asked).toEqual([['Planner']]);
    expect(calls).toEqual([]);
  });

  it("a person's post the router places with nobody still reaches one agent", async () => {
    const { hub, calls } = cloudHub();
    let person = await testPerson(hub.registry, 'Ori');
    const workspace = await hub.registry.createWorkspace(person, 'unheard-co');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, workspace.id, 'team');
    person = (await hub.registry.get(person.id))!;
    const scout = await hub.createCloudAgent(person, { name: 'Scout', workspaceId: workspace.id });
    const planner = await hub.createCloudAgent(person, { name: 'Planner', workspaceId: workspace.id });
    for (const a of [scout, planner]) await hub.registry.addToChannel(person, team.id, a.id);
    hub.chat.route = async () => [];
    calls.length = 0;
    await hub.send(person, { channel: team.id }, [{ text: 'should the free plan allow 2 workspaces?' }]);
    await hub.wakeService.idle();
    expect(calls).toHaveLength(1);
  });

  it("an agent's thread reply the router can't place wakes the thread's agents, for a short run only", async () => {
    const { hub, calls } = cloudHub();
    let person = await testPerson(hub.registry, 'Lia');
    const workspace = await hub.registry.createWorkspace(person, 'fallback-co');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, workspace.id, 'team');
    person = (await hub.registry.get(person.id))!;
    // Both Planners answer every time they're woken (see cloudHub); Scout passes.
    const scout = await hub.createCloudAgent(person, { name: 'Scout', workspaceId: workspace.id });
    const planner = await hub.createCloudAgent(person, { name: 'Planner', workspaceId: workspace.id });
    const other = await hub.createCloudAgent(person, { name: 'Planner Two', workspaceId: workspace.id });
    for (const a of [scout, planner, other]) await hub.registry.addToChannel(person, team.id, a.id);
    hub.chat.route = async () => undefined; // the router is down
    const woken = () => calls.map((c) => c.system.split(',')[0]);

    // Planner answers Scout's post in its thread: Scout, already in the thread, is woken.
    calls.length = 0;
    await hub.chat.post((await hub.registry.get(scout.id))!, { channelId: team.id }, { parts: [{ text: '@Planner can you take this?' }] });
    await hub.wakeService.idle();
    expect(woken()).toEqual(['You are Planner', 'You are Scout']);

    // Two agents that always answer: guessed wakes stop after ROUTE_FALLBACK_RUN agents' messages in a row.
    calls.length = 0;
    const { message: post } = await hub.chat.post((await hub.registry.get(other.id))!, { channelId: team.id }, { parts: [{ text: '@Planner ping' }] });
    await hub.wakeService.idle();
    expect(woken()).toEqual(['You are Planner', 'You are Planner Two', 'You are Planner']);
    const thread = await hub.chat.page(person, threadKey(team.id, post.id), 50);
    expect(thread.messages.filter((m) => m.id !== post.id)).toHaveLength(3);

    // An agent's first reply to its own post joins the channel to the thread, but a guess wakes none of them.
    calls.length = 0;
    const { message: own } = await hub.chat.post((await hub.registry.get(scout.id))!, { channelId: team.id }, { parts: [{ text: 'status: shipped' }] });
    await hub.chat.post((await hub.registry.get(scout.id))!, { channelId: team.id, thread: own.id }, { parts: [{ text: 'details to follow' }] });
    await hub.wakeService.idle();
    expect(calls).toEqual([]);
  });

  it("a message the router (or its mentions) narrowed isn't in other agents' inboxes; they see it before what's next for them", async () => {
    const { hub } = cloudHub();
    let person = await testPerson(hub.registry, 'Noa');
    const workspace = await hub.registry.createWorkspace(person, 'inbox-co');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, workspace.id, 'team');
    person = (await hub.registry.get(person.id))!;
    const { agent: coder } = await hub.registry.createBot(person, { name: 'Coder' });
    const { agent: writer } = await hub.registry.createBot(person, { name: 'Writer' });
    for (const a of [coder, writer]) {
      await hub.registry.addToWorkspace(person, workspace.id, a.id);
      await hub.registry.addToChannel(person, team.id, a.id);
    }
    hub.chat.route = async (text, candidates) => candidates.filter((c) => text.includes(c.name.toLowerCase())).map((c) => c.id);
    const inbox = async (id: string) => (await hub.chat.newFor((await hub.registry.get(id))!)).map((i) => i.message.parts[0]!.text);
    await hub.send(person, { channel: team.id }, [{ text: 'the coder should fix the login bug' }]);
    expect(await inbox(coder.id)).toEqual(['the coder should fix the login bug']);
    expect(await inbox(writer.id)).toEqual([]);
    // Something for the writer: what it didn't get comes along as what came before.
    await hub.send(person, { channel: team.id }, [{ text: 'and the writer announces it' }]);
    const [item] = await hub.chat.newFor((await hub.registry.get(writer.id))!);
    expect(item!.message.parts[0]!.text).toBe('and the writer announces it');
    expect(item!.earlier.map((m) => m.parts[0]!.text)).toEqual(['the coder should fix the login bug']);
    // The router can't tell: everyone, as before.
    hub.chat.route = async () => undefined;
    await hub.send(person, { channel: team.id }, [{ text: 'anyone around?' }]);
    expect((await inbox(writer.id)).at(-1)).toBe('anyone around?');
    // But an agent's post wakes no other agent on a guess.
    await hub.send((await hub.registry.get(coder.id))!, { channel: team.id }, [{ text: 'thinking out loud' }]);
    expect(await inbox(writer.id)).not.toContain('thinking out loud');
  });

  it('the Vertex router: the ids it picks, only known ones; nothing usable is "can\'t tell"', async () => {
    const reply = (agents: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ agents }) }] } }] }));
    let next: () => Response = () => reply(['a', 'ghost', 'b', 'c']);
    const route = vertexRouter({ project: 'p', location: 'global', model: 'flash', accessToken: async () => 't', fetchImpl: (async () => next()) as unknown as typeof fetch });
    const cands = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() }));
    expect(await route('hi', cands)).toEqual(['a', 'b', 'c']);
    next = () => reply([]);
    expect(await route('thanks!', cands)).toEqual([]);
    next = () => new Response('nope', { status: 500 });
    expect(await route('hi', cands)).toBeUndefined();
  });

  it('says once that the credits are used up, then passes', async () => {
    const { hub, calls } = cloudHub();
    const person = await testPerson(hub.registry, 'Eli');
    const agent = await hub.createCloudAgent(person, { name: 'Planner' });
    await hub.llm.add(person.id, 5_000_000);
    await hub.send(person, { to: agent.id }, [{ text: 'hi' }]);
    await hub.wakeService.idle();
    await hub.send(person, { to: agent.id }, [{ text: 'still there?' }]);
    await hub.wakeService.idle();
    const dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.filter((m) => m.fromId === agent.id).map((m) => m.parts[0]!.text)).toEqual([expect.stringMatching(/Your Parly credits for this month are used up/)]);
    expect(calls).toEqual([]);
  });

  it("stops a looping turn at the hub's per-turn credit cap and answers with what it has", async () => {
    let calls = 0;
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init.body));
      // A bug: it keeps reading channels (a new one each time, so it looks like progress) until tools are turned off.
      const parts = body.toolConfig?.functionCallingConfig?.mode === 'NONE' ? [{ text: 'Stopped here.' }] : [{ functionCall: { name: 'parly_read_channel', args: { channel: `c${calls}` } } }];
      return new Response(JSON.stringify({ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 100_000 } }));
    }) as typeof fetch;
    // 100k tokens in at $2/M = $0.20 a call, $0.40 with the markup: a 200-credit ($2) cap is reached after 5 calls.
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD, agentTurnCreditCap: 200 }), cloudFetch, cloudToken: async () => 'ya29.test' });
    const person = await testPerson(hub.registry, 'Looper');
    await hub.billing.setPlan(person.id, { plan: 'pro' });
    const agent = await hub.createCloudAgent(person, { name: 'Looper' });
    await hub.send(person, { to: agent.id }, [{ text: 'go' }]);
    await hub.wakeService.idle();
    expect(calls).toBe(6);
    const dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.at(-1)!.parts[0]!.text).toBe('Stopped here.');
  });

  it('says so when the model refuses, instead of retrying in silence', async () => {
    const cloudFetch = (async () => new Response('model not found', { status: 404 })) as unknown as typeof fetch;
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }), cloudFetch, cloudToken: async () => 'ya29.test' });
    const person = await testPerson(hub.registry, 'Fay');
    const agent = await hub.createCloudAgent(person, { name: 'Planner' });
    await hub.send(person, { to: agent.id }, [{ text: 'hi' }]);
    await hub.wakeService.idle();
    const dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.find((m) => m.fromId === agent.id)!.parts[0]!.text).toMatch(/gemini-4-argon\) refused the call \(HTTP 404\)/);
  });

  it("finds and runs its owner's tools on demand, read-only unless allowed to act", async () => {
    const executed: { slug: string; body: Record<string, unknown> }[] = [];
    const TOOLS = [
      { slug: 'LINEAR_LIST_ISSUES', description: 'List issues', input_parameters: { type: 'object', properties: { repo: { type: 'string' } } }, tags: ['readOnlyHint'] },
      { slug: 'LINEAR_CREATE_ISSUE', description: 'Create an issue', input_parameters: { type: 'object', properties: {} }, tags: ['createHint'] },
    ];
    const composioFetch = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/connected_accounts')) return Response.json({ items: [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'linear' } }] });
      if (u.pathname.endsWith('/tools')) return Response.json({ items: TOOLS });
      if (u.pathname.includes('/tools/execute/')) {
        executed.push({ slug: u.pathname.split('/').pop()!, body: JSON.parse(String(init!.body)) });
        return Response.json({ successful: true, data: { issues: [{ title: 'Bug' }] } });
      }
      const one = TOOLS.find((t) => u.pathname.endsWith(`/tools/${t.slug}`));
      if (one) return Response.json(one);
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    // The model: find a tool, run the one the test wants, then answer with what came back.
    let wantSlug = 'LINEAR_LIST_ISSUES';
    const seen: { declared: string[]; last: any; system: string; prompt: string }[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const last = body.contents.at(-1).parts[0];
      seen.push({ declared: (body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name), last, system: body.systemInstruction.parts[0].text, prompt: JSON.stringify(body.contents) });
      const parts = !last.functionResponse
        ? [{ functionCall: { name: 'find_tools', args: { query: 'issues' } } }]
        : last.functionResponse.name === 'find_tools'
          ? [{ functionCall: { name: 'run_tool', args: { tool: wantSlug, arguments: { repo: 'parly' } } } }]
          : [{ text: `Result: ${JSON.stringify(last.functionResponse.response)}` }];
      return Response.json({ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    }) as typeof fetch;
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD, composioApiKey: 'ck_test' }), cloudFetch, cloudToken: async () => 'ya29.test', composioFetch });
    const person = await testPerson(hub.registry, 'Gil');
    const agent = await hub.createCloudAgent(person, { name: 'Scout' });
    await hub.setAgentTools(person, agent.id, { toolkits: ['Linear', 'not a slug!'], act: false });
    expect((await hub.registry.get(agent.id))!.tools).toEqual({ toolkits: ['linear'], act: false });
    const reply = async (text: string) => {
      await hub.send(person, { to: agent.id }, [{ text }]);
      await hub.wakeService.idle();
      const dm = await hub.chat.page(person, `agent:${agent.id}`, 20);
      return dm.messages.filter((m) => m.fromId === agent.id).at(-1)!.parts[0]!.text!;
    };

    // Only the two small functions are declared, never the tools themselves; a read is found and run as its owner.
    expect(await reply('what issues are open?')).toBe('Result: {"ok":true,"data":{"issues":[{"title":"Bug"}]}}');
    expect(seen[0]!.declared).toEqual(expect.arrayContaining(['parly_read_channel', 'send_message', 'read_thread', 'find_tools', 'run_tool']));
    expect(seen[1]!.last.functionResponse.response.tools.map((t: { tool: string }) => t.tool)).toEqual(['LINEAR_LIST_ISSUES']);
    expect(executed).toEqual([{ slug: 'LINEAR_LIST_ISSUES', body: { user_id: person.id, arguments: { repo: 'parly' } } }]);
    // What it found, it keeps: the next turn starts knowing the tools (names, compact arguments), not looking again.
    expect(seen[0]!.system).not.toContain('LINEAR_LIST_ISSUES');
    const turns = seen.length;

    // Read-only: a write is refused, and nothing runs; another app's tool isn't its to run.
    wantSlug = 'LINEAR_CREATE_ISSUE';
    expect(await reply('file a bug')).toMatch(/lets you only read/);
    expect(seen[turns]!.system).toBe(seen[0]!.system);
    expect(seen[turns]!.prompt).toContain('Tools you found before');
    expect(seen[turns]!.prompt).toContain(JSON.stringify('{"tool":"LINEAR_LIST_ISSUES","app":"linear","does":"List issues","arguments":{"properties":{"repo":"string"}}}').slice(1, -1));
    wantSlug = 'GMAIL_SEND_EMAIL';
    expect(await reply('email them')).toMatch(/isn't a tool of your apps/);
    expect(executed).toHaveLength(1);

    // Allowed to act: the write runs.
    await hub.setAgentTools(person, agent.id, { toolkits: ['linear'], act: true });
    wantSlug = 'LINEAR_CREATE_ISSUE';
    await reply('file a bug');
    expect(executed.map((e) => e.slug)).toEqual(['LINEAR_LIST_ISSUES', 'LINEAR_CREATE_ISSUE']);
  });

  it('caps tool rounds with functionCallingConfig mode NONE on the final round and degrades cleanly if Composio fails', async () => {
    let composioDown = false;
    const composioFetch = (async (url: string) => {
      if (composioDown) return new Response('down', { status: 503 });
      const u = new URL(url);
      if (u.pathname.endsWith('/connected_accounts')) return Response.json({ items: [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'linear' } }] });
      if (u.pathname.endsWith('/tools'))
        return Response.json({
          items: [{ slug: 'LINEAR_LIST_ISSUES', description: 'List issues', input_parameters: { type: 'object', properties: {} } }],
        });
      if (u.pathname.includes('/tools/execute/')) return Response.json({ successful: true, data: { ok: true } });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const bodies: Record<string, unknown>[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const mode = (body.toolConfig as { functionCallingConfig?: { mode?: string } } | undefined)?.functionCallingConfig?.mode;
      const parts = mode === 'NONE' || !body.tools ? [{ text: 'Done after rounds.' }] : [{ functionCall: { name: 'LINEAR_LIST_ISSUES', args: {} } }];
      return Response.json({ candidates: [{ content: { parts } }] });
    }) as typeof fetch;

    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD, composioApiKey: 'ck_test' }), cloudFetch, cloudToken: async () => 'ya29.test', composioFetch });
    const person = await testPerson(hub.registry, 'Hana');
    const agent = await hub.createCloudAgent(person, { name: 'Scout' });
    await hub.setAgentTools(person, agent.id, { toolkits: ['linear'], act: false });

    await hub.send(person, { to: agent.id }, [{ text: 'loop test' }]);
    await hub.wakeService.idle();
    expect(bodies).toHaveLength(15);
    // Final round keeps tools declared (required by Vertex when contents has functionCall/functionResponse) and sets mode: 'NONE'.
    expect(bodies[14]!.tools).toBeDefined();
    expect(bodies[14]!.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });

    // If Composio is unreachable, the agent still answers without crashing the turn.
    composioDown = true;
    await hub.send(person, { to: agent.id }, [{ text: 'still there?' }]);
    await hub.wakeService.idle();
    const dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.filter((m) => m.fromId === agent.id)).toHaveLength(2);
  });

  it('remembers the conversation, reads its channels, and never leaves a direct message unanswered', async () => {
    const bodies: any[] = [];
    let script: (body: any) => any[] = () => [{ text: 'ok' }];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return Response.json({ candidates: [{ content: { parts: script(body) } }] });
    }) as typeof fetch;
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }), cloudFetch, cloudToken: async () => 'ya29.test' });
    const person = await testPerson(hub.registry, 'Mali');
    const agent = await hub.createCloudAgent(person, { name: 'Cloudy' });
    const ws = await hub.registry.createWorkspace(person, 'Mali');
    const channel = await hub.registry.createChannel(person, ws.id, 'build-in-public');
    await hub.registry.addToWorkspace(person, ws.id, agent.id);
    await hub.registry.addToChannel(person, channel.id, agent.id);
    await hub.send(person, { channel: channel.id }, [{ text: 'Shipped: email listening for cloud agents' }]);
    // Channel names match loosely: "build in public" and "#Build In Public" are #build-in-public; a miss lists yours.
    const member = (await hub.registry.get(agent.id))!;
    expect((await hub.registry.resolveMemberChannel(member, 'build in public')).id).toBe(channel.id);
    expect((await hub.registry.resolveMemberChannel(member, '#Build In Public')).id).toBe(channel.id);
    await expect(hub.registry.resolveMemberChannel(member, 'parly dev')).rejects.toThrow(/Yours: build-in-public/);
    await hub.wakeService.idle();

    // An empty answer in a DM isn't silence.
    script = () => [];
    await hub.send(person, { to: agent.id }, [{ text: 'Add the new features to build-in-public' }]);
    await hub.wakeService.idle();
    let dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.at(-1)!.fromId).toBe(agent.id);
    expect(dm.messages.at(-1)!.parts[0]!.text).toMatch(/couldn't put together an answer/);

    // It reads the channel with its Parly tool, and remembers what was asked.
    bodies.length = 0;
    script = (body) => {
      const last = body.contents.at(-1);
      if (last.parts.some((p: any) => p.functionResponse)) return [{ text: 'Read it: the last post was about email listening.' }];
      return [{ functionCall: { name: 'parly_read_channel', args: { channel: 'build-in-public' } } }];
    };
    await hub.send(person, { to: agent.id }, [{ text: '?' }]);
    await hub.wakeService.idle();
    const first = JSON.stringify(bodies[0].contents);
    expect(first).toContain('Add the new features to build-in-public'); // remembered
    expect(first).toContain("couldn't put together an answer"); // its own turn, as the model
    expect(bodies[0].contents.some((c: any) => c.role === 'model')).toBe(true);
    expect(JSON.stringify(bodies[1].contents)).toContain('Shipped: email listening for cloud agents');
    dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.at(-1)!.parts[0]!.text).toBe('Read it: the last post was about email listening.');

    // Parly's own MCP tools, in-process as the agent: it posts the update in the channel.
    script = (body) => {
      const last = body.contents.at(-1);
      if (last.parts.some((p: any) => p.functionResponse)) return [{ text: 'Posted it in #build-in-public.' }];
      return [{ functionCall: { name: 'send_message', args: { channel: 'build-in-public', text: 'New: cloud agents remember and read channels' } } }];
    };
    await hub.send(person, { to: agent.id }, [{ text: 'Post the update there' }]);
    await hub.wakeService.idle();
    const posts = await hub.chat.page(person, `channel:${channel.id}`, 10);
    expect(posts.messages.at(-1)).toMatchObject({ fromId: agent.id });
    expect(posts.messages.at(-1)!.parts[0]!.text).toBe('New: cloud agents remember and read channels');
  });

  it("in a channel, a post it made with its own tool is its answer: no second 'I posted it' message", async () => {
    let script: (body: any) => any[] = () => [{ text: 'PASS' }];
    const cloudFetch = (async (_url: string, init: RequestInit) => Response.json({ candidates: [{ content: { parts: script(JSON.parse(String(init.body))) } }] })) as typeof fetch;
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }), cloudFetch, cloudToken: async () => 'ya29.test' });
    const person = await testPerson(hub.registry, 'Mali');
    const agent = await hub.createCloudAgent(person, { name: 'Hype' });
    const ws = await hub.registry.createWorkspace(person, 'Party');
    const channel = await hub.registry.createChannel(person, ws.id, 'talk-me-out-of-it');
    await hub.registry.addToWorkspace(person, ws.id, agent.id);
    await hub.registry.addToChannel(person, channel.id, agent.id);
    let postId = '';
    script = (body) =>
      body.contents.at(-1).parts.some((p: any) => p.functionResponse)
        ? [{ text: 'I posted the opening pitch in the thread.' }]
        : [{ functionCall: { name: 'send_message', args: { channel: 'talk-me-out-of-it', thread: postId, text: 'DO IT TODAY.' } } }];
    const posted = await hub.send(person, { channel: channel.id }, [{ text: '@Hype I want a Tesla' }]);
    postId = (posted as { message: { id: string } }).message.id;
    await hub.wakeService.idle();
    const thread = await hub.chat.page(person, `thread:${channel.id}:${postId}`, 10);
    expect(thread.messages.filter((m) => m.fromId === agent.id).map((m) => m.parts[0]!.text)).toEqual(['DO IT TODAY.']);
  });

  it('retries a malformed empty step, and says what it tried when it runs out', async () => {
    let n = 0;
    let mode: 'malformed' | 'failing' = 'malformed';
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      n++;
      if (mode === 'malformed') {
        if (n === 1) return Response.json({ candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] });
        return Response.json({ candidates: [{ content: { parts: [{ text: 'Second try worked.' }] }, finishReason: 'STOP' }] });
      }
      // Keeps reading a channel it isn't in, then says nothing.
      if (body.toolConfig?.functionCallingConfig?.mode === 'NONE') return Response.json({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
      return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: 'parly_read_channel', args: { channel: 'nowhere' } } }] } }] });
    }) as typeof fetch;
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }), cloudFetch, cloudToken: async () => 'ya29.test' });
    const person = await testPerson(hub.registry, 'Ron');
    const agent = await hub.createCloudAgent(person, { name: 'Cloudy' });

    await hub.send(person, { to: agent.id }, [{ text: 'hello' }]);
    await hub.wakeService.idle();
    let dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.at(-1)!.parts[0]!.text).toBe('Second try worked.');

    mode = 'failing';
    await hub.send(person, { to: agent.id }, [{ text: 'read #nowhere' }]);
    await hub.wakeService.idle();
    dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    const said = dm.messages.at(-1)!.parts[0]!.text!;
    expect(said).toMatch(/^I couldn't finish that. Here's what I tried:/);
    expect(said).toMatch(/parly_read_channel: failed/);
  });

  it('runs up to MAX_CALLS_PER_STEP (15) tool calls per step, auto-continues mid-task when making progress, and enforces the per-task circuit breaker', async () => {
    expect(MAX_CALLS_PER_STEP).toBe(15);
    expect(TURN_BUDGET_MICROS).toBe(15_000_000);
    expect(TASK_MAX_ROUNDS).toBeGreaterThanOrEqual(45);
    expect(TASK_BUDGET_MICROS).toBeGreaterThanOrEqual(30_000_000);

    const commits = [{ sha: 'a1', html_url: 'h', commit: { message: 'feat: x', author: { name: 'M', date: 'd1' }, tree: { sha: 't' } } }];
    expect(pick(commits, ['message', 'date'])).toEqual([{ commit: { message: 'feat: x', author: { date: 'd1' } } }]);
    expect(pick({ a: 1 }, ['nope'])).toEqual({ a: 1 });
    const many = Array.from({ length: 6 }, (_, i) => ({ message: `feat: thing ${i}\n\nlong body\nSigned-off-by: x` }));
    expect((compact(many) as { message: string }[])[0]!.message).toBe('feat: thing 0 …');
    expect(compact({ sha: 'a1', url: 'https://x', html_url: 'h', author: { login: 'm', avatar_url: 'a', node_id: 'n' }, files: [], note: null, message: 'Fix' })).toEqual({ sha: 'a1', author: { login: 'm' }, message: 'Fix' });

    let executed = 0;
    const composioFetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/connected_accounts')) return Response.json({ items: [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'linear' } }] });
      if (u.pathname.endsWith('/tools')) return Response.json({ items: [{ slug: 'LINEAR_LIST_COMMITS', description: 'List commits', input_parameters: { type: 'object', properties: {} } }] });
      if (u.pathname.endsWith('/tools/LINEAR_LIST_COMMITS')) return Response.json({ slug: 'LINEAR_LIST_COMMITS', description: 'List commits', input_parameters: { type: 'object', properties: {} } });
      if (u.pathname.includes('/tools/execute/')) {
        executed++;
        return Response.json({ successful: true, data: { commits: [{ sha: 'x', url: 'https://noise', message: 'feat' }] } });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const bodies: any[] = [];
    let step = 0;
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      step++;
      if (body.toolConfig?.functionCallingConfig?.mode === 'NONE') return Response.json({ candidates: [{ content: { parts: [{ text: 'Circuit breaker answer.' }] } }] });
      if (step === 1) {
        const calls = Array.from({ length: 18 }, (_, i) => ({ functionCall: { name: 'run_tool', args: { tool: 'LINEAR_LIST_COMMITS', arguments: { page: i + 1 } } } }));
        return Response.json({ candidates: [{ content: { parts: calls } }], usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 10 } });
      }
      if (step <= 20) {
        return Response.json({
          candidates: [{ content: { parts: [{ functionCall: { name: 'run_tool', args: { tool: 'LINEAR_LIST_COMMITS', arguments: { page: 100 + step } } } }] } }],
          usageMetadata: { promptTokenCount: 500_000, candidatesTokenCount: 10 },
        });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Explored all 20 steps and finished!' }] } }] });
    }) as typeof fetch;

    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD, composioApiKey: 'ak', llmMonthlyAllowanceUsd: 500 }), cloudFetch, cloudToken: async () => 'ya29.test', composioFetch });
    const person = await testPerson(hub.registry, 'Eli');
    const agent = await hub.createCloudAgent(person, { name: 'Scout' });
    await hub.setAgentTools(person, agent.id, { toolkits: ['linear'], act: false });
    await hub.send(person, { to: agent.id }, [{ text: 'list commits across repo' }]);
    await hub.wakeService.idle();
    expect(executed).toBe(34);
    expect(bodies).toHaveLength(21);
    expect(JSON.stringify(bodies[1].contents)).not.toContain('https://noise');
    const dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.at(-1)!.parts[0]!.text).toBe('Explored all 20 steps and finished!');

    bodies.length = 0;
    step = 0;
    const runawayFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      step++;
      if (body.toolConfig?.functionCallingConfig?.mode === 'NONE') {
        return Response.json({ candidates: [{ content: { parts: [{ text: 'Stopped safely at the per-task circuit breaker.' }] } }] });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ functionCall: { name: 'run_tool', args: { tool: 'LINEAR_LIST_COMMITS', arguments: { runaway: step } } } }] } }],
        usageMetadata: { promptTokenCount: 10_000_000, candidatesTokenCount: 10 },
      });
    }) as typeof fetch;
    const hubBreaker = createHub({
      db: testDb(),
      config: testConfig({ cloudAgents: CLOUD, composioApiKey: 'ak', llmMonthlyAllowanceUsd: 500 }),
      cloudFetch: runawayFetch,
      cloudToken: async () => 'ya29.test',
      composioFetch,
    });
    const eli2 = await testPerson(hubBreaker.registry, 'Eli2');
    const scout2 = await hubBreaker.createCloudAgent(eli2, { name: 'Scout2' });
    await hubBreaker.setAgentTools(eli2, scout2.id, { toolkits: ['linear'], act: false });
    await hubBreaker.send(eli2, { to: scout2.id }, [{ text: 'runaway task' }]);
    await hubBreaker.wakeService.idle();
    expect(bodies.length).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(bodies.at(-1)!.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    const dm2 = await hubBreaker.chat.page(eli2, `agent:${scout2.id}`, 10);
    expect(dm2.messages.at(-1)!.parts[0]!.text).toBe('Stopped safely at the per-task circuit breaker.');

    // 3. Hard per-task max-rounds circuit breaker (TASK_MAX_ROUNDS = 60) + synthesize() merges into trailing user turn.
    bodies.length = 0;
    step = 0;
    const roundBreakerFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      step++;
      const asked = JSON.stringify(body.contents);
      if (asked.includes('Tools are off now')) {
        return Response.json({ candidates: [{ content: { parts: [{ text: 'Synthesized at max-rounds circuit breaker.' }] } }] });
      }
      if (body.toolConfig?.functionCallingConfig?.mode === 'NONE') {
        return Response.json({ candidates: [{ content: { parts: [] } }] });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ functionCall: { name: 'run_tool', args: { tool: 'LINEAR_LIST_COMMITS', arguments: { round: step } } } }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
      });
    }) as typeof fetch;
    const hubRoundBreaker = createHub({
      db: testDb(),
      config: testConfig({ cloudAgents: CLOUD, composioApiKey: 'ak', llmMonthlyAllowanceUsd: 500 }),
      cloudFetch: roundBreakerFetch,
      cloudToken: async () => 'ya29.test',
      composioFetch,
    });
    const eli3 = await testPerson(hubRoundBreaker.registry, 'Eli3');
    const scout3 = await hubRoundBreaker.createCloudAgent(eli3, { name: 'Scout3' });
    await hubRoundBreaker.setAgentTools(eli3, scout3.id, { toolkits: ['linear'], act: false });
    await hubRoundBreaker.send(eli3, { to: scout3.id }, [{ text: 'infinite pagination' }]);
    await hubRoundBreaker.wakeService.idle();
    // 60 rounds (TASK_MAX_ROUNDS) + 1 synthesize call = 61 calls.
    expect(bodies).toHaveLength(TASK_MAX_ROUNDS + 1);
    expect(bodies[TASK_MAX_ROUNDS - 1]!.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    // Verify synthesize() merged the note into the trailing user turn instead of sending two consecutive user turns.
    const synthContents = bodies.at(-1)!.contents as { role: string }[];
    for (let i = 1; i < synthContents.length; i++) {
      expect(synthContents[i]!.role === 'user' && synthContents[i - 1]!.role === 'user').toBe(false);
    }
    const dm3 = await hubRoundBreaker.chat.page(eli3, `agent:${scout3.id}`, 10);
    expect(dm3.messages.at(-1)!.parts[0]!.text).toBe('Synthesized at max-rounds circuit breaker.');
  });

  it('skips a repeated call, and sums up what it found instead of listing tool names', async () => {
    let reads = 0;
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const asked = JSON.stringify(body.contents);
      if (asked.includes('Tools are off now')) return Response.json({ candidates: [{ content: { parts: [{ text: 'So far: the channel has 1 post. Still missing: the commits.' }] } }] });
      if (body.toolConfig?.functionCallingConfig?.mode === 'NONE') return Response.json({ candidates: [{ content: { parts: [] } }] });
      return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: 'parly_read_channel', args: { channel: 'news' } } }] } }] });
    }) as typeof fetch;
    const hub = createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }), cloudFetch, cloudToken: async () => 'ya29.test' });
    const person = await testPerson(hub.registry, 'Noa');
    const agent = await hub.createCloudAgent(person, { name: 'Cloudy' });
    const ws = await hub.registry.createWorkspace(person, 'Noa');
    const channel = await hub.registry.createChannel(person, ws.id, 'news');
    await hub.registry.addToWorkspace(person, ws.id, agent.id);
    await hub.registry.addToChannel(person, channel.id, agent.id);
    const read = hub.chat.page.bind(hub.chat);
    hub.chat.page = (async (...args: Parameters<typeof read>) => {
      if (String(args[1]).startsWith('channel:')) reads++;
      return read(...args);
    }) as typeof read;
    await hub.send(person, { to: agent.id }, [{ text: 'what is in #news?' }]);
    await hub.wakeService.idle();
    expect(reads).toBe(1); // the same call again was skipped, not run
    const dm = await hub.chat.page(person, `agent:${agent.id}`, 10);
    expect(dm.messages.at(-1)!.parts[0]!.text).toBe('So far: the channel has 1 post. Still missing: the commits.');
  });

  it("isn't offered on a hub without a model", async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const person = await testPerson(hub.registry);
    await expect(hub.createCloudAgent(person, { name: 'x' })).rejects.toThrow(/doesn't run cloud agents/);
  });
  it('find_tools looks for several things at once, each tool once', async () => {
    const asked: string[] = [];
    const composio = {
      findTools: async (_apps: string[], query: string) => {
        asked.push(query);
        return query === 'pr' ? [{ slug: 'LINEAR_GET_ISSUE', toolkit: 'linear', description: 'Get an issue', parameters: {}, readOnly: true }] : [{ slug: 'LINEAR_GET_ISSUE', toolkit: 'linear', description: 'Get an issue', parameters: {}, readOnly: true }, { slug: 'LINEAR_MERGE_ISSUE', toolkit: 'linear', description: 'Merge', parameters: {}, readOnly: false }];
      },
    } as unknown as Parameters<typeof useAppTool>[0];
    const out = (await useAppTool(composio, 'owner', ['linear'], true, 'find_tools', { queries: ['pr', 'merge'] })) as { tools: { tool: string }[] };
    expect(asked).toEqual(['pr', 'merge']);
    expect(out.tools.map((t) => t.tool)).toEqual(['LINEAR_GET_ISSUE', 'LINEAR_MERGE_ISSUE']);
  });
  it('run_tool: the tool named under another key still runs; no name at all says so', async () => {
    const ran: string[] = [];
    const composio = {
      tool: async (slug: string) => ({ slug, readOnly: true }),
      execute: async (_owner: string, slug: string) => (ran.push(slug), { ok: true, data: {} }),
    } as unknown as Parameters<typeof useAppTool>[0];
    expect(await useAppTool(composio, 'owner', ['linear'], true, 'run_tool', { slug: 'LINEAR_GET_ISSUE' })).toMatchObject({ ok: true });
    expect(ran).toEqual(['LINEAR_GET_ISSUE']);
    expect(await useAppTool(composio, 'owner', ['linear'], true, 'run_tool', {})).toMatchObject({ ok: false, error: expect.stringMatching(/needs `tool`/) });
  });
  it('run_tool executes as owner but charges the payer when they differ', async () => {
    const executedAs: string[] = [];
    const charged: string[] = [];
    const composio = {
      tool: async (slug: string) => ({ slug, readOnly: true }),
      execute: async (owner: string, slug: string) => (executedAs.push(owner), { ok: true, data: { slug } }),
    } as unknown as Parameters<typeof useAppTool>[0];
    const credits = {
      hasCredits: async (id: string) => id === 'payer',
      charge: async (id: string) => void charged.push(id),
    };
    expect(await useAppTool(composio, 'owner', ['linear'], true, 'run_tool', { tool: 'LINEAR_GET_ISSUE' }, credits, 'payer')).toMatchObject({ ok: true });
    expect(executedAs).toEqual(['owner']);
    expect(charged).toEqual(['payer']);
    expect(await useAppTool(composio, 'owner', ['linear'], true, 'run_tool', { tool: 'LINEAR_GET_ISSUE' }, { hasCredits: async () => false, charge: async () => {} }, 'payer')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/credits/),
    });
  });
  it("keeps the fields an agent picked whole, even in a long list (each file's patch of a 6-file PR)", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.ts`, patch: '@@ -1,2 +1,3 @@\n-old\n+new' }));
    expect((compact(files) as { patch: string }[])[0]!.patch).not.toContain('+new'); // cut to its first line
    expect((compact(files, 0, true) as { patch: string }[])[0]!.patch).toBe('@@ -1,2 +1,3 @@\n-old\n+new');
  });
  it("reads a file a tool hands back as an S3 link (text in place; a PDF or a picture attached), and fetches no other link", async () => {
    const real = globalThis.fetch;
    const fetched: string[] = [];
    const body: Record<string, Uint8Array | string> = { 'a.ts': 'export const x = 1;\n', 'doc.pdf': '%PDF-1.7 …', 'zip': new Uint8Array([0x50, 0x4b, 0, 0]) };
    globalThis.fetch = (async (url: string) => {
      fetched.push(url);
      return new Response(body[url.split('/').pop()!]!);
    }) as typeof fetch;
    try {
      const at = (f: string) => ({ s3url: `https://b.s3.amazonaws.com/${f}` });
      const data = { content: { name: 'a.ts', s3url: 'https://temp.acct.r2.cloudflarestorage.com/a.ts' }, pdf: at('doc.pdf'), zip: at('zip'), other: { s3url: 'http://169.254.169.254/' }, ec2: { s3url: 'https://ec2-1-2-3-4.compute-1.amazonaws.com/x' } };
      const files: Parameters<typeof readFiles>[1] = [];
      expect(await readFiles(data, files)).toBe(true);
      expect(data.content).toEqual({ name: 'a.ts', text: 'export const x = 1;\n' });
      expect(data.pdf).toEqual({ shown: 'PDF 1, attached to this result' });
      expect(files).toEqual([{ inlineData: { mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7 …').toString('base64') } }]);
      expect(data.zip).toEqual(at('zip')); // binary, not a PDF or a picture: stays a link
      expect(data.other).toEqual({ s3url: 'http://169.254.169.254/' }); // not S3 over https: never fetched
      expect(data.ec2).toEqual({ s3url: 'https://ec2-1-2-3-4.compute-1.amazonaws.com/x' }); // AWS but not S3: never fetched
      expect(fetched).toHaveLength(3);
      // Path-style + dualstack hosts are allowed S3 shapes.
      fetched.length = 0;
      body['path.txt'] = 'path\n';
      body['dual.txt'] = 'dual\n';
      const more = {
        path: { s3url: 'https://s3.us-east-1.amazonaws.com/b/path.txt' },
        dual: { s3url: 'https://b.s3.dualstack.us-east-1.amazonaws.com/dual.txt' },
      };
      expect(await readFiles(more)).toBe(true);
      expect(more.path).toEqual({ text: 'path\n' });
      expect(more.dual).toEqual({ text: 'dual\n' });
      expect(fetched).toHaveLength(2);
      // Path-style and dualstack S3 hosts are allowed (Composio/R2-adjacent).
      fetched.length = 0;
      const pathStyle = { f: { s3url: 'https://s3.us-west-2.amazonaws.com/b/a.ts' } };
      expect(await readFiles(pathStyle, [])).toBe(true);
      expect(fetched).toEqual(['https://s3.us-west-2.amazonaws.com/b/a.ts']);
      fetched.length = 0;
      const dual = { f: { s3url: 'https://b.s3.dualstack.us-east-1.amazonaws.com/a.ts' } };
      expect(await readFiles(dual, [])).toBe(true);
      expect(fetched).toEqual(['https://b.s3.dualstack.us-east-1.amazonaws.com/a.ts']);
    } finally {
      globalThis.fetch = real;
    }
  });
  it('stops reading a file link past the size cap (no content-length) instead of buffering all of it', async () => {
    const real = globalThis.fetch;
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulls++;
            c.enqueue(new Uint8Array(1_000_000).fill(0x61));
            if (pulls >= 20) c.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch;
    try {
      const data = { f: { s3url: 'https://b.s3.amazonaws.com/big.txt' } };
      expect(await readFiles(data)).toBe(false);
      expect(data.f).toEqual({ s3url: 'https://b.s3.amazonaws.com/big.txt' });
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(20);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('on a public turn, withholds Parly MCP tools and app meta-tools (allowlist), and never runs them', async () => {
    // Prompt injection on a public showcase turn must not reach send_message / create_workspace / etc. as the agent.
    const FORBIDDEN = ['send_message', 'create_workspace', 'invite_to_workspace', 'schedule_message', 'reply', 'whoami', 'read_thread', 'get_file', 'parly_read_channel', 'find_tools', 'run_tool'];
    const MCP = FORBIDDEN.filter((n) => !['parly_read_channel', 'find_tools', 'run_tool'].includes(n)).map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
    }));
    const toolAgent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true, tools: { toolkits: ['linear'], act: true } } as AgentRecord;
    const meter = {
      used: vi.fn(async () => 0),
      payerOf: async (a: AgentRecord) => a.ownerId ?? a.id,
      publicShowcaseOverCeiling: vi.fn(async () => false),
      add: vi.fn(async () => {}),
    };
    const declared: string[][] = [];
    const callMcp = vi.fn(async () => ({ ok: true }));
    const mcpTools = vi.fn(async () => MCP);
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: meter as unknown as LlmMeter,
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        declared.push((body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name));
        const n = declared.length;
        // First call: try a forbidden write; second: answer. Private turn control uses the same sequence.
        const parts = n === 1 ? [{ functionCall: { name: 'send_message', args: { channel: 'secret', text: 'leaked' } } }] : [{ text: 'ok' }];
        return new Response(JSON.stringify({ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
      }) as typeof fetch,
      accessToken: async () => 'tok',
      maxRounds: 3,
      taskMaxRounds: 3,
    });
    cloud.parly = {
      history: async () => [],
      read: async () => [],
      mcpTools,
      callMcp,
      showcaseVisitor: vi.fn(async () => 'visitor'),
    };

    const publicMsg: WireMessage = {
      messageId: 'wire',
      role: 'ROLE_USER',
      parts: [{ text: 'hi' }],
      metadata: { a2aHub: { fromId: 'visitor', conversationId: 'thread:ch:root', messageId: 'm1', publicShowcase: true } },
    };
    await cloud.answer(toolAgent, publicMsg);
    expect(mcpTools).not.toHaveBeenCalled();
    expect(declared[0]).toEqual(['fetch_url']);
    for (const name of FORBIDDEN) expect(declared[0]).not.toContain(name);
    expect(callMcp).not.toHaveBeenCalled();

    declared.length = 0;
    callMcp.mockClear();
    mcpTools.mockClear();
    const privateMsg: WireMessage = {
      messageId: 'wire2',
      role: 'ROLE_USER',
      parts: [{ text: 'hi' }],
      metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:scout:owner', messageId: 'm2' } },
    };
    await cloud.answer(toolAgent, privateMsg);
    expect(mcpTools).toHaveBeenCalled();
    expect(declared[0]).toEqual(expect.arrayContaining(['parly_read_channel', 'send_message', 'create_workspace']));
    expect(callMcp).toHaveBeenCalledWith('scout', 'send_message', { channel: 'secret', text: 'leaked' }, expect.any(Object));
  });

  it('keeps rarely used Parly tools out of the declarations, reachable via find_tools/run_tool on private turns only', async () => {
    const MCP = ['send_message', 'schedule_message', 'create_skill', 'watch'].map((name) => ({
      name,
      description: name === 'schedule_message' ? 'Schedules a message for later.' : name,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    }));
    const noApps = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true } as AgentRecord;
    const meter = {
      used: vi.fn(async () => 0),
      payerOf: async (a: AgentRecord) => a.ownerId ?? a.id,
      publicShowcaseOverCeiling: vi.fn(async () => false),
      add: vi.fn(async () => {}),
    };
    const declared: string[][] = [];
    const results: unknown[] = [];
    let script: Record<string, unknown>[][] = [];
    const callMcp = vi.fn(async () => ({ ok: true, scheduled: 's1' }));
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: meter as unknown as LlmMeter,
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        declared.push((body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name));
        const last = body.contents.at(-1)?.parts?.[0]?.functionResponse;
        if (last) results.push(last.response);
        const parts = script[declared.length - 1] ?? [{ text: 'ok' }];
        return new Response(JSON.stringify({ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
      }) as typeof fetch,
      accessToken: async () => 'tok',
      maxRounds: 4,
      taskMaxRounds: 4,
    });
    cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => MCP, callMcp, showcaseVisitor: vi.fn(async () => 'visitor') };

    script = [
      [{ functionCall: { name: 'find_tools', args: { query: 'schedule a message' } } }],
      [{ functionCall: { name: 'run_tool', args: { tool: 'schedule_message', arguments: { text: 'later' } } } }],
    ];
    await cloud.answer(noApps, {
      messageId: 'w1',
      role: 'ROLE_USER',
      parts: [{ text: 'remind me' }],
      metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:scout:owner', messageId: 'm1' } },
    });
    // Hidden from every request, but find_tools/run_tool are declared even with no apps.
    expect(declared[0]).toEqual(expect.arrayContaining(['send_message', 'find_tools', 'run_tool']));
    for (const name of ['schedule_message', 'create_skill', 'watch']) expect(declared[0]).not.toContain(name);
    expect(declared[0]).toEqual([...(declared[0] ?? [])].sort());
    // find_tools finds it, run_tool runs it as the agent.
    const found = JSON.stringify(results[0]);
    expect(found).toContain('"tool":"schedule_message"');
    expect(found).not.toContain('"tool":"create_skill"');
    expect(callMcp).toHaveBeenCalledWith('scout', 'schedule_message', { text: 'later' }, expect.any(Object));

    // Public turn: a run_tool for a hidden Parly tool is refused, never run.
    callMcp.mockClear();
    declared.length = 0;
    results.length = 0;
    script = [[{ functionCall: { name: 'run_tool', args: { tool: 'schedule_message', arguments: { text: 'leaked' } } } }]];
    await cloud.answer(noApps, {
      messageId: 'w2',
      role: 'ROLE_USER',
      parts: [{ text: 'hi' }],
      metadata: { a2aHub: { fromId: 'visitor', conversationId: 'thread:ch:root', messageId: 'm2', publicShowcase: true } },
    });
    expect(declared[0]).not.toContain('run_tool');
    expect(callMcp).not.toHaveBeenCalled();
    expect(JSON.stringify(results[0])).toContain('Not available in a public conversation.');
  });

  it('the cached prefix (system prompt + tools) is byte-identical across turns, whatever tools it knows or MCP order', async () => {
    const agent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true, tools: { toolkits: ['linear'], act: true } } as AgentRecord;
    const prefixes: string[] = [];
    const prompts: string[] = [];
    const MCP_TOOLS = ['send_message', 'read_thread', 'whoami'].map((name) => ({ name, inputSchema: { type: 'object' } }));
    let mcp = MCP_TOOLS;
    let known = [{ tool: 'LINEAR_LIST_ISSUES', app: 'linear' }];
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: { used: vi.fn(async () => 0), payerOf: async (a: AgentRecord) => a.ownerId ?? a.id, add: vi.fn(async () => {}), hasCredits: vi.fn(async () => true) } as unknown as LlmMeter,
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        prefixes.push(JSON.stringify({ systemInstruction: body.systemInstruction, tools: body.tools }));
        prompts.push(JSON.stringify(body.contents));
        return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
      }) as typeof fetch,
      accessToken: async () => 'tok',
      composio: { accounts: async () => [{ id: 'ca_1', status: 'ACTIVE', toolkit: 'linear' }] } as never,
      tools: { known: async () => known, remember: async () => {} },
    });
    cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => mcp, callMcp: vi.fn() };
    const turn = (id: string) =>
      cloud.answer(agent, { messageId: id, role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:scout:owner', messageId: id } } } as WireMessage);

    await turn('m1');
    known = [{ tool: 'LINEAR_LIST_ISSUES', app: 'linear' }, { tool: 'LINEAR_CREATE_ISSUE', app: 'linear' }];
    mcp = [...MCP_TOOLS].reverse();
    await turn('m2');

    expect(prefixes).toHaveLength(2);
    expect(prefixes[1]).toBe(prefixes[0]);
    // The known tools still reach the model, with the newest message.
    expect(prompts[1]).toContain('LINEAR_CREATE_ISSUE');
    expect(prefixes[0]).not.toContain('LINEAR_');
  });

  it('a turn that posted part of its answer and then failed says so instead of ending as done', async () => {
    // Round 1 posts a fragment with its own tool; round 2 the model errors. The push catch marks a turn seen once the
    // agent has posted, so a rethrow here would leave the fragment standing as the whole answer.
    let n = 0;
    const callMcp = vi.fn(async () => ({ ok: true }));
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: { used: vi.fn(async () => 0), payerOf: async (a: AgentRecord) => a.ownerId ?? a.id, add: vi.fn(async () => {}), hasCredits: vi.fn(async () => true) } as unknown as LlmMeter,
      fetchImpl: (async () => {
        if (++n > 1) return new Response('overloaded', { status: 503 });
        const parts = [{ functionCall: { name: 'send_message', args: { channel: 'dev', thread: 'root', text: 'Part one…' } } }];
        return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }));
      }) as typeof fetch,
      accessToken: async () => 'tok',
    });
    cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => [{ name: 'send_message', inputSchema: { type: 'object' } }], callMcp };
    const agent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true } as AgentRecord;
    const msg = (conversationId: string): WireMessage => ({ messageId: 'w', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: { a2aHub: { fromId: 'owner', conversationId, messageId: 'm' } } });

    const out = await cloud.answer(agent, msg('thread:dev:root'));
    expect(callMcp).toHaveBeenCalledTimes(1);
    expect(out.kind === 'message' && out.message.parts[0]).toMatchObject({ text: expect.stringMatching(/incomplete/) });

    // Nothing posted yet: it still throws, so the push queue retries the whole turn.
    n = 1;
    await expect(cloud.answer(agent, msg('thread:dev:root'))).rejects.toThrow(/HTTP 503/);
  });

  it("a turn past its deadline stops the model call and says it's still working instead of throwing", async () => {
    // The model hangs; only the turn's signal ends it in time (unaided, it gives up with a 503 after 1s).
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: { used: vi.fn(async () => 0), payerOf: async (a: AgentRecord) => a.ownerId ?? a.id, add: vi.fn(async () => {}), hasCredits: vi.fn(async () => true) } as unknown as LlmMeter,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          setTimeout(() => resolve(new Response('overloaded', { status: 503 })), 1_000);
        })) as typeof fetch,
      accessToken: async () => 'tok',
    });
    const agent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true } as AgentRecord;
    const msg: WireMessage = { messageId: 'w', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:scout:owner', messageId: 'm' } } };
    const out = await cloud.answer(agent, msg, AbortSignal.timeout(50));
    expect(out.kind === 'message' && out.message.parts[0]).toMatchObject({ text: expect.stringMatching(/still working/) });
  });

  it('a read-only tool ran then the model failed with nothing posted: still throws so the whole turn retries', async () => {
    // read_thread is retry-safe, so replaying the turn just re-reads — let the push queue retry transparently.
    let n = 0;
    const callMcp = vi.fn(async () => ({ ok: true }));
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: { used: vi.fn(async () => 0), payerOf: async (a: AgentRecord) => a.ownerId ?? a.id, add: vi.fn(async () => {}), hasCredits: vi.fn(async () => true) } as unknown as LlmMeter,
      fetchImpl: (async () => {
        if (++n > 1) return new Response('overloaded', { status: 503 });
        const parts = [{ functionCall: { name: 'read_thread', args: { thread: 'root' } } }];
        return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }));
      }) as typeof fetch,
      accessToken: async () => 'tok',
    });
    cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => [{ name: 'read_thread', inputSchema: { type: 'object' } }], callMcp };
    const agent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true } as AgentRecord;
    const msg: WireMessage = { messageId: 'w', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:scout:owner', messageId: 'm' } } };
    await expect(cloud.answer(agent, msg)).rejects.toThrow(/HTTP 503/);
    expect(callMcp).toHaveBeenCalledTimes(1);
  });

  it('a mutating tool ran then the model failed with nothing posted: ends in-band so the write is not replayed', async () => {
    // schedule_message already wrote; replaying the whole turn would schedule it twice. Finish in-band instead of throwing.
    let n = 0;
    const callMcp = vi.fn(async () => ({ ok: true }));
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: { used: vi.fn(async () => 0), payerOf: async (a: AgentRecord) => a.ownerId ?? a.id, add: vi.fn(async () => {}), hasCredits: vi.fn(async () => true) } as unknown as LlmMeter,
      fetchImpl: (async () => {
        if (++n > 1) return new Response('overloaded', { status: 503 });
        const parts = [{ functionCall: { name: 'schedule_message', args: { to: 'owner', text: 'later', at: '2030-01-01' } } }];
        return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }));
      }) as typeof fetch,
      accessToken: async () => 'tok',
    });
    cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => [{ name: 'schedule_message', inputSchema: { type: 'object' } }], callMcp };
    const agent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true } as AgentRecord;
    const msg: WireMessage = { messageId: 'w', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:scout:owner', messageId: 'm' } } };
    const out = await cloud.answer(agent, msg);
    expect(callMcp).toHaveBeenCalledTimes(1);
    expect(out.kind === 'message' && out.message.parts[0]).toMatchObject({ text: expect.stringMatching(/error partway/) });
  });

  it('an inner model-call timeout with the turn signal still live rethrows instead of claiming it ran out of time', async () => {
    // The per-call 120s timeout fires its own composed signal; the turn's outer signal never aborted. The error name is
    // TimeoutError, but the gate reads the OUTER signal's reason (undefined here), so nothing posted means rethrow + retry.
    const cloud = new CloudAgents({
      model: 'test',
      project: 'test',
      location: 'global',
      prices: { input: 1, output: 1 },
      meter: { used: vi.fn(async () => 0), payerOf: async (a: AgentRecord) => a.ownerId ?? a.id, add: vi.fn(async () => {}), hasCredits: vi.fn(async () => true) } as unknown as LlmMeter,
      fetchImpl: (async () => {
        throw new DOMException('timed out', 'TimeoutError');
      }) as typeof fetch,
      accessToken: async () => 'tok',
    });
    cloud.parly = { history: async () => [], read: async () => [], mcpTools: async () => [], callMcp: vi.fn() };
    const agent = { id: 'scout', ownerId: 'owner', name: 'Scout', cloud: true } as AgentRecord;
    const msg: WireMessage = { messageId: 'w', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: { a2aHub: { fromId: 'owner', conversationId: 'dm:scout:owner', messageId: 'm' } } };
    // No turn signal passed: signal?.reason is undefined, so timedOut stays false and it must rethrow.
    await expect(cloud.answer(agent, msg)).rejects.toThrow(/timed out/);
  });

  it('HireGallery removes "What should it do?" and defaults Name to a random name while keeping Team + Type', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const gallerySrc = readFileSync(new URL('../web/components/HireGallery.tsx', import.meta.url), 'utf8');
    expect(gallerySrc).not.toContain('What should it do?');
    expect(gallerySrc).not.toContain('RolePicks');
    expect(gallerySrc).not.toContain('id="hire-does"');
    expect(existsSync(new URL('../web/components/RolePicks.tsx', import.meta.url))).toBe(false);
    expect(gallerySrc).toContain("useState('')");
    expect(gallerySrc).toContain('useEffect');
    expect(gallerySrc).toContain('randomAgentName');
    expect(gallerySrc).toContain('id="hire-name"');
    expect(gallerySrc).toContain('name="channelId"');
    expect(gallerySrc).toContain('name="type"');

    // Hiring a cloud agent with no description (or empty description) succeeds with a default description.
    const { hub } = cloudHub();
    let person = await testPerson(hub.registry, 'MayaOwner');
    const ws = await hub.registry.createWorkspace(person, 'crew');
    person = (await hub.registry.get(person.id))!;
    const team = await hub.registry.createChannel(person, ws.id, 'general');
    person = (await hub.registry.get(person.id))!;
    const agent = await hub.createCloudAgent(person, { name: 'Maya', description: '', workspaceId: ws.id, channelId: team.id });
    expect(agent.name).toBe('Maya');
    expect(agent.description).toContain("A cloud agent of MayaOwner's");
    expect((await hub.registry.get(agent.id))!.channels).toContain(team.id);
  });
});
