import { CREDIT_MICROS } from '../src/llm/llm.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testConfig, testDb, testPerson } from './helpers.js';

describe('your apps, from the apps side', () => {
  it('shows each connected app with your agents: who may use it, and how they have (count, last tool)', async () => {
    const composioFetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/connected_accounts')) return Response.json({ items: [{ id: 'ca_lin', status: 'ACTIVE', toolkit: { slug: 'linear' } }, { id: 'ca_sl', status: 'INITIATED', toolkit: { slug: 'slack' } }] });
      if (u.pathname.endsWith('/toolkits')) return Response.json({ items: [{ slug: 'linear', name: 'Linear', meta: { logo: 'https://logo.test/lin.png' }, composio_managed_auth_schemes: ['OAUTH2'] }] });
      if (u.pathname.endsWith('/tools/LINEAR_LIST_ISSUES')) return Response.json({ slug: 'LINEAR_LIST_ISSUES', description: 'List issues' });
      if (u.pathname.endsWith('/tools/execute/LINEAR_LIST_ISSUES')) return Response.json({ successful: true, data: { items: [] } });
      return Response.json({ items: [] });
    }) as typeof fetch;
    const { hub } = createApp({ db: testDb(), config: testConfig({ composioApiKey: 'ak_test', cloudAgents: { model: 'm', project: 'p', location: 'global', prices: { input: 2, output: 12 } } }), composioFetch, cloudToken: async () => 't' });
    const person = await testPerson(hub.registry, 'Yael');
    const { agent: tool } = await hub.registry.createBot(person, { name: 'MyCodex' });
    const { agent: idle } = await hub.registry.createBot(person, { name: 'Idle' });
    await hub.setAgentTools(person, tool.id, { toolkits: ['linear'], act: false });

    const out = await hub.appTool((await hub.registry.get(tool.id))!, 'run_tool', { tool: 'LINEAR_LIST_ISSUES', arguments: {} });
    expect(out).toMatchObject({ ok: true });
    await hub.appTool((await hub.registry.get(tool.id))!, 'run_tool', { tool: 'LINEAR_LIST_ISSUES', arguments: {} });

    const [linear] = await hub.myApps(person);
    expect(linear).toMatchObject({ toolkit: 'linear', name: 'Linear', logo: 'https://logo.test/lin.png', account: { id: 'ca_lin', status: 'ACTIVE' } });
    const byName = Object.fromEntries(linear!.agents.map((a) => [a.name, a]));
    expect(byName.MyCodex).toMatchObject({ enabled: true, act: false, use: { uses: 2, lastTool: 'LINEAR_LIST_ISSUES' } });
    expect(byName.Idle).toMatchObject({ enabled: false });
    expect(byName.Idle!.use).toBeUndefined();
    // Its history: each run, newest first (tool, time, outcome; no arguments or results).
    const history = await hub.appHistory(person, tool.id, 'linear');
    expect(history.map((h) => [h.tool, h.ok])).toEqual([
      ['LINEAR_LIST_ISSUES', true],
      ['LINEAR_LIST_ISSUES', true],
    ]);
    expect(Object.keys(history[0]!).sort()).toEqual(['at', 'ok', 'tool']);
    await expect(hub.appHistory(await testPerson(hub.registry, 'Other'), tool.id, 'linear')).rejects.toThrow(/No bot/);
    expect(idle.id).toBeTruthy();
    // An app that isn't connected isn't listed, even if an agent may use it.
    await hub.setAgentTools(person, idle.id, { toolkits: ['gmail'], act: false });
    expect((await hub.myApps(person)).map((a) => a.toolkit)).toEqual(['linear']);
    // Each app action that works costs its owner 1 credit; with none left, apps pause.
    expect((await hub.llm.balance(person.id)).spentMicros).toBe(2 * CREDIT_MICROS);
    await hub.llm.charge(person.id, 1_000_000);
    expect(await hub.appTool((await hub.registry.get(tool.id))!, 'run_tool', { tool: 'LINEAR_LIST_ISSUES', arguments: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/credits .* used up/) });
  });
});
