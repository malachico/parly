import { describe, expect, it } from 'vitest';
import { continues } from '../web/lib/labels.js';

describe('thread grouping', () => {
  const at = new Date().toISOString();
  const soon = new Date(Date.now() + 1000).toISOString();

  it('groups the same sender within a few minutes', () => {
    expect(continues({ fromId: 'a', at }, { fromId: 'a', at: soon })).toBe(true);
  });

  it('starts a new author line when one message is automatic and the other is not', () => {
    expect(continues({ fromId: 'a', at }, { fromId: 'a', at: soon, scheduled: true })).toBe(false);
    expect(continues({ fromId: 'a', at, scheduled: true }, { fromId: 'a', at: soon })).toBe(false);
    expect(continues({ fromId: 'a', at, scheduled: true }, { fromId: 'a', at: soon, scheduled: true })).toBe(true);
  });
});
