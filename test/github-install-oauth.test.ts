import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testConfig, testDb } from './helpers.js';

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Install = {
  id: number;
  account: { login: string; type?: string };
  repository_selection?: string;
};

function appWithGitHub(githubFetch: typeof fetch) {
  return createApp({
    db: testDb(),
    config: testConfig({
      publicUrl: 'https://hub.parly.test',
      webUrl: 'https://parly.test',
      githubAppId: '5448582',
      githubAppPrivateKey: TEST_PRIVATE_KEY,
      githubClientId: 'Iv1.client',
      githubClientSecret: 'secret',
    }),
    githubFetch,
  });
}

async function signIn(baseUrl: string, email: string) {
  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: `dev:${email}` }),
  });
  return (await res.json()) as { token: string; agent: { id: string } };
}

async function startState(baseUrl: string, token: string) {
  const connect = await fetch(`${baseUrl}/me/tools/github/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  expect(connect.status).toBe(200);
  return new URL(((await connect.json()) as { url: string }).url).searchParams.get('state')!;
}

/** GitHub's browser redirect hits GET /github/callback (no session), which forwards to the web page; the page posts back signed in. */
async function complete(baseUrl: string, token: string | undefined, query: string) {
  const cb = await fetch(`${baseUrl}/github/callback?${query}`, { redirect: 'manual' });
  expect(cb.status).toBe(302);
  const forwarded = new URL(cb.headers.get('location')!);
  expect(`${forwarded.origin}${forwarded.pathname}`).toBe('https://parly.test/github/installed');
  const res = await fetch(`${baseUrl}/github/oauth/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(Object.fromEntries(forwarded.searchParams)),
  });
  const out = (await res.json()) as { redirectUrl?: string };
  return { status: res.status, location: out.redirectUrl ?? null };
}

