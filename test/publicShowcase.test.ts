import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createHub } from '../src/app.js';
import { BILLING, CREDIT_MICROS } from '../src/billing/billing.js';
import { threadKey } from '../src/chat/chat.js';
import { MemoryFileStore } from '../src/files/store.js';
import type { HubService } from '../src/hub/hubService.js';
import { crewOverHttp, newAgentOverHttp, testConfig, testDb, testPerson, freePort, httpCaller } from './helpers.js';

describe('public showcase workspace v1', () => {
  let hubUrl: string;
  let server: Server;
  let hub: HubService;

  const call = httpCaller(() => hubUrl);

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    const built = createApp({
      db: testDb(),
      config: testConfig({ port, publicUrl: hubUrl }),
      fileStore: new MemoryFileStore(),
    });
    hub = built.hub;
    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(port, '127.0.0.1', () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('requires publicShowcase: true + public + open for self-join, and is idempotent when already joined', async () => {
    const showcaseBot = await newAgentOverHttp(hubUrl, { name: 'ShowcaseHostBot' });
    const ownerToken = showcaseBot.owner.token;
    const { workspaceId, channelId } = await crewOverHttp(hubUrl, [showcaseBot], 'arena');

    // Make #arena public + open, but workspace is NOT publicShowcase yet.
    expect((await call(ownerToken, 'PATCH', `/channels/${channelId}`, { public: true, open: true })).status).toBe(200);

    // Non-showcase public channel response stays minimal and cannot be self-joined.
    const pubBefore = await call(undefined, 'GET', `/public/channels/${channelId}`);
    expect(pubBefore.status).toBe(200);
    expect(pubBefore.json.channel).toEqual({ id: channelId, name: 'arena' });

    const visitor = await newAgentOverHttp(hubUrl, { name: 'VisitorBot' });
    const visitorHumanToken = visitor.owner.token;
    const visitorHumanId = visitor.owner.id;

    // Outside human cannot self-join when workspace.publicShowcase is not true.
    expect((await call(visitorHumanToken, 'POST', `/channels/${channelId}/join`)).status).toBe(404);

    // Non-owner cannot enable publicShowcase on the workspace.
    expect((await call(visitorHumanToken, 'PUT', `/workspaces/${workspaceId}/showcase`, { publicShowcase: true })).status).toBe(404);

    // Owner enables publicShowcase: true.
    const enabled = await call(ownerToken, 'PUT', `/workspaces/${workspaceId}/showcase`, { publicShowcase: true });
    expect(enabled.status).toBe(200);
    expect(enabled.json.publicShowcase).toBe(true);

    // Public channel endpoint now advertises selfJoin metadata.
    const pubAfter = await call(undefined, 'GET', `/public/channels/${channelId}`);
    expect(pubAfter.status).toBe(200);
    expect(pubAfter.json.channel).toEqual({
      id: channelId,
      name: 'arena',
      workspaceId,
      open: true,
      publicShowcase: true,
      selfJoin: true,
    });

    // If channel is closed (open: false), self-join is refused and selfJoin is false.
    await call(ownerToken, 'PATCH', `/channels/${channelId}`, { open: false });
    expect((await call(undefined, 'GET', `/public/channels/${channelId}`)).json.channel.selfJoin).toBe(false);
    expect((await call(visitorHumanToken, 'POST', `/channels/${channelId}/join`)).status).toBe(404);

    // Re-open channel; bots still cannot self-join, only humans.
    await call(ownerToken, 'PATCH', `/channels/${channelId}`, { open: true });
    expect((await call(visitor.token, 'POST', `/channels/${channelId}/join`)).status).toBe(404);

    // Signed-in human self-joins #arena and becomes a participate-only guest in the workspace + channel.
    const joined = await call(visitorHumanToken, 'POST', `/channels/${channelId}/join`);
    expect(joined.status).toBe(200);
    expect(joined.json).toMatchObject({ id: channelId, workspaceId, name: 'arena', owner: false });

    // Idempotent second call succeeds without error or duplicate entries.
    const joinedAgain = await call(visitorHumanToken, 'POST', `/channels/${channelId}/join`);
    expect(joinedAgain.status).toBe(200);
    const freshVisitor = (await hub.registry.get(visitorHumanId))!;
    expect(freshVisitor.workspaces?.filter((w) => w === workspaceId)).toHaveLength(1);
    expect(freshVisitor.channels?.filter((c) => c === channelId)).toHaveLength(1);

    // Guest can read and post in the joined showcase channel and reply in threads.
    const postRes = await call(visitorHumanToken, 'POST', `/conversations/channel:${channelId}/messages`, {
      text: 'Hello showcase agents!',
    });
    expect(postRes.status).toBe(201);
    const replyRes = await call(visitorHumanToken, 'POST', `/messages/${postRes.json.id}/reply`, {
      text: 'Following up in thread',
    });
    expect(replyRes.status).toBe(201);
  });

  it('enforces guest = participate-only across all workspace/channel mutations and scopes roster/search to joined channels', async () => {
    const showcaseBot = await newAgentOverHttp(hubUrl, { name: 'PublicJudgeBot' });
    const ownerToken = showcaseBot.owner.token;
    const secretBot = (await call(ownerToken, 'POST', '/agents/bots', { name: 'SecretInternalBot' })).json as { agent: { id: string; name: string } };
    const benchBot = (await call(ownerToken, 'POST', '/agents/bots', { name: 'BenchBot' })).json as { agent: { id: string; name: string } };

    const { workspaceId, channelId: publicChannelId } = await crewOverHttp(hubUrl, [showcaseBot], 'public-lounge');
    await call(ownerToken, 'POST', `/workspaces/${workspaceId}/members`, { agentId: secretBot.agent.id });
    await call(ownerToken, 'POST', `/workspaces/${workspaceId}/members`, { agentId: benchBot.agent.id });
    const secretChannel = (await call(ownerToken, 'POST', `/workspaces/${workspaceId}/channels`, { name: 'internal-ops' })).json;
    await call(ownerToken, 'POST', `/channels/${secretChannel.id}/members`, { agentId: secretBot.agent.id });

    const privateMember = await newAgentOverHttp(hubUrl, { name: 'PrivateHumanBot' });
    await call(ownerToken, 'POST', `/workspaces/${workspaceId}/invites`, { email: privateMember.owner.email });
    await call(ownerToken, 'POST', `/channels/${secretChannel.id}/members`, { agentId: privateMember.owner.id });
    await call(ownerToken, 'POST', `/workspaces/${workspaceId}/invites`, { email: 'pending-secret@example.com' });

    await call(ownerToken, 'PUT', `/workspaces/${workspaceId}/showcase`, { publicShowcase: true });
    await call(ownerToken, 'PATCH', `/channels/${publicChannelId}`, { public: true, open: true });

    const guest = await newAgentOverHttp(hubUrl, { name: 'GuestOwnedBot' });
    const guestToken = guest.owner.token;
    const guestId = guest.owner.id;
    expect((await call(guestToken, 'POST', `/channels/${publicChannelId}/join`)).status).toBe(200);

    // Every non-owner workspace/channel mutation is rejected with 403
    expect((await call(guestToken, 'POST', `/workspaces/${workspaceId}/channels`, { name: 'guest-spam' })).status).toBe(403);
    expect((await call(guestToken, 'POST', `/workspaces/${workspaceId}/invites`, { email: 'friend@example.com' })).status).toBe(403);
    expect((await call(guestToken, 'GET', `/workspaces/${workspaceId}/invites`)).status).toBe(403);
    expect((await call(guestToken, 'DELETE', `/workspaces/${workspaceId}/invites/pending-secret@example.com`)).status).toBe(403);
    expect((await call(guestToken, 'POST', `/workspaces/${workspaceId}/members`, { agentId: guest.agent.id })).status).toBe(403);
    expect((await call(guestToken, 'POST', `/channels/${publicChannelId}/members`, { agentId: guest.agent.id })).status).toBe(403);
    expect((await call(guestToken, 'PATCH', `/channels/${publicChannelId}/canvas`, { x: 100, y: 100, w: 400, h: 300 })).status).toBe(403);
    expect((await call(guestToken, 'POST', `/agents/${showcaseBot.agent.id}/archive`)).status).toBe(403);
    expect((await call(guestToken, 'PATCH', `/channels/${publicChannelId}`, { archived: true })).status).toBe(403);
    expect((await call(guestToken, 'PUT', `/workspaces/${workspaceId}/archived`, { archived: true })).status).toBe(403);
    expect((await call(guestToken, 'POST', `/channels/${publicChannelId}/webhooks`, { name: 'Hook' })).status).toBe(403);
    expect((await call(guestToken, 'POST', `/channels/${publicChannelId}/schedules`, { text: 'spam', repeat: 'daily', time: '09:00' })).status).toBe(403);

    // Non-public open channel in showcase workspace cannot be joined or listed by guest
    expect((await call(guestToken, 'POST', `/channels/${secretChannel.id}/join`)).status).toBe(404);
    const joinable = await call(guestToken, 'GET', `/workspaces/${workspaceId}/channels/joinable`);
    expect(joinable.json.map((c: any) => c.id)).not.toContain(secretChannel.id);

    const myChs = await call(guestToken, 'GET', `/workspaces/${workspaceId}/channels`);
    expect(myChs.json.map((c: any) => c.id)).toEqual([publicChannelId]);

    // Roster & search scoping to joined channels
    const wsAgents = await call(guestToken, 'GET', `/agents?workspace=${workspaceId}`);
    const wsAgentIds = wsAgents.json.map((a: any) => a.id);
    expect(wsAgentIds).toContain(showcaseBot.agent.id);
    expect(wsAgentIds).toContain(guestId);
    expect(wsAgentIds).not.toContain(secretBot.agent.id);
    expect(wsAgentIds).not.toContain(benchBot.agent.id);
    expect(wsAgentIds).not.toContain(privateMember.owner.id);

    expect((await call(guestToken, 'GET', `/agents?channel=${secretChannel.id}`)).json).toEqual([]);

    const allVisibleIds = (await call(guestToken, 'GET', '/agents')).json.map((a: any) => a.id);
    expect(allVisibleIds).toContain(showcaseBot.agent.id);
    expect(allVisibleIds).not.toContain(secretBot.agent.id);
    expect(allVisibleIds).not.toContain(benchBot.agent.id);
    expect(allVisibleIds).not.toContain(privateMember.owner.id);

    expect((await call(guestToken, 'GET', `/agents/${secretBot.agent.id}`)).status).toBe(404);
    expect((await call(guestToken, 'POST', `/conversations/agent:${secretBot.agent.id}/messages`, { text: 'hi secret' })).status).toBe(404);

    const ownerWsAgents = await call(ownerToken, 'GET', `/agents?workspace=${workspaceId}`);
    expect(ownerWsAgents.json.map((a: any) => a.id)).toEqual(
      expect.arrayContaining([showcaseBot.agent.id, secretBot.agent.id, benchBot.agent.id, privateMember.owner.id, guestId]),
    );

    // Canvas for guest only includes joined channel teams and omits `elsewhere` bench
    const guestCanvas = await call(guestToken, 'GET', `/workspaces/${workspaceId}/canvas`);
    expect(guestCanvas.status).toBe(200);
    expect(guestCanvas.json.teams.map((t: any) => t.channelId)).toEqual([publicChannelId]);
    expect(guestCanvas.json.elsewhere).toBeUndefined();

    // Guest cannot attach or create skills scoped to the public workspace or channel
    expect(
      (
        await call(guestToken, 'POST', '/me/skills', {
          name: 'GuestHijackSkill',
          description: 'Attempted hijack',
          instructions: 'Do bad things',
          scope: 'workspace',
          id: workspaceId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(guestToken, 'POST', '/me/skills', {
          name: 'GuestChannelHijackSkill',
          description: 'Attempted hijack',
          instructions: 'Do bad things',
          scope: 'channel',
          id: publicChannelId,
        })
      ).status,
    ).toBe(403);

    // Atomic "Go Public" with explicit publicChannels selection flips unselected channels to private (open: false)
    const atomicEnable = await call(ownerToken, 'PUT', `/workspaces/${workspaceId}/public`, {
      public: true,
      publicChannels: [publicChannelId],
    });
    expect(atomicEnable.status).toBe(200);
    expect(atomicEnable.json.public).toBe(true);
    const pubWsInfo = await call(undefined, 'GET', `/public/workspaces/${workspaceId}`);
    expect(pubWsInfo.status).toBe(200);
    expect(pubWsInfo.json.channels).toEqual([{ id: publicChannelId, name: 'public-lounge' }]);

    // Another visitor can join via POST /workspaces/:id/join and only enters the selected public channel
    const wsJoiner = await newAgentOverHttp(hubUrl, { name: 'WsJoinerBot' });
    const wsJoined = await call(wsJoiner.owner.token, 'POST', `/workspaces/${workspaceId}/join`);
    expect(wsJoined.status).toBe(200);
    expect(wsJoined.json.channels.map((c: any) => c.id)).toEqual([publicChannelId]);

    // Owner moderation: removing a guest from the channel bans them from re-joining that channel (or bypassing via workspace join)
    expect((await call(ownerToken, 'DELETE', `/channels/${publicChannelId}/members/${wsJoiner.owner.id}`)).status).toBe(200);
    expect((await call(wsJoiner.owner.token, 'POST', `/channels/${publicChannelId}/join`)).status).toBe(403);
    expect((await call(wsJoiner.owner.token, 'POST', `/workspaces/${workspaceId}/join`)).status).toBe(403);

    // Owner explicitly re-adding the removed member to the channel clears their channel ban
    expect((await call(ownerToken, 'POST', `/channels/${publicChannelId}/members`, { agentId: wsJoiner.owner.id })).status).toBe(200);

    // Removing a guest from the workspace bans them from re-joining the workspace or its channels
    expect((await call(ownerToken, 'DELETE', `/workspaces/${workspaceId}/members/${guestId}`)).status).toBe(200);
    expect((await call(guestToken, 'POST', `/channels/${publicChannelId}/join`)).status).toBe(403);
    expect((await call(guestToken, 'POST', `/workspaces/${workspaceId}/join`)).status).toBe(403);
  });

  it('isolates owner tools, enforces free-allowance-only (no card/top-up charges), per-visitor rate limits, and global daily spend kill-switch on public turns', async () => {
    const db = testDb();
    const calls: { system: string; declarations: string[]; responses: unknown[] }[] = [];
    let nextCallTool: { name: string; args: Record<string, unknown> } | undefined;

    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const system = body.systemInstruction?.parts?.[0]?.text ?? '';
      const declarations = (body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name);
      const lastUserParts = body.contents?.at(-1)?.parts ?? [];
      const hasFnResponse = lastUserParts.some((p: Record<string, unknown>) => 'functionResponse' in p);
      calls.push({ system, declarations, responses: lastUserParts.filter((p: Record<string, unknown>) => 'functionResponse' in p) });
      if (nextCallTool && !hasFnResponse) {
        const call = nextCallTool;
        nextCallTool = undefined;
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: call }] } }],
            usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 50 },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Showcase reply!' }] } }],
          usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100 },
        }),
      );
    }) as typeof fetch;

    const composioFetch = (async (url: string) => {
      if (url.includes('/connected_accounts')) {
        return new Response(JSON.stringify({ items: [{ id: 'acc_1', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }] }));
      }
      return new Response(JSON.stringify({ items: [] }));
    }) as typeof fetch;

    const showcaseHub = createHub({
      db,
      config: testConfig({
        cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } },
        composioApiKey: 'comp_test_key',
        llmMonthlyAllowanceUsd: 1,
        publicTurnLimitPerHour: 2,
        publicDailySpendCeilingUsd: 0.05,
      }),
      cloudFetch,
      cloudToken: async () => 'ya29.test',
      composioFetch,
    });

    let owner = await testPerson(showcaseHub.registry, 'Owner');
    const ws = await showcaseHub.registry.createWorkspace(owner, 'ShowcaseWS');
    await showcaseHub.registry.setWorkspacePublicShowcase(owner, ws.id, true);
    owner = (await showcaseHub.registry.get(owner.id))!;
    const channel = await showcaseHub.registry.createChannel(owner, ws.id, 'arena');
    await showcaseHub.registry.updateChannel(owner, channel.id, { publicFromSeq: 0, open: true });
    owner = (await showcaseHub.registry.get(owner.id))!;

    const judge = await showcaseHub.createCloudAgent(owner, {
      name: 'Judge',
      description: 'Judges pitches in public.',
      workspaceId: ws.id,
      channelId: channel.id,
    });
    await showcaseHub.setAgentTools(owner, judge.id, { toolkits: ['gmail', 'github'], act: true });

    let visitor1 = await testPerson(showcaseHub.registry, 'AliceVisitor');
    await showcaseHub.registry.joinChannel(visitor1, channel.id);
    visitor1 = (await showcaseHub.registry.get(visitor1.id))!;

    // Guest cannot create a cloud agent attached to a publicShowcase workspace
    await expect(
      showcaseHub.createCloudAgent(visitor1, { name: 'VisitorCloud', workspaceId: ws.id, channelId: channel.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const initialExtraMicros = 500 * CREDIT_MICROS;
    await db.collection(BILLING).doc(visitor1.id).set({ ownerId: visitor1.id, plan: 'pro', extraMicros: initialExtraMicros });
    // Even if visitor1 has already spent more than the $1 free allowance in their private workspaces this month,
    // public showcase turns track publicShowcaseMicros separately and are not falsely blocked.
    const period = new Date().toISOString().slice(0, 7);
    await db.collection('usage').doc(`${visitor1.id}_${period}`).set({ ownerId: visitor1.id, period, micros: 5_000_000 }, { merge: true });

    // A public-readable channel inside a private (non-public) workspace is NOT a publicShowcase turn:
    // owner's Pro plan/top-ups and tools work normally even when owner's private spend exceeds the free tier.
    await db.collection(BILLING).doc(owner.id).set({ ownerId: owner.id, plan: 'pro', extraMicros: initialExtraMicros });
    await db.collection('usage').doc(`${owner.id}_${period}`).set({ ownerId: owner.id, period, micros: 5_000_000 }, { merge: true });
    const privWs = await showcaseHub.registry.createWorkspace(owner, 'PrivateTeamWS');
    owner = (await showcaseHub.registry.get(owner.id))!;
    const pubReadOnlyCh = await showcaseHub.registry.createChannel(owner, privWs.id, 'team-dev');
    await showcaseHub.registry.updateChannel(owner, pubReadOnlyCh.id, { publicFromSeq: 0, open: true });
    owner = (await showcaseHub.registry.get(owner.id))!;
    const teamBot = await showcaseHub.createCloudAgent(owner, {
      name: 'TeamBot',
      description: 'Internal dev bot.',
      workspaceId: privWs.id,
      channelId: pubReadOnlyCh.id,
    });
    await showcaseHub.setAgentTools(owner, teamBot.id, { toolkits: ['gmail'], act: true });
    const teamPost = (await showcaseHub.send(owner, { channel: pubReadOnlyCh.id }, [{ text: '@TeamBot status check?' }])).message;
    await showcaseHub.wakeService.idle();
    const teamThread = (await showcaseHub.chat.page(owner, threadKey(pubReadOnlyCh.id, teamPost.id), 10)).messages;
    expect(teamThread.map((m) => m.parts[0]?.text)).toContain('Showcase reply!');
    expect(calls[0]!.declarations).toContain('find_tools');
    for (const write of ['send_message', 'reply', 'update_room_document']) expect(calls[0]!.declarations).toContain(write);
    // schedule_message, create_skill and watch are reached through find_tools/run_tool, not declared.
    for (const hidden of ['schedule_message', 'create_skill', 'watch']) expect(calls[0]!.declarations).not.toContain(hidden);
    calls.length = 0;

    // The showcase owner testing their own crew pays from their plan, not the free public allowance: having used
    // that allowance up ($1 here) doesn't silence the crew for them.
    await db.collection('usage').doc(`${owner.id}_${period}`).set({ publicShowcaseMicros: 2_000_000 }, { merge: true });
    const ownerPost = (await showcaseHub.send(owner, { channel: channel.id }, [{ text: '@Judge owner test run' }])).message;
    await showcaseHub.wakeService.idle();
    const ownerThread = (await showcaseHub.chat.page(owner, threadKey(channel.id, ownerPost.id), 10)).messages.map((m) => m.parts[0]?.text);
    expect(ownerThread).toContain('Showcase reply!');
    expect(ownerThread.join(' ')).not.toMatch(/allowance for public turns is used up/);
    calls.length = 0;

    nextCallTool = { name: 'run_tool', args: { tool: 'GMAIL_SEND_EMAIL', arguments: {} } };
    const post1 = (await showcaseHub.send(visitor1, { channel: channel.id }, [{ text: '@Judge hi from Alice!' }])).message;
    await showcaseHub.wakeService.idle();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.declarations).not.toContain('find_tools');
    expect(calls[0]!.declarations).not.toContain('run_tool');
    expect(calls[0]!.declarations).not.toContain('github_comment');
    // Public turn: no Parly tools at all. They run as the agent, so even reads would reach its private channels.
    for (const tool of ['parly_read_channel', 'whoami', 'read_thread', 'get_file', 'send_message', 'reply', 'schedule_message', 'update_room_document', 'create_skill', 'watch']) expect(calls[0]!.declarations).not.toContain(tool);
    expect(calls[0]!.system).not.toContain('connected accounts');

    const v1Billing = (await db.collection(BILLING).doc(visitor1.id).get()).data()!;
    expect(v1Billing.extraMicros).toBe(initialExtraMicros);
    expect(await showcaseHub.llm.publicShowcaseSpent()).toBeGreaterThan(0);

    // A visitor who talks the model into reading another channel anyway gets nothing back.
    calls.length = 0;
    nextCallTool = { name: 'parly_read_channel', args: { channel: 'Parly dev' } };
    await showcaseHub.send(visitor1, { channel: channel.id, thread: post1.id }, [{ text: '@Judge second turn' }]);
    await showcaseHub.wakeService.idle();
    expect(JSON.stringify(calls.flatMap((c) => c.responses))).toContain('Not available in a public conversation.');

    const callsBeforeRateLimit = calls.length;
    await showcaseHub.send(visitor1, { channel: channel.id, thread: post1.id }, [{ text: '@Judge third turn (rate limited)' }]);
    await showcaseHub.wakeService.idle();
    expect(calls.length).toBe(callsBeforeRateLimit);
    const threadMsgs = (await showcaseHub.chat.page(visitor1, threadKey(channel.id, post1.id), 20)).messages;
    expect(threadMsgs.map((m) => m.parts[0]?.text)).toContain(
      "You've reached the hourly limit for public showcase turns. Please wait a bit before asking again.",
    );

    let visitor2 = await testPerson(showcaseHub.registry, 'BobVisitor');
    await showcaseHub.registry.joinChannel(visitor2, channel.id);
    visitor2 = (await showcaseHub.registry.get(visitor2.id))!;

    await showcaseHub.llm.addPublicShowcaseSpend(50_000);
    const callsBeforeCeiling = calls.length;
    const post2 = (await showcaseHub.send(visitor2, { channel: channel.id }, [{ text: '@Judge hi from Bob!' }])).message;
    await showcaseHub.wakeService.idle();
    expect(calls.length).toBe(callsBeforeCeiling);
    const post2Thread = (await showcaseHub.chat.page(visitor2, threadKey(channel.id, post2.id), 10)).messages;
    expect(post2Thread.map((m) => m.parts[0]?.text)).toContain(
      "Today's free public showcase budget is used up. From your next message, your turns here use your own Parly credits.",
    );

    // Add an invited private-channel teammate and a teammate-owned bot added by the owner: neither should be evicted on disable
    let invitedTeammate = await testPerson(showcaseHub.registry, 'InvitedTeammate');
    const teammateBot = (await showcaseHub.registry.createBot(invitedTeammate, { name: 'TeammateBot', public: true })).agent;
    const internalChannel = await showcaseHub.registry.createChannel(owner, ws.id, 'internal-ops');
    await showcaseHub.registry.updateChannel(owner, internalChannel.id, { open: false });
    await showcaseHub.registry.inviteToWorkspace(owner, ws.id, invitedTeammate.email!);
    invitedTeammate = (await showcaseHub.registry.get(invitedTeammate.id))!;
    await showcaseHub.registry.addToChannel(owner, internalChannel.id, invitedTeammate.id);
    await showcaseHub.registry.addToWorkspace(owner, ws.id, teammateBot.id);
    await showcaseHub.registry.addToChannel(owner, channel.id, teammateBot.id);

    // Disabling the public workspace evicts non-owner guests (without banning them) so leftover guests cannot trigger owner-billed turns,
    // while keeping invited private-channel teammates and owner-added bots intact.
    await showcaseHub.registry.setWorkspacePublicShowcase(owner, ws.id, false);
    const freshV1 = (await showcaseHub.registry.get(visitor1.id))!;
    const freshV2 = (await showcaseHub.registry.get(visitor2.id))!;
    const freshJudge = (await showcaseHub.registry.get(judge.id))!;
    const freshTeammate = (await showcaseHub.registry.get(invitedTeammate.id))!;
    const freshTeammateBot = (await showcaseHub.registry.get(teammateBot.id))!;
    const freshWs = (await showcaseHub.registry.workspacesOf(owner)).find((w) => w.id === ws.id)!;
    expect(freshV1.workspaces ?? []).not.toContain(ws.id);
    expect(freshV1.channels ?? []).not.toContain(channel.id);
    expect(freshV2.workspaces ?? []).not.toContain(ws.id);
    expect(freshV2.channels ?? []).not.toContain(channel.id);
    expect(freshWs.bannedAgents ?? []).not.toContain(visitor1.id);
    expect(freshWs.bannedAgents ?? []).not.toContain(visitor2.id);
    // Workspace bots (both owner-owned and owner-added teammate bots) and invited private-channel teammates remain intact
    expect(freshJudge.workspaces ?? []).toContain(ws.id);
    expect(freshJudge.channels ?? []).toContain(channel.id);
    expect(freshTeammate.workspaces ?? []).toContain(ws.id);
    expect(freshTeammate.channels ?? []).toContain(internalChannel.id);
    expect(freshTeammateBot.workspaces ?? []).toContain(ws.id);
    expect(freshTeammateBot.channels ?? []).toContain(channel.id);

    // Disabling a workspace that was never public (or re-disabling an already-private workspace) does NOT evict its members
    const privateWs = await showcaseHub.registry.createWorkspace(owner, 'NeverPublicTeam');
    const privateGeneral = await showcaseHub.registry.createChannel(owner, privateWs.id, 'general');
    let normalMember = await testPerson(showcaseHub.registry, 'NormalTeamMember');
    await showcaseHub.registry.inviteToWorkspace(owner, privateWs.id, normalMember.email!);
    normalMember = (await showcaseHub.registry.get(normalMember.id))!;
    await showcaseHub.registry.addToChannel(owner, privateGeneral.id, normalMember.id);
    await showcaseHub.registry.setWorkspacePublicShowcase(owner, privateWs.id, false);
    const freshNormalMember = (await showcaseHub.registry.get(normalMember.id))!;
    expect(freshNormalMember.workspaces ?? []).toContain(privateWs.id);
    expect(freshNormalMember.channels ?? []).toContain(privateGeneral.id);

    const callsBeforeDisabledTurn = calls.length;
    await expect(showcaseHub.send(freshV1, { channel: channel.id }, [{ text: '@Judge turn after disable' }])).rejects.toThrow();
    await showcaseHub.wakeService.idle();
    expect(calls.length).toBe(callsBeforeDisabledTurn);

    // Since disable does not ban guests, re-enabling public mode allows the guest to cleanly self-join again
    await showcaseHub.registry.setWorkspacePublicShowcase(owner, ws.id, true);
    await showcaseHub.registry.joinPublicWorkspace(freshV1, ws.id);
    const rejoinedV1 = (await showcaseHub.registry.get(visitor1.id))!;
    expect(rejoinedV1.workspaces ?? []).toContain(ws.id);
    expect(rejoinedV1.channels ?? []).toContain(channel.id);
  });
});
