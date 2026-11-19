import { splitOwnerRepo, type GitHubApp } from './github.js';
import type { GitHubInstall } from './githubInstalls.js';

/** Minimal native GitHub App tools exposed to cloud agents in `CLOUD_TOOLS`. */
export const GITHUB_NATIVE_NAME = 'GitHub';
export const GITHUB_NATIVE_LOGO = '/github-mark.svg';
/** Maximum decoded file size (1 MB) accepted by `github_put_file`. */
export const GITHUB_PUT_FILE_MAX_BYTES = 1_000_000;
export const GITHUB_READ_TOOL_NAMES = new Set(['github_pr_diff', 'github_pr_files', 'github_list_dir', 'github_get_content']);
/** What a cloud agent is told when its GitHub tools are off, or it may only read. */
export const GITHUB_OFF = 'GitHub is not enabled for this agent: ask your owner to turn on GitHub (Parly App) in Tools settings.';
export const GITHUB_READ_ONLY = 'Read-only: ask your owner to enable acting in Tools settings before posting to GitHub.';
export const GITHUB_WRITE_TOOL_NAMES = new Set(['github_comment', 'github_open_pr', 'github_merge_pr', 'github_create_branch', 'github_put_file']);

/** `github_pr_diff` and `github_pr_files` take the same arguments: which pull request. */
const PR_PARAMETERS = {
  type: 'object',
  properties: {
    owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
    repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
    number: { type: 'integer', description: 'Pull request number' },
  },
  required: ['owner', 'repo', 'number'],
} as const;

export const GITHUB_CLOUD_TOOLS = [
  {
    name: 'github_pr_diff',
    description: "Fetches the unified git diff of a GitHub pull request using Parly's GitHub App (read-only).",
    parametersJsonSchema: PR_PARAMETERS,
  },
  {
    name: 'github_pr_files',
    description: "Lists the changed files and patches of a GitHub pull request using Parly's GitHub App (read-only).",
    parametersJsonSchema: PR_PARAMETERS,
  },
  {
    name: 'github_list_dir',
    description: "Lists files and directories in a GitHub repository directory (or the full recursive tree when `recursive: true`) in one call using Parly's GitHub App (read-only).",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
        repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
        path: { type: 'string', description: 'Optional directory path within the repository (defaults to "" for repository root, e.g. "src/hub")' },
        ref: { type: 'string', description: 'Optional branch, tag, or commit SHA' },
        recursive: { type: 'boolean', description: 'Optional: when true, lists the full recursive file tree in a single call' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github_get_content',
    description: "Reads one file (`path`) or multiple files in a single batch call (`paths`) from a GitHub repository at an optional ref/SHA using Parly's GitHub App (read-only).",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
        repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
        path: { type: 'string', description: 'Repository file path when reading a single file (e.g. "src/telegram/bridge.ts")' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple repository file paths to read in a single batch call (e.g. ["src/app.ts", "src/config.ts"])',
        },
        ref: { type: 'string', description: 'Optional branch, tag, or commit SHA' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github_comment',
    description: "Posts a comment on a GitHub issue or pull request using Parly's GitHub App.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
        repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
        number: { type: 'integer', description: 'Issue or pull request number' },
        body: { type: 'string', description: 'Markdown comment body' },
      },
      required: ['owner', 'repo', 'number', 'body'],
    },
  },
  {
    name: 'github_open_pr',
    description: "Opens a pull request on a GitHub repository using Parly's GitHub App.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
        repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Branch containing the changes (e.g. "feat/my-branch")' },
        base: { type: 'string', description: 'Target branch to merge into (e.g. "main")' },
        body: { type: 'string', description: 'Optional Markdown description for the pull request' },
        draft: { type: 'boolean', description: 'Optional: open as a draft pull request' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'github_merge_pr',
    description: "Merges an open pull request on a GitHub repository using Parly's GitHub App.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
        repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
        number: { type: 'integer', description: 'Pull request number' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method: "squash" (default), "merge", or "rebase"' },
        commitTitle: { type: 'string', description: 'Optional title for the automatic merge/squash commit' },
        commitMessage: { type: 'string', description: 'Optional extra detail to append to the automatic commit message' },
        sha: { type: 'string', description: 'Optional SHA that the pull request head must match to allow merge' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'github_create_branch',
    description: "Creates a new branch on a GitHub repository from a base branch or commit SHA using Parly's GitHub App.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
        repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
        branch: { type: 'string', description: 'New branch name to create (e.g. "feat/my-branch")' },
        from: { type: 'string', description: 'Optional base branch name or commit SHA to branch from (defaults to "main")' },
        base: { type: 'string', description: 'Alias for `from`: base branch name or commit SHA to branch from' },
        sha: { type: 'string', description: 'Optional explicit 40-char commit SHA to branch from' },
      },
      required: ['owner', 'repo', 'branch'],
    },
  },
  {
    name: 'github_put_file',
    description: "Creates or updates a file on a branch in a GitHub repository using Parly's GitHub App (content as base64, capped at 1 MB).",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (e.g. "malachico")' },
        repo: { type: 'string', description: 'Repository name (e.g. "a2a-hub", or "owner/repo")' },
        path: { type: 'string', description: 'Repository-relative file path (e.g. "src/feature.ts")' },
        content: { type: 'string', description: 'Base64-encoded file contents (max 1 MB decoded)' },
        message: { type: 'string', description: 'Commit message describing the change' },
        branch: { type: 'string', description: 'Target branch name (e.g. "feat/my-branch")' },
        sha: { type: 'string', description: 'Optional blob SHA of the existing file when updating' },
      },
      required: ['owner', 'repo', 'path', 'content', 'message', 'branch'],
    },
  },
] as const;

