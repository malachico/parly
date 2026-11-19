import { describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../src/db/types.js';
import { ToolUsage } from '../src/hub/toolUsage.js';
import { TriggerStore } from '../src/hub/triggers.js';
import { testDb } from './helpers.js';

describe('history retention', () => {
  it('expires tool events after 90 days while retaining cumulative use counts', async () => {
    const db = testDb();
    const usage = new ToolUsage(db);
    const before = Date.now();
    await usage.record('owner', 'agent', 'github', 'list_issues', true);
    const ref = db.collection(COLLECTIONS.toolUsage).doc('agent|github');
    const event = (await ref.collection('events').get()).docs[0]!.data();
    expect(event.expiresAt.toMillis()).toBeGreaterThanOrEqual(before + 90 * 86_400_000);
    expect(event.expiresAt.toMillis()).toBeLessThanOrEqual(Date.now() + 90 * 86_400_000);
    expect(await usage.history('agent', 'github')).toEqual([{ at: event.at, tool: 'list_issues', ok: true }]);
    expect((await ref.get()).data()).not.toHaveProperty('expiresAt');
  });

  it('expires delivery history after 90 days without exposing storage metadata', async () => {
    const db = testDb();
    const triggers = new TriggerStore(db);
    const entry = { at: new Date().toISOString(), outcome: 'filtered' as const, why: 'not relevant' };
    const before = Date.now();
    await triggers.logOutcome('listener', entry);
    const event = (await db.collection(COLLECTIONS.triggerListeners).doc('listener').collection('deliveries').get()).docs[0]!.data();
    expect(event.expiresAt.toMillis()).toBeGreaterThanOrEqual(before + 90 * 86_400_000);
    expect(event.expiresAt.toMillis()).toBeLessThanOrEqual(Date.now() + 90 * 86_400_000);
    expect(await triggers.history('listener')).toEqual([entry]);
  });
});
