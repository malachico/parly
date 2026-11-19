import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const CLOUD = { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } };
const TYPES = [{ slug: 'GITHUB_PULL_REQUEST_EVENT', name: 'Pull Request Event', toolkit: { slug: 'github' }, config: { properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } }];

/** A hub whose Composio knows one GitHub account and trigger type, and records what it was asked. */
async function setup() {
  const calls: string[] = [];
  const composioFetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? 'GET'} ${u.pathname.replace('/api/v3.1', '')}`);
    if (u.pathname.endsWith('/connected_accounts')) return Response.json({ items: [{ id: 'ca_gh', status: 'ACTIVE', toolkit: { slug: 'github' } }] });
    if (u.pathname.endsWith('/triggers_types')) return Response.json({ items: TYPES });
    if (u.pathname.endsWith('/upsert')) return Response.json({ trigger_id: 'ti_pr' });
    return Response.json({ status: 'deleted' });
  }) as typeof fetch;
  const cloudFetch = (async () => Response.json({ candidates: [{ content: { parts: [{ text: 'PASS' }] } }] })) as typeof fetch;
  const { hub } = createApp({ db: testDb(), config: testConfig({ cloudAgents: CLOUD, composioApiKey: 'ak_test', composioWebhookSecret: 'whsec_x' }), cloudFetch, cloudToken: async () => 'ya29.test', composioFetch });
  let person = await testPerson(hub.registry, `Shir${Math.random().toString(36).slice(2, 6)}`);
  await hub.billing.setPlan(person.id, { plan: 'pro' });
  const ws = await hub.registry.createWorkspace(person, 'team');
  const dev = await hub.registry.createChannel(person, ws.id, 'dev');
  const rev = await hub.createCloudAgent((person = (await hub.registry.get(person.id))!), { name: 'Rev', workspaceId: ws.id });
  await hub.registry.addToChannel(person, dev.id, rev.id);
  person = (await hub.registry.get(person.id))!;
  const event = (id: string, text: string) => ({ id, type: 'composio.trigger.message', metadata: { trigger_id: 'ti_pr' }, data: { action: 'opened', pull_request: { title: text } } });
  const page = async (key: string) => (await hub.chat.page(person, key, 20)).messages.filter((m) => m.meta?.webhook);
  return { hub, calls, person, dev, rev: (await hub.registry.get(rev.id))!, event, page };
}

describe('shared triggers: sources and listeners', () => {
  it('one source, listeners with their own filter, instruction and destination', async () => {
    const { hub, calls, person, dev, rev, event, page } = await setup();
    const [source, dupSource] = await Promise.all([
      hub.triggerService.ensureSource(person, { slug: 'GITHUB_PULL_REQUEST_EVENT', config: { repo: 'web', owner: 'acme' } }),
      hub.triggerService.ensureSource(person, { slug: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme', repo: 'web' } }),
    ]);
    // Concurrent or subsequent ensureSource calls with the same settings return the single active source.
    expect(dupSource.id).toBe(source.id);
    expect((await hub.triggerService.ensureSource(person, { slug: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme', repo: 'web' } })).id).toBe(source.id);
    expect(await hub.triggers.sourcesOf(person.id)).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith('/upsert'))).toHaveLength(1);

    await hub.triggerService.addListener(person, source.id, { agentId: rev.id, filter: { contains: 'billing' }, task: 'Review it' });
    await hub.triggerService.addListener(person, source.id, { channelId: dev.id });
    await expect(hub.triggerService.addListener(person, source.id, {})).rejects.toThrow(/agent, a channel/);

    expect(await hub.triggerService.onComposioEvent(event('e1', 'Fix login'))).toBe('delivered');
    expect(await hub.triggerService.onComposioEvent(event('e2', 'Billing: refunds'))).toBe('delivered');
    await hub.wakeService.idle();
    // The channel hears both, posted for the team (nobody mentioned); Rev only the billing one, with its instruction.
    const inDev = await page(`channel:${dev.id}`);
    expect(inDev.map((m) => [m.parts[0]!.text!.startsWith('⚡ Pull Request Event'), m.mentions ?? []])).toEqual([
      [true, []],
      [true, []],
    ]);
    const dm = await page(`dm:${[person.id, rev.id].sort().join('_')}`);
    expect(dm).toHaveLength(1);
    expect(dm[0]!.parts[0]!.text).toMatch(/From me, your owner, what to do with it: Review it\n<<<event\n[\s\S]*Billing: refunds[\s\S]*\nevent>>>$/);
    const [mine] = await hub.triggerService.mySources(person);
    expect(mine!.fired).toBe(2);
    expect(mine!.listeners.map((l) => l.delivered ?? 0).sort()).toEqual([1, 2]);
    // Each listener's history says what became of every event: Rev's filter skipped the first one.
    const revListener = mine!.listeners.find((l) => l.agentId === rev.id)!;
    expect((await hub.listenerHistory(person, source.id, revListener.id)).map((h) => h.outcome)).toEqual(['delivered', 'filtered']);
    // The agent card still reads its own listener as one trigger.
    expect((await hub.triggerService.agentTriggers(person, rev.id)).map((t) => [t.label, t.filter, t.task])).toEqual([['Pull Request Event', { contains: 'billing' }, 'Review it']]);
  });

  it('checks membership when delivering, not only when set up; archive keeps history, restore re-checks', async () => {
    const { hub, calls, person, dev, rev, event, page } = await setup();
    const source = await hub.triggerService.ensureSource(person, { slug: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme', repo: 'web' } });
    const teamOnly = await hub.triggerService.addListener(person, source.id, { channelId: dev.id });
    const revInDev = await hub.triggerService.addListener(person, source.id, { agentId: rev.id, channelId: dev.id });
    // Rev leaves #dev: its listener is skipped (no DM fallback, review #30); the channel-only listener keeps posting.
    await hub.registry.removeFromChannel(person, dev.id, rev.id);
    expect(await hub.triggerService.onComposioEvent(event('e1', 'One'))).toBe('delivered');
    await hub.wakeService.idle();
    expect(await page(`channel:${dev.id}`)).toHaveLength(1);
    expect(await page(`dm:${[person.id, rev.id].sort().join('_')}`)).toHaveLength(0);
    expect((await hub.listenerHistory(person, source.id, revInDev.id)).map((h) => [h.outcome, h.why])).toEqual([['skipped', 'its agent left the channel']]);

    // Turned off: kept, with its listeners and their counts; Composio stops watching; nothing more is delivered.
    await hub.triggerService.archiveSource(person, source.id);
    expect(calls).toContain('DELETE /trigger_instances/manage/ti_pr');
    expect(await hub.triggerService.onComposioEvent(event('e2', 'Two'))).toBe('ignored');
    const [off] = await hub.triggerService.mySources(person);
    expect(off!.archivedAt).toBeTruthy();
    expect(off!.listeners.map((l) => [l.id, l.enabled, l.delivered ?? 0])).toEqual(expect.arrayContaining([[teamOnly.id, false, 1], [revInDev.id, false, 0]]));
    expect(await hub.triggerService.agentTriggers(person, rev.id)).toEqual([]);

    // Back on: Composio watches again; Rev, archived since, stays off; the team listener comes back.
    await hub.registry.setArchived(person, rev.id, true);
    const restored = await hub.triggerService.restoreSource(person, source.id);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.listeners.map((l) => [l.id, l.enabled]).sort()).toEqual([[teamOnly.id, true], [revInDev.id, false]].sort());
    expect(calls.filter((c) => c.endsWith('/upsert'))).toHaveLength(2);
    // Turning Rev's listener back on by hand checks the same: its agent is archived, so no.
    await expect(hub.triggerService.updateListener(person, source.id, revInDev.id, { enabled: true })).rejects.toThrow(/archived/);
  });

  it('turning the last listener off archives the source and releases Composio; the old routes still work', async () => {
    const { hub, calls, person, rev } = await setup();
    const t = await hub.triggerService.createTrigger(person, rev.id, { slug: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme', repo: 'web' }, contains: 'fix' });
    expect(t).toMatchObject({ agentId: rev.id, label: 'Pull Request Event', filter: { contains: 'fix' } });
    await hub.triggerService.deleteTrigger(person, rev.id, t.id);
    expect(calls).toContain('DELETE /trigger_instances/manage/ti_pr');
    const [source] = await hub.triggerService.mySources(person);
    expect(source!.archivedAt).toBeTruthy();
    expect(source!.listeners[0]!.enabled).toBe(false);
  });

  it('a failed Composio upsert leaves no source row, so a later ensureSource can register', async () => {
    let upserts = 0;
    const composioFetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/connected_accounts')) return Response.json({ items: [{ id: 'ca_gh', status: 'ACTIVE', toolkit: { slug: 'github' } }] });
      if (u.pathname.endsWith('/triggers_types')) return Response.json({ items: TYPES });
      if (u.pathname.endsWith('/upsert')) {
        upserts += 1;
        if (upserts === 1) return new Response('boom', { status: 500 });
        return Response.json({ trigger_id: 'ti_pr' });
      }
      return Response.json({ status: 'deleted' });
    }) as typeof fetch;
    const cloudFetch = (async () => Response.json({ candidates: [{ content: { parts: [{ text: 'PASS' }] } }] })) as typeof fetch;
    const { hub } = createApp({ db: testDb(), config: testConfig({ cloudAgents: CLOUD, composioApiKey: 'ak_test', composioWebhookSecret: 'whsec_x' }), cloudFetch, cloudToken: async () => 'ya29.test', composioFetch });
    const person = await testPerson(hub.registry, `Fail${Math.random().toString(36).slice(2, 6)}`);
    await hub.billing.setPlan(person.id, { plan: 'pro' });
    await expect(hub.triggerService.ensureSource(person, { slug: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme', repo: 'web' } })).rejects.toThrow();
    expect(await hub.triggers.sourcesOf(person.id)).toHaveLength(0);
    const source = await hub.triggerService.ensureSource(person, { slug: 'GITHUB_PULL_REQUEST_EVENT', config: { owner: 'acme', repo: 'web' } });
    expect(source.composioId).toBe('ti_pr');
    expect(await hub.triggers.sourcesOf(person.id)).toHaveLength(1);
    expect(upserts).toBe(2);
  });

});
