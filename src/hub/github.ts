import { createSign } from 'node:crypto';
import { GITHUB_PUT_FILE_MAX_BYTES } from './githubTools.js';

export {
  GITHUB_CLOUD_TOOLS,
  GITHUB_NATIVE_LOGO,
  GITHUB_NATIVE_NAME,
  GITHUB_PUT_FILE_MAX_BYTES,
  GITHUB_READ_TOOL_NAMES,
  GITHUB_WRITE_TOOL_NAMES,
  runGitHubCloudTool,
} from './githubTools.js';

const DEFAULT_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';
/** Installation access tokens live for 60 minutes; cache them for 55 minutes before refreshing. */
export const INSTALLATION_TOKEN_TTL_MS = 55 * 60_000;
/** App JWT lifetime in seconds (must be <= 10 minutes per GitHub's spec). */
export const APP_JWT_EXP_SECONDS = 9 * 60;
/** Headers common to GitHub API calls. */
const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'parly-hub',
  'x-github-api-version': '2022-11-28',
};

interface GitHubAppConfig {
  githubAppId?: string;
  githubAppPrivateKey?: string;
}

/** True when both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are present and non-empty. */
export function githubAppEnabled(config?: GitHubAppConfig): boolean {
  return Boolean(config?.githubAppId?.trim() && config?.githubAppPrivateKey?.trim());
}

/** Normalizes a PEM string (converting literal `\n` sequences if passed via single-line env). */
function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, '\n').trim();
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Mints a short-lived GitHub App JWT signed with RS256 (`iss = appId`, `iat = now - 60`, `exp = now + 540` <= 10min).
 */
export function mintGitHubAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const iss = appId.trim();
  const key = normalizePem(privateKeyPem);
  if (!iss || !key) throw new Error('GitHub App ID and private key are required to mint an App JWT');
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: nowSec - 60,
      exp: nowSec + APP_JWT_EXP_SECONDS,
      iss,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key).toString('base64url');
  return `${signingInput}.${signature}`;
}

interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Optional zero-scope public-read token used for reads on repos the App isn't installed on (5,000 req/hr vs 60 unauth). */
  publicReadToken?: string;
}

interface GitHubInstallation {
  id: number;
  account?: { login?: string };
}

/**
 * Parly's GitHub App outbound client: mints an RS256 App JWT, exchanges it for an installation access token via
 * `GET /app/installations` + `POST /app/installations/{id}/access_tokens` (cached ~55min), and executes minimal
 * outbound actions (`github_comment`, `github_open_pr`).
 */
export class GitHubApp {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly publicReadToken?: string;
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private noInstalls = false;

