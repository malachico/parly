import type { Database } from '../db/types.js';
import { HubStore } from './hubStore.js';

/** `github_installs/{installationId}`: one Parly GitHub App install, and the Parly owner whose agents may use it. */
export interface GitHubInstall {
  installationId: number;
  /** The Parly person whose agents (and who) get tokens from this install. */
  ownerId: string;
  /** The GitHub account (user or org) it is installed on. */
  accountLogin: string;
  /** Repo names it covers; legacy empty lists mean all unless repositorySelection is selected. */
  repos: string[];
  repositorySelection?: 'all' | 'selected';
  /** The Parly person who installed it. */
  installedBy: string;
  at: string;
}

export class GitHubInstalls {
  private readonly store: HubStore;

  constructor(db: Database) {
    this.store = new HubStore(db);
  }

  async get(installationId: number): Promise<GitHubInstall | undefined> {
    return this.store.getGitHubInstall(installationId);
  }

  async save(install: Omit<GitHubInstall, 'at'>): Promise<GitHubInstall> {
    const record: GitHubInstall = { ...install, at: new Date().toISOString() };
    // An install already mapped to another Parly owner is never reassigned; they must remove it first.
    if (!(await this.store.saveGitHubInstall(record))) {
      throw new Error('github install belongs to another owner');
    }
    return record;
  }

  // ponytail: newest install wins (sorted in memory, no index); pick by account when one owner needs several at once.
  async forOwner(ownerId: string): Promise<GitHubInstall | undefined> {
    const installs = await this.store.githubInstallsOfOwner(ownerId);
    return installs.sort((a, b) => b.at.localeCompare(a.at))[0];
  }

  async setRepos(installationId: number, repos: string[], repositorySelection: 'all' | 'selected' = repos.length ? 'selected' : 'all'): Promise<void> {
    await this.store.setGitHubInstallRepos(installationId, repos, repositorySelection);
  }

  async remove(installationId: number): Promise<void> {
    await this.store.removeGitHubInstall(installationId);
  }
}
