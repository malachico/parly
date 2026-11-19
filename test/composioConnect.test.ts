import { describe, expect, it } from 'vitest';
import { Composio } from '../src/hub/composio.js';

describe('connecting apps through Composio', () => {
  it("one-click apps use Composio's sign-in; key apps use the person's key on Composio's page; OAuth-only apps can't yet", async () => {
    const created: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (u.pathname.endsWith('/toolkits'))
        return Response.json({
          items: [
            { slug: 'gmail', name: 'Gmail', composio_managed_auth_schemes: ['OAUTH2'], auth_schemes: ['OAUTH2'] },
            { slug: 'tavily', name: 'Tavily', composio_managed_auth_schemes: [], auth_schemes: ['API_KEY'] },
            { slug: 'twitter', name: 'X', composio_managed_auth_schemes: [], auth_schemes: ['OAUTH2'] },
          ],
        });
      if (u.pathname.endsWith('/toolkits/tavily')) return Response.json({ auth_config_details: [{ mode: 'API_KEY' }] });
      if (u.pathname.endsWith('/auth_configs') && init?.method === 'POST') return created.push(body), Response.json({ auth_config: { id: `ac_${body.toolkit.slug}` } });
      if (u.pathname.endsWith('/auth_configs')) return Response.json({ items: [] });
      if (u.pathname.endsWith('/connected_accounts/link')) return Response.json({ redirect_url: `https://connect.test/${body.auth_config_id}` });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    const composio = new Composio('ak_test', fetchImpl);

    const catalog = await composio.catalog();
    expect(catalog.map((t) => [t.slug, t.connectable, !!t.keyed])).toEqual([
      ['gmail', true, false],
      ['tavily', true, true],
      ['twitter', false, false],
    ]);
    expect(await composio.connectUrl('person-1', 'github', 'https://parly.test/back')).toBe('https://github.com/apps/parly-dev/installations/new');
    expect(await new Composio('ak_test', fetchImpl, 'custom-app').connectUrl('person-1', 'github', 'https://parly.test/back')).toBe('https://github.com/apps/custom-app/installations/new');
    expect(await composio.connectUrl('person-1', 'gmail', 'https://parly.test/back')).toBe('https://connect.test/ac_gmail');
    expect(await composio.connectUrl('person-1', 'tavily', 'https://parly.test/back')).toBe('https://connect.test/ac_tavily');
    expect(created).toEqual([
      { toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth' } },
      // The key itself is typed on Composio's page: the config holds no credentials of ours or theirs.
      { toolkit: { slug: 'tavily' }, auth_config: { type: 'use_custom_auth', authScheme: 'API_KEY', credentials: {} } },
    ]);
    await expect(composio.connectUrl('person-1', 'twitter', 'https://parly.test/back')).rejects.toThrow(/can't be connected from Parly yet/);
  });

  it('github_merge_pr merges via PUT /repos/:owner/:repo/pulls/:number/merge (default squash) and validates method', async () => {
    const { GitHubApp, runGitHubCloudTool, GITHUB_WRITE_TOOL_NAMES, GITHUB_CLOUD_TOOLS } = await import('../src/hub/github.js');
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    expect(GITHUB_WRITE_TOOL_NAMES.has('github_merge_pr')).toBe(true);
    expect(GITHUB_CLOUD_TOOLS.some((t) => t.name === 'github_merge_pr')).toBe(true);

    const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      if (url.endsWith('/app/installations?per_page=100')) {
        return Response.json([{ id: 42, account: { login: 'malachico' } }]);
      }
      if (url.endsWith('/app/installations/42/access_tokens')) {
        return Response.json({ token: 'ghs_tok' });
      }
      if (method === 'PUT' && url.endsWith('/repos/malachico/parly/pulls/685/merge')) {
        return Response.json({ sha: 'abc1234', merged: true, message: 'Pull Request successfully merged' });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const gh = new GitHubApp({ appId: '5448582', privateKey, fetchImpl });
    const install = { accountLogin: 'malachico', repos: [] };

    const merged = await runGitHubCloudTool(gh, install, 'github_merge_pr', {
      owner: 'malachico',
      repo: 'parly',
      number: 685,
      commitTitle: 'fix(notif): clear stale unread (#685)',
    });
    expect(merged).toEqual({
      ok: true,
      data: { sha: 'abc1234', merged: true, message: 'Pull Request successfully merged' },
    });
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      url: 'https://api.github.com/repos/malachico/parly/pulls/685/merge',
      body: { merge_method: 'squash', commit_title: 'fix(notif): clear stale unread (#685)' },
    });

    const badMethod = await runGitHubCloudTool(gh, install, 'github_merge_pr', {
      owner: 'malachico',
      repo: 'parly',
      number: 685,
      method: 'fast-forward',
    });
    expect(badMethod).toEqual({
      ok: false,
      error: 'github_merge_pr method must be "merge", "squash", or "rebase"',
    });

    const wrongOwner = await runGitHubCloudTool(gh, { accountLogin: 'someone-else', repos: [] }, 'github_merge_pr', {
      owner: 'malachico',
      repo: 'parly',
      number: 685,
    });
    expect(wrongOwner).toEqual({
      ok: false,
      error: 'GitHub App is not installed on malachico',
    });
  });

  it('loads 20 apps and finds the rest by asking Composio, sign-in kind included', async () => {
    const urls: URL[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/auth_configs')) return Response.json({ items: [{ id: 'ac_vercel', status: 'ENABLED', toolkit: { slug: 'vercel' } }] });
      if (u.pathname.endsWith('/connected_accounts/link')) return Response.json({ redirect_url: `https://connect.test/${JSON.parse(String(init?.body)).auth_config_id}` });
      urls.push(u);
      const q = u.searchParams.get('search');
      if (!q) return Response.json({ items: [{ slug: 'gmail', name: 'Gmail', composio_managed_auth_schemes: ['OAUTH2'] }] });
      return Response.json({
        items: q === 'vercel' ? [{ slug: 'botvercel', name: 'Bot for Vercel', auth_schemes: ['API_KEY'] }, { slug: 'vercel', name: 'Vercel', auth_schemes: ['OAUTH2'] }] : [],
      });
    }) as typeof fetch;

    const composio = new Composio('ak_test', fetchImpl);
    await composio.catalog();
    expect(urls[0]?.searchParams.get('limit')).toBe('20');

    // Past the 20 loaded, and connected through the app's own auth config.
    expect((await composio.searchCatalog('Vercel')).map((t) => [t.slug, t.connectable])).toEqual([
      ['vercel', true],
      ['botvercel', true],
    ]);
    expect(urls[1]?.searchParams.get('limit')).toBe('20');
    expect(await composio.connectUrl('u1', 'vercel', 'https://cb.test')).toBe('https://connect.test/ac_vercel');
    expect(await composio.app('nope')).toBeUndefined();
  });

  it('unlocks custom OAuth apps (like X / twitter) once an auth_config is configured in Composio and ranks twitter at the top for query "x"', async () => {
    let twitterConfigured = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (u.pathname.endsWith('/toolkits'))
        return Response.json({
          items: [
            { slug: 'perplexityai', name: 'Perplexity AI', composio_managed_auth_schemes: [], auth_schemes: ['API_KEY'] },
            { slug: 'twitter', name: 'Twitter', composio_managed_auth_schemes: [], auth_schemes: ['OAUTH2'], meta: { description: 'Social network rebranded as X' } },
          ],
        });
      if (u.pathname.endsWith('/auth_configs')) {
        return Response.json({
          items: twitterConfigured ? [{ id: 'ac_twitter_custom', status: 'ENABLED', toolkit: { slug: 'twitter' } }] : [],
        });
      }
      if (u.pathname.endsWith('/connected_accounts/link')) return Response.json({ redirect_url: `https://connect.test/${body.auth_config_id}` });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const composio = new Composio('ak_test', fetchImpl);

    // Before configuring Twitter OAuth in Composio: searching "x" ranks twitter first, with connectable: false.
    const beforeSearch = await composio.searchCatalog('x');
    expect(beforeSearch.map((t) => [t.slug, t.connectable])).toEqual([
      ['twitter', false],
      ['perplexityai', true],
    ]);

    // Once the admin adds the Twitter Auth Config in Composio, connectUrl (and catalog) unlocks it immediately.
    twitterConfigured = true;
    expect(await composio.connectUrl('person-1', 'twitter', 'https://parly.test/back')).toBe('https://connect.test/ac_twitter_custom');
    const afterSearch = await composio.searchCatalog('x');
    expect(afterSearch.find((t) => t.slug === 'twitter')?.connectable).toBe(true);
  });

  it('treats toolkits whose only "managed" schemes are API keys (e.g. Gemini) as Add key, not Connect', async () => {
    const created: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (u.pathname.endsWith('/toolkits'))
        return Response.json({
          items: [
            // Composio lists API_KEY under composio_managed_auth_schemes even when it has no managed credentials.
            {
              slug: 'gemini',
              name: 'Gemini',
              composio_managed_auth_schemes: ['API_KEY'],
              auth_schemes: ['API_KEY'],
              meta: { description: 'Comprehensive Gemini integration' },
            },
          ],
        });
      if (u.pathname.endsWith('/toolkits/gemini')) return Response.json({ auth_config_details: [{ mode: 'API_KEY' }] });
      if (u.pathname.endsWith('/auth_configs') && init?.method === 'POST') {
        if (body?.auth_config?.type === 'use_composio_managed_auth') {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Default auth config not found for toolkit "gemini". Composio does not have managed credentials for this toolkit.',
                suggested_fix: 'Use type "use_custom_auth"',
              },
            }),
            { status: 404 },
          );
        }
        created.push(body);
        return Response.json({ auth_config: { id: `ac_${body.toolkit.slug}` } });
      }
      if (u.pathname.endsWith('/auth_configs')) return Response.json({ items: [] });
      if (u.pathname.endsWith('/connected_accounts/link')) return Response.json({ redirect_url: `https://connect.test/${body.auth_config_id}` });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    const composio = new Composio('ak_test', fetchImpl);

    const gemini = (await composio.catalog()).find((t) => t.slug === 'gemini');
    expect(gemini).toEqual(expect.objectContaining({ connectable: true, keyed: true }));
    expect(await composio.connectUrl('person-1', 'gemini', 'https://parly.test/back')).toBe('https://connect.test/ac_gemini');
    expect(created).toEqual([
      { toolkit: { slug: 'gemini' }, auth_config: { type: 'use_custom_auth', authScheme: 'API_KEY', credentials: {} } },
    ]);
  });

  it('falls back to the person\'s key when Composio lists managed OAuth but has no managed credentials', async () => {
    const created: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (u.pathname.endsWith('/toolkits'))
        return Response.json({
          items: [
            {
              slug: 'gemini',
              name: 'Gemini',
              composio_managed_auth_schemes: ['OAUTH2'],
              auth_schemes: ['OAUTH2', 'API_KEY'],
            },
          ],
        });
      if (u.pathname.endsWith('/toolkits/gemini')) return Response.json({ auth_config_details: [{ mode: 'API_KEY' }, { mode: 'OAUTH2' }] });
      if (u.pathname.endsWith('/auth_configs') && init?.method === 'POST') {
        if (body?.auth_config?.type === 'use_composio_managed_auth') {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Default auth config not found for toolkit "gemini". Composio does not have managed credentials for this toolkit.',
              },
            }),
            { status: 404 },
          );
        }
        created.push(body);
        return Response.json({ auth_config: { id: `ac_${body.toolkit.slug}` } });
      }
      if (u.pathname.endsWith('/auth_configs')) return Response.json({ items: [] });
      if (u.pathname.endsWith('/connected_accounts/link')) return Response.json({ redirect_url: `https://connect.test/${body.auth_config_id}` });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    const composio = new Composio('ak_test', fetchImpl);

    expect(await composio.connectUrl('person-1', 'gemini', 'https://parly.test/back')).toBe('https://connect.test/ac_gemini');
    expect(created).toEqual([
      { toolkit: { slug: 'gemini' }, auth_config: { type: 'use_custom_auth', authScheme: 'API_KEY', credentials: {} } },
    ]);
  });
});
