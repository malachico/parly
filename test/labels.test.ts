import { describe, expect, it } from 'vitest';
import { cadence, nextInThread, workingIn } from '../web/lib/labels.js';

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

describe('nextInThread', () => {
  const at = (h: number) => `2026-11-04T${String(h).padStart(2, '0')}:00:00Z`;
  it('ignores other threads, channel-level, paused and unscheduled ones', () => {
    const schedules = [
      { id: 'other', thread: 'p2', active: true, nextAt: at(1) },
      { id: 'channel', active: true, nextAt: at(1) },
      { id: 'paused', thread: 'p1', active: false, nextAt: at(1) },
      { id: 'noNext', thread: 'p1', active: true },
    ];
    expect(nextInThread(schedules, 'p1')).toBeUndefined();
    expect(nextInThread([], 'p1')).toBeUndefined();
  });
  it('picks the soonest and counts the rest', () => {
    const schedules = [
      { id: 'b', thread: 'p1', active: true, nextAt: at(9) },
      { id: 'a', thread: 'p1', active: true, nextAt: at(3) },
      { id: 'c', thread: 'p1', active: true, nextAt: at(12) },
      { id: 'x', thread: 'p2', active: true, nextAt: at(1) },
    ];
    const found = nextInThread(schedules, 'p1');
    expect(found?.next.id).toBe('a');
    expect(found?.more).toBe(2);
  });
});

describe('cadence', () => {
  it('words each repeat', () => {
    expect(cadence({ repeat: 'daily' })).toBe('every day');
    expect(cadence({ repeat: 'weekdays' })).toBe('every weekday');
    expect(cadence({ repeat: 'weekly' })).toBe('weekly');
    expect(cadence({ repeat: 'interval', minutes: 30 })).toBe('every 30 min');
    expect(cadence({ repeat: 'once' })).toBe('');
  });
});
