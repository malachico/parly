import { COLLECTIONS, type Database } from '../db/types.js';

/** `rate_limits/{id}`: one fixed window's hit count, shared across hub instances. */
export class RateLimitStore {
  constructor(private readonly db: Database) {}

  /**
   * Adds `count` hits to window `id` (all or none) in one transaction.
   * Returns `{ ok: false, start }` when they don't fit under `limit`; nothing is written then.
   */
  async addHits(id: string, count: number, limit: number, windowMs: number, now: number): Promise<{ ok: true } | { ok: false; start: number }> {
    const ref = this.db.collection(COLLECTIONS.rateLimits).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() as { start?: number; count?: number } | undefined;
      const fresh = !data || typeof data.start !== 'number' || now - data.start >= windowMs;
      const start = fresh ? now : data.start!;
      const used = fresh ? 0 : (data.count ?? 0);
      if (used + count > limit) return { ok: false as const, start };
      tx.set(ref, { start, count: used + count, expiresAt: new Date(start + windowMs) });
      return { ok: true as const };
    });
  }
}