/** GitHub stand-in: OAuth token exchange + /user + installations (+ optional repos / org membership). */
function githubStub(opts: {
  userLogin: string;
  installations: Install[] | (() => Install[]);
  repositories?: { name: string }[];
  reposStatus?: number;
  orgMembership?: { role: string; state: string } | null;
  onRevoke?: () => void;
}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const installations = typeof opts.installations === 'function' ? opts.installations() : opts.installations;
    if (url.includes('/applications/') && url.includes('/token') && (init?.method ?? 'GET').toUpperCase() === 'DELETE') {
      opts.onRevoke?.();
      return new Response(null, { status: 204 });
    }
    if (url.includes('login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'ghu_user' }), { status: 200 });
    }
    // Exact /user — not /user/installations or /user/memberships/...
    if (/api\.github\.com\/user(?:\?|$)/.test(url)) {
      return new Response(JSON.stringify({ login: opts.userLogin }), { status: 200 });
    }
    if (url.includes('/user/memberships/orgs/')) {
      if (!opts.orgMembership) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(opts.orgMembership), { status: 200 });
    }
    if (url.includes('/user/installations/') && url.includes('/repositories')) {
      return new Response(JSON.stringify({ repositories: opts.repositories ?? [] }), {
        status: opts.reposStatus ?? 200,
      });
    }
    if (url.includes('/user/installations')) {
      return new Response(JSON.stringify({ installations }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
}

describe('GitHub App install OAuth: bind installation to Parly owner', () => {
  it('callback only saves the install for the signed-in person who started it (no session or another person: nothing saved)', async () => {
    const { app, hub } = appWithGitHub(
      githubStub({ userLogin: 'malachico', installations: [{ id: 42, account: { login: 'malachico', type: 'User' }, repository_selection: 'all' }] }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const alice = await signIn(baseUrl, 'alice-gh-csrf@people.test');
      const bob = await signIn(baseUrl, 'bob-gh-csrf@people.test');
      const query = async () => `code=c&state=${encodeURIComponent(await startState(baseUrl, alice.token))}&installation_id=42&setup_action=install`;

      const bare = await fetch(`${baseUrl}/github/callback?${await query()}`, { redirect: 'manual' });
      expect(bare.status).toBe(302);
      expect(bare.headers.get('location')).toMatch(/^https:\/\/parly\.test\/github\/installed\?/);
      expect(await hub.githubInstalls!.forOwner(alice.agent.id)).toBeUndefined();

      expect((await complete(baseUrl, undefined, await query())).status).toBe(401);
      expect((await complete(baseUrl, bob.token, await query())).status).toBe(403);
      expect(await hub.githubInstalls!.forOwner(alice.agent.id)).toBeUndefined();
      expect(await hub.githubInstalls!.forOwner(bob.agent.id)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('callback saves the install for the state owner and rejects a faked installation_id', async () => {
    let installations: Install[] = [{ id: 42, account: { login: 'malachico', type: 'User' }, repository_selection: 'all' }];
    let revoked = 0;
    const { app, hub } = appWithGitHub(
      githubStub({ userLogin: 'malachico', installations: () => installations, onRevoke: () => { revoked += 1; } }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const alice = await signIn(baseUrl, 'alice-gh-oauth@people.test');
      const bob = await signIn(baseUrl, 'bob-gh-oauth@people.test');

      const state = await startState(baseUrl, alice.token);

      expect(
        ((await (await fetch(`${baseUrl}/me/tools`, { headers: { authorization: `Bearer ${alice.token}` } })).json()) as {
          connected: { account: { status: string } }[];
        }).connected[0]?.account.status,
      ).toBe('NOT_INSTALLED');

      const cb = await complete(baseUrl, alice.token, `code=oauth-code&state=${encodeURIComponent(state)}&installation_id=42&setup_action=install`);
      expect(cb.status).toBe(200);
      expect(cb.location).toBe('https://parly.test/?github=installed');
      expect(revoked).toBeGreaterThanOrEqual(1);
      expect(await hub.githubInstalls!.forOwner(alice.agent.id)).toMatchObject({
        installationId: 42,
        ownerId: alice.agent.id,
        accountLogin: 'malachico',
        repos: [],
      });
      expect(await hub.githubInstalls!.forOwner(bob.agent.id)).toBeUndefined();

      const bobState = await startState(baseUrl, bob.token);
      installations = [{ id: 42, account: { login: 'malachico', type: 'User' }, repository_selection: 'all' }];
      const fake = await complete(baseUrl, bob.token, `code=oauth-code-2&state=${encodeURIComponent(bobState)}&installation_id=999&setup_action=install`);
      expect(fake.location).toContain('error=');
      expect(await hub.githubInstalls!.forOwner(bob.agent.id)).toBeUndefined();

      const replay = await complete(baseUrl, alice.token, `code=oauth-code-3&state=${encodeURIComponent(state)}&installation_id=42&setup_action=install`);
      expect(replay.location).toContain('expired');
    } finally {
      server.close();
    }
  });

  it('callback redirects (not 500) when save() refuses a cross-owner overwrite', async () => {
    // Same GitHub user (malachico) connecting two Parly owners to one install — claim passes, save() must not.
    const { app, hub } = appWithGitHub(
      githubStub({
        userLogin: 'malachico',
        installations: [{ id: 42, account: { login: 'malachico', type: 'User' }, repository_selection: 'all' }],
      }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const alice = await signIn(baseUrl, 'alice-claim@people.test');
      const bob = await signIn(baseUrl, 'bob-claim@people.test');

      const aliceState = await startState(baseUrl, alice.token);
      const aliceCb = await complete(baseUrl, alice.token, `code=c1&state=${encodeURIComponent(aliceState)}&installation_id=42&setup_action=install`);
      expect(aliceCb.location).toBe('https://parly.test/?github=installed');
      expect(await hub.githubInstalls!.forOwner(alice.agent.id)).toMatchObject({ installationId: 42 });

      const bobState = await startState(baseUrl, bob.token);
      const bobCb = await complete(baseUrl, bob.token, `code=c2&state=${encodeURIComponent(bobState)}&installation_id=42&setup_action=install`);
      expect(bobCb.status).toBe(200);
      expect(decodeURIComponent(bobCb.location!)).toMatch(/another owner/i);
      expect(await hub.githubInstalls!.forOwner(bob.agent.id)).toBeUndefined();
      expect(await hub.githubInstalls!.forOwner(alice.agent.id)).toMatchObject({ installationId: 42, ownerId: alice.agent.id });
    } finally {
      server.close();
    }
  });

  it('callback refuses a User install when the OAuth user is only a collaborator (login mismatch)', async () => {
    const { app, hub } = appWithGitHub(
      githubStub({
        userLogin: 'collaborator',
        installations: [{ id: 42, account: { login: 'malachico', type: 'User' }, repository_selection: 'all' }],
      }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token, agent } = await signIn(baseUrl, 'collab@people.test');
      const state = await startState(baseUrl, token);
      const cb = await complete(baseUrl, token, `code=c&state=${encodeURIComponent(state)}&installation_id=42&setup_action=install`);
      expect(cb.status).toBe(200);
      expect(decodeURIComponent(cb.location!)).toMatch(/owns this installation/i);
      expect(await hub.githubInstalls!.forOwner(agent.id)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('callback refuses an Organization install unless the OAuth user is an active org admin', async () => {
    const { app, hub } = appWithGitHub(
      githubStub({
        userLogin: 'member',
        installations: [{ id: 55, account: { login: 'acme-corp', type: 'Organization' }, repository_selection: 'all' }],
        orgMembership: { role: 'member', state: 'active' },
      }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token, agent } = await signIn(baseUrl, 'member@people.test');
      const state = await startState(baseUrl, token);
      const cb = await complete(baseUrl, token, `code=c&state=${encodeURIComponent(state)}&installation_id=55&setup_action=install`);
      expect(decodeURIComponent(cb.location!)).toMatch(/organization admin/i);
      expect(await hub.githubInstalls!.forOwner(agent.id)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('callback accepts an Organization install when the OAuth user is an active org admin', async () => {
    const { app, hub } = appWithGitHub(
      githubStub({
        userLogin: 'boss',
        installations: [{ id: 55, account: { login: 'acme-corp', type: 'Organization' }, repository_selection: 'all' }],
        orgMembership: { role: 'admin', state: 'active' },
      }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token, agent } = await signIn(baseUrl, 'boss@people.test');
      const state = await startState(baseUrl, token);
      const cb = await complete(baseUrl, token, `code=c&state=${encodeURIComponent(state)}&installation_id=55&setup_action=install`);
      expect(cb.location).toBe('https://parly.test/?github=installed');
      expect(await hub.githubInstalls!.forOwner(agent.id)).toMatchObject({
        installationId: 55,
        accountLogin: 'acme-corp',
        repos: [],
      });
    } finally {
      server.close();
    }
  });

  it('callback stores concrete repos for repository_selection=selected (not [] meaning all)', async () => {
    const { app, hub } = appWithGitHub(
      githubStub({
        userLogin: 'acme',
        installations: [{ id: 77, account: { login: 'acme', type: 'User' }, repository_selection: 'selected' }],
        repositories: [{ name: 'parly' }, { name: 'notes' }],
      }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token, agent } = await signIn(baseUrl, 'selected-repos@people.test');
      const state = await startState(baseUrl, token);
      const cb = await complete(baseUrl, token, `code=c&state=${encodeURIComponent(state)}&installation_id=77&setup_action=install`);
      expect(cb.status).toBe(200);
      expect(await hub.githubInstalls!.forOwner(agent.id)).toMatchObject({
        installationId: 77,
        accountLogin: 'acme',
        repos: ['parly', 'notes'],
      });
    } finally {
      server.close();
    }
  });

  it('callback refuses selected with zero repositories (would otherwise save repos:[] as all)', async () => {
    const { app, hub } = appWithGitHub(
      githubStub({
        userLogin: 'acme',
        installations: [{ id: 88, account: { login: 'acme', type: 'User' }, repository_selection: 'selected' }],
        repositories: [],
      }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token, agent } = await signIn(baseUrl, 'selected-empty@people.test');
      const state = await startState(baseUrl, token);
      const bad = await complete(baseUrl, token, `code=c&state=${encodeURIComponent(state)}&installation_id=88&setup_action=install`);
      expect(decodeURIComponent(bad.location!)).toMatch(/no repositories selected/i);
      expect(await hub.githubInstalls!.forOwner(agent.id)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('callback refuses selected installs when the repo list request fails', async () => {
    const { app, hub } = appWithGitHub(
      githubStub({
        userLogin: 'acme',
        installations: [{ id: 88, account: { login: 'acme', type: 'User' }, repository_selection: 'selected' }],
        reposStatus: 500,
      }),
    );
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token, agent } = await signIn(baseUrl, 'selected-fail@people.test');
      const state = await startState(baseUrl, token);
      const bad = await complete(baseUrl, token, `code=c&state=${encodeURIComponent(state)}&installation_id=88&setup_action=install`);
      expect(bad.location).toContain('error=');
      expect(await hub.githubInstalls!.forOwner(agent.id)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('callback follows Link rel="next" pagination for /user/installations and /user/installations/:id/repositories', async () => {
    const page1Installs = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: { login: `other-${i + 1}`, type: 'User' },
      repository_selection: 'all',
    }));
    const page1Repos = Array.from({ length: 100 }, (_, i) => ({ name: `repo-${i + 1}` }));
    const { app, hub } = appWithGitHub((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu_user' }));
      if (/api\.github\.com\/user(?:\?|$)/.test(url)) return new Response(JSON.stringify({ login: 'acme' }));
      if (url === 'https://api.github.com/user/installations?per_page=100') {
        return new Response(JSON.stringify({ installations: page1Installs }), {
          headers: { link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"' },
        });
      }
      if (url === 'https://api.github.com/user/installations?per_page=100&page=2') {
        return new Response(
          JSON.stringify({ installations: [{ id: 150, account: { login: 'acme', type: 'User' }, repository_selection: 'selected' }] }),
        );
      }
      if (url === 'https://api.github.com/user/installations/150/repositories?per_page=100') {
        return new Response(JSON.stringify({ repositories: page1Repos }), {
          headers: { link: '<https://api.github.com/user/installations/150/repositories?per_page=100&page=2>; rel="next"' },
        });
      }
      if (url === 'https://api.github.com/user/installations/150/repositories?per_page=100&page=2') {
        return new Response(JSON.stringify({ repositories: [{ name: 'repo-101' }] }));
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch);
    const server = app.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { token, agent } = await signIn(baseUrl, 'paged-oauth@people.test');
      const state = await startState(baseUrl, token);
      const cb = await complete(baseUrl, token, `code=c&state=${encodeURIComponent(state)}&installation_id=150&setup_action=install`);
      expect(cb.status).toBe(200);
      expect(cb.location).toBe('https://parly.test/?github=installed');
      const saved = await hub.githubInstalls!.forOwner(agent.id);
      expect(saved?.installationId).toBe(150);
      expect(saved?.repos).toHaveLength(101);
      expect(saved?.repos).toContain('repo-101');
    } finally {
      server.close();
    }
  });
});
