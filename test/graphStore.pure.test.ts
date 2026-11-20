import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/types.js';
import { GraphStore, normalizeKey } from '../src/graph/store.js';

/** A db that fails any touch, so a passing flag-off test proves nothing reached it. */
const explodingDb = new Proxy({}, { get: () => { throw new Error('db touched'); } }) as Database;
const fakeMeter = (spent: number) => ({ graphSpent: vi.fn(async () => spent), addGraphSpend: vi.fn(async () => {}) });

describe('GraphStore (pure)', () => {
  it('is a no-op when the flag is off', async () => {
    const meter = fakeMeter(0);
    const graph = new GraphStore(explodingDb, meter, { enabled: false, dailyCapMicros: 250_000 });
    expect(await graph.upsertNode({ workspaceId: 'w', conversationId: 'c', kind: 'topic', title: 't' })).toBeUndefined();
    expect(await graph.upsertEdge({ workspaceId: 'w', kind: 'about', from: { id: 'a', conversationId: 'c' }, to: { id: 'b', conversationId: 'c' } })).toBeUndefined();
    await graph.upsertEmbedding({ workspaceId: 'w', conversationId: 'c', nodeId: 'a', kind: 'topic', model: 'm', vector: [1] });
    await graph.purgeGraphFor({ workspaceId: 'w' });
    expect(await graph.canSpendOnGraph('w')).toBe(false);
    await graph.recordGraphSpend('w', 100);
    expect(meter.graphSpent).not.toHaveBeenCalled();
    expect(meter.addGraphSpend).not.toHaveBeenCalled();
  });

  it('enforces the daily cap', async () => {
    const at = (spent: number, cap = 250_000) => new GraphStore(explodingDb, fakeMeter(spent), { enabled: true, dailyCapMicros: cap }).canSpendOnGraph('w');
    expect(await at(249_999)).toBe(true);
    expect(await at(250_000)).toBe(false);
    expect(await at(1_000_000)).toBe(false);
    expect(await at(0, 0)).toBe(false);
  });

  it('records spend on the meter', async () => {
    const meter = fakeMeter(0);
    await new GraphStore(explodingDb, meter, { enabled: true, dailyCapMicros: 1 }).recordGraphSpend('w', 42);
    expect(meter.addGraphSpend).toHaveBeenCalledWith('w', 42);
  });

  it('normalizes keys', () => {
    expect(normalizeKey('  Use \n Mongo ')).toBe('use mongo');
  });
});
