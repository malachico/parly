import { createHash } from 'node:crypto';
import type { Database } from '../db/types.js';
import { RateLimitStore } from './rateLimitStore.js';
import { HubError } from './errors.js';

export interface HitLimiter {
  hit(key: string, count?: number, now?: number): void | Promise<void>;
}

/**
 * Fixed-window counter: at most `limit` hits per key per `windowMs`.
 */
// ponytail: in-memory per instance for per-agent/session limits; sign-in, registration and pairing redeem use SharedRateLimiter
export class RateLimiter implements HitLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly what: string,
  ) {}

  /** Counts `count` hits for `key` (all or none); throws `rate_limited` if they don't fit in the window. */
  hit(key: string, count = 1, now = Date.now()): void {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.sweep(now);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count + count > this.limit) {
      const retry = Math.ceil((w.start + this.windowMs - now) / 1000);
      throw new HubError('rate_limited', `Too many ${this.what}. Try again in ${retry}s.`);
    }
    w.count += count;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/**
 * Fixed-window counter in RateLimitStore, shared across all Cloud Run instances.
 */
export class SharedRateLimiter implements HitLimiter {
  private readonly store: RateLimitStore;

  constructor(
    db: Database,
    private readonly scope: string,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly what: string,
  ) {
    this.store = new RateLimitStore(db);
  }

  async hit(key: string, count = 1, now = Date.now()): Promise<void> {
    const id = createHash('sha256').update(`${this.scope}:${key}`).digest('hex');
    let res: Awaited<ReturnType<RateLimitStore['addHits']>>;
    try {
      res = await this.store.addHits(id, count, this.limit, this.windowMs, now);
    } catch (err) {
      // Write contention (ABORTED) or a store outage rethrows the callback's error after rollback.
      // Fail closed: a limiter that can't confirm the count must reject, not 500 (and never silently allow).
      if (err instanceof HubError) throw err;
      throw new HubError('rate_limited', `Too many ${this.what}. Try again shortly.`, String(err));
    }
    if (!res.ok) {
      const retry = Math.ceil((res.start + this.windowMs - now) / 1000);
      throw new HubError('rate_limited', `Too many ${this.what}. Try again in ${retry}s.`);
    }
  }
}
