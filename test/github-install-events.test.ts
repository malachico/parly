import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runGitHubCloudTool } from '../src/hub/github.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const secret = 'installation-event-test';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

async function fixture() {
  const remote = { selection: 'selected', repos: ['old', 'new'], failure: false, calls: [] as string[] };
  const githubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    remote.calls.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}`);
    if (remote.failure) return new Response('unavailable', { status: 503 });
    if (u.pathname === '/app/installations/77') return Response.json({ repository_selection: remote.selection });
    if (u.pathname === '/app/installations') return Response.json([{ id: 77, account: { login: 'acme' } }]);
    if (u.pathname === '/app/installations/77/access_tokens') return Response.json({ token: 'ghs_test', permissions: { metadata: 'read' } });
    if (u.pathname === '/installation/repositories') {
      const page = Number(u.searchParams.get('page') ?? 1);
      return Response.json({ repositories: remote.repos.slice((page - 1) * 100, page * 100).map((name) => ({ name })) }, {
        headers: page * 100 < remote.repos.length ? { link: `<https://api.github.com/installation/repositories?per_page=100&page=${page + 1}>; rel="next"` } : {},
      });
    }
    if (u.pathname === '/repos/acme/new/issues/1/comments') return Response.json({ html_url: 'https://github.com/acme/new/issues/1#comment' });
    throw new Error(`Unexpected GitHub call: ${url}`);
  }) as typeof fetch;
  const { app, hub } = createApp({ db: testDb(), config: testConfig({ githubAppId: '123', githubAppPrivateKey: privateKey, githubWebhookSecret: secret }), githubFetch });
  const server = app.listen(0);
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = await testPerson(hub.registry, 'Install owner');
  await hub.githubInstalls!.save({ installationId: 77, ownerId: owner.id, installedBy: owner.id, accountLogin: 'acme', repos: ['old'] });
  const post = async (event: string, payload: object, signature?: string) => {
    const body = JSON.stringify({ installation: { id: 77 }, ...payload });
    const res = await fetch(`${url}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
      body,
    });
    return { status: res.status, body: await res.json() as { outcome: string } };
  };
  const comment = async () => runGitHubCloudTool(hub.github!, await hub.githubInstalls!.forOwner(owner.id), 'github_comment', { owner: 'acme', repo: 'new', number: 1, body: 'hello' });
  return { hub, url, owner, remote, post, comment };
}

it('signed repository changes refresh every page, preserve the owner, and change native tool access', async () => {
  const { hub, owner, remote, post, comment } = await fixture();
  const { agent } = await hub.registry.createBot(owner, { name: 'Watcher' });
  const source = await hub.triggerService.ensureSource(owner, { slug: 'GITHUB_PUSH' });
  await hub.triggerService.addListener(owner, source.id, { agentId: agent.id });
  const push = () => post('push', { ref: 'refs/heads/main', repository: { name: 'new', full_name: 'acme/new' } });
  expect((await push()).body.outcome).toBe('ignored');
  expect(await comment()).toMatchObject({ ok: false });
  remote.repos = [...Array.from({ length: 100 }, (_, i) => `repo-${i}`), 'new'];
  expect(await post('installation_repositories', { action: 'added', repository_selection: 'selected', repositories_added: [{ name: 'new' }] })).toMatchObject({ status: 200 });
  expect(await hub.githubInstalls!.forOwner(owner.id)).toMatchObject({ ownerId: owner.id, installedBy: owner.id, repositorySelection: 'selected', repos: remote.repos });
  expect(remote.calls).toContain('GET /installation/repositories?per_page=100&page=2');
  expect(await comment()).toMatchObject({ ok: true });
  expect((await push()).body.outcome).toBe('delivered');
  expect((await hub.chat.page(agent, `agent:${owner.id}`, 10)).messages).toHaveLength(1);

  remote.repos = ['old'];
  await post('installation_repositories', { action: 'removed', repositories_removed: [{ name: 'new' }] });
  expect(await comment()).toMatchObject({ ok: false });
  expect((await push()).body.outcome).toBe('ignored');
  // An old delivery is replayed after removal: current GitHub scope wins over its stale delta.
  await post('installation_repositories', { action: 'added', repositories_added: [{ name: 'new' }] });
  expect(await hub.githubInstalls!.forOwner(owner.id)).toMatchObject({ repos: ['old'] });
});

it('switching between all and an empty selected list never turns selected into wildcard access', async () => {
  const { hub, url, owner, remote, post, comment } = await fixture();
  remote.selection = 'all';
  await post('installation_repositories', { action: 'added', repository_selection: 'all' });
  expect(await comment()).toMatchObject({ ok: true });
  remote.selection = 'selected';
  remote.repos = [];
  // A stale all-repositories payload cannot override the installation's current selection.
  await post('installation_repositories', { action: 'removed', repository_selection: 'all', repositories_removed: [] });
  expect(await hub.githubInstalls!.forOwner(owner.id)).toMatchObject({ repositorySelection: 'selected', repos: [] });
  expect(await comment()).toMatchObject({ ok: false });
  const { agent, token } = await hub.registry.createBot(owner, { name: 'Git agent' });
  await hub.registry.setTools(agent.id, { toolkits: ['github'], act: true });
  const res = await fetch(`${url}/github/token`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
});

it('uninstall removes only the bound installation and unsigned or unknown-install events cannot change bindings', async () => {
  const { hub, owner, remote, post } = await fixture();
  await hub.githubInstalls!.save({ installationId: 88, ownerId: 'another-owner', installedBy: 'another-owner', accountLogin: 'other', repos: ['private'] });
  expect((await post('installation', { action: 'deleted' }, 'sha256=bad')).status).toBe(401);
  expect(await hub.githubInstalls!.forOwner(owner.id)).toBeDefined();
  await post('installation_repositories', { action: 'added', installation: { id: 999 } });
  expect(remote.calls).toEqual([]);
  expect(await hub.githubInstalls!.get(999)).toBeUndefined();
  await post('installation', { action: 'deleted' });
  expect(await hub.githubInstalls!.forOwner(owner.id)).toBeUndefined();
  expect(await hub.githubInstalls!.forOwner('another-owner')).toMatchObject({ installationId: 88 });
  expect((await post('installation', { action: 'deleted' })).body.outcome).toBe('ignored');
});

it('a failed scope refresh is retriable and does not replace the last known scope', async () => {
  const { hub, owner, remote, post } = await fixture();
  remote.failure = true;
  expect((await post('installation_repositories', { action: 'added' })).status).toBe(500);
  expect(await hub.githubInstalls!.forOwner(owner.id)).toMatchObject({ repos: ['old'] });
  remote.failure = false;
  expect((await post('installation_repositories', { action: 'added' })).status).toBe(200);
  expect(await hub.githubInstalls!.forOwner(owner.id)).toMatchObject({ repos: ['old', 'new'] });
});
