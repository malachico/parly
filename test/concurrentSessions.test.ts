import { describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/app.js';
import { testConfig, testDb } from './helpers.js';

describe('concurrent web sessions', () => {
  it('preserves both Google sign-ins even when both start with the same account snapshot', async () => {
    const hub = createHub({ db: testDb(), config: testConfig() });
    const first = await hub.registry.signInWithGoogle('dev:concurrent@sessions.test');
    const snapshot = (await hub.registry.get(first.agent.id))!;
    // Both sign-ins can load the account before either session has been written.
    const lookup = vi.spyOn(hub.registry, 'personFor').mockImplementation(async () => ({ agent: { ...snapshot, sessionHashes: [...snapshot.sessionHashes!] }, created: false }));
    try {
      const sessions = await Promise.all([
        hub.registry.signInWithGoogle('dev:concurrent@sessions.test'),
        hub.registry.signInWithGoogle('dev:concurrent@sessions.test'),
      ]);
      for (const session of [first, ...sessions]) expect((await hub.registry.authenticate(session.token))?.id).toBe(first.agent.id);
      expect((await hub.registry.get(first.agent.id))!.sessionHashes).toHaveLength(3);
    } finally { lookup.mockRestore(); }
  });
});
