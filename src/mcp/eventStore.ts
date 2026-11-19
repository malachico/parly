import { COLLECTIONS, type Database } from '../db/types.js';
import type { Subscription } from './events.js';

/** `mcpEventSubs/{id}`: MCP event subscriptions. */
export class McpEventStore {
  constructor(private readonly db: Database) {}

  private get col() {
    return this.db.collection(COLLECTIONS.mcpEventSubs);
  }

  async subscription(id: string): Promise<(Subscription & { verifiedAt?: string }) | undefined> {
    return (await this.col.doc(id).get()).data() as (Subscription & { verifiedAt?: string }) | undefined;
  }

  async saveSubscription(sub: Subscription & { verifiedAt?: string }): Promise<void> {
    await this.col.doc(sub.id).set(sub, { merge: false });
  }

  async removeSubscription(id: string): Promise<void> {
    await this.col.doc(id).delete();
  }

  async subscriptionsOf(agentId: string): Promise<Subscription[]> {
    return (await this.col.where('agentId', '==', agentId).get()).docs.map((d) => d.data() as Subscription);
  }

  async markSent(id: string, at: string): Promise<void> {
    await this.col.doc(id).update({ lastSentAt: at });
  }
}
