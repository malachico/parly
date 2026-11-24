import { COLLECTIONS, Timestamp, type Database } from '../db/types.js';
import type { AdminLogEntry, ClientRequest, PlanLead } from './admin.js';

// ponytail: old collection name kept so existing leads stay listed; rename with a data migration if it matters.
const LEADS = 'enterpriseLeads';

/** Persistence for the admin pages: `admin_log`, message times, client requests, plan leads, and `settings/connect`. */
export class AdminStore {
  constructor(private readonly db: Database) {}

  // ---- admin log --------------------------------------------------------------------------------

  async addLog(entry: AdminLogEntry): Promise<void> {
    await this.db.collection(COLLECTIONS.adminLog).add(entry);
  }

  async listLog(limit: number): Promise<AdminLogEntry[]> {
    const snap = await this.db.collection(COLLECTIONS.adminLog).orderBy('at', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as AdminLogEntry);
  }

  // ---- messages ---------------------------------------------------------------------------------

  /** `createdAt` (ms) of up to `limit` messages created at or after `sinceMs`. Single-field range on createdAt: no composite index. */
  async messageTimesSince(sinceMs: number, limit: number): Promise<number[]> {
    const snap = await this.db.collection(COLLECTIONS.messages).where('createdAt', '>=', Timestamp.fromMillis(sinceMs)).select('createdAt').limit(limit).get();
    return snap.docs.map((d) => (d.get('createdAt') as Timestamp).toMillis());
  }

  // ---- client requests & plan leads -------------------------------------------------------

  async addClientRequest(request: Omit<ClientRequest, 'id'>): Promise<ClientRequest> {
    const ref = this.db.collection(COLLECTIONS.clientRequests).doc();
    const saved: ClientRequest = { id: ref.id, ...request };
    await ref.set(saved);
    return saved;
  }

  async listClientRequests(limit: number): Promise<ClientRequest[]> {
    const snap = await this.db.collection(COLLECTIONS.clientRequests).orderBy('at', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as ClientRequest);
  }

  async addLead(lead: Omit<PlanLead, 'id'>): Promise<PlanLead> {
    const ref = this.db.collection(LEADS).doc();
    const saved: PlanLead = { id: ref.id, ...lead };
    await ref.set(saved);
    return saved;
  }

  async listLeads(limit: number): Promise<PlanLead[]> {
    const snap = await this.db.collection(LEADS).orderBy('at', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as PlanLead);
  }

  // ---- connect settings (`settings/connect`) ----------------------------------------------------

  async connectShown(): Promise<Record<string, boolean>> {
    return ((await this.connect.get()).data()?.shown as Record<string, boolean> | undefined) ?? {};
  }

  async setConnectShown(key: string, shown: boolean): Promise<void> {
    await this.connect.set({ shown: { [key]: shown } }, { merge: true });
  }

  private get connect() {
    return this.db.collection(COLLECTIONS.settings).doc('connect');
  }
}
