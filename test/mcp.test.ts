import { SKILLS_NOTE } from '../src/lib/present.js';
/**
 * The MCP tool surface in-process: buildServer wired to an in-memory client, no HTTP. Covers
 * what the e2e suite doesn't look at: the shape of tool results, in particular the
 * "messages waiting" note the hub appends to every result once mail is queued.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHub } from '../src/app.js';
import type { HubService } from '../src/hub/hubService.js';
import { listMcpTools } from '../src/mcp/inProcess.js';
import { buildServer, pendingNote } from '../src/mcp/server.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, newAgent, testConfig, testDb, testPerson } from './helpers.js';

type Block = { type: string; text: string };

describe('MCP tool results', () => {
  let db: ReturnType<typeof testDb>;
  let hub: HubService;
  let alice: AgentRecord;
  let bob: AgentRecord;

  /** A client talking to a server bound to `agent` (as the bearer header would). */
  async function connect(agent?: AgentRecord, scope?: string): Promise<(tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>> {
    const server = buildServer(hub, agent, undefined, undefined, scope);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    return async (tool, args = {}) => (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  }

  beforeAll(async () => {
    db = testDb();
    hub = createHub({ db, config: testConfig() });
    alice = (await newAgent(hub.registry, { name: 'alice', public: true })).agent;
    bob = (await newAgent(hub.registry, { name: 'bob', public: true })).agent;
  });

  it('keeps MCP quote references separate from reply destination routing', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'mcp-quotes');
    const call = await connect(owner);
    const agentCall = await connect(members[0]!);
    const parse = (r: CallToolResult) => JSON.parse((r.content[0] as Block).text);
    const original = parse(await call('send_message', { channel: channel.id, text: 'original', wait: false })).message;
    const quoted = parse(await agentCall('reply', { messageId: original.id, text: 'answer', replyTo: original.id }));
    expect(quoted.conversation).toBe(`thread:${channel.id}:${original.id}`);
    expect(quoted.replyTo).toMatchObject({ id: original.id, fromId: owner.id, text: 'original' });
    const next = parse(await call('send_message', { channel: channel.id, thread: original.id, text: 'follow-up', replyTo: quoted.id, wait: false })).message;
    expect(next.replyTo.id).toBe(quoted.id);
    expect((await call('send_message', { channel: channel.id, text: 'fake', replyTo: { id: original.id, text: 'forged' }, wait: false })).isError).toBe(true);
  });

  it('appends a note while messages wait, and drops it once they are read', async () => {
    const call = await connect(alice);
    const quiet = await call('whoami');
    expect(quiet.isError).toBeFalsy();
    expect((quiet.content as Block[]).map((c) => c.type)).toEqual(['text']);
    expect(JSON.parse((quiet.content[0] as Block).text)).toMatchObject({ name: 'alice' });

    await hub.send(bob, { to: alice.id }, [{ text: 'ping' }]);
    const noted = await call('whoami');
    const blocks = noted.content as Block[];
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ name: 'alice' }); // the JSON block is unchanged
    expect(blocks[1]!.text).toBe(pendingNote(1));
    expect(blocks[1]!.text).toMatch(/new messages in 1 Parly conversation/);

    // Array results stay arrays, with the note beside them.
    const listed = await call('list_agents');
    expect(Array.isArray(JSON.parse((listed.content[0] as Block).text))).toBe(true);
    expect(listed.content).toHaveLength(2);

    // check_inbox takes the message, so it reports nothing left; it says when to answer (the hub, not the plugin).
    const inbox = await call('check_inbox');
    expect(JSON.parse((inbox.content[0] as Block).text)).toMatchObject([{ text: 'ping' }]);
    expect(inbox.content).toHaveLength(2);
    expect((inbox.content[1] as Block).text).toMatch(/only where a message asks you something/);
    expect((await call('check_inbox')).content).toHaveLength(1); // nothing new: no rule either
    expect((await call('whoami')).content).toHaveLength(1);
  });

  it('reuses the pending count across read-only calls, but not past a post that reaches the caller', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'pending-cache');
    const call = await connect(members[0]!);
    const scans = vi.spyOn(hub.chat, 'newFor');
    try {
      await call('whoami');
      await call('whoami');
      expect(scans).toHaveBeenCalledTimes(1); // the second read-only call reused the count
      await hub.send(owner, { channel: channel.id }, [{ text: 'news' }]);
      expect((await call('whoami')).content).toHaveLength(2); // the post dropped the cached 0
      await call('check_inbox');
      expect((await call('whoami')).content).toHaveLength(1); // check_inbox rescanned, so no stale note
    } finally {
      scans.mockRestore();
    }
  });

  it('looks up a channel\'s briefing and skills once per inbox call, not once per item', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'inbox-memo');
    const me = members[0]!;
    const a = await hub.send(owner, { channel: channel.id }, [{ text: 'first' }]);
    await hub.send(owner, { channel: channel.id, thread: a.message.id }, [{ text: 'in thread' }]);
    await hub.send(owner, { channel: channel.id }, [{ text: 'second' }]);
    const items = await hub.chat.newFor(me);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(new Set(items.map((i) => i.message.channelId))).toEqual(new Set([channel.id]));
    const skills = vi.spyOn(hub.registry, 'resolveAttachedSkills');
    try {
      expect(await hub.inboxView(me, items)).toHaveLength(items.length);
      expect(skills).toHaveBeenCalledTimes(1);
    } finally {
      skills.mockRestore();
    }
  });

  it('scoped check_inbox and scoped sessions get no note about other mail; full check_inbox does not rescan for one', async () => {
    const carol = (await newAgent(hub.registry, { name: 'carol', public: true })).agent;
    const call = await connect(alice);
    await hub.send(bob, { to: alice.id }, [{ text: 'from-bob' }]);
    await hub.send(carol, { to: alice.id }, [{ text: 'from-carol' }]);
    const bobDm = (await hub.chat.newFor(alice)).find((i) => i.message.parts[0]?.text === 'from-bob')!.conversation.id;
    const scoped = await call('check_inbox', { conversation: bobDm });
    expect(JSON.parse((scoped.content[0] as Block).text)).toMatchObject([{ text: 'from-bob' }]);
    // Other mail remains, but a scoped take says nothing about it: that is another session's.
    expect(scoped.content.some((c) => (c as Block).text?.includes?.('new messages in'))).toBe(false);
    // A session scoped by its header (X-Parly-Conversation) gets no note on any tool; unscoped it would.
    expect((await (await connect(alice, bobDm))('whoami')).content).toHaveLength(1);
    expect((await call('whoami')).content.some((c) => (c as Block).text === pendingNote(1))).toBe(true);
    const full = await call('check_inbox');
    expect(JSON.parse((full.content[0] as Block).text)).toMatchObject([{ text: 'from-carol' }]);
    // Full take already scanned the inbox — only the when-to-reply note, no second pending note.
    expect(full.content).toHaveLength(2);
    expect((full.content[1] as Block).text).toMatch(/only where a message asks you something/);
    expect((full.content[1] as Block).text).not.toMatch(/new messages in/);
  });

  it('unscoped check_inbox capped at max still notes remaining waiting mail', async () => {
    const carol = (await newAgent(hub.registry, { name: 'carol-cap', public: true })).agent;
    const call = await connect(alice);
    await hub.send(bob, { to: alice.id }, [{ text: 'cap-bob' }]);
    await hub.send(carol, { to: alice.id }, [{ text: 'cap-carol' }]);
    const capped = await call('check_inbox', { max: 1 });
    expect(JSON.parse((capped.content[0] as Block).text)).toHaveLength(1);
    // take stopped at max with more waiting — pending note must still fire (skipPending only when drained).
    expect(capped.content.some((c) => (c as Block).text === pendingNote(1))).toBe(true);
  });

  it('adds the delta-only reply rule to the inbox note only when threadDeltaRule is on', async () => {
    const noteFor = async (deltaHub: HubService) => {
      const sender = (await newAgent(deltaHub.registry, { name: 'sender', public: true })).agent;
      const reader = (await newAgent(deltaHub.registry, { name: 'reader', public: true })).agent;
      await deltaHub.send(sender, { to: reader.id }, [{ text: 'ping' }]);
      const server = buildServer(deltaHub, reader);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(clientSide);
      const inbox = (await client.callTool({ name: 'check_inbox', arguments: {} })) as CallToolResult;
      return (inbox.content[1] as Block).text;
    };
    expect(await noteFor(hub)).not.toMatch(/post only the delta/); // default off
    const onHub = createHub({ db: testDb(), config: { ...testConfig(), threadDeltaRule: true } });
    expect(await noteFor(onHub)).toMatch(/post only the delta/);
  });

  it('tells an agent that posts in a public channel that anyone can read it', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'mcp-public', ['poster']);
    const call = await connect(members[0]);
    const say = async () => JSON.parse(((await call('send_message', { channel: channel.id, text: 'hi', wait: false })).content[0] as Block).text);
    expect((await say()).public).toBeUndefined();
    const made = await (await connect(owner))('update_channel', { channel: channel.id, public: true });
    expect(JSON.parse((made.content[0] as Block).text)).toMatchObject({ public: true });
    expect(await say()).toMatchObject({ public: true, publicNote: expect.stringMatching(/anyone on the internet/) });
  });

  it("gives the channel's context with inbox items and read_thread; an owner sets it with update_channel", async () => {
    const { owner, channel, members } = await crew(hub.registry, 'mcp-context', ['reader']);
    const ownerCall = await connect(owner);
    const set = await ownerCall('update_channel', { channel: channel.id, context: 'For the store: repo malachico/solo-founder-os' });
    expect(JSON.parse((set.content[0] as Block).text)).toMatchObject({ context: 'For the store: repo malachico/solo-founder-os' });
    const post = JSON.parse(((await ownerCall('send_message', { channel: channel.id, text: 'go', wait: false })).content[0] as Block).text);
    const reader = await connect(members[0]);
    const inbox = JSON.parse(((await reader('check_inbox')).content[0] as Block).text);
    expect(inbox[0]).toMatchObject({ channelContext: 'For the store: repo malachico/solo-founder-os', channelContextNote: expect.stringMatching(/background/) });
    const raw = ((await reader('read_thread', { channel: channel.id, thread: post.message.id })).content[0] as Block).text;
    const thread = JSON.parse(raw);
    expect(thread[0]).toMatchObject({ channelContext: 'For the store: repo malachico/solo-founder-os' });
  });

  it('sends the channel context and the when-to-reply note once per conversation, and again when the context changes', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'mcp-once', ['reader']);
    const ownerCall = await connect(owner);
    await ownerCall('update_channel', { channel: channel.id, context: 'v1' });
    const skill = JSON.parse(((await ownerCall('create_skill', { name: 'Runbook', description: 'Triage steps', instructions: '# Runbook' })).content[0] as Block).text);
    await ownerCall('attach_skill', { scope: 'channel', id: channel.id, skillId: skill.id });
    const post = JSON.parse(((await ownerCall('send_message', { channel: channel.id, text: 'go', wait: false })).content[0] as Block).text);
    const reader = await connect(members[0]);
    await reader('check_inbox'); // the post itself is the channel's conversation; its thread is another
    await ownerCall('send_message', { channel: channel.id, thread: post.message.id, text: 'first', wait: false });
    const first = await reader('check_inbox');
    expect(JSON.parse((first.content[0] as Block).text)[0]).toMatchObject({ text: 'first', channelContext: 'v1', skills: expect.arrayContaining([expect.objectContaining({ name: 'Runbook' })]) });
    expect(first.content).toHaveLength(2); // the when-to-reply note
    await ownerCall('send_message', { channel: channel.id, thread: post.message.id, text: 'more', wait: false });
    const again = await reader('check_inbox');
    const item = JSON.parse((again.content[0] as Block).text)[0];
    expect(item.text).toBe('more');
    expect(item.channelContext).toBeUndefined();
    expect(item.skills).toBeUndefined();
    expect(again.content).toHaveLength(1);
    await ownerCall('update_channel', { channel: channel.id, context: 'v2' });
    await ownerCall('send_message', { channel: channel.id, thread: post.message.id, text: 'changed', wait: false });
    const changed = await reader('check_inbox');
    expect(JSON.parse((changed.content[0] as Block).text)[0]).toMatchObject({ channelContext: 'v2' });
    expect(changed.content).toHaveLength(2);
  });

  it('lets an agent schedule a message for its owner, and list it', async () => {
    const { channel, members } = await crew(hub.registry, 'mcp-schedule', ['planner']);
    const call = await connect(members[0]);
    const made = await call('schedule_message', { channel: channel.id, text: '@planner check the CI', repeat: 'weekdays', time: '09:00', tz: 'Asia/Bangkok' });
    expect(made.isError).toBeFalsy();
    expect(JSON.parse((made.content[0] as Block).text)).toMatchObject({ when: 'Weekdays at 09:00 (Asia/Bangkok)', active: true });
    const listed = JSON.parse(((await call('list_schedules', { channel: channel.id })).content[0] as Block).text);
    expect(listed.map((x: { text: string }) => x.text)).toEqual(['@planner check the CI']);
  });

  it('a bot its owner connected a wake to keeps its name, whoever signs in as it', async () => {
    const { members } = await crew(hub.registry, 'mcp-wake');
    const bot = await hub.registry.setWake(members[0]!, { type: 'webhook', url: 'https://hooks.example.com/grok' });
    const call = await connect(bot);
    const renamed = await call('register_agent', { name: "Someone's Cursor" });
    expect(renamed.isError).toBe(true);
    expect((renamed.content[0] as Block).text).toContain(`You keep the name ${bot.name}`);
    expect((await hub.registry.get(bot.id))!.name).toBe(bot.name);
    expect((await call('register_agent', { name: bot.name, description: 'same name' })).isError).toBeFalsy();
  });

  it('updates the caller\'s registration (never creates one), and refuses anonymous calls', async () => {
    const call = await connect(alice);
    await hub.send(bob, { to: alice.id }, [{ text: 'again' }]);
    const re = await call('register_agent', { name: 'alice', public: true });
    expect(JSON.parse((re.content[0] as Block).text)).toMatchObject({ agent: { id: alice.id }, note: 'Registration updated.' });
    expect(re.content).toHaveLength(2);
    await hub.chat.take(alice);

    const anon = await connect(undefined);
    const refused = await anon('whoami');
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as Block).text).toMatch(/not identified/);
  });

  it('returns tool errors as a single readable block', async () => {
    const call = await connect(alice);
    await hub.send(bob, { to: alice.id }, [{ text: 'pending while erroring' }]);
    const bad = await call('reply', { messageId: 'nope', text: 'x' });
    expect(bad.isError).toBe(true);
    expect(bad.content).toHaveLength(1);
    await hub.chat.take(alice);
  });

  it("cloud agents can read and write a room's shared document (hosted room agents agree through it)", async () => {
    const names = (await listMcpTools(hub)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['room_document', 'update_room_document']));
  });

  it("cloud agents' in-process tools include setting up their own triggers and loading skills", async () => {
    const names = (await listMcpTools(hub)).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'find_triggers',
        'watch',
        'watching',
        'stop_watching',
        'reply',
        'create_skill',
        'update_skill',
        'delete_skill',
        'attach_skill',
        'detach_skill',
        'list_skills',
        'get_skill',
      ]),
    );
    // The owner's instruction goes along with watch.
    expect(Object.keys(((await listMcpTools(hub)).find((t) => t.name === 'watch')!.inputSchema as { properties: object }).properties)).toContain('task');
  });

  it('creates, updates, attaches, lists, and loads first-class skills across workspace -> channel -> agent scopes', async () => {
    const { owner, workspace, channel, members } = await crew(hub.registry, 'mcp-skills', ['worker']);
    const worker = members[0]!;
    const ownerCall = await connect(owner);
    const workerCall = await connect(worker);

    // Non-owner cannot create a skill attached to a channel or workspace they don't own.
    const unauthorizedCreate = await workerCall('create_skill', {
      name: 'Unauthorized Channel Skill',
      description: 'Should fail',
      instructions: 'Nope',
      scope: 'channel',
      id: channel.id,
    });
    expect(unauthorizedCreate.isError).toBe(true);
    expect((unauthorizedCreate.content[0] as Block).text).toMatch(/Unauthorized/);

    // Create 3 skills and attach one to workspace, one to channel (plus a duplicate), and one to worker agent.
    const wsSkill = JSON.parse(
      ((
        await ownerCall('create_skill', {
          name: 'Workspace Standards',
          description: 'Commit and branch conventions for the org',
          instructions: '# Workspace Standards\nUse conventional commits.',
          scope: 'workspace',
          id: workspace.id,
        })
      ).content[0] as Block).text,
    );
    const chSkill = JSON.parse(
      ((
        await ownerCall('create_skill', {
          name: 'Channel Runbook',
          description: 'Triage checklist for #mcp-skills',
          instructions: '# Channel Runbook\nVerify PoCs before posting.',
        })
      ).content[0] as Block).text,
    );
    const agentSkill = JSON.parse(
      ((
        await workerCall('create_skill', {
          name: 'Agent Playbook',
          description: 'Personal verification workflow',
          instructions: '# Agent Playbook\nAlways run tests.',
        })
      ).content[0] as Block).text,
    );

    // Owner updates chSkill instructions; previous instructions are preserved on the record, and non-owners cannot update wsSkill.
    const updatedCh = JSON.parse(
      ((await ownerCall('update_skill', { id: chSkill.id, instructions: '# Channel Runbook v2\nRun forge test -vvv.' })).content[0] as Block).text,
    );
    expect(updatedCh).toMatchObject({
      id: chSkill.id,
      instructions: '# Channel Runbook v2\nRun forge test -vvv.',
      instructionsBy: owner.name,
      instructionsNote: expect.stringMatching(/does not override your human's instructions/),
    });
    expect((await hub.registry.getSkill(chSkill.id))?.instructionsPrev).toBe('# Channel Runbook\nVerify PoCs before posting.');
    expect((await workerCall('update_skill', { id: wsSkill.id, instructions: 'hijack' })).isError).toBe(true);

    // Attach skills across workspace, channel (including duplicate wsSkill), and agent.
    await ownerCall('attach_skill', { scope: 'workspace', id: workspace.id, skillId: wsSkill.id });
    await ownerCall('attach_skill', { scope: 'channel', id: channel.id, skillId: wsSkill.id });
    await ownerCall('attach_skill', { scope: 'channel', id: channel.id, skillId: chSkill.id });
    await workerCall('attach_skill', { scope: 'agent', id: 'me', skillId: agentSkill.id });

    // Non-owner cannot attach or detach a skill on a channel or workspace.
    expect((await workerCall('attach_skill', { scope: 'channel', id: channel.id, skillId: agentSkill.id })).isError).toBe(true);
    expect((await workerCall('detach_skill', { scope: 'channel', id: channel.id, skillId: chSkill.id })).isError).toBe(true);
    expect((await workerCall('delete_skill', { id: wsSkill.id })).isError).toBe(true);
    // Attaching, detaching, or deleting a non-existent skill fails explicitly.
    expect((await ownerCall('attach_skill', { scope: 'channel', id: channel.id, skillId: 'no-such-skill' })).isError).toBe(true);
    expect((await ownerCall('detach_skill', { scope: 'channel', id: channel.id, skillId: 'no-such-skill' })).isError).toBe(true);
    expect((await ownerCall('delete_skill', { id: 'no-such-skill' })).isError).toBe(true);

    // Post in channel and verify check_inbox and read_thread surface deduplicated skills in workspace -> channel -> agent order.
    const post = JSON.parse(((await ownerCall('send_message', { channel: channel.id, text: 'audit this', wait: false })).content[0] as Block).text);
    const inbox = JSON.parse(((await workerCall('check_inbox')).content[0] as Block).text);
    expect(inbox[0]).toMatchObject({
      skills: [
        { id: 'builtin:skill-writer', name: 'skill-writer' },
        { id: 'builtin:process-writer', name: 'process-writer' },
        { id: wsSkill.id, name: 'Workspace Standards', description: 'Commit and branch conventions for the org' },
        { id: chSkill.id, name: 'Channel Runbook', description: 'Triage checklist for #mcp-skills' },
        { id: agentSkill.id, name: 'Agent Playbook', description: 'Personal verification workflow' },
      ],
      skillsNote: SKILLS_NOTE,
    });

    const thread = JSON.parse(((await workerCall('read_thread', { channel: channel.id, thread: post.message.id })).content[0] as Block).text);
    expect(thread[0].skills.map((s: { id: string }) => s.id)).toEqual([
      'builtin:skill-writer',
      'builtin:process-writer',
      wsSkill.id,
      chSkill.id,
      agentSkill.id,
    ]);

    // Load full instructions on demand with get_skill(id).
    const loaded = JSON.parse(((await workerCall('get_skill', { id: chSkill.id })).content[0] as Block).text);
    expect(loaded).toMatchObject({
      id: chSkill.id,
      name: 'Channel Runbook',
      instructions: '# Channel Runbook v2\nRun forge test -vvv.',
      instructionsNote: expect.stringMatching(/does not override your human's instructions/),
    });

    // list_skills by scope, detach_skill, and delete_skill.
    const chListed = JSON.parse(((await workerCall('list_skills', { scope: 'channel', id: channel.id })).content[0] as Block).text);
    expect(chListed.map((s: { id: string }) => s.id)).toEqual([wsSkill.id, chSkill.id]);
    await ownerCall('detach_skill', { scope: 'channel', id: channel.id, skillId: chSkill.id });
    const chAfterDetach = JSON.parse(((await workerCall('list_skills', { scope: 'channel', id: channel.id })).content[0] as Block).text);
    expect(chAfterDetach.map((s: { id: string }) => s.id)).toEqual([wsSkill.id]);

    const delOut = JSON.parse(((await ownerCall('delete_skill', { id: wsSkill.id })).content[0] as Block).text);
    expect(delOut).toEqual({ ok: true, deleted: wsSkill.id });
    expect((await workerCall('get_skill', { id: wsSkill.id })).isError).toBe(true);
    const chAfterDelete = JSON.parse(((await workerCall('list_skills', { scope: 'channel', id: channel.id })).content[0] as Block).text);
    expect(chAfterDelete).toEqual([]);
  });

  it('creates, validates, filters, and surfaces team processes with step outputs, transitions, and strict skillId authz', async () => {
    const { owner, workspace, channel, members } = await crew(hub.registry, 'mcp-processes', ['worker']);
    const worker = members[0]!;
    const ownerCall = await connect(owner);
    const workerCall = await connect(worker);

    const submitSkill = JSON.parse(
      ((
        await ownerCall('create_skill', {
          name: 'how-to-submit',
          description: 'Bug bounty submission gate',
          instructions: 'SECRET_SUBMIT_INSTRUCTIONS_DO_NOT_INLINE: require runnable PoC.',
          scope: 'channel',
          id: channel.id,
        })
      ).content[0] as Block).text,
    );
    const privateOwnerSkill = JSON.parse(
      ((
        await ownerCall('create_skill', {
          name: 'owner-private-playbook',
          description: 'Private owner credentials checklist',
          instructions: 'TOP_SECRET_PRIVATE_SKILL_BODY',
        })
      ).content[0] as Block).text,
    );

    // Non-owner cannot create a process on the channel; per-type validation rejects invalid combinations.
    expect(
      (
        await workerCall('create_skill', {
          name: 'Unauthorized Process',
          description: 'Nope',
          type: 'process',
          steps: [{ role: 'auditor', action: 'Scan repo' }],
          scope: 'channel',
          id: channel.id,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await ownerCall('create_skill', {
          name: 'Contradictory Skill',
          description: 'Has both',
          type: 'skill',
          instructions: 'Some instructions',
          steps: [{ role: 'dev', action: 'Build' }],
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await ownerCall('create_skill', {
          name: 'Contradictory Process',
          description: 'Has instructions',
          type: 'process',
          instructions: 'Not allowed on process',
          steps: [{ role: 'dev', action: 'Build' }],
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await ownerCall('create_skill', {
          name: 'Empty Process',
          description: 'No steps',
          type: 'process',
          steps: [],
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await ownerCall('create_skill', {
          name: 'Bad Ref Process',
          description: 'Missing skillId',
          type: 'process',
          steps: [{ role: 'auditor', action: 'Audit', skillId: 'no-such-skill-id' }],
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await workerCall('create_skill', {
          name: 'Worker Process Linking Private Skill',
          description: 'Worker cannot link owner private skill',
          type: 'process',
          steps: [{ role: 'auditor', action: 'Use secret skill', skillId: privateOwnerSkill.id }],
        })
      ).isError,
    ).toBe(true);

    const bountyProcess = JSON.parse(
      ((
        await ownerCall('create_skill', {
          name: 'find-and-submit-bounty',
          description: 'End-to-end security research and bounty submission flow',
          type: 'process',
          scope: 'channel',
          id: channel.id,
          steps: [
            {
              order: 1,
              role: 'researcher',
              action: 'Audit target contract and send candidate in DM',
              output: 'Candidate vulnerability with file:line and hypothesis',
              transition: 'Never post vuln details in public thread; DM verifier',
            },
            {
              order: 2,
              role: 'verifier',
              action: 'Reproduce locally with runnable PoC',
              output: 'Passing exploit test proving impact',
              transition: 'If PoC fails -> return to researcher; do not proceed',
              skillId: submitSkill.id,
            },
            {
              order: 3,
              role: 'owner',
              action: 'Final account check and platform submission',
              output: 'Submitted report URL',
              transition: 'Requires human owner approval',
              skillId: privateOwnerSkill.id,
            },
          ],
        })
      ).content[0] as Block).text,
    );
    expect(bountyProcess).toMatchObject({
      name: 'find-and-submit-bounty',
      type: 'process',
      processNote: expect.stringMatching(/static recipe, not a live progress tracker/),
    });
    expect(bountyProcess.instructions).toBeUndefined();
    expect(bountyProcess.steps[1]).toMatchObject({
      order: 2,
      role: 'verifier',
      output: 'Passing exploit test proving impact',
      transition: 'If PoC fails -> return to researcher; do not proceed',
      skillId: submitSkill.id,
      skillName: 'how-to-submit',
    });

    // list_skills filters by type ('skill' vs 'process').
    const onlySkills = JSON.parse(((await workerCall('list_skills', { scope: 'channel', id: channel.id, type: 'skill' })).content[0] as Block).text);
    expect(onlySkills.map((s: { id: string; type: string }) => ({ id: s.id, type: s.type }))).toEqual([{ id: submitSkill.id, type: 'skill' }]);
    const onlyProcesses = JSON.parse(((await workerCall('list_skills', { scope: 'channel', id: channel.id, type: 'process' })).content[0] as Block).text);
    expect(onlyProcesses.map((s: { id: string; type: string }) => ({ id: s.id, type: s.type }))).toEqual([{ id: bountyProcess.id, type: 'process' }]);

    // Surfacing in check_inbox and read_thread: inline steps, no instruction leak, inaccessible skillId -> "unavailable".
    const post = JSON.parse(((await ownerCall('send_message', { channel: channel.id, text: 'start bounty hunt', wait: false })).content[0] as Block).text);
    const inboxRaw = ((await workerCall('check_inbox')).content[0] as Block).text;
    expect(inboxRaw).not.toContain('SECRET_SUBMIT_INSTRUCTIONS_DO_NOT_INLINE');
    expect(inboxRaw).not.toContain('TOP_SECRET_PRIVATE_SKILL_BODY');
    expect(inboxRaw).not.toContain('owner-private-playbook');
    const inbox = JSON.parse(inboxRaw);
    expect(inbox[0].processes).toHaveLength(1);
    expect(inbox[0].processesNote).toMatch(/static recipe/);
    expect(inbox[0].processes[0].steps).toEqual([
      {
        order: 1,
        role: 'researcher',
        action: 'Audit target contract and send candidate in DM',
        output: 'Candidate vulnerability with file:line and hypothesis',
        transition: 'Never post vuln details in public thread; DM verifier',
      },
      {
        order: 2,
        role: 'verifier',
        action: 'Reproduce locally with runnable PoC',
        output: 'Passing exploit test proving impact',
        transition: 'If PoC fails -> return to researcher; do not proceed',
        skillId: submitSkill.id,
        skillName: 'how-to-submit',
      },
      {
        order: 3,
        role: 'owner',
        action: 'Final account check and platform submission',
        output: 'Submitted report URL',
        transition: 'Requires human owner approval',
        skillId: privateOwnerSkill.id,
        skillName: 'unavailable',
      },
    ]);

    expect((await workerCall('get_skill', { id: privateOwnerSkill.id })).isError).toBe(true);
    expect((await workerCall('get_skill', { id: submitSkill.id })).isError).toBeFalsy();

    // Deleting a referenced skill degrades gracefully to skillName: "unavailable" without breaking surfacing.
    await ownerCall('delete_skill', { id: submitSkill.id });
    const thread = JSON.parse(((await workerCall('read_thread', { channel: channel.id, thread: post.message.id })).content[0] as Block).text);
    expect(thread[0].processes[0].steps[1].skillName).toBe('unavailable');
    // Once submitSkill is deleted, only workspace defaults remain in skills (bountyProcess is never double-serialized into skills);
    // detaching the workspace defaults leaves skills undefined.
    expect(thread[0].skills.map((s: { id: string }) => s.id)).toEqual(['builtin:skill-writer', 'builtin:process-writer']);
    await ownerCall('detach_skill', { scope: 'workspace', id: workspace.id, skillId: 'builtin:skill-writer' });
    await ownerCall('detach_skill', { scope: 'workspace', id: workspace.id, skillId: 'builtin:process-writer' });
    const threadNoSkills = JSON.parse(((await workerCall('read_thread', { channel: channel.id, thread: post.message.id })).content[0] as Block).text);
    expect(threadNoSkills[0].skills).toBeUndefined();

    // Fail-closed when viewer is undefined on resolveProcessSteps: referenced skill names resolve to "unavailable".
    const failClosed = await hub.registry.resolveProcessSteps(
      undefined,
      [{ order: 1, role: 'owner', action: 'Check', skillId: privateOwnerSkill.id }],
      1500,
    );
    expect(failClosed.steps[0]?.skillName).toBe('unavailable');

    // A maximum-size first step (role 100 + action 1000 + output 500 + transition 500 = 2100 chars) stays within PROCESS_SURFACE_MAX (1500).
    const maxStep = await hub.registry.resolveProcessSteps(
      owner,
      [{ order: 1, role: 'r'.repeat(100), action: 'a'.repeat(1000), output: 'o'.repeat(500), transition: 't'.repeat(500) }],
      1500,
    );
    expect(maxStep.truncated).toBe(true);
    const totalStepChars = maxStep.steps.reduce(
      (n, s) => n + s.role.length + s.action.length + (s.output?.length ?? 0) + (s.transition?.length ?? 0) + (s.skillName?.length ?? 0),
      0,
    );
    expect(totalStepChars).toBeLessThanOrEqual(1500);

    // Switching a skill to process clears instructions; switching back to skill clears steps; concurrent edits preserve the type invariant.
    const convertible = JSON.parse(
      ((
        await ownerCall('create_skill', {
          name: 'Convertible Item',
          description: 'Starts as a skill',
          instructions: 'Initial skill instructions',
        })
      ).content[0] as Block).text,
    );
    await Promise.allSettled([
      hub.registry.updateSkill(owner, convertible.id, {
        type: 'process',
        steps: [{ role: 'implementer', action: 'Write code', output: 'PR link', transition: 'All tests green' }],
      }),
      hub.registry.updateSkill(owner, convertible.id, { instructions: 'Concurrent skill edit' }),
    ]);
    const afterRace = await hub.registry.getSkill(convertible.id);
    expect(afterRace?.type === 'process' && !!afterRace.instructions && !!afterRace.steps?.length).toBe(false);

    const asProcess = JSON.parse(
      ((
        await ownerCall('update_skill', {
          id: convertible.id,
          type: 'process',
          steps: [{ role: 'implementer', action: 'Write code', output: 'PR link', transition: 'All tests green' }],
        })
      ).content[0] as Block).text,
    );
    expect(asProcess.type).toBe('process');
    expect(asProcess.instructions).toBeUndefined();
    expect((await hub.registry.getSkill(convertible.id))?.instructions).toBe('');
    expect(asProcess.steps).toHaveLength(1);

    const backToSkill = JSON.parse(
      ((
        await ownerCall('update_skill', {
          id: convertible.id,
          type: 'skill',
          instructions: 'Back to skill instructions',
        })
      ).content[0] as Block).text,
    );
    expect(backToSkill.type).toBe('skill');
    expect(backToSkill.steps).toBeUndefined();
    expect(backToSkill.instructions).toBe('Back to skill instructions');
    expect((await hub.registry.getSkill(convertible.id))?.steps).toBeUndefined();
  });

  it('attaches builtin:skill-writer and builtin:process-writer to every workspace by default with read-only protection, opt-out, and local overrides', async () => {
    const { owner: ownerA, workspace: wsA, channel: chA, members: membersA } = await crew(hub.registry, 'ws-defaults-a', ['worker-a']);
    const { owner: ownerB, workspace: wsB } = await crew(hub.registry, 'ws-defaults-b', []);
    const workerA = membersA[0]!;
    const ownerACall = await connect(ownerA);
    const workerACall = await connect(workerA);
    const ownerBCall = await connect(ownerB);

    // 1. New workspace gets both authoring skills (type: "skill") exactly once.
    expect(wsA.attachedSkills).toEqual(['builtin:skill-writer', 'builtin:process-writer']);
    const listedA = JSON.parse(((await workerACall('list_skills', { scope: 'workspace', id: wsA.id })).content[0] as Block).text);
    expect(listedA.map((s: { id: string; name: string; type: string; builtin?: boolean }) => ({ id: s.id, name: s.name, type: s.type, builtin: s.builtin }))).toEqual([
      { id: 'builtin:skill-writer', name: 'skill-writer', type: 'skill', builtin: true },
      { id: 'builtin:process-writer', name: 'process-writer', type: 'skill', builtin: true },
    ]);

    // 2. Existing workspace (missing attachedSkills in the DB) reads with the same defaults, once each.
    await db.collection('workspaces').doc(wsB.id).update({ attachedSkills: [] });
    expect((await hub.registry.workspaceById(wsB.id))?.attachedSkills).toEqual(['builtin:skill-writer', 'builtin:process-writer']);

    // 3. Compact discovery metadata is surfaced in inbox/thread; full instructions load on demand via get_skill(id).
    await ownerACall('send_message', { channel: chA.id, text: 'write a skill for us', wait: false });
    const inboxRaw = ((await workerACall('check_inbox')).content[0] as Block).text;
    expect(inboxRaw).not.toContain('# Write a reusable skill');
    expect(inboxRaw).not.toContain('# Write a team process');
    const inbox = JSON.parse(inboxRaw);
    expect(inbox[0].skills).toEqual([
      {
        id: 'builtin:skill-writer',
        name: 'skill-writer',
        description: expect.stringMatching(/^Use when creating or improving a reusable skill\./),
        type: 'skill',
      },
      {
        id: 'builtin:process-writer',
        name: 'process-writer',
        description: expect.stringMatching(/^Use when designing or revising a team process template\./),
        type: 'skill',
      },
    ]);

    const skillWriter = JSON.parse(((await workerACall('get_skill', { id: 'builtin:skill-writer' })).content[0] as Block).text);
    const processWriter = JSON.parse(((await workerACall('get_skill', { id: 'builtin:process-writer' })).content[0] as Block).text);
    expect(skillWriter).toMatchObject({
      id: 'builtin:skill-writer',
      name: 'skill-writer',
      type: 'skill',
      builtin: true,
      instructions: expect.stringContaining('# Write a reusable skill'),
    });
    expect(processWriter).toMatchObject({
      id: 'builtin:process-writer',
      name: 'process-writer',
      type: 'skill',
      builtin: true,
      instructions: expect.stringContaining('# Write a team process'),
    });

    // 4. Built-in skills are strictly read-only: Workspace A's owner cannot modify or delete them (protecting Workspace B).
    expect((await ownerACall('update_skill', { id: 'builtin:skill-writer', instructions: 'hijacked' })).isError).toBe(true);
    expect((await ownerACall('delete_skill', { id: 'builtin:skill-writer' })).isError).toBe(true);
    expect((await ownerACall('update_skill', { id: 'builtin:process-writer', instructions: 'hijacked' })).isError).toBe(true);
    expect((await ownerACall('delete_skill', { id: 'builtin:process-writer' })).isError).toBe(true);

    // 5. Explicit detach opt-out on Workspace A survives re-reads.
    const detachRes = JSON.parse(
      ((await ownerACall('detach_skill', { scope: 'workspace', id: wsA.id, skillId: 'builtin:process-writer' })).content[0] as Block).text,
    );
    expect(detachRes.attachedSkills).toEqual(['builtin:skill-writer']);
    const afterDetachList = JSON.parse(((await workerACall('list_skills', { scope: 'workspace', id: wsA.id })).content[0] as Block).text);
    expect(afterDetachList.map((s: { id: string }) => s.id)).toEqual(['builtin:skill-writer']);

    // Re-attaching clears the opt-out.
    const reattachRes = JSON.parse(
      ((await ownerACall('attach_skill', { scope: 'workspace', id: wsA.id, skillId: 'builtin:process-writer' })).content[0] as Block).text,
    );
    expect(reattachRes.attachedSkills).toEqual(['builtin:skill-writer', 'builtin:process-writer']);

    // 6. Local override: creating/attaching a custom "skill-writer" in Workspace A shadows builtin:skill-writer in Workspace A
    // without modifying the global built-in or Workspace B.
    const customOverride = JSON.parse(
      ((
        await ownerACall('create_skill', {
          name: 'skill-writer',
          description: 'Use when creating custom skills in Workspace A.',
          instructions: '# Workspace A Custom Skill Writer\nFollow org A rules.',
          scope: 'workspace',
          id: wsA.id,
        })
      ).content[0] as Block).text,
    );
    await ownerACall('update_skill', {
      id: customOverride.id,
      instructions: '# Workspace A Custom Skill Writer v2\nUpdated org A rules.',
    });

    const wsAListWithOverride = JSON.parse(((await workerACall('list_skills', { scope: 'workspace', id: wsA.id })).content[0] as Block).text);
    expect(wsAListWithOverride.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }))).toEqual([
      { id: 'builtin:process-writer', name: 'process-writer' },
      { id: customOverride.id, name: 'skill-writer' },
    ]);

    // Workspace B still sees the untouched built-in skill-writer.
    const wsBList = JSON.parse(((await ownerBCall('list_skills', { scope: 'workspace', id: wsB.id })).content[0] as Block).text);
    expect(wsBList.map((s: { id: string }) => s.id)).toEqual(['builtin:skill-writer', 'builtin:process-writer']);
    const globalSkillWriter = JSON.parse(((await ownerBCall('get_skill', { id: 'builtin:skill-writer' })).content[0] as Block).text);
    expect(globalSkillWriter.instructions).toContain('# Write a reusable skill');
    expect(globalSkillWriter.instructions).not.toContain('Workspace A Custom Skill Writer');
  });

  it("gives a computer agent its owner's apps and the link to connect one; nobody else gets those tools", async () => {
    // A computer agent of alice's, as the bearer header would identify it.
    const compi = { ...bob, id: 'compi-test', ownerId: alice.id, workspaces: ['ws-1'], hosted: { secrets: '{}' } } as AgentRecord;
    const names = async (agent: AgentRecord) => {
      const server = buildServer(hub, agent);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(c);
      return (await client.listTools()).tools.map((t) => t.name);
    };
    expect(await names(compi)).toEqual(expect.arrayContaining(['find_tools', 'run_tool', 'connect_app']));
    // Any agent alice owns (say her Claude Code, a mailbox bot) gets them too; a person, or a bot nobody owns, doesn't.
    expect(await names({ ...bob, id: 'cc-test', kind: 'mailbox', ownerId: alice.id } as AgentRecord)).toContain('run_tool');
    expect(await names(await testPerson(hub.registry, 'tools-person'))).not.toContain('find_tools');
    expect(await names({ ...bob, kind: 'mailbox', ownerId: undefined } as AgentRecord)).not.toContain('find_tools');

    const composio = hub.composio;
    hub.composio = { accounts: async () => [] } as unknown as typeof hub.composio;
    try {
      const call = await connect(compi);
      const link = JSON.parse(((await call('connect_app', { app: 'github' })).content[0] as Block).text);
      expect(link.link).toContain(`/agents/${compi.id}#tools`);
      // Nothing turned on for it: find_tools says where to connect, instead of failing blind.
      const found = JSON.parse(((await call('find_tools', { query: 'list issues' })).content[0] as Block).text);
      expect(found).toMatchObject({ ok: false });
      expect(found.error).toContain(link.link);
    } finally {
      hub.composio = composio;
    }
  });
});
