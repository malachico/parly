import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { HubService } from '../src/hub/hubService.js';
import { crew, testConfig, testDb, testPerson, freePort } from './helpers.js';

describe('skills & processes REST API', () => {
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

  it('supports Library CRUD, readOnly built-ins, whereUsed counts/targets, and process step skillName resolution', async () => {
    const { owner, workspace, channel } = await crew(hub.registry, 'rest-skills-lib', []);
    const { agent: ownerBot, token: ownerToken } = await hub.registry.createBot(owner, { name: 'rest-skills-owner-bot', follow: true });
    await hub.registry.addToWorkspace(owner, workspace.id, ownerBot.id);
    await hub.registry.addToChannel(owner, channel.id, ownerBot.id);
    await hub.registry.addWorkspaceOwner(owner, workspace.id, ownerBot.id);

    const { agent: memberBot, token: memberToken } = await hub.registry.createBot(await testPerson(hub.registry, 'rest-skills-member'), {
      name: 'rest-skills-member-bot',
      public: true,
    });
    await hub.registry.addToWorkspace(owner, workspace.id, memberBot.id);
    await hub.registry.addToChannel(owner, channel.id, memberBot.id);

    const initialCatalog = await call(ownerToken, 'GET', '/me/skills');
    expect(initialCatalog.status).toBe(200);
    const skillWriter = initialCatalog.body.find((s: any) => s.id === 'builtin:skill-writer');
    expect(skillWriter).toMatchObject({
      id: 'builtin:skill-writer',
      name: 'skill-writer',
      type: 'skill',
      builtin: true,
      readOnly: true,
      whereUsed: {
        workspaces: expect.arrayContaining([{ id: workspace.id, name: workspace.name }]),
      },
    });
    expect(skillWriter.whereUsed.counts.workspaces).toBeGreaterThanOrEqual(1);

    expect((await call(ownerToken, 'PATCH', '/me/skills/builtin:skill-writer', { name: 'hacked' })).status).toBe(403);
    expect((await call(ownerToken, 'DELETE', '/me/skills/builtin:skill-writer')).status).toBe(403);

    const validSkill = await call(ownerToken, 'POST', '/me/skills', {
      name: 'PR Review Guide',
      description: 'Use when reviewing pull requests in this repo.',
      type: 'skill',
      instructions: '# PR Review\nAlways check the real diff.',
      scope: 'agent',
      id: ownerBot.id,
    });
    expect(validSkill.status).toBe(201);
    expect(validSkill.body).toMatchObject({
      name: 'PR Review Guide',
      type: 'skill',
      instructions: '# PR Review\nAlways check the real diff.',
      readOnly: false,
      whereUsed: {
        agents: [{ id: ownerBot.id, name: ownerBot.name }],
        channels: [],
        workspaces: [],
        counts: { agents: 1, channels: 0, workspaces: 0, total: 1 },
      },
    });
    const skillId = validSkill.body.id as string;

    const createdProc = await call(ownerToken, 'POST', '/me/skills', {
      name: 'Ship Feature',
      description: 'Use when shipping a feature from scope to deploy.',
      type: 'process',
      steps: [
        { order: 1, role: 'implementer', action: 'Open PR with tests', output: 'PR link', transition: 'CI green' },
        { order: 2, role: 'reviewer', action: 'Review diff', output: 'Approval', transition: 'Approved', skillId },
      ],
      scope: 'channel',
      id: channel.id,
    });
    expect(createdProc.status).toBe(201);
    expect(createdProc.body.steps[1]).toMatchObject({
      order: 2,
      role: 'reviewer',
      skillId,
      skillName: 'PR Review Guide',
    });
    // Zod at the REST edge: malformed steps are 400 before registry create.
    const badSteps = await call(ownerToken, 'POST', '/me/skills', {
      name: 'Bad Process',
      description: 'rejects bad steps',
      type: 'process',
      steps: [{ role: 1, action: 'x' }],
    });
    expect(badSteps.status).toBe(400);
    expect(String(badSteps.body.error ?? badSteps.body.message ?? '')).toMatch(/string|Invalid|role/i);
    const procId = createdProc.body.id as string;

    const onlyProcs = await call(ownerToken, 'GET', '/me/skills?type=process');
    expect(onlyProcs.status).toBe(200);
    expect(onlyProcs.body.map((p: any) => p.id)).toEqual([procId]);

    const memberProcs = await call(memberToken, 'GET', '/me/skills?type=process');
    expect(memberProcs.status).toBe(200);
    expect(memberProcs.body[0]).toMatchObject({ id: procId, readOnly: true });

    const patchedSkill = await call(ownerToken, 'PATCH', `/me/skills/${skillId}`, {
      description: 'Updated description for PR reviews.',
      instructions: '# PR Review v2\nQuote file:line.',
    });
    expect(patchedSkill.status).toBe(200);
    expect(patchedSkill.body.instructions).toBe('# PR Review v2\nQuote file:line.');
    expect((await call(memberToken, 'PATCH', `/me/skills/${procId}`, { name: 'Hijack' })).status).toBe(403);
  });

  it('returns effective scope skills with source (builtin | workspace | channel | direct) and enabled state for detached opt-outs', async () => {
    const { owner, workspace, channel } = await crew(hub.registry, 'rest-skills-scopes', []);
    const { agent: ownerBot, token: ownerToken } = await hub.registry.createBot(owner, { name: 'rest-scope-owner-bot', follow: true });
    await hub.registry.addToWorkspace(owner, workspace.id, ownerBot.id);
    await hub.registry.addToChannel(owner, channel.id, ownerBot.id);
    await hub.registry.addWorkspaceOwner(owner, workspace.id, ownerBot.id);

    const wsSkill = (
      await call(ownerToken, 'POST', '/me/skills', {
        name: 'Org Security',
        description: 'Workspace-wide security rules.',
        instructions: 'Never post secrets.',
        scope: 'workspace',
        id: workspace.id,
      })
    ).body;
    const chProc = (
      await call(ownerToken, 'POST', '/me/skills', {
        name: 'Channel Triage',
        description: 'Channel triage workflow.',
        type: 'process',
        steps: [{ role: 'triage', action: 'Check repro' }],
        scope: 'channel',
        id: channel.id,
      })
    ).body;
    const botSkill = (
      await call(ownerToken, 'POST', '/me/skills', {
        name: 'Bot Style',
        description: 'Agent-specific style guide.',
        instructions: 'Be concise.',
      })
    ).body;

    const attachRes = await call(ownerToken, 'POST', `/agents/${ownerBot.id}/skills/${botSkill.id}`);
    expect(attachRes.status).toBe(200);
    expect(attachRes.body.attachedSkills).toContain(botSkill.id);

    const wsList = await call(ownerToken, 'GET', `/workspaces/${workspace.id}/skills`);
    expect(wsList.status).toBe(200);
    expect(wsList.body.map((e: any) => ({ id: e.skill.id, source: e.source, enabled: e.enabled }))).toEqual([
      { id: 'builtin:skill-writer', source: 'builtin', enabled: true },
      { id: 'builtin:process-writer', source: 'builtin', enabled: true },
      { id: wsSkill.id, source: 'direct', enabled: true },
    ]);

    const chList = await call(ownerToken, 'GET', `/channels/${channel.id}/skills`);
    expect(chList.status).toBe(200);
    expect(chList.body.map((e: any) => ({ id: e.skill.id, source: e.source, enabled: e.enabled }))).toEqual([
      { id: 'builtin:skill-writer', source: 'builtin', enabled: true },
      { id: 'builtin:process-writer', source: 'builtin', enabled: true },
      { id: wsSkill.id, source: 'workspace', enabled: true },
      { id: chProc.id, source: 'direct', enabled: true },
    ]);

    const agList = await call(ownerToken, 'GET', `/agents/${ownerBot.id}/skills`);
    expect(agList.status).toBe(200);
    expect(agList.body.map((e: any) => ({ id: e.skill.id, source: e.source, enabled: e.enabled }))).toEqual([
      { id: 'builtin:skill-writer', source: 'builtin', enabled: true },
      { id: 'builtin:process-writer', source: 'builtin', enabled: true },
      { id: wsSkill.id, source: 'workspace', enabled: true },
      { id: chProc.id, source: 'channel', enabled: true },
      { id: botSkill.id, source: 'direct', enabled: true },
    ]);

    // Detaching an inherited skill (wsSkill) on the agent marks it enabled: false with source: 'workspace'.
    const detachInherited = await call(ownerToken, 'DELETE', `/agents/${ownerBot.id}/skills/${wsSkill.id}`);
    expect(detachInherited.status).toBe(200);
    expect(detachInherited.body.detachedSkills).toContain(wsSkill.id);

    const agAfterOptOut = await call(ownerToken, 'GET', `/agents/${ownerBot.id}/skills`);
    expect(agAfterOptOut.body.find((e: any) => e.skill.id === wsSkill.id)).toMatchObject({
      source: 'workspace',
      enabled: false,
    });
    const resolvedOnAgent = await hub.registry.resolveAttachedSkills({
      agentId: ownerBot.id,
      channelId: channel.id,
      workspaceId: workspace.id,
    });
    expect(resolvedOnAgent.map((s) => s.id)).not.toContain(wsSkill.id);

    const reenableInherited = await call(ownerToken, 'POST', `/agents/${ownerBot.id}/skills/${wsSkill.id}`);
    expect(reenableInherited.status).toBe(200);
    const agAfterReenable = await call(ownerToken, 'GET', `/agents/${ownerBot.id}/skills`);
    expect(agAfterReenable.body.find((e: any) => e.skill.id === wsSkill.id)).toMatchObject({
      source: 'workspace',
      enabled: true,
    });

    await call(ownerToken, 'DELETE', `/agents/${ownerBot.id}/skills/${botSkill.id}`);
    const agAfterDirectDetach = await call(ownerToken, 'GET', `/agents/${ownerBot.id}/skills`);
    expect(agAfterDirectDetach.body.find((e: any) => e.skill.id === botSkill.id)).toBeUndefined();

    await call(ownerToken, 'DELETE', `/workspaces/${workspace.id}/skills/builtin:process-writer`);
    const wsAfterBuiltinDetach = await call(ownerToken, 'GET', `/workspaces/${workspace.id}/skills`);
    expect(wsAfterBuiltinDetach.body.find((e: any) => e.skill.id === 'builtin:process-writer')).toMatchObject({
      source: 'builtin',
      enabled: false,
    });

    const delRes = await call(ownerToken, 'DELETE', `/me/skills/${wsSkill.id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ ok: true, deleted: wsSkill.id });
    expect((await call(ownerToken, 'GET', `/me/skills/${wsSkill.id}`)).status).toBe(404);
  });
});
