import { describe, expect, it } from 'vitest';
import { formatFeedCursor, parseFeedCursor } from '../src/chat/chat.js';

describe('feed cursor', () => {
  it('round-trips an old-format cursor byte-for-byte (nanos preserved)', () => {
    const s = '1700000000.123456789|abc';
    expect(formatFeedCursor(parseFeedCursor(s))).toBe(s);
  });

  it('decodes a bare ISO time to that second, no id', () => {
    const c = parseFeedCursor('2023-11-14T22:13:20.000Z');
    expect(c.at.seconds).toBe(1700000000);
    expect(c.id).toBe('');
  });

  it('rejects a non-cursor string', () => {
    expect(() => parseFeedCursor('not-a-cursor')).toThrow();
  });
});