/** Executes a native GitHub App cloud tool (`github_pr_diff`, `github_pr_files`, `github_list_dir`, `github_get_content`, `github_comment`, `github_open_pr`). */
export async function runGitHubCloudTool(
  appClient: GitHubApp,
  install: Pick<GitHubInstall, 'accountLogin' | 'repos' | 'repositorySelection'> | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Only the caller's own install (github_installs) authenticates; any other owner/repo gets public reads only.
  const { owner, repo } = splitOwnerRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  const own =
    !!install &&
    owner.toLowerCase() === install.accountLogin.toLowerCase() &&
    ((install.repositorySelection !== 'selected' && !install.repos.length) || install.repos.some((r) => r.toLowerCase() === repo.toLowerCase()));
  const github = own ? appClient : appClient.publicOnly();
  try {
    if (name === 'github_pr_diff') {
      const data = await github.prDiff({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        number: Number(args.number ?? args.pull_number),
      });
      return { ok: true, whole: true, data };
    }
    if (name === 'github_pr_files') {
      const data = await github.prFiles({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        number: Number(args.number ?? args.pull_number),
      });
      return { ok: true, whole: true, data };
    }
    if (name === 'github_list_dir') {
      const data = await github.listDir({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        ...(args.path !== undefined ? { path: String(args.path) } : {}),
        ...(args.ref !== undefined ? { ref: String(args.ref) } : {}),
        ...(args.recursive !== undefined ? { recursive: Boolean(args.recursive) } : {}),
      });
      return { ok: true, whole: true, data };
    }
    if (name === 'github_get_content') {
      const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p)).filter((p) => p.trim().length > 0) : undefined;
      const data = await github.getContent({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        ...(args.path !== undefined ? { path: String(args.path) } : {}),
        ...(paths?.length ? { paths } : {}),
        ...(args.ref !== undefined ? { ref: String(args.ref) } : {}),
      });
      return { ok: true, whole: true, data };
    }
    if (name === 'github_comment') {
      const data = await github.comment({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        number: Number(args.number ?? args.issue_number ?? args.pull_number),
        body: String(args.body ?? ''),
      });
      return { ok: true, data };
    }
    if (name === 'github_open_pr') {
      const data = await github.openPr({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        title: String(args.title ?? ''),
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
        ...(args.body !== undefined ? { body: String(args.body) } : {}),
        ...(args.draft !== undefined ? { draft: Boolean(args.draft) } : {}),
      });
      return { ok: true, data };
    }
    if (name === 'github_merge_pr') {
      const methodVal = args.method ?? args.merge_method;
      const titleVal = args.commitTitle ?? args.commit_title;
      const msgVal = args.commitMessage ?? args.commit_message;
      const data = await github.mergePr({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        number: Number(args.number ?? args.pull_number),
        ...(methodVal !== undefined ? { method: String(methodVal) } : {}),
        ...(titleVal !== undefined ? { commitTitle: String(titleVal) } : {}),
        ...(msgVal !== undefined ? { commitMessage: String(msgVal) } : {}),
        ...(args.sha !== undefined ? { sha: String(args.sha) } : {}),
      });
      return { ok: true, data };
    }
    if (name === 'github_create_branch') {
      const fromVal = args.from ?? args.base ?? args.base_ref ?? args.ref;
      const data = await github.createBranch({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        branch: String(args.branch ?? args.new_branch ?? ''),
        ...(fromVal !== undefined ? { from: String(fromVal) } : {}),
        ...(args.sha !== undefined ? { sha: String(args.sha) } : {}),
      });
      return { ok: true, data };
    }
    if (name === 'github_put_file') {
      const contentVal = args.content ?? args.contentBase64;
      const data = await github.putFile({
        owner: String(args.owner ?? ''),
        repo: String(args.repo ?? ''),
        path: String(args.path ?? ''),
        ...(contentVal !== undefined ? { content: String(contentVal) } : {}),
        message: String(args.message ?? ''),
        branch: String(args.branch ?? ''),
        ...(args.sha !== undefined ? { sha: String(args.sha) } : {}),
      });
      return { ok: true, data };
    }
    return { ok: false, error: `No GitHub tool ${name}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
