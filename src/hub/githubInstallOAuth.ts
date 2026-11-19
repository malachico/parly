import { randomBytes } from 'node:crypto';
import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';
import { githubInstallUrl } from './composio.js';
import type { GitHubInstall, GitHubInstalls } from './githubInstalls.js';
import { HubStore } from './hubStore.js';

const STATE_TTL_MS = 10 * 60_000;
const STATE_RE = /^[A-Za-z0-9_-]{10,64}$/;

interface GitHubInstallOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  appSlug: string;
  publicUrl: string;
  webUrl: string;
  fetchImpl?: typeof fetch;
}

interface UserInstallation {
  id: number;
  account?: { login?: string; type?: string; id?: number };
  repository_selection?: string;
}

const GH_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'parly-hub',
  'x-github-api-version': '2022-11-28',
} as const;

/**
 * GitHub App install → Parly owner: single-use `state` (like Slack), callback exchanges `code`,
 * verifies `installation_id` via `GET /user/installations`, then `githubInstalls.save`.
 */
export class GitHubInstallOAuth {
  private readonly store: HubStore;
  private readonly fetchImpl: typeof fetch;

  constructor(
    db: Database,
    private readonly installs: GitHubInstalls,
    private readonly opts: GitHubInstallOAuthOptions,
  ) {
    this.store = new HubStore(db);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get callbackUrl(): string {
    return `${this.opts.publicUrl.replace(/\/+$/, '')}/github/callback`;
  }

  /** Web page GitHub's redirect is forwarded to; it posts back with the signed-in person's token. */
  get installedPageUrl(): string {
    return `${this.opts.webUrl.replace(/\/+$/, '')}/github/installed`;
  }

  get configured(): boolean {
    return Boolean(this.opts.clientId?.trim() && this.opts.clientSecret?.trim());
  }

  /** Starts a GitHub App install for the signed-in person with a single-use 10-minute `state`. */
  async startInstall(caller: AgentRecord, now = Date.now()): Promise<{ url: string; state: string }> {
    if (caller.kind !== 'human') throw new HubError('forbidden', 'Only a person can connect GitHub');
    if (!this.configured) {
      throw new HubError('unavailable', 'GitHub App OAuth is not configured on this hub (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)');
    }

    const state = randomBytes(18).toString('base64url');
    await this.store.saveGitHubOAuthState(state, caller.id, new Date(now + STATE_TTL_MS));

    const url = new URL(githubInstallUrl(this.opts.appSlug));
    url.searchParams.set('state', state);
    return { url: url.toString(), state };
  }

  /** Spends an OAuth state once; returns undefined if unknown, already used, or expired. */
  async spendState(state: string, now = Date.now()): Promise<{ ownerId: string } | undefined> {
    if (!STATE_RE.test(state)) return undefined;
    return this.store.spendGitHubOAuthState(state, now);
  }

  /**
   * POST /github/oauth/complete: spends `state`, requires the signed-in `caller` to be the person who started it,
   * exchanges `code` for a user token, verifies `installation_id` is in that user's `GET /user/installations`,
   * then saves the install for `state.ownerId`.
   */
  async handleCallback(
    caller: AgentRecord,
    query: { code?: string; state?: string; installation_id?: string; setup_action?: string; error?: string; error_description?: string },
    now = Date.now(),
  ): Promise<{ redirectUrl: string; install?: GitHubInstall }> {
    const web = this.opts.webUrl.replace(/\/+$/, '');
    const fail = (msg: string) => ({ redirectUrl: `${web}/?error=${encodeURIComponent(msg)}` });
    const ok = (path: string) => ({ redirectUrl: `${web}${path}` });

    const stateData = await this.spendState(query.state ?? '', now);
    if (!stateData) return fail('This GitHub installation link has expired or was already used. Start again from Apps.');
    if (caller.kind !== 'human' || caller.id !== stateData.ownerId) {
      throw new HubError('forbidden', 'Only the person who started this GitHub installation can complete it');
    }

    if (query.error) {
      return fail(query.error_description || query.error || 'GitHub installation was cancelled.');
    }
    if (query.setup_action === 'request') {
      // Org install needs admin approval; nothing to save yet.
      return ok('/?github=requested');
    }

    const installationId = Number(query.installation_id);
    if (!query.code || !Number.isInteger(installationId) || installationId <= 0) {
      return fail('GitHub did not return an installation. Start again from Apps.');
    }
    if (!this.configured) return fail('GitHub App OAuth is not configured on this hub.');

    const tokenRes = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        code: query.code,
        redirect_uri: this.callbackUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenOut = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !tokenOut.access_token) {
      return fail(tokenOut.error_description || tokenOut.error || 'GitHub refused the installation code.');
    }

    const userToken = tokenOut.access_token;
    try {
      const authHeaders = { authorization: `Bearer ${userToken}`, ...GH_HEADERS };

      const installations = await this.fetchPages<UserInstallation>(
        'https://api.github.com/user/installations?per_page=100',
        authHeaders,
        (body) => (body as { installations?: UserInstallation[] }).installations,
      );
      if (!installations) return fail('Could not list your GitHub App installations.');
      const matched = installations.find((i) => i.id === installationId);
      if (!matched) {
        // Faked or foreign installation_id: do not save.
        return fail('That GitHub installation is not one of yours.');
      }

      const accountLogin = matched.account?.login?.trim();
      if (!accountLogin) return fail('GitHub installation has no account login.');

      // Membership in /user/installations is not enough (collaborators see installs too). Require
      // the OAuth user to own a User install, or be an active org admin for an Organization install.
      const claim = await this.assertCanClaimInstall(authHeaders, matched);
      if (!claim.ok) return fail(claim.reason);

      // `repos: []` means "all repos on this install" — only for repository_selection=all.
      // Selected installs always store the concrete list from GitHub (never default to []).
      let repos: string[];
      if (matched.repository_selection === 'all') {
        repos = [];
      } else if (matched.repository_selection === 'selected') {
        const listed = await this.fetchPages<{ name?: string }>(
          `https://api.github.com/user/installations/${installationId}/repositories?per_page=100`,
          authHeaders,
          (body) => (body as { repositories?: { name?: string }[] }).repositories,
        );
        if (!listed) return fail('Could not list the repositories for this GitHub installation.');
        repos = listed.map((r) => r.name).filter((n): n is string => Boolean(n));
        // Empty selected must not become repos:[] ("all") — that would widen the token scope.
        if (repos.length === 0) return fail('This GitHub installation has no repositories selected yet. Pick at least one repo and try again.');
      } else {
        return fail('GitHub installation has an unknown repository selection.');
      }

      try {
        const install = await this.installs.save({
          installationId,
          ownerId: stateData.ownerId,
          accountLogin,
          repos,
          repositorySelection: matched.repository_selection,
          installedBy: stateData.ownerId,
        });
        return { ...ok('/?github=installed'), install };
      } catch (err) {
        // #449's save() refuses cross-owner overwrite (plain Error or HubError) — redirect, don't 500.
        const msg = err instanceof Error ? err.message : '';
        if (err instanceof HubError || /another owner/i.test(msg)) {
          return fail(msg || 'This GitHub installation belongs to another Parly account.');
        }
        throw err;
      }
    } finally {
      // User-to-server token is only needed for this callback; revoke so it can't be reused if leaked from logs.
      await this.revokeUserToken(userToken).catch(() => undefined);
    }
  }

