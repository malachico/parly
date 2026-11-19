import { describe, expect, it } from 'vitest';
import { BoundedMap } from '../src/lib/boundedMap.js';

describe('bounded caches', () => {
  it('drops old entries while retaining refreshed values', () => {
    const cache = new BoundedMap<string, number>(2);
    cache.set('a', 1).set('b', 2).set('a', 3).set('c', 4);
    expect([...cache]).toEqual([['a', 3], ['c', 4]]);
    for (let i = 0; i < 100; i++) cache.set(String(i), i);
    expect([...cache]).toEqual([['98', 98], ['99', 99]]);
  });

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid capacity %s', (limit) => {
    expect(() => new BoundedMap(limit)).toThrow(RangeError);
  });
});
