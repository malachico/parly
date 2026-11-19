import { describe, expect, it } from 'vitest';
import { workingIn } from '../web/lib/labels.js';

describe('workingIn', () => {
  const now = Date.parse('2026-11-04T06:00:00Z');
  const at = '2026-11-04T05:55:00Z';
  it('counts fresh work in the channel or its threads', () => {
    expect(workingIn({ text: 'tests', at, conversationId: 'channel:c1' }, 'c1', now)).toBe(true);
    expect(workingIn({ text: 'tests', at, conversationId: 'thread:c1:p1' }, 'c1', now)).toBe(true);
  });
  it('ignores work elsewhere, finished work and old work', () => {
    expect(workingIn({ text: 'tests', at, conversationId: 'thread:c2:p1' }, 'c1', now)).toBe(false);
    expect(workingIn({ text: 'tests', at, conversationId: 'dm:a:b' }, 'c1', now)).toBe(false);
    expect(workingIn({ text: 'Done: shipped', at, conversationId: 'channel:c1' }, 'c1', now)).toBe(false);
    expect(workingIn({ text: 'tests', at: '2026-11-04T05:00:00Z', conversationId: 'channel:c1' }, 'c1', now)).toBe(false);
    expect(workingIn(undefined, 'c1', now)).toBe(false);
  });
});
