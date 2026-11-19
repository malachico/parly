import type { AddressInfo } from 'node:net';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp, createHub } from '../src/app.js';
import { CLOUD_TOOLS, appsOf } from '../src/hub/cloudAgent.js';
import { Composio, POPULAR } from '../src/hub/composio.js';
import {
  APP_JWT_EXP_SECONDS,
  GITHUB_PUT_FILE_MAX_BYTES,
  GITHUB_WRITE_TOOL_NAMES,
  GitHubApp,
  INSTALLATION_TOKEN_TTL_MS,
  githubAppEnabled,
  mintGitHubAppJwt,
  runGitHubCloudTool,
} from '../src/hub/github.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function decodeJwtPart(b64url: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64url, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('GitHub App outbound auth and cloud tools', () => {
  it('gates githubAppEnabled on both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY being present', () => {
    expect(githubAppEnabled(undefined)).toBe(false);
    expect(githubAppEnabled({})).toBe(false);
    expect(githubAppEnabled({ githubAppId: '5448582' })).toBe(false);
    expect(githubAppEnabled({ githubAppPrivateKey: TEST_PRIVATE_KEY })).toBe(false);
    expect(githubAppEnabled({ githubAppId: '  ', githubAppPrivateKey: TEST_PRIVATE_KEY })).toBe(false);
    expect(githubAppEnabled({ githubAppId: '5448582', githubAppPrivateKey: TEST_PRIVATE_KEY })).toBe(true);
  });

  it('mints an RS256 App JWT with iss=GITHUB_APP_ID and exp <= 10 minutes verified by the RSA public key', () => {
    const nowSec = 1_761_264_000;
    const escapedPem = TEST_PRIVATE_KEY.replace(/\n/g, '\\n');
    const token = mintGitHubAppJwt('5448582', escapedPem, nowSec);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    const header = decodeJwtPart(parts[0]!);
    const payload = decodeJwtPart(parts[1]!);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toEqual({
      iat: nowSec - 60,
      exp: nowSec + APP_JWT_EXP_SECONDS,
      iss: '5448582',
    });
    expect((payload.exp as number) - nowSec).toBeLessThanOrEqual(600);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    expect(verifier.verify(TEST_PUBLIC_KEY, Buffer.from(parts[2]!, 'base64url'))).toBe(true);
  });

  it('follows Link pagination on GET /app/installations so an install on page 2 is found', async () => {
    const urls: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, account: { login: `org-${i + 1}` } }));
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url === 'https://api.github.com/app/installations?per_page=100') {
        return new Response(JSON.stringify(page1), {
          headers: { link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next", <https://api.github.com/app/installations?per_page=100&page=2>; rel="last"' },
        });
      }
      if (url === 'https://api.github.com/app/installations?per_page=100&page=2') {
        return new Response(JSON.stringify([{ id: 4242, account: { login: 'late-org' } }]));
      }
      if (url === 'https://api.github.com/app/installations/4242/access_tokens') return new Response(JSON.stringify({ token: 'ghs_page2_tok' }));
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;
    const gh = new GitHubApp({ appId: '5448582', privateKey: TEST_PRIVATE_KEY, fetchImpl });
    expect(await gh.installationToken('Late-Org')).toBe('ghs_page2_tok');
    expect((await gh.scopedToken('late-org', { permissions: { contents: 'read' } })).token).toBe('ghs_page2_tok');
    expect(urls.filter((u) => u.includes('page=2'))).toHaveLength(2);
  });

  it('exchanges an App JWT for an installation access token, caches it for ~55min, and sends it on github_comment and github_open_pr', async () => {
    let clockMs = 1_761_264_000_000;
    let tokenCounter = 0;
    const requests: { method: string; url: string; auth: string; body?: Record<string, unknown> }[] = [];

    const mockFetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization') ?? '';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      requests.push({ method, url, auth, ...(body ? { body } : {}) });

      if (method === 'GET' && url === 'https://api.github.com/app/installations?per_page=100') {
        const jwt = auth.replace(/^Bearer\s+/i, '');
        const [h, p] = jwt.split('.');
        expect(decodeJwtPart(h!)).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(decodeJwtPart(p!).iss).toBe('5448582');
        return new Response(JSON.stringify([{ id: 99123, account: { login: 'malachico' } }]), { status: 200 });
      }
      if (method === 'POST' && url === 'https://api.github.com/app/installations/99123/access_tokens') {
        tokenCounter += 1;
        return new Response(JSON.stringify({ token: `ghs_install_tok_${tokenCounter}` }), { status: 201 });
      }
      if (method === 'POST' && url === 'https://api.github.com/repos/malachico/a2a-hub/issues/228/comments') {
        return new Response(
          JSON.stringify({ id: 777, html_url: 'https://github.com/malachico/a2a-hub/pull/228#issuecomment-777', body: body?.body }),
          { status: 201 },
        );
      }
      if (method === 'POST' && url === 'https://api.github.com/repos/malachico/a2a-hub/pulls') {
        return new Response(
          JSON.stringify({ number: 229, html_url: 'https://github.com/malachico/a2a-hub/pull/229', title: body?.title, state: 'open' }),
          { status: 201 },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const gh = new GitHubApp({
      appId: '5448582',
      privateKey: TEST_PRIVATE_KEY,
      fetchImpl: mockFetch,
      now: () => clockMs,
    });

    const c1 = await runGitHubCloudTool(gh, { accountLogin: 'malachico', repos: [] }, 'github_comment', {
      owner: 'malachico',
      repo: 'a2a-hub',
      number: 228,
      body: 'LGTM from cloud agent!',
    });
    expect(c1).toMatchObject({ ok: true, data: { id: 777, body: 'LGTM from cloud agent!' } });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://api.github.com/app/installations?per_page=100',
      'POST https://api.github.com/app/installations/99123/access_tokens',
      'POST https://api.github.com/repos/malachico/a2a-hub/issues/228/comments',
    ]);
    expect(requests[2]!.auth).toBe('Bearer ghs_install_tok_1');
    expect(requests[2]!.body).toEqual({ body: 'LGTM from cloud agent!' });

    clockMs += 10 * 60_000;
    const pr = await runGitHubCloudTool(gh, { accountLogin: 'malachico', repos: [] }, 'github_open_pr', {
      owner: 'malachico',
      repo: 'a2a-hub',
      title: 'feat(github): native app outbound',
      head: 'feat/github-app-outbound',
      base: 'main',
      body: 'Opens PR via GitHub App installation token',
    });
    expect(pr).toMatchObject({ ok: true, data: { number: 229, title: 'feat(github): native app outbound' } });
    expect(requests).toHaveLength(4);
    expect(requests[3]!.auth).toBe('Bearer ghs_install_tok_1');

    // Explicit owner that has no matching installation fails clearly without falling back or polluting cache.
    const wrongOwner = await runGitHubCloudTool(gh, { accountLogin: 'malachico', repos: [] }, 'github_comment', {
      owner: 'other-org',
      repo: 'a2a-hub',
      number: 228,
      body: 'Should not fall back to malachico installation',
    });
    expect(wrongOwner).toEqual({ ok: false, error: 'GitHub App is not installed on other-org' });

    // Another tenant's install, or a repo outside the caller's install: no installation token is minted or used.
    const before = requests.length;
    for (const install of [{ accountLogin: 'someone-else', repos: [] }, { accountLogin: 'malachico', repos: ['other-repo'] }, undefined]) {
      const res = await runGitHubCloudTool(gh, install, 'github_comment', { owner: 'malachico', repo: 'a2a-hub', number: 228, body: 'x' });
      expect(res).toEqual({ ok: false, error: 'GitHub App is not installed on malachico' });
    }
    expect(requests).toHaveLength(before);

    clockMs += INSTALLATION_TOKEN_TTL_MS + 1_000;
    await gh.comment({ owner: 'malachico', repo: 'a2a-hub', number: 228, body: 'Second comment after TTL' });
    expect(requests.at(-1)!.auth).toBe('Bearer ghs_install_tok_2');
  });

  it('removes github from Composio connectable catalog/POPULAR and blocks Composio github action tools', async () => {
    expect(POPULAR.github).toBeUndefined();

    const composioFetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/toolkits')) {
        return Response.json({
          items: [
            { slug: 'github', name: 'GitHub', composio_managed_auth_schemes: ['OAUTH2'], auth_schemes: ['OAUTH2'] },
            { slug: 'linear', name: 'Linear', composio_managed_auth_schemes: ['OAUTH2'], auth_schemes: ['OAUTH2'] },
          ],
        });
      }
      if (u.pathname.endsWith('/connected_accounts')) {
        return Response.json({
          items: [
            { id: 'ca_gh', status: 'ACTIVE', toolkit: { slug: 'github' } },
            { id: 'ca_lin', status: 'ACTIVE', toolkit: { slug: 'linear' } },
          ],
        });
      }
      if (u.pathname.endsWith('/tools')) {
        const tk = u.searchParams.get('toolkit_slug');
        if (tk === 'github') return Response.json({ items: [{ slug: 'GITHUB_LIST_ISSUES', description: 'List issues', tags: ['readOnlyHint'] }] });
        if (tk === 'linear') return Response.json({ items: [{ slug: 'LINEAR_LIST_ISSUES', description: 'List Linear issues', tags: ['readOnlyHint'] }] });
      }
      if (u.pathname.endsWith('/tools/LINEAR_LIST_ISSUES')) {
        return Response.json({ slug: 'LINEAR_LIST_ISSUES', description: 'List Linear issues', tags: ['readOnlyHint'] });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const composio = new Composio('ak_test', composioFetch);
    const catalog = await composio.catalog();
    expect(catalog.map((t) => t.slug)).toEqual(['linear']);
    expect((await composio.popular()).map((t) => t.slug)).not.toContain('github');

    const found = await composio.findTools(['github', 'linear'], 'list issues', { act: true });
    expect(found.map((t) => t.slug)).toEqual(['LINEAR_LIST_ISSUES']);
    expect(await composio.tool('GITHUB_LIST_ISSUES', 'github')).toBeUndefined();
    expect(await composio.execute('owner-1', 'GITHUB_CREATE_ISSUE', {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/native GitHub App/),
    });

    const apps = await appsOf(composio, {
      id: 'agent-1',
      name: 'Bot',
      description: '',
      kind: 'endpoint',
      ownerId: 'owner-1',
      public: false,
      skills: [],
      workspaces: [],
      channels: [],
      tools: { toolkits: ['github', 'linear'], act: true },
      tokenHash: '',
      lastSeen: '',
      createdAt: '',
    });
    expect(apps).toEqual(['linear']);
  });

  it('wires github_comment and github_open_pr into CLOUD_TOOLS and CloudAgents when credentials are configured', async () => {
    expect(CLOUD_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['github_comment', 'github_open_pr']));

    const ghCalls: { url: string; auth: string; body?: unknown }[] = [];
    const githubFetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      ghCalls.push({
        url,
        auth: headers.get('authorization') ?? '',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith('/app/installations?per_page=100')) return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]));
      if (url.endsWith('/app/installations/42/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_cloud_agent_tok' }));
      if (url.endsWith('/repos/malachico/a2a-hub/issues/228/comments')) {
        return new Response(JSON.stringify({ id: 901, html_url: 'https://github.com/malachico/a2a-hub/pull/228#issuecomment-901' }), { status: 201 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    let round = 0;
    let declaredTools: string[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      declaredTools = (body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name);
      round += 1;
      if (round === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: 'github_comment',
                        args: { owner: 'malachico', repo: 'a2a-hub', number: 228, body: 'Reviewed and approved!' },
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Posted comment on #228.' }] } }] }));
    }) as typeof fetch;

    const hub = createHub({
      db: testDb(),
      config: testConfig({
        cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } },
        githubAppId: '5448582',
        githubAppPrivateKey: TEST_PRIVATE_KEY,
      }),
      cloudFetch,
      cloudToken: async () => 'ya29.test',
      githubFetch,
    });

    expect(hub.github).toBeDefined();
    const owner = await testPerson(hub.registry, 'Malachi');
    await hub.githubInstalls!.save({ installationId: 281000, ownerId: owner.id, accountLogin: 'malachico', repos: [], installedBy: owner.id });
    const joey = await hub.createCloudAgent(owner, { name: 'Joey', description: 'Reviewer' });
    await hub.setAgentTools(owner, joey.id, { toolkits: ['github'], act: true });
    await hub.send(owner, { to: joey.id }, [{ text: 'Please comment on PR #228' }]);
    await hub.wakeService.idle();

    expect(declaredTools).toEqual(expect.arrayContaining(['github_comment', 'github_open_pr']));
    expect(ghCalls.map((c) => c.url)).toEqual([
      'https://api.github.com/app/installations?per_page=100',
      'https://api.github.com/app/installations/42/access_tokens',
      'https://api.github.com/repos/malachico/a2a-hub/issues/228/comments',
    ]);
    expect(ghCalls[2]!.auth).toBe('Bearer ghs_cloud_agent_tok');
    expect(ghCalls[2]!.body).toEqual({ body: 'Reviewed and approved!' });
  });

  it('refuses github_comment and github_open_pr when act=false without calling GitHub, and posts once act=true', async () => {
    const ghCalls: { url: string; auth: string; body?: unknown }[] = [];
    const githubFetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      ghCalls.push({
        url,
        auth: headers.get('authorization') ?? '',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith('/app/installations?per_page=100')) return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]));
      if (url.endsWith('/app/installations/42/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_act_tok' }));
      if (url.endsWith('/repos/malachico/a2a-hub/issues/229/comments')) {
        return new Response(JSON.stringify({ id: 902, html_url: 'https://github.com/malachico/a2a-hub/pull/229#issuecomment-902' }), { status: 201 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const toolResults: Record<string, unknown>[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const lastPart = body.contents?.at(-1)?.parts?.at(-1);
      if (lastPart?.functionResponse) {
        toolResults.push(lastPart.functionResponse.response as Record<string, unknown>);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(lastPart.functionResponse.response) }] } }] }));
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'github_comment',
                      args: { owner: 'malachico', repo: 'a2a-hub', number: 229, body: 'Should be gated by act' },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    }) as typeof fetch;

    const hub = createHub({
      db: testDb(),
      config: testConfig({
        cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } },
        githubAppId: '5448582',
        githubAppPrivateKey: TEST_PRIVATE_KEY,
      }),
      cloudFetch,
      cloudToken: async () => 'ya29.test',
      githubFetch,
    });

    const owner = await testPerson(hub.registry, 'Malachi');
    await hub.githubInstalls!.save({ installationId: 354000, ownerId: owner.id, accountLogin: 'malachico', repos: [], installedBy: owner.id });
    const joey = await hub.createCloudAgent(owner, { name: 'Joey', description: 'Reviewer' });

    // Default act=false (and github enabled by default): github_comment is refused and 0 GitHub requests are made.
    await hub.send(owner, { to: joey.id }, [{ text: 'Try commenting while read-only' }]);
    await hub.wakeService.idle();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toEqual({
      ok: false,
      error: 'Read-only: ask your owner to enable acting in Tools settings before posting to GitHub.',
    });
    expect(ghCalls).toHaveLength(0);

    // Enable act=true: github_comment now runs and posts to GitHub.
    await hub.setAgentTools(owner, joey.id, { toolkits: ['github'], act: true });
    await hub.send(owner, { to: joey.id }, [{ text: 'Now comment with acting enabled' }]);
    await hub.wakeService.idle();
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1]).toMatchObject({ ok: true, data: { id: 902 } });
    expect(ghCalls).toHaveLength(3);
  });

  it('allows read-only cloud agents (act=false) to run github_pr_diff, github_pr_files, and github_get_content', async () => {
    expect(CLOUD_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(['github_pr_diff', 'github_pr_files', 'github_get_content', 'github_comment', 'github_open_pr']),
    );

    const ghCalls: { method: string; url: string; accept: string }[] = [];
    const githubFetch = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const accept = headers.get('accept') ?? '';
      ghCalls.push({ method: init?.method ?? 'GET', url, accept });
      if (url.endsWith('/app/installations?per_page=100')) return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]));
      if (url.endsWith('/app/installations/42/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_read_tok' }));
      if (url.endsWith('/repos/malachico/a2a-hub/pulls/233') && accept === 'application/vnd.github.v3.diff') {
        return new Response('diff --git a/src/telegram/bridge.ts b/src/telegram/bridge.ts\n+export class TelegramBridge {}\n');
      }
      if (url.endsWith('/repos/malachico/a2a-hub/pulls/233/files?per_page=100')) {
        return new Response(
          JSON.stringify([{ filename: 'src/telegram/bridge.ts', status: 'added', additions: 10, deletions: 0, changes: 10, sha: 'abc', patch: '@@ -0,0 +1 @@\n+export class TelegramBridge {}' }]),
        );
      }
      if (url.endsWith('/repos/malachico/a2a-hub/contents/src/telegram/bridge.ts?ref=93a7c85')) {
        return new Response(
          JSON.stringify({
            path: 'src/telegram/bridge.ts',
            sha: 'abc',
            size: 32,
            encoding: 'base64',
            content: Buffer.from('export class TelegramBridge {}\n').toString('base64'),
          }),
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const toolResponses: Record<string, unknown>[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const parts = body.contents?.at(-1)?.parts ?? [];
      if (parts.some((p: { functionResponse?: unknown }) => p.functionResponse)) {
        for (const p of parts) if (p.functionResponse) toolResponses.push(p.functionResponse.response);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Reviewed all 3 read tools.' }] } }] }));
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'github_pr_diff', args: { owner: 'malachico', repo: 'a2a-hub', number: 233 } } },
                  { functionCall: { name: 'github_pr_files', args: { owner: 'malachico', repo: 'a2a-hub', number: 233 } } },
                  { functionCall: { name: 'github_get_content', args: { owner: 'malachico', repo: 'a2a-hub', path: 'src/telegram/bridge.ts', ref: '93a7c85' } } },
                ],
              },
            },
          ],
        }),
      );
    }) as typeof fetch;

    const hub = createHub({
      db: testDb(),
      config: testConfig({
        cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } },
        githubAppId: '5448582',
        githubAppPrivateKey: TEST_PRIVATE_KEY,
      }),
      cloudFetch,
      cloudToken: async () => 'ya29.test',
      githubFetch,
    });

    const owner = await testPerson(hub.registry, 'Malachi');
    const gitit = await hub.createCloudAgent(owner, { name: 'Gitit', description: 'Reviewer' });
    // Default act=false (and github enabled by default): all 3 read tools succeed without requiring act=true.
    await hub.send(owner, { to: gitit.id }, [{ text: 'Review PR #233' }]);
    await hub.wakeService.idle();

    expect(toolResponses).toHaveLength(3);
    expect(toolResponses[0]).toEqual({
      ok: true,
      data: { diff: 'diff --git a/src/telegram/bridge.ts b/src/telegram/bridge.ts\n+export class TelegramBridge {}\n' },
    });
    expect(toolResponses[1]).toEqual({
      ok: true,
      data: {
        files: [
          {
            filename: 'src/telegram/bridge.ts',
            status: 'added',
            additions: 10,
            deletions: 0,
            changes: 10,
            sha: 'abc',
            patch: '@@ -0,0 +1 @@\n+export class TelegramBridge {}',
          },
        ],
      },
    });
    expect(toolResponses[2]).toEqual({
      ok: true,
      data: {
        path: 'src/telegram/bridge.ts',
        sha: 'abc',
        size: 32,
        text: 'export class TelegramBridge {}\n',
      },
    });
  });

  it('falls back to unauthenticated reads for a public repo the App is not installed on, but keeps the installation token for installed owners', async () => {
    const reqs: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      reqs.push({ url: String(url), auth });
      if (String(url).endsWith('/app/installations?per_page=100')) {
        return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]));
      }
      if (String(url).endsWith('/app/installations/42/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_inst_tok' }));
      }
      // Any repo contents fetch returns a public file; external orgs reach here with NO auth header.
      if (String(url).includes('/contents/')) {
        return new Response(
          JSON.stringify({ path: 'src/Vault.sol', sha: 'deadbeef', size: 12, encoding: 'base64', content: Buffer.from('contract V {}').toString('base64') }),
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const app = new GitHubApp({ appId: '5448582', privateKey: TEST_PRIVATE_KEY, fetchImpl });

    // External org the App is NOT installed on → unauthenticated public read succeeds.
    const external = await app.getContent({ owner: 'Strata-Markets', repo: 'contracts', path: 'src/Vault.sol' });
    expect(external).toMatchObject({ path: 'src/Vault.sol', text: 'contract V {}' });
    const externalReq = reqs.find((r) => r.url.includes('/repos/Strata-Markets/'));
    expect(externalReq?.auth).toBeNull(); // no Authorization header on the fallback

    // Installed owner → still uses the installation token.
    reqs.length = 0;
    const own = await app.getContent({ owner: 'malachico', repo: 'a2a-hub', path: 'src/index.ts' });
    expect(own).toMatchObject({ text: 'contract V {}' });
    const ownReq = reqs.find((r) => r.url.includes('/repos/malachico/'));
    expect(ownReq?.auth).toBe('Bearer ghs_inst_tok');

    //With a public-read token configured, the external fallback uses it (5,000 req/hr) instead of going unauthenticated.
    reqs.length = 0;
    const appWithToken = new GitHubApp({ appId: '5448582', privateKey: TEST_PRIVATE_KEY, fetchImpl, publicReadToken: 'github_pat_public' });
    await appWithToken.getContent({ owner: 'Strata-Markets', repo: 'contracts', path: 'src/Vault.sol' });
    const tokenReq = reqs.find((r) => r.url.includes('/repos/Strata-Markets/'));
    expect(tokenReq?.auth).toBe('Bearer github_pat_public');

    // Network/API errors fetching the installation token are rethrown instead of silently downgrading to public token.
    const failingApp = new GitHubApp({
      appId: '5448582',
      privateKey: TEST_PRIVATE_KEY,
      publicReadToken: 'github_pat_public',
      fetchImpl: (async () => new Response('upstream outage', { status: 502 })) as typeof fetch,
    });
    await expect(failingApp.getContent({ owner: 'malachico', repo: 'a2a-hub', path: 'src/index.ts' })).rejects.toThrow(
      /GET \/app\/installations failed \(HTTP 502\)/,
    );
  });

  it('gates github_* tools per-agent on agent.tools.toolkits including "github" and surfaces native "GitHub (Parly App)" in myApps', async () => {
    let installed = false;
    const githubFetch = (async (url: string) => {
      if (url.endsWith('/app/installations?per_page=100')) {
        return new Response(JSON.stringify(installed ? [{ id: 42, account: { login: 'malachico' } }] : []));
      }
      if (url.endsWith('/app/installations/42/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_tok' }));
      }
      if (url.endsWith('/repos/malachico/a2a-hub/pulls/258')) {
        return new Response('diff --git a/file.ts b/file.ts\n');
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const declaredPerTurn: string[][] = [];
    const toolResponses: unknown[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      declaredPerTurn.push((body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name));
      const parts = body.contents?.at(-1)?.parts ?? [];
      if (parts.some((p: { functionResponse?: unknown }) => p.functionResponse)) {
        for (const p of parts) if (p.functionResponse) toolResponses.push(p.functionResponse.response);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }));
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'github_pr_diff', args: { owner: 'malachico', repo: 'a2a-hub', number: 258 } } }],
              },
            },
          ],
        }),
      );
    }) as typeof fetch;

    const { app, hub } = createApp({
      db: testDb(),
      config: testConfig({
        cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } },
        githubAppId: '5448582',
        githubAppPrivateKey: TEST_PRIVATE_KEY,
      }),
      cloudFetch,
      cloudToken: async () => 'ya29.test',
      githubFetch,
    });

    const owner = await testPerson(hub.registry, 'Malachi');
    const agent = await hub.createCloudAgent(owner, { name: 'Reviewer', description: 'PR reviewer' });

    // Newly-hired cloud agents default with 'github' enabled (read-only); before this owner connects, status is NOT_INSTALLED.
    const defaultApps = await hub.myApps(owner);
    expect(defaultApps).toEqual([
      {
        toolkit: 'github',
        name: 'GitHub',
        logo: '/github-mark.svg',
        native: true,
        account: { id: 'github-app', status: 'NOT_INSTALLED' },
        agents: [expect.objectContaining({ id: agent.id, name: 'Reviewer', enabled: true, act: false })],
      },
    ]);

    // Unticking github on the agent disables github_* tools: they are not declared and calling one is refused.
    await hub.setAgentTools(owner, agent.id, { toolkits: [], act: false });
    const disabledApps = await hub.myApps(owner);
    expect(disabledApps[0]?.agents).toEqual([expect.objectContaining({ id: agent.id, name: 'Reviewer', enabled: false, act: false })]);

    await hub.send(owner, { to: agent.id }, [{ text: 'Check PR #258 without github enabled' }]);
    await hub.wakeService.idle();
    expect(declaredPerTurn[0]).not.toContain('github_pr_diff');
    expect(toolResponses[0]).toEqual({
      ok: false,
      error: 'GitHub is not enabled for this agent: ask your owner to turn on GitHub (Parly App) in Tools settings.',
    });

    // Once this owner has a mapped install and 'github' is enabled on the agent, myApps shows ACTIVE and github_pr_diff succeeds.
    installed = true;
    await hub.githubInstalls!.save({
      installationId: 42,
      ownerId: owner.id,
      accountLogin: 'malachico',
      repos: [],
      installedBy: owner.id,
    });
    await hub.setAgentTools(owner, agent.id, { toolkits: ['github'], act: false });
    const afterApps = await hub.myApps(owner);
    expect(afterApps[0]).toMatchObject({
      toolkit: 'github',
      name: 'GitHub',
      logo: '/github-mark.svg',
      native: true,
      installUrl: 'https://github.com/apps/parly-dev/installations/new',
      account: { id: 'github-app:42', status: 'ACTIVE' },
      agents: [expect.objectContaining({ id: agent.id, enabled: true, act: false })],
    });

    declaredPerTurn.length = 0;
    toolResponses.length = 0;
    await hub.send(owner, { to: agent.id }, [{ text: 'Check PR #258 with github enabled' }]);
    await hub.wakeService.idle();
    expect(declaredPerTurn[0]).toEqual(expect.arrayContaining(['github_pr_diff', 'github_pr_files', 'github_get_content']));
    expect(toolResponses[0]).toEqual({
      ok: true,
      data: { diff: 'diff --git a/file.ts b/file.ts\n' },
    });

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const authRes = await fetch(`${baseUrl}/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'dev:malachi-gh@people.test' }),
      });
      const { token } = (await authRes.json()) as { token: string };
      const toolsRes = await fetch(`${baseUrl}/me/tools`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(toolsRes.status).toBe(200);
      expect(await toolsRes.json()).toMatchObject({
        available: true,
        connected: [
          expect.objectContaining({
            slug: 'github',
            name: 'GitHub',
            logo: '/github-mark.svg',
            native: true,
          }),
        ],
      });
    } finally {
      server.close();
    }
  });

  it('supports github_list_dir (directory and recursive tree), batch multi-path github_get_content, and sharp 404 errors', async () => {
    expect(CLOUD_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(['github_pr_diff', 'github_pr_files', 'github_list_dir', 'github_get_content', 'github_comment', 'github_open_pr']),
    );

    const githubFetch = (async (url: string) => {
      if (url.endsWith('/app/installations?per_page=100')) return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]));
      if (url.endsWith('/app/installations/42/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_tok' }));
      if (url.endsWith('/repos/malachico/a2a-hub/contents/src/hub?ref=main')) {
        return new Response(
          JSON.stringify([
            { name: 'cloudAgent.ts', path: 'src/hub/cloudAgent.ts', type: 'file', sha: 'sha1', size: 120 },
            { name: 'github.ts', path: 'src/hub/github.ts', type: 'file', sha: 'sha2', size: 240 },
          ]),
        );
      }
      if (url.endsWith('/repos/malachico/a2a-hub/git/trees/main?recursive=1')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'src', type: 'tree', sha: 't0' },
              { path: 'src/app.ts', type: 'blob', sha: 'b1', size: 100 },
              { path: 'src/hub/cloudAgent.ts', type: 'blob', sha: 'b2', size: 200 },
            ],
            truncated: false,
          }),
        );
      }
      if (url.endsWith('/repos/malachico/a2a-hub/contents/src/app.ts?ref=93a7c85')) {
        return new Response(
          JSON.stringify({
            path: 'src/app.ts',
            sha: 'sha_app',
            size: 20,
            encoding: 'base64',
            content: Buffer.from('export const app = 1;\n').toString('base64'),
          }),
        );
      }
      if (url.endsWith('/repos/malachico/a2a-hub/contents/src/config.ts?ref=93a7c85')) {
        return new Response(
          JSON.stringify({
            path: 'src/config.ts',
            sha: 'sha_cfg',
            size: 23,
            encoding: 'base64',
            content: Buffer.from('export const cfg = true;\n').toString('base64'),
          }),
        );
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    }) as typeof fetch;

    const app = new GitHubApp({ appId: '5448582', privateKey: TEST_PRIVATE_KEY, fetchImpl: githubFetch });

    // 1. github_list_dir: directory listing + recursive tree listing in one call
    const dirRes = await runGitHubCloudTool(app, { accountLogin: 'malachico', repos: [] }, 'github_list_dir', { owner: 'malachico', repo: 'a2a-hub', path: 'src/hub', ref: 'main' });
    expect(dirRes).toEqual({
      ok: true,
      whole: true,
      data: {
        path: 'src/hub',
        ref: 'main',
        entries: [
          { name: 'cloudAgent.ts', path: 'src/hub/cloudAgent.ts', type: 'file', sha: 'sha1', size: 120 },
          { name: 'github.ts', path: 'src/hub/github.ts', type: 'file', sha: 'sha2', size: 240 },
        ],
      },
    });

    const treeRes = await runGitHubCloudTool(app, { accountLogin: 'malachico', repos: [] }, 'github_list_dir', { owner: 'malachico', repo: 'a2a-hub', ref: 'main', recursive: true });
    expect(treeRes).toEqual({
      ok: true,
      whole: true,
      data: {
        path: '/',
        ref: 'main',
        entries: [
          { name: 'src', path: 'src', type: 'dir', sha: 't0' },
          { name: 'app.ts', path: 'src/app.ts', type: 'file', sha: 'b1', size: 100 },
          { name: 'cloudAgent.ts', path: 'src/hub/cloudAgent.ts', type: 'file', sha: 'b2', size: 200 },
        ],
      },
    });

    // 2. Batch multi-path github_get_content (including partial 404 in batch)
    const batchRes = await runGitHubCloudTool(app, { accountLogin: 'malachico', repos: [] }, 'github_get_content', {
      owner: 'malachico',
      repo: 'a2a-hub',
      paths: ['src/app.ts', 'src/config.ts', 'src/missing.ts'],
      ref: '93a7c85',
    });
    expect(batchRes).toEqual({
      ok: true,
      whole: true,
      data: {
        files: [
          { path: 'src/app.ts', sha: 'sha_app', size: 20, text: 'export const app = 1;\n' },
          { path: 'src/config.ts', sha: 'sha_cfg', size: 23, text: 'export const cfg = true;\n' },
          { path: 'src/missing.ts', ok: false, error: 'no file at `src/missing.ts` on ref `93a7c85` — check the path/branch' },
        ],
      },
    });

    // 3. Sharp 404 error on single-path github_get_content
    const missingSingle = await runGitHubCloudTool(app, { accountLogin: 'malachico', repos: [] }, 'github_get_content', {
      owner: 'malachico',
      repo: 'a2a-hub',
      path: 'src/does-not-exist.ts',
      ref: '93a7c85',
    });
    expect(missingSingle).toEqual({
      ok: false,
      error: 'no file at `src/does-not-exist.ts` on ref `93a7c85` — check the path/branch',
    });
  });

  it('enables act=true cloud AND computer agents to author a PR end-to-end (github_create_branch + github_put_file + github_open_pr)', async () => {
    expect([...GITHUB_WRITE_TOOL_NAMES]).toEqual(
      expect.arrayContaining(['github_comment', 'github_open_pr', 'github_merge_pr', 'github_create_branch', 'github_put_file']),
    );

    const ghRequests: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    const githubFetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      ghRequests.push({ method, url, ...(body ? { body } : {}) });

      if (url.endsWith('/app/installations?per_page=100')) {
        return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]));
      }
      if (url.endsWith('/app/installations/42/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_author_tok' }));
      }
      if (method === 'GET' && url.endsWith('/repos/malachico/a2a-hub/git/ref/heads/main')) {
        return new Response(JSON.stringify({ ref: 'refs/heads/main', object: { sha: '1111111111111111111111111111111111111111' } }));
      }
      if (method === 'POST' && url.endsWith('/repos/malachico/a2a-hub/git/refs')) {
        return new Response(JSON.stringify({ ref: body?.ref, object: { sha: body?.sha } }), { status: 201 });
      }
      if (method === 'PUT' && url.includes('/repos/malachico/a2a-hub/contents/src/')) {
        return new Response(
          JSON.stringify({
            content: { path: url.split('/contents/')[1], sha: 'blob_sha_1' },
            commit: { sha: 'commit_sha_1', message: body?.message },
          }),
          { status: 201 },
        );
      }
      if (method === 'POST' && url.endsWith('/repos/malachico/a2a-hub/pulls')) {
        return new Response(
          JSON.stringify({ number: 325, html_url: 'https://github.com/malachico/a2a-hub/pull/325', title: body?.title }),
          { status: 201 },
        );
      }
      if (method === 'PUT' && url.endsWith('/repos/malachico/a2a-hub/pulls/325/merge')) {
        return new Response(
          JSON.stringify({ sha: 'merged_sha_325', merged: true, message: 'Pull Request successfully merged' }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    let cloudTurn = 0;
    let cloudDeclared: string[] = [];
    const cloudToolOutputs: unknown[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      cloudDeclared = (body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name);
      const parts = body.contents?.at(-1)?.parts ?? [];
      for (const p of parts) if (p.functionResponse) cloudToolOutputs.push(p.functionResponse.response);
      cloudTurn += 1;
      if (cloudTurn === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { name: 'github_create_branch', args: { owner: 'malachico', repo: 'a2a-hub', branch: 'feat/cloud-pr', from: 'main' } } },
                    {
                      functionCall: {
                        name: 'github_put_file',
                        args: {
                          owner: 'malachico',
                          repo: 'a2a-hub',
                          path: 'src/cloudFeature.ts',
                          content: Buffer.from('export const cloud = true;\n').toString('base64'),
                          message: 'feat: add cloudFeature',
                          branch: 'feat/cloud-pr',
                        },
                      },
                    },
                    { functionCall: { name: 'github_open_pr', args: { owner: 'malachico', repo: 'a2a-hub', title: 'feat: cloud PR', head: 'feat/cloud-pr', base: 'main' } } },
                    { functionCall: { name: 'github_merge_pr', args: { owner: 'malachico', repo: 'a2a-hub', number: 325 } } },
                  ],
                },
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Opened PR #325.' }] } }] }));
    }) as typeof fetch;

    const hub = createHub({
      db: testDb(),
      config: testConfig({
        cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } },
        githubAppId: '5448582',
        githubAppPrivateKey: TEST_PRIVATE_KEY,
      }),
      cloudFetch,
      cloudToken: async () => 'ya29.test',
      githubFetch,
    });

    const owner = await testPerson(hub.registry, 'Malachi');
    await hub.githubInstalls!.save({ installationId: 972000, ownerId: owner.id, accountLogin: 'malachico', repos: [], installedBy: owner.id });
    const cloudBot = await hub.createCloudAgent(owner, { name: 'CloudDev', description: 'Cloud implementer' });
    await hub.setAgentTools(owner, cloudBot.id, { toolkits: ['github'], act: true });
    await hub.send(owner, { to: cloudBot.id }, [{ text: 'Ship cloudFeature.ts' }]);
    await hub.wakeService.idle();

    expect(cloudDeclared).toEqual(expect.arrayContaining(['github_create_branch', 'github_put_file', 'github_open_pr', 'github_merge_pr', 'github_comment']));
    expect(cloudToolOutputs).toHaveLength(4);
    expect(cloudToolOutputs[0]).toMatchObject({ ok: true, data: { ref: 'refs/heads/feat/cloud-pr' } });
    expect(cloudToolOutputs[1]).toMatchObject({ ok: true, data: { content: { path: 'src/cloudFeature.ts' } } });
    expect(cloudToolOutputs[2]).toMatchObject({ ok: true, data: { number: 325 } });
    expect(cloudToolOutputs[3]).toMatchObject({ ok: true, data: { merged: true, sha: 'merged_sha_325' } });

    // Computer agent with act=true discovers native GitHub tools via find_tools and authors a PR via run_tool
    const { agent: compBot } = await hub.registry.createBot(owner, { hired: true, name: 'CompiDev' });
    await hub.setAgentTools(owner, compBot.id, { toolkits: ['github'], act: true });
    const compRecord = (await hub.registry.get(compBot.id))!;

    const found = (await hub.appTool(compRecord, 'find_tools', { app: 'github' })) as {
      ok: boolean;
      tools: { tool: string; app: string; writes?: boolean }[];
    };
    expect(found.ok).toBe(true);
    expect(found.tools.map((t) => t.tool)).toEqual(
      expect.arrayContaining([
        'github_pr_diff',
        'github_pr_files',
        'github_list_dir',
        'github_get_content',
        'github_comment',
        'github_open_pr',
        'github_merge_pr',
        'github_create_branch',
        'github_put_file',
      ]),
    );

    const branchOut = await hub.appTool(compRecord, 'run_tool', {
      tool: 'github_create_branch',
      arguments: { owner: 'malachico', repo: 'a2a-hub', branch: 'feat/compi-pr', from: 'main' },
    });
    expect(branchOut).toMatchObject({
      ok: true,
      data: { ref: 'refs/heads/feat/compi-pr', object: { sha: '1111111111111111111111111111111111111111' } },
    });

    const putOut = await hub.appTool(compRecord, 'run_tool', {
      tool: 'github_put_file',
      arguments: {
        owner: 'malachico',
        repo: 'a2a-hub',
        path: 'src/compiFeature.ts',
        content: Buffer.from('export const compi = 42;\n').toString('base64'),
        message: 'feat: add compiFeature',
        branch: 'feat/compi-pr',
      },
    });
    expect(putOut).toMatchObject({
      ok: true,
      data: { content: { path: 'src/compiFeature.ts', sha: 'blob_sha_1' } },
    });

    const prOut = await hub.appTool(compRecord, 'run_tool', {
      tool: 'github_open_pr',
      arguments: {
        owner: 'malachico',
        repo: 'a2a-hub',
        title: 'feat: computer agent PR',
        head: 'feat/compi-pr',
        base: 'main',
      },
      fields: ['number', 'html_url'],
    });
    expect(prOut).toEqual({
      ok: true,
      data: { number: 325, html_url: 'https://github.com/malachico/a2a-hub/pull/325' },
    });

    const history = await hub.appHistory(owner, compBot.id, 'github');
    expect(history.map((h) => [h.tool, h.ok])).toEqual([
      ['github_open_pr', true],
      ['github_put_file', true],
      ['github_create_branch', true],
    ]);
  });

  it('gives act=false and public-workspace agents zero write tools and refuses any write call, fails writes to non-installed repos, and enforces size/path-traversal caps on github_put_file', async () => {
    const ghCalls: { method: string; url: string }[] = [];
    const githubFetch = (async (url: string, init?: RequestInit) => {
      ghCalls.push({ method: init?.method ?? 'GET', url });
      if (url.endsWith('/app/installations?per_page=100')) {
        return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]));
      }
      if (url.endsWith('/app/installations/42/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_tok' }));
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    let cloudDeclared: string[] = [];
    const cloudToolResults: unknown[] = [];
    const cloudFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      cloudDeclared = (body.tools?.[0]?.functionDeclarations ?? []).map((d: { name: string }) => d.name);
      const parts = body.contents?.at(-1)?.parts ?? [];
      if (parts.some((p: { functionResponse?: unknown }) => p.functionResponse)) {
        for (const p of parts) if (p.functionResponse) cloudToolResults.push(p.functionResponse.response);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Refused.' }] } }] }));
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'github_create_branch', args: { owner: 'malachico', repo: 'a2a-hub', branch: 'feat/nope' } } },
                  {
                    functionCall: {
                      name: 'github_put_file',
                      args: { owner: 'malachico', repo: 'a2a-hub', path: 'src/x.ts', content: 'eA==', message: 'nope', branch: 'main' },
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    }) as typeof fetch;

    const hub = createHub({
      db: testDb(),
      config: testConfig({
        cloudAgents: { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } },
        githubAppId: '5448582',
        githubAppPrivateKey: TEST_PRIVATE_KEY,
      }),
      cloudFetch,
      cloudToken: async () => 'ya29.test',
      githubFetch,
    });

    const owner = await testPerson(hub.registry, 'Malachi');

    // 1. Read-only (act=false) cloud agent gets zero write tools declared and direct write calls are refused
    const roCloud = await hub.createCloudAgent(owner, { name: 'ReadOnlyCloud', description: 'Reviewer' });
    await hub.send(owner, { to: roCloud.id }, [{ text: 'Try creating a branch' }]);
    await hub.wakeService.idle();
    for (const writeName of GITHUB_WRITE_TOOL_NAMES) {
      expect(cloudDeclared).not.toContain(writeName);
    }
    expect(cloudDeclared).toEqual(expect.arrayContaining(['github_pr_diff', 'github_pr_files', 'github_list_dir', 'github_get_content']));
    expect(cloudToolResults).toEqual([
      { ok: false, error: 'Read-only: ask your owner to enable acting in Tools settings before posting to GitHub.' },
      { ok: false, error: 'Read-only: ask your owner to enable acting in Tools settings before posting to GitHub.' },
    ]);
    expect(ghCalls).toHaveLength(0);

    // 2. Read-only (act=false) computer agent gets zero write tools from find_tools and run_tool refuses all write tools
    const { agent: roComp } = await hub.registry.createBot(owner, { hired: true, name: 'ReadOnlyCompi' });
    await hub.setAgentTools(owner, roComp.id, { toolkits: ['github'], act: false });
    const roCompRec = (await hub.registry.get(roComp.id))!;

    const roFound = (await hub.appTool(roCompRec, 'find_tools', {})) as {
      ok: boolean;
      tools: { tool: string; writes?: boolean }[];
    };
    expect(roFound.ok).toBe(true);
    expect(roFound.tools.map((t) => t.tool)).toEqual([
      'github_pr_diff',
      'github_pr_files',
      'github_list_dir',
      'github_get_content',
    ]);
    expect(roFound.tools.some((t) => t.writes)).toBe(false);

    for (const writeTool of ['github_create_branch', 'github_put_file', 'github_open_pr', 'github_merge_pr', 'github_comment']) {
      const res = await hub.appTool(roCompRec, 'run_tool', {
        tool: writeTool,
        arguments: { owner: 'malachico', repo: 'a2a-hub', branch: 'feat/x', path: 'a.ts', content: 'eA==', message: 'm', title: 't', head: 'h', base: 'main', number: 1, body: 'b' },
      });
      expect(res).toEqual({
        ok: false,
        error: 'Read-only: ask your owner to enable acting in Tools settings before posting to GitHub.',
      });
    }
    expect(ghCalls).toHaveLength(0);

    // 3. Public-workspace (publicShowcase) agent cannot write even if in a public workspace
    const pubWs = await hub.registry.createWorkspace(owner, 'PublicShowcaseWS');
    await hub.registry.setWorkspacePublicShowcase(owner, pubWs.id, true);
    const updatedOwner = (await hub.registry.get(owner.id))!;
    const { agent: pubBot } = await hub.registry.createBot(updatedOwner, { hired: true, name: 'ShowcaseCompi' });
    await hub.registry.addToWorkspace(updatedOwner, pubWs.id, pubBot.id);
    await hub.setAgentTools(updatedOwner, pubBot.id, { toolkits: ['github'], act: false });
    const pubBotRec = (await hub.registry.get(pubBot.id))!;

    const pubFound = (await hub.appTool(pubBotRec, 'find_tools', { app: 'github' })) as {
      ok: boolean;
      tools: { tool: string; writes?: boolean }[];
    };
    expect(pubFound.tools.some((t) => GITHUB_WRITE_TOOL_NAMES.has(t.tool))).toBe(false);
    expect(
      await hub.appTool(pubBotRec, 'run_tool', {
        tool: 'github_create_branch',
        arguments: { owner: 'malachico', repo: 'a2a-hub', branch: 'feat/pwn' },
      }),
    ).toEqual({
      ok: false,
      error: 'Read-only: ask your owner to enable acting in Tools settings before posting to GitHub.',
    });
    expect(ghCalls).toHaveLength(0);

    // 4. Write to a non-installed repo fails cleanly, and github_put_file enforces path traversal + size caps
    await hub.setAgentTools(updatedOwner, roComp.id, { toolkits: ['github'], act: true });
    const actCompRec = (await hub.registry.get(roComp.id))!;

    for (const badPath of ['../secret.txt', 'src/../../etc/passwd', '/etc/passwd', 'src/%2e%2e/secret.txt', 'src\\..\\secret.txt', '.git/config']) {
      const res = await hub.appTool(actCompRec, 'run_tool', {
        tool: 'github_put_file',
        arguments: {
          owner: 'malachico',
          repo: 'a2a-hub',
          path: badPath,
          content: Buffer.from('x').toString('base64'),
          message: 'bad path',
          branch: 'feat/x',
        },
      });
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/path traversal|invalid path/i) });
    }
    expect(ghCalls).toHaveLength(0);

    const oversized = Buffer.alloc(GITHUB_PUT_FILE_MAX_BYTES + 1, 0x61).toString('base64');
    const sizeRes = await hub.appTool(actCompRec, 'run_tool', {
      tool: 'github_put_file',
      arguments: {
        owner: 'malachico',
        repo: 'a2a-hub',
        path: 'src/huge.bin',
        content: oversized,
        message: 'too big',
        branch: 'feat/x',
      },
    });
    expect(sizeRes).toMatchObject({ ok: false, error: expect.stringMatching(/exceeds maximum size/) });
    expect(ghCalls).toHaveLength(0);

    const nonInstalledBranch = await hub.appTool(actCompRec, 'run_tool', {
      tool: 'github_create_branch',
      arguments: { owner: 'uninstalled-org', repo: 'some-repo', branch: 'feat/x', from: 'main' },
    });
    expect(nonInstalledBranch).toEqual({
      ok: false,
      error: 'GitHub App is not installed on uninstalled-org',
    });

    const nonInstalledPut = await hub.appTool(actCompRec, 'run_tool', {
      tool: 'github_put_file',
      arguments: {
        owner: 'uninstalled-org',
        repo: 'some-repo',
        path: 'src/index.ts',
        content: Buffer.from('hi').toString('base64'),
        message: 'feat: test',
        branch: 'feat/x',
      },
    });
    expect(nonInstalledPut).toEqual({
      ok: false,
      error: 'GitHub App is not installed on uninstalled-org',
    });
  });

  it('scopedToken mints a repo+permission-scoped installation token (POST body carries the scope, no caching)', async () => {
    const requests: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    const mockFetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      requests.push({ method, url, ...(body ? { body } : {}) });
      if (method === 'GET' && url === 'https://api.github.com/app/installations?per_page=100') {
        return new Response(JSON.stringify([{ id: 99123, account: { login: 'malachico' } }]), { status: 200 });
      }
      if (method === 'POST' && url === 'https://api.github.com/app/installations/99123/access_tokens') {
        return new Response(
          JSON.stringify({
            token: 'ghs_scoped_tok',
            expires_at: '2026-10-27T23:26:13Z',
            permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
            repositories: [{ name: 'a2a-hub' }],
          }),
          { status: 201 },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const gh = new GitHubApp({ appId: '5448582', privateKey: TEST_PRIVATE_KEY, fetchImpl: mockFetch });
    const scope = { repositories: ['a2a-hub'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } };
    const first = await gh.scopedToken(undefined, scope);
    expect(first).toEqual({
      token: 'ghs_scoped_tok',
      expiresAt: '2026-10-27T23:26:13Z',
      repositories: ['a2a-hub'],
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    // The scope is sent to GitHub, not just requested locally.
    expect(requests.at(-1)!.body).toEqual(scope);

    // No caching: a second call re-lists and re-mints (scoped tokens must not reuse the full-scope cache).
    await gh.scopedToken(undefined, scope);
    expect(requests.filter((r) => r.url.endsWith('/access_tokens'))).toHaveLength(2);

    // An owner with no matching installation fails clearly.
    await expect(gh.scopedToken('other-org', scope)).rejects.toThrow('GitHub App is not installed on other-org');
  });

  it('POST /github/token gates on act + github toolkit, then mints a repo-scoped write token', async () => {
    let scopedBody: Record<string, unknown> | undefined;
    const githubFetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.endsWith('/app/installations?per_page=100')) {
        return new Response(JSON.stringify([{ id: 42, account: { login: 'malachico' } }]), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/app/installations/7/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_other', permissions: {} }), { status: 201 });
      }
      if (method === 'POST' && url.endsWith('/app/installations/42/access_tokens')) {
        scopedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        return new Response(
          JSON.stringify({ token: 'ghs_scoped', expires_at: '2026-10-27T23:26:13Z', permissions: scopedBody?.permissions, repositories: [{ name: 'parly' }] }),
          { status: 201 },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const { app, hub } = createApp({
      db: testDb(),
      config: testConfig({ githubAppId: '5448582', githubAppPrivateKey: TEST_PRIVATE_KEY }),
      githubFetch,
    });
    const owner = await testPerson(hub.registry, 'Malachi');
    const { agent, token } = await hub.registry.createBot(owner, { hired: true, name: 'Compi' });

    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const mint = () => fetch(`${baseUrl}/github/token`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

      // No token → 401 (requireAgent).
      expect((await fetch(`${baseUrl}/github/token`, { method: 'POST' })).status).toBe(401);

      // Has github but not act → 403.
      await hub.registry.setTools(agent.id, { toolkits: ['github'], act: false });
      expect((await mint()).status).toBe(403);

      // Acts but no github toolkit → 403.
      await hub.registry.setTools(agent.id, { toolkits: [], act: true });
      expect((await mint()).status).toBe(403);

      // act + github, but the owner hasn't connected GitHub → 404, never another account's install.
      await hub.registry.setTools(agent.id, { toolkits: ['github'], act: true });
      await hub.githubInstalls!.save({ installationId: 7, ownerId: 'someone-else', accountLogin: 'acme', repos: [], installedBy: 'someone-else' });
      expect((await mint()).status).toBe(404);

      // Another owner can't take over an install that's already mapped.
      await expect(
        hub.githubInstalls!.save({ installationId: 7, ownerId: owner.id, accountLogin: 'acme', repos: [], installedBy: owner.id }),
      ).rejects.toThrow('another owner');
      expect((await hub.githubInstalls!.forOwner('someone-else'))?.installationId).toBe(7);
      expect((await mint()).status).toBe(404);

      // Mapped to its owner → 200, a token from that install only, scoped to its repos.
      // An older install for the same owner (sorts first by doc id) must not shadow the reinstall.
      await hub.githubInstalls!.save({ installationId: 100, ownerId: owner.id, accountLogin: 'malachico', repos: [], installedBy: owner.id });
      await new Promise((r) => setTimeout(r, 5));
      await hub.githubInstalls!.save({ installationId: 42, ownerId: owner.id, accountLogin: 'malachico', repos: ['parly'], installedBy: owner.id });
      const ok = await mint();
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        token: 'ghs_scoped',
        expiresAt: '2026-10-27T23:26:13Z',
        repositories: ['parly'],
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      });
      expect(scopedBody).toEqual({ repositories: ['parly'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });

      // A human caller is refused even with act + github set (people use their own git creds).
      const authRes = await fetch(`${baseUrl}/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'dev:gh-token-human@people.test' }),
      });
      const human = (await authRes.json()) as { agent: { id: string }; token: string };
      await hub.registry.setTools(human.agent.id, { toolkits: ['github'], act: true });
      const humanRes = await fetch(`${baseUrl}/github/token`, { method: 'POST', headers: { authorization: `Bearer ${human.token}` } });
      expect(humanRes.status).toBe(403);
    } finally {
      server.close();
    }
  });
});
