import { COLLECTIONS, FieldValue, toMillis, type Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import type { CanvasNote } from './canvasNotes.js';
import type { GitHubInstall } from './githubInstalls.js';
import type { KnownTool, ToolUse } from './toolUsage.js';

interface StoredGitHubOAuthState {
  ownerId: string;
  expiresAt: { toMillis(): number } | Date;
}

/**
 * DB access for workspace canvas notes (`workspaces/{id}/notes`), GitHub App installs and OAuth states
 * (`github_installs`, `github_oauth_states`), agent tool usage and memory (`toolUsage`, `toolMemory`), and hub
 * connect settings (`settings/connect`).
 */
export class HubStore {
  constructor(private readonly db: Database) {}

  // Connect settings (`settings/connect`).

  async isHireEnabled(): Promise<boolean> {
    const snap = await this.db.collection(COLLECTIONS.settings).doc('connect').get();
    return (snap.data()?.shown as Record<string, boolean> | undefined)?.hire !== false;
  }

  // Workspace canvas notes (`workspaces/{workspaceId}/notes/{id}`).

  private notesOf(workspaceId: string) {
    return this.db.collection(COLLECTIONS.workspaces).doc(workspaceId).collection('notes');
  }

  async listNotes(workspaceId: string): Promise<CanvasNote[]> {
    const rows = await this.notesOf(workspaceId).get();
    return rows.docs.map((doc) => doc.data() as CanvasNote);
  }

  async getNote(workspaceId: string, id: string): Promise<CanvasNote | undefined> {
    const doc = await this.notesOf(workspaceId).doc(id).get();
    return doc.exists ? (doc.data() as CanvasNote) : undefined;
  }

  async createNote(workspaceId: string, note: CanvasNote): Promise<void> {
    await this.notesOf(workspaceId).doc(note.id).create(note);
  }

  /** Replaces `note` if its stored `version` is still `expectedVersion`; returns false on conflict or missing note. */
  async updateNoteIfVersion(workspaceId: string, note: CanvasNote, expectedVersion: number): Promise<boolean> {
    const ref = this.notesOf(workspaceId).doc(note.id);
    return this.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (!current.exists || current.data()!.version !== expectedVersion) return false;
      tx.set(ref, note);
      return true;
    });
  }

  /** Deletes note `id` inside a transaction after `authorize` checks the current record and version. */
  async deleteNote(workspaceId: string, id: string, authorize: (note: CanvasNote) => void): Promise<void> {
    const ref = this.notesOf(workspaceId).doc(id);
    await this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new HubError('not_found', 'Note not found');
      authorize(doc.data() as CanvasNote);
      tx.delete(ref);
    });
  }

  // GitHub App installs (`github_installs/{installationId}`).

  private get githubInstalls() {
    return this.db.collection(COLLECTIONS.githubInstalls);
  }

  async getGitHubInstall(installationId: number): Promise<GitHubInstall | undefined> {
    return (await this.githubInstalls.doc(String(installationId)).get()).data() as GitHubInstall | undefined;
  }

  /**
   * Saves `record` unless the installation is already bound to a different Parly owner; returns false then.
   */
  async saveGitHubInstall(record: GitHubInstall): Promise<boolean> {
    const ref = this.githubInstalls.doc(String(record.installationId));
    return this.db.runTransaction(async (tx) => {
      const existing = (await tx.get(ref)).data() as GitHubInstall | undefined;
      if (existing && existing.ownerId !== record.ownerId) return false;
      tx.set(ref, record);
      return true;
    });
  }

  async githubInstallsOfOwner(ownerId: string): Promise<GitHubInstall[]> {
    return (await this.githubInstalls.where('ownerId', '==', ownerId).get()).docs.map((d) => d.data() as GitHubInstall);
  }

  async setGitHubInstallRepos(installationId: number, repos: string[], repositorySelection: 'all' | 'selected'): Promise<void> {
    await this.githubInstalls.doc(String(installationId)).update({ repos, repositorySelection });
  }

  async removeGitHubInstall(installationId: number): Promise<void> {
    await this.githubInstalls.doc(String(installationId)).delete();
  }

  // GitHub App OAuth states (`github_oauth_states/{state}`).

  private get githubOauthStates() {
    return this.db.collection(COLLECTIONS.githubOauthStates);
  }

  async saveGitHubOAuthState(state: string, ownerId: string, expiresAt: Date): Promise<void> {
    await this.githubOauthStates.doc(state).set({ ownerId, expiresAt });
  }

  async spendGitHubOAuthState(state: string, now: number): Promise<{ ownerId: string } | undefined> {
    const ref = this.githubOauthStates.doc(state);
    return this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as StoredGitHubOAuthState | undefined;
      if (!data) return undefined;
      tx.delete(ref);
      if (toMillis(data.expiresAt) <= now) return undefined;
      return { ownerId: data.ownerId };
    });
  }

  // Agent tool usage (`toolUsage/{agentId}|{toolkit}`) and tool memory (`toolMemory/{agentId}`).

  private get toolUsage() {
    return this.db.collection(COLLECTIONS.toolUsage);
  }

  async recordToolUse(ownerId: string, agentId: string, toolkit: string, tool: string, ok: boolean, at: string, expiresAt: Date): Promise<void> {
    const ref = this.toolUsage.doc(`${agentId}|${toolkit}`);
    await ref.set(
      { ownerId, agentId, toolkit, uses: FieldValue.increment(1), ...(ok ? {} : { failures: FieldValue.increment(1) }), lastAt: at, lastTool: tool },
      { merge: true },
    );
    await ref.collection('events').add({ at, tool, ok, expiresAt });
  }

  async toolUseHistory(agentId: string, toolkit: string, limit: number): Promise<{ at: string; tool: string; ok: boolean }[]> {
    const snap = await this.toolUsage.doc(`${agentId}|${toolkit}`).collection('events').orderBy('at', 'desc').limit(limit).get();
    return snap.docs.map((d) => {
      const { expiresAt, ...event } = d.data();
      return event as { at: string; tool: string; ok: boolean };
    });
  }

  async knownTools(agentId: string): Promise<KnownTool[]> {
    return ((await this.db.collection(COLLECTIONS.toolMemory).doc(agentId).get()).data()?.tools as KnownTool[] | undefined) ?? [];
  }

  async rememberTools(agentId: string, tools: KnownTool[], max: number, updatedAt: string): Promise<void> {
    const ref = this.db.collection(COLLECTIONS.toolMemory).doc(agentId);
    await this.db.runTransaction(async (tx) => {
      const before = ((await tx.get(ref)).data()?.tools as KnownTool[] | undefined) ?? [];
      const slugs = new Set(tools.map((t) => t.tool));
      tx.set(ref, { agentId, tools: [...tools, ...before.filter((t) => !slugs.has(t.tool))].slice(0, max), updatedAt });
    });
  }

  async toolUsesOfOwner(ownerId: string): Promise<ToolUse[]> {
    return (await this.toolUsage.where('ownerId', '==', ownerId).get()).docs.map((d) => d.data() as ToolUse);
  }
}