  /** Revokes a GitHub App user-to-server token (DELETE /applications/{client_id}/token). */
  private async revokeUserToken(accessToken: string): Promise<void> {
    if (!this.opts.clientId || !this.opts.clientSecret) return;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    await this.fetchImpl(`https://api.github.com/applications/${encodeURIComponent(this.opts.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
        ...GH_HEADERS,
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** True when the OAuth user may bind this install to their Parly owner (not merely see it). */
  private async assertCanClaimInstall(
    authHeaders: Record<string, string>,
    matched: UserInstallation,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const accountLogin = matched.account?.login?.trim();
    if (!accountLogin) return { ok: false, reason: 'GitHub installation has no account login.' };

    const userRes = await this.fetchImpl('https://api.github.com/user', {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) return { ok: false, reason: 'Could not verify your GitHub account.' };
    const user = (await userRes.json().catch(() => ({}))) as { login?: string };
    const userLogin = user.login?.trim();
    if (!userLogin) return { ok: false, reason: 'Could not verify your GitHub account.' };

    const accountType = (matched.account?.type ?? 'User').toLowerCase();
    if (accountType === 'user') {
      if (userLogin.toLowerCase() !== accountLogin.toLowerCase()) {
        return { ok: false, reason: 'Only the GitHub account that owns this installation can connect it to Parly.' };
      }
      return { ok: true };
    }
    if (accountType === 'organization') {
      const memRes = await this.fetchImpl(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(accountLogin)}`, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      if (!memRes.ok) {
        return { ok: false, reason: 'Only an organization admin can connect this GitHub installation to Parly.' };
      }
      const mem = (await memRes.json().catch(() => ({}))) as { role?: string; state?: string };
      if (mem.role !== 'admin' || mem.state !== 'active') {
        return { ok: false, reason: 'Only an organization admin can connect this GitHub installation to Parly.' };
      }
      return { ok: true };
    }
    return { ok: false, reason: 'GitHub installation has an unknown account type.' };
  }

  private async fetchPages<T>(
    firstUrl: string,
    headers: Record<string, string>,
    extract: (body: unknown) => T[] | undefined,
  ): Promise<T[] | undefined> {
    const all: T[] = [];
    let url: string | undefined = firstUrl;
    while (url) {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return undefined;
      const items = extract(await res.json().catch(() => ({})));
      if (Array.isArray(items)) all.push(...items);
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    }
    return all;
  }
}
