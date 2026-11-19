import { expect, test, vi } from 'vitest';
import { retryingMemo } from '../src/lib/retryingMemo.js';

test('caches a resolved value and loads only once', async () => {
  const load = vi.fn(async () => 'ok');
  const memo = retryingMemo(load);
  expect(await memo()).toBe('ok');
  expect(await memo()).toBe('ok');
  expect(load).toHaveBeenCalledTimes(1);
});

test('a rejection is not cached: the next call retries and can succeed', async () => {
  let calls = 0;
  const load = vi.fn(async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return 'ok';
  });
  const memo = retryingMemo(load);
  await expect(memo()).rejects.toThrow('boom');
  expect(await memo()).toBe('ok');
  // Resolved now: a third call reuses it rather than loading a third time.
  expect(await memo()).toBe('ok');
  expect(load).toHaveBeenCalledTimes(2);
});
