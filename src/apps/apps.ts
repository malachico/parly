import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import { isOwner } from '../lib/admin.js';
import { hashToken, type Registry } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';
import { AppsStore } from './store.js';

/** What an app's key may do; a key carries a subset. */
const APP_SCOPES = ['rooms:read', 'rooms:write'] as const;
export type AppScope = (typeof APP_SCOPES)[number];
export const APP_KEY_PREFIX = 'pk_live_';

/** A workspace's app: its servers call /v1 with one of its keys. */
export interface AppRecord {
  id: string;
  workspaceId: string;
  name: string;
  webhookUrl?: string;
  /** Signs webhooks to webhookUrl; the app verifies them with it. */
  webhookSecret: string;
  /**
   * Templates saved before apps' agents had their own store (AppAgents): read as a fallback when a room names one.
   */
  agents: Record<string, AgentTemplate>;
  createdBy: string;
  createdAt: string;
}

interface AgentTemplate {
  name: string;
  instructions: string;
}

/** Stored under sha256(key): the key itself is shown once and never kept. */
export interface AppKeyRecord {
  appId: string;
  /** The key's first characters, to tell keys apart in a list. */
  prefix: string;
  scopes: AppScope[];
  createdAt: string;
  revokedAt?: string;
}

/** Who a /v1 request is: the app its key belongs to. */
export interface AppCaller {
  id: string;
  workspaceId: string;
  scopes: AppScope[];
}

const NAME_MAX = 80;

/** Apps and their API keys. Only a workspace's owners manage them. */
export class Apps {
  private readonly store: AppsStore;

  constructor(db: Database, private readonly registry: Registry) {
    this.store = new AppsStore(db);
  }

  async create(person: AgentRecord, workspaceId: string, input: { name?: unknown; webhookUrl?: unknown }): Promise<{ app: AppRecord; key: string }> {
    await this.owner(person, workspaceId);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > NAME_MAX) throw new HubError('invalid', `An app needs a name (up to ${NAME_MAX} characters)`);
    const app: AppRecord = {
      id: randomUUID(), workspaceId, name, ...webhook(input.webhookUrl), webhookSecret: `whsec_${randomBytes(32).toString('base64url')}`,
      agents: {}, createdBy: person.id, createdAt: new Date().toISOString(),
    };
    await this.store.createApp(app);
    return { app, key: await this.issueKey(app.id) };
  }

  /** A workspace's apps with their keys (prefixes only). */
  async list(person: AgentRecord, workspaceId: string) {
    await this.owner(person, workspaceId);
    const apps = await this.store.listAppsByWorkspace(workspaceId);
    const keys = await this.store.listKeysForApps(apps.map((a) => a.id));
    return apps.map(({ webhookSecret: _secret, ...app }) => ({ ...app, keys: keys.filter((k) => k.appId === app.id).map(({ appId: _a, ...k }) => k) }));
  }

  /** Another key for an app (rotation: issue a new one, move over, revoke the old one). */
  async addKey(person: AgentRecord, workspaceId: string, appId: string): Promise<{ key: string }> {
    await this.appOf(person, workspaceId, appId);
    return { key: await this.issueKey(appId) };
  }

  async revokeKey(person: AgentRecord, workspaceId: string, appId: string, prefix: string): Promise<void> {
    await this.appOf(person, workspaceId, appId);
    const revoked = await this.store.revokeKeyByPrefix(appId, prefix, new Date().toISOString());
    if (!revoked) throw new HubError('not_found', 'No such key');
  }

  async delete(person: AgentRecord, workspaceId: string, appId: string): Promise<void> {
    await this.appOf(person, workspaceId, appId);
    await this.store.revokeAllKeysForApp(appId, new Date().toISOString());
    await this.store.deleteApp(appId);
  }

  /** The app a key belongs to, or undefined (unknown, revoked, or its app is gone). */
  async authenticate(key: string): Promise<AppCaller | undefined> {
    if (!key.startsWith(APP_KEY_PREFIX)) return undefined;
    const record = await this.store.getKey(hashToken(key));
    if (!record || record.revokedAt) return undefined;
    const app = await this.store.getApp(record.appId);
    if (!app) return undefined;
    // An app acts (and is billed) as the owner who made it: once they no longer own the workspace, its keys stop.
    const [maker, workspace] = await Promise.all([this.registry.get(app.createdBy), this.registry.workspaceById(app.workspaceId)]);
    if (!maker || maker.archived || !workspace || !isOwner(workspace, maker)) return undefined;
    return { id: app.id, workspaceId: app.workspaceId, scopes: record.scopes };
  }

  async get(appId: string): Promise<AppRecord | undefined> {
    return this.store.getApp(appId);
  }

  private async issueKey(appId: string): Promise<string> {
    const key = `${APP_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    await this.store.createKey(hashToken(key), { appId, prefix: key.slice(0, APP_KEY_PREFIX.length + 6), scopes: [...APP_SCOPES], createdAt: new Date().toISOString() } satisfies AppKeyRecord);
    return key;
  }

  private async owner(person: AgentRecord, workspaceId: string) {
    if (person.kind !== 'human') throw new HubError('forbidden', 'A person manages apps');
    return this.registry.requireWorkspaceOwner(person, workspaceId);
  }

  private async appOf(person: AgentRecord, workspaceId: string, appId: string): Promise<AppRecord> {
    await this.owner(person, workspaceId);
    const app = await this.get(appId);
    if (!app || app.workspaceId !== workspaceId) throw new HubError('not_found', 'No such app');
    return app;
  }
}

function webhook(raw: unknown): { webhookUrl?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new HubError('invalid', 'webhookUrl must be an https URL'); }
  if (url.protocol !== 'https:') throw new HubError('invalid', 'webhookUrl must be an https URL');
  return { webhookUrl: url.toString() };
}