  constructor(opts: GitHubAppOptions) {
    this.appId = opts.appId.trim();
    this.privateKey = normalizePem(opts.privateKey);
    this.apiUrl = (opts.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? INSTALLATION_TOKEN_TTL_MS;
    this.publicReadToken = opts.publicReadToken?.trim() || undefined;
  }

  /** Mints a fresh App JWT for authenticating `/app/*` endpoints. */
  jwt(): string {
    return mintGitHubAppJwt(this.appId, this.privateKey, Math.floor(this.now() / 1000));
  }

  /** Every installation of the App: `GET /app/installations?per_page=100`, following `Link: rel="next"` pages. */
  private async listInstallations(headers: Record<string, string>): Promise<GitHubInstallation[]> {
    const all: GitHubInstallation[] = [];
    let url: string | undefined = `${this.apiUrl}/app/installations?per_page=100`;
    while (url) {
      const res = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`GitHub GET /app/installations failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
      const page = (await res.json()) as GitHubInstallation[];
      if (!Array.isArray(page)) break;
      all.push(...page);
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    }
    return all;
  }

  /**
   * Returns a cached or freshly-exchanged installation access token (discovered via `GET /app/installations`).
   */
  async installationToken(owner?: string): Promise<string> {
    const target = (owner ?? '').trim().toLowerCase();
    if (this.noInstalls) throw new Error(`GitHub App is not installed on ${(owner ?? '').trim() || 'that account'}`);
    const hit = target ? this.cache.get(target) : this.cache.get('*');
    if (hit && this.now() < hit.expiresAt) return hit.token;

    const appJwt = this.jwt();
    const headers = {
      authorization: `Bearer ${appJwt}`,
      ...GITHUB_HEADERS,
    };
    const installations = await this.listInstallations(headers);
    if (installations.length === 0) {
      throw new Error('No GitHub App installations found');
    }
    let matched: GitHubInstallation | undefined;
    if (target) {
      matched = installations.find((i) => i.account?.login?.toLowerCase() === target);
      if (!matched) {
        throw new Error(`GitHub App is not installed on ${owner!.trim()}`);
      }
    } else {
      matched = installations[0]!;
    }

    const tokRes = await this.fetchImpl(`${this.apiUrl}/app/installations/${encodeURIComponent(String(matched.id))}/access_tokens`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokRes.ok) {
      throw new Error(`GitHub POST /app/installations/${matched.id}/access_tokens failed (HTTP ${tokRes.status}): ${(await tokRes.text()).slice(0, 200)}`);
    }
    const data = (await tokRes.json()) as { token?: string };
    if (!data?.token) throw new Error('GitHub installation token response did not include a token');

    const entry = { token: data.token, expiresAt: this.now() + this.ttlMs };
    const login = matched.account?.login?.toLowerCase();
    if (login) this.cache.set(login, entry);
    if (!target) this.cache.set('*', entry);
    return data.token;
  }

  /** Drop tokens minted before a repository permission change or uninstall. */
  forgetInstallation(accountLogin: string): void {
    this.cache.delete(accountLogin.toLowerCase());
    this.cache.delete('*');
  }

  /** Current scope after an installation webhook; fetch the full list so replays and all→selected changes converge. */
  async installationRepositories(installationId: number): Promise<{ repositorySelection: 'all' | 'selected'; repos: string[] }> {
    const detail = await this.fetchImpl(`${this.apiUrl}/app/installations/${installationId}`, {
      headers: { ...GITHUB_HEADERS, authorization: `Bearer ${this.jwt()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!detail.ok) throw new Error(`GitHub installation lookup failed (HTTP ${detail.status})`);
    const { repository_selection: selection } = await detail.json() as { repository_selection?: string };
    if (selection === 'all') return { repositorySelection: 'all', repos: [] };
    if (selection !== 'selected') throw new Error('GitHub installation has an unknown repository selection');
    const { token } = await this.scopedToken(installationId, { permissions: { metadata: 'read' } });
    const repos: string[] = [];
    let url: string | undefined = `${this.apiUrl}/installation/repositories?per_page=100`;
    while (url) {
      const res = await this.fetchImpl(url, {
        headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub repository listing failed (HTTP ${res.status})`);
      const page = await res.json() as { repositories?: { name?: string }[] };
      if (!Array.isArray(page.repositories) || page.repositories.some((r) => typeof r.name !== 'string' || !r.name)) throw new Error('Invalid GitHub repository list');
      repos.push(...page.repositories.map((r) => r.name!));
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    }
    return { repositorySelection: 'selected', repos };
  }

  /** This client with no installation tokens: public reads still work, writes fail. For callers outside an install. */
  publicOnly(): GitHubApp {
    const c = Object.create(this) as GitHubApp;
    c.noInstalls = true;
    return c;
  }

  /**
   * Mints a short-lived installation token scoped DOWN to specific repositories/permissions. Never cached (each
   * request may scope differently, and these go to a sandbox, not the hub). Powers `POST /github/token` so a hosted
   * agent can `git clone`/`push` via Parly's App without a standing PAT. `owner` is an account login, or an
   * installation id (number) to skip the lookup; omitted → the first installation.
   */
  async scopedToken(
    owner: string | number | undefined,
    scope: { repositories?: string[]; permissions: Record<string, string> },
  ): Promise<{ token: string; expiresAt: string; repositories?: string[]; permissions: Record<string, string> }> {
    const headers = {
      authorization: `Bearer ${this.jwt()}`,
      ...GITHUB_HEADERS,
      'content-type': 'application/json',
    };
    let matched: Pick<GitHubInstallation, 'id'> | undefined;
    if (typeof owner === 'number') matched = { id: owner };
    else {
      const installations = await this.listInstallations(headers);
      if (installations.length === 0) throw new Error('No GitHub App installations found');
      const target = (owner ?? '').trim().toLowerCase();
      matched = target ? installations.find((i) => i.account?.login?.toLowerCase() === target) : installations[0];
      if (!matched) throw new Error(`GitHub App is not installed on ${owner!.trim()}`);
    }
    const tokRes = await this.fetchImpl(`${this.apiUrl}/app/installations/${encodeURIComponent(String(matched.id))}/access_tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...(scope.repositories?.length ? { repositories: scope.repositories } : {}), permissions: scope.permissions }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokRes.ok) throw new Error(`GitHub POST /app/installations/${matched.id}/access_tokens failed (HTTP ${tokRes.status}): ${(await tokRes.text()).slice(0, 200)}`);
    const data = (await tokRes.json()) as { token?: string; expires_at?: string; permissions?: Record<string, string>; repositories?: Array<{ name: string }> };
    if (!data?.token) throw new Error('GitHub installation token response did not include a token');
    return {
      token: data.token,
      expiresAt: data.expires_at ?? new Date(this.now() + 60 * 60_000).toISOString(),
      ...(data.repositories ? { repositories: data.repositories.map((r) => r.name) } : {}),
      permissions: data.permissions ?? scope.permissions,
    };
  }

  /**
   * One `/repos/{owner}/{repo}{path}` call: `auth` + GitHub headers (+ JSON content-type when there is a body), 15s timeout.
   * `notFound` throws that message on 404; `fail` throws `GitHub {fail} failed (HTTP n): <body>` on any other non-OK.
   */
  private async ghRequest(
    owner: string,
    repo: string,
    path: string,
    opts: { method: string; auth: Record<string, string>; headers?: Record<string, string>; body?: unknown; notFound?: string; fail?: string },
  ): Promise<Response> {
    const json = opts.body !== undefined;
    const res = await this.fetchImpl(`${this.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
      method: opts.method,
      headers: { ...opts.auth, ...GITHUB_HEADERS, ...(json ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      ...(json ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (opts.notFound && res.status === 404) throw new Error(opts.notFound);
    if (opts.fail && !res.ok) throw new Error(`GitHub ${opts.fail} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  /** `POST /repos/{owner}/{repo}/issues/{number}/comments` (works for both issues and pull requests). */
  async comment(args: { owner: string; repo: string; number: number; body: string }): Promise<Record<string, unknown>> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    const num = Number(args.number);
    const body = String(args.body ?? '').trim();
    if (!owner || !repo) throw new Error('github_comment requires owner and repo');
    if (!Number.isInteger(num) || num <= 0) throw new Error('github_comment requires a positive issue/PR number');
    if (!body) throw new Error('github_comment requires a non-empty body');

    const token = await this.installationToken(owner);
    const res = await this.ghRequest(owner, repo, `/issues/${num}/comments`, {
      method: 'POST',
      auth: { authorization: `Bearer ${token}` },
      body: { body },
      fail: 'comment',
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /** `POST /repos/{owner}/{repo}/pulls` */
  async openPr(args: { owner: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean }): Promise<Record<string, unknown>> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    const title = String(args.title ?? '').trim();
    const head = String(args.head ?? '').trim();
    const base = String(args.base ?? '').trim();
    if (!owner || !repo) throw new Error('github_open_pr requires owner and repo');
    if (!title || !head || !base) throw new Error('github_open_pr requires title, head, and base');

    const token = await this.installationToken(owner);
    const res = await this.ghRequest(owner, repo, '/pulls', {
      method: 'POST',
      auth: { authorization: `Bearer ${token}` },
      body: {
        title,
        head,
        base,
        ...(args.body !== undefined ? { body: String(args.body) } : {}),
        ...(args.draft !== undefined ? { draft: Boolean(args.draft) } : {}),
      },
      fail: 'open PR',
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /** `PUT /repos/{owner}/{repo}/pulls/{number}/merge` */
  async mergePr(args: {
    owner: string;
    repo: string;
    number: number;
    method?: string;
    commitTitle?: string;
    commitMessage?: string;
    sha?: string;
  }): Promise<Record<string, unknown>> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    const num = Number(args.number);
    if (!owner || !repo) throw new Error('github_merge_pr requires owner and repo');
    if (!Number.isInteger(num) || num <= 0) throw new Error('github_merge_pr requires a positive integer number');
    const methodRaw = args.method !== undefined && String(args.method).trim() ? String(args.method).trim().toLowerCase() : 'squash';
    if (methodRaw !== 'merge' && methodRaw !== 'squash' && methodRaw !== 'rebase') {
      throw new Error('github_merge_pr method must be "merge", "squash", or "rebase"');
    }

    const token = await this.installationToken(owner);
    const res = await this.ghRequest(owner, repo, `/pulls/${num}/merge`, {
      method: 'PUT',
      auth: { authorization: `Bearer ${token}` },
      body: {
        merge_method: methodRaw,
        ...(args.commitTitle !== undefined ? { commit_title: String(args.commitTitle) } : {}),
        ...(args.commitMessage !== undefined ? { commit_message: String(args.commitMessage) } : {}),
        ...(args.sha !== undefined ? { sha: String(args.sha) } : {}),
      },
      fail: 'merge PR',
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Auth headers for a read request: the installation token when the App is installed on `owner`, otherwise none
   * so public repos still read (unauthenticated, GitHub's ~60 req/hr/IP limit). Private/external repos then 404.
   * Network or GitHub API errors while fetching the installation token are rethrown instead of silently downgrading.
   */
  private async readAuthHeaders(owner: string): Promise<Record<string, string>> {
    try {
      return { authorization: `Bearer ${await this.installationToken(owner)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('GitHub App is not installed on ') && msg !== 'No GitHub App installations found') {
        throw err;
      }
      // Not installed on `owner`: use the public-read token if configured (5,000 req/hr), else unauthenticated (~60 req/hr/IP).
      return this.publicReadToken ? { authorization: `Bearer ${this.publicReadToken}` } : {};
    }
  }

  /** `GET /repos/{owner}/{repo}/pulls/{number}` with `Accept: application/vnd.github.v3.diff` */
  async prDiff(args: { owner: string; repo: string; number: number }): Promise<{ diff: string }> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    const num = Number(args.number);
    if (!owner || !repo) throw new Error('github_pr_diff requires owner and repo');
    if (!Number.isInteger(num) || num <= 0) throw new Error('github_pr_diff requires a positive integer number');

    const auth = await this.readAuthHeaders(owner);
    const res = await this.ghRequest(owner, repo, `/pulls/${num}`, {
      method: 'GET',
      auth,
      headers: { accept: 'application/vnd.github.v3.diff' },
      fail: 'PR diff',
    });
    return { diff: await res.text() };
  }

  /** `GET /repos/{owner}/{repo}/pulls/{number}/files?per_page=100` */
  async prFiles(args: { owner: string; repo: string; number: number }): Promise<{ files: Record<string, unknown>[] }> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    const num = Number(args.number);
    if (!owner || !repo) throw new Error('github_pr_files requires owner and repo');
    if (!Number.isInteger(num) || num <= 0) throw new Error('github_pr_files requires a positive integer number');

    const auth = await this.readAuthHeaders(owner);
    const res = await this.ghRequest(owner, repo, `/pulls/${num}/files?per_page=100`, { method: 'GET', auth, fail: 'PR files' });
    const items = (await res.json()) as Record<string, unknown>[];
    return {
      files: Array.isArray(items)
        ? items.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            sha: f.sha,
            ...(typeof f.patch === 'string' ? { patch: f.patch } : {}),
          }))
        : [],
    };
  }

  /** `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}` or `/git/trees/{ref}?recursive=1` in one call. */
  async listDir(args: { owner: string; repo: string; path?: string; ref?: string; recursive?: boolean }): Promise<Record<string, unknown>> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    if (!owner || !repo) throw new Error('github_list_dir requires owner and repo');
    const rawPath = String(args.path ?? '').trim().replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '');
    const normalizedPath = rawPath === '.' ? '' : rawPath;
    const cleanPath = normalizedPath ? normalizedPath.split('/').filter(Boolean).map(encodeURIComponent).join('/') : '';
    const refTrim = args.ref && String(args.ref).trim() ? String(args.ref).trim() : undefined;
    const displayPath = normalizedPath || '/';
    const displayRef = refTrim || 'HEAD';
    const auth = await this.readAuthHeaders(owner);
    const notFound = `no directory at \`${displayPath}\` on ref \`${displayRef}\` — check the path/branch`;

    if (args.recursive) {
      const res = await this.ghRequest(owner, repo, `/git/trees/${encodeURIComponent(displayRef)}?recursive=1`, { method: 'GET', auth, notFound, fail: 'list dir' });
      const data = (await res.json()) as { tree?: Record<string, unknown>[]; truncated?: boolean };
      const prefix = normalizedPath ? `${normalizedPath}/` : '';
      const rawTree = Array.isArray(data.tree) ? data.tree : [];
      const filtered = prefix ? rawTree.filter((e) => String(e.path ?? '') === normalizedPath || String(e.path ?? '').startsWith(prefix)) : rawTree;
      if (normalizedPath && filtered.length === 0) throw new Error(`no directory at \`${displayPath}\` on ref \`${displayRef}\` — check the path/branch`);
      const entries = filtered.map((e) => {
        const p = String(e.path ?? '');
        return { name: p.split('/').pop() ?? p, path: p, type: e.type === 'tree' ? 'dir' : e.type === 'blob' ? 'file' : e.type, sha: e.sha, ...(e.size !== undefined ? { size: e.size } : {}) };
      });
      return { path: displayPath, ref: displayRef, entries, ...(data.truncated ? { truncated: true } : {}) };
    }

    const refQuery = refTrim ? `?ref=${encodeURIComponent(refTrim)}` : '';
    const res = await this.ghRequest(owner, repo, `/contents${cleanPath ? `/${cleanPath}` : ''}${refQuery}`, { method: 'GET', auth, notFound, fail: 'list dir' });
    const raw = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
    const entries = Array.isArray(raw)
      ? raw.map((e) => ({ name: e.name, path: e.path, type: e.type, sha: e.sha, size: e.size }))
      : [{ name: raw.name ?? raw.path, path: raw.path, type: raw.type ?? 'file', sha: raw.sha, size: raw.size }];
    return { path: displayPath, ...(refTrim ? { ref: refTrim } : {}), entries };
  }

  /** `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}` (decodes base64 file content to UTF-8 `text`). */
  async getContent(args: { owner: string; repo: string; path?: string; paths?: string[]; ref?: string }): Promise<Record<string, unknown>> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    if (!owner || !repo) throw new Error('github_get_content requires owner and repo');
    const batchPaths = Array.isArray(args.paths) ? args.paths.map((p) => String(p ?? '').trim()).filter(Boolean) : [];
    if (batchPaths.length > 0) {
      const singlePath = String(args.path ?? '').trim();
      const uniquePaths = [...new Set([...(singlePath ? [singlePath] : []), ...batchPaths])];
      const files = await Promise.all(
        uniquePaths.map(async (p) => {
          try {
            return { path: p, ...(await this.getSingleContent(owner, repo, p, args.ref)) };
          } catch (err) {
            return { path: p, ok: false, error: (err as Error).message };
          }
        }),
      );
      return { files };
    }
    return this.getSingleContent(owner, repo, String(args.path ?? ''), args.ref);
  }

  private async getSingleContent(owner: string, repo: string, pathRaw: string, refRaw?: string): Promise<Record<string, unknown>> {
    const trimmedPath = String(pathRaw ?? '').trim().replace(/^\/+/, '');
    const cleanPath = trimmedPath
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
    if (!cleanPath) throw new Error('github_get_content requires path');

    const auth = await this.readAuthHeaders(owner);
    const refTrim = refRaw && String(refRaw).trim() ? String(refRaw).trim() : undefined;
    const refQuery = refTrim ? `?ref=${encodeURIComponent(refTrim)}` : '';
    const res = await this.ghRequest(owner, repo, `/contents/${cleanPath}${refQuery}`, {
      method: 'GET',
      auth,
      notFound: `no file at \`${trimmedPath}\` on ref \`${refTrim ?? 'HEAD'}\` — check the path/branch`,
      fail: 'get content',
    });
    const raw = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
    if (Array.isArray(raw)) {
      return { entries: raw.map((e) => ({ name: e.name, path: e.path, type: e.type, sha: e.sha, size: e.size })) };
    }
    if (raw.encoding === 'base64' && typeof raw.content === 'string') {
      const text = Buffer.from(raw.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      return { path: raw.path, sha: raw.sha, size: raw.size, text };
    }
    return raw;
  }

  /** `GET /repos/{owner}/{repo}/git/ref/heads/{from}` + `POST /repos/{owner}/{repo}/git/refs` */
  async createBranch(args: {
    owner: string;
    repo: string;
    branch: string;
    from?: string;
    base?: string;
    sha?: string;
  }): Promise<Record<string, unknown>> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    const branch = String(args.branch ?? '')
      .trim()
      .replace(/^refs\/heads\//, '');
    if (!owner || !repo) throw new Error('github_create_branch requires owner and repo');
    if (!branch) throw new Error('github_create_branch requires branch');
    if (
      branch === 'HEAD' ||
      branch.includes('..') ||
      /[\x00-\x1f\x7f\s~^:?*[\]\\]/.test(branch) ||
      branch.startsWith('/') ||
      branch.endsWith('/') ||
      branch.startsWith('.') ||
      branch.endsWith('.') ||
      branch.endsWith('.lock') ||
      branch.includes('//')
    ) {
      throw new Error('github_create_branch: invalid branch name');
    }

    const auth = { authorization: `Bearer ${await this.installationToken(owner)}` };

    const explicitSha = String(args.sha ?? '').trim();
    const baseRef = String(args.from ?? args.base ?? 'main')
      .trim()
      .replace(/^refs\/(heads\/)?/, '');
    if (!baseRef && !explicitSha) throw new Error('github_create_branch requires a base ref (`from`) or `sha`');

    let baseSha = explicitSha && args.from === undefined && args.base === undefined ? explicitSha : '';
    if (!baseSha) {
      const encodedBase = baseRef
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
      const refRes = await this.ghRequest(owner, repo, `/git/ref/heads/${encodedBase}`, { method: 'GET', auth });
      if (refRes.status === 404 && /^[0-9a-f]{40}$/i.test(baseRef)) {
        baseSha = baseRef;
      } else if (!refRes.ok) {
        throw new Error(`GitHub get base ref '${baseRef}' failed (HTTP ${refRes.status}): ${(await refRes.text()).slice(0, 200)}`);
      } else {
        const refData = (await refRes.json()) as { object?: { sha?: string }; sha?: string } | { object?: { sha?: string } }[];
        const resolved = Array.isArray(refData) ? refData[0]?.object?.sha : (refData?.object?.sha ?? refData?.sha);
        if (!resolved) throw new Error(`GitHub base ref '${baseRef}' did not resolve to a commit SHA`);
        baseSha = resolved;
      }
    }

    const res = await this.ghRequest(owner, repo, '/git/refs', {
      method: 'POST',
      auth,
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
      fail: 'create branch',
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /** `PUT /repos/{owner}/{repo}/contents/{path}` (content as base64, capped at `GITHUB_PUT_FILE_MAX_BYTES`, path-traversal safe). */
  async putFile(args: {
    owner: string;
    repo: string;
    path: string;
    content?: string;
    message: string;
    branch: string;
    sha?: string;
  }): Promise<Record<string, unknown>> {
    const { owner, repo } = splitOwnerRepo(args.owner, args.repo);
    if (!owner || !repo) throw new Error('github_put_file requires owner and repo');
    const cleanPath = validateRepoFilePath(args.path);
    const branch = String(args.branch ?? '')
      .trim()
      .replace(/^refs\/heads\//, '');
    if (!branch) throw new Error('github_put_file requires branch');
    if (
      branch === 'HEAD' ||
      branch.includes('..') ||
      /[\x00-\x1f\x7f\s~^:?*[\]\\]/.test(branch) ||
      branch.startsWith('/') ||
      branch.endsWith('/')
    ) {
      throw new Error('github_put_file: invalid branch name');
    }
    const message = String(args.message ?? '').trim();
    if (!message) throw new Error('github_put_file requires a non-empty message');
    if (args.content === undefined || args.content === null) {
      throw new Error('github_put_file requires base64-encoded content');
    }
    const base64Content = normalizeAndCapBase64Content(String(args.content));

    const auth = { authorization: `Bearer ${await this.installationToken(owner)}` };
    const path = `/contents/${cleanPath}`;
    const explicitSha = args.sha !== undefined && String(args.sha).trim() ? String(args.sha).trim() : undefined;

    let res = await this.ghRequest(owner, repo, path, {
      method: 'PUT',
      auth,
      body: {
        message,
        content: base64Content,
        branch,
        ...(explicitSha ? { sha: explicitSha } : {}),
      },
    });

    if (res.status === 422 && !explicitSha) {
      const getRes = await this.ghRequest(owner, repo, `${path}?ref=${encodeURIComponent(branch)}`, {
        method: 'GET',
        auth,
        headers: { 'content-type': 'application/json' },
      });
      if (getRes.ok) {
        const existing = (await getRes.json()) as { sha?: string };
        if (existing?.sha) {
          res = await this.ghRequest(owner, repo, path, {
            method: 'PUT',
            auth,
            body: { message, content: base64Content, branch, sha: existing.sha },
          });
        }
      }
    }

    if (!res.ok) {
      throw new Error(`GitHub put file failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

function validateRepoFilePath(pathRaw: string): string {
  const raw = String(pathRaw ?? '').trim();
  if (!raw) throw new Error('github_put_file requires path');
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('\\') || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new Error('github_put_file: invalid path (path traversal or absolute/backslash path is not allowed)');
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error('github_put_file: invalid URL-encoded path');
  }
  if (decoded.startsWith('/') || decoded.endsWith('/') || decoded.includes('\\') || /[\x00-\x1f\x7f]/.test(decoded)) {
    throw new Error('github_put_file: invalid path (path traversal is not allowed)');
  }
  const segments = raw.split('/');
  const decodedSegments = decoded.split('/');
  for (const seg of [...segments, ...decodedSegments]) {
    if (!seg || seg === '.' || seg === '..' || seg.includes('..') || seg.toLowerCase() === '.git') {
      throw new Error('github_put_file: invalid path (path traversal is not allowed)');
    }
  }
  return segments.map(encodeURIComponent).join('/');
}

function normalizeAndCapBase64Content(contentRaw: string): string {
  const stripped = contentRaw.replace(/\s+/g, '');
  const maxEncodedLen = Math.ceil(GITHUB_PUT_FILE_MAX_BYTES / 3) * 4;
  if (stripped.length > maxEncodedLen) {
    throw new Error(`github_put_file content exceeds maximum size of ${GITHUB_PUT_FILE_MAX_BYTES} bytes`);
  }
  if (stripped.length > 0 && (stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped))) {
    throw new Error('github_put_file requires valid base64-encoded content');
  }
  const bytes = Buffer.from(stripped, 'base64');
  if (bytes.byteLength > GITHUB_PUT_FILE_MAX_BYTES) {
    throw new Error(`github_put_file content exceeds maximum size of ${GITHUB_PUT_FILE_MAX_BYTES} bytes`);
  }
  return bytes.toString('base64');
}

export function splitOwnerRepo(ownerRaw: string | undefined, repoRaw: string | undefined): { owner: string; repo: string } {
  const r = String(repoRaw ?? '').trim();
  const o = String(ownerRaw ?? '').trim();
  if (r.includes('/')) {
    const [fromRepoOwner, fromRepoName] = r.split('/', 2);
    return { owner: o || (fromRepoOwner ?? '').trim(), repo: (fromRepoName ?? '').trim() };
  }
  return { owner: o, repo: r };
}
