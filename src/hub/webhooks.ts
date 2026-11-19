import { randomBytes } from 'node:crypto';
import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import { newId } from '../lib/wire.js';
import { hashToken } from '../registry/registry.js';
import { TriggerStore } from './triggerStore.js';

/** An incoming webhook: a secret URL (POST /hooks/:channelId/:token) whose posts go into a channel as the person who made it, marked 🪝. */
export interface WebhookRecord {
  id: string;
  channelId: string;
  name: string;
  ownerId: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

const MAX_PER_CHANNEL = 20;

export class Webhooks {
  private readonly store: TriggerStore;

  constructor(db: Database) {
    this.store = new TriggerStore(db);
  }

  /** A new webhook and its token (shown once; only its hash is kept). */
  async create(input: { channelId: string; name: string; ownerId: string }): Promise<{ webhook: WebhookRecord; token: string }> {
    const token = `pwh_${randomBytes(32).toString('base64url')}`;
    const webhook: WebhookRecord = { ...input, id: newId(), tokenHash: hashToken(token), createdAt: new Date().toISOString() };
    if (!(await this.store.addWebhook(webhook, MAX_PER_CHANNEL))) {
      throw new HubError('conflict', `Up to ${MAX_PER_CHANNEL} webhooks per channel`);
    }
    return { webhook, token };
  }

  async byToken(token: string): Promise<WebhookRecord | undefined> {
    return this.store.webhookByTokenHash(hashToken(token));
  }

  async get(id: string): Promise<WebhookRecord | undefined> {
    return this.store.webhook(id);
  }

  async ofChannel(channelId: string): Promise<WebhookRecord[]> {
    return (await this.store.webhooksOfChannel(channelId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async used(id: string): Promise<void> {
    await this.store.webhookUsed(id, new Date().toISOString());
  }

  async remove(id: string): Promise<void> {
    await this.store.removeWebhook(id);
  }
}
