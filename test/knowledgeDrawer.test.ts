import { describe, expect, it } from 'vitest';
import { connectionGroups, entryUrl, isMissing, sourceLinks, trailTo } from '../web/lib/knowledge.js';

const entry = (id: string) => ({ id, workspaceId: 'w', kind: 'topic' as const, title: `T ${id}`, sources: [] });

describe('knowledge drawer', () => {
  it('isMissing: 404/403 mean gone, an outage does not', () => {
    expect([404, 403].every(isMissing)).toBe(true);
    expect([500, 502, 503, 401].some(isMissing)).toBe(false);
  });

  it('trailTo appends, cuts back on revisit, and caps length', () => {
    expect(trailTo([], 'a')).toEqual(['a']);
    expect(trailTo(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(trailTo(['a', 'b', 'c'], 'a')).toEqual(['a']);
    expect(trailTo(['a', 'b'], 'b')).toEqual(['a', 'b']);
    expect(trailTo(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });

  it('connectionGroups groups by relation and drops unknown ids and empty groups', () => {
    const groups = connectionGroups({
      neighbours: {
        about: [
          { id: 'x', direction: 'out' },
          { id: 'gone', direction: 'out' },
        ],
        involves: [{ id: 'y', direction: 'in' }],
        empty: [{ id: 'gone', direction: 'in' }],
      },
      nodes: [entry('x'), entry('y')],
    });
    expect(groups.map((g) => [g.relation, g.items.map((i) => `${i.entry.id}:${i.direction}`)])).toEqual([
      ['about', ['x:out']],
      ['involves', ['y:in']],
    ]);
  });

  it('sourceLinks links each message, keeps threads, and skips DMs', () => {
    const links = sourceLinks('w', [
      { channelId: 'c1', messageIds: ['m1', 'm2'] },
      { channelId: 'c2', thread: 'p1', messageIds: ['m3'] },
      { channelId: 'c3', messageIds: [] },
      { channelId: '', messageIds: ['dm'] },
    ]);
    expect(links).toHaveLength(4);
    expect(links[0]?.href).toContain('at=m1');
    expect(links[2]).toMatchObject({ inThread: true });
    expect(links[2]?.href).toMatch(/thread=p1.*at=m3/);
    expect(links[3]?.href).not.toContain('at=');
    expect(new Set(links.map((l) => l.key)).size).toBe(4);
  });

  it('entryUrl sets and clears ?entry= and keeps other params', () => {
    expect(entryUrl('w', '?kind=topic', 'e1')).toBe('/w/w/knowledge?kind=topic&entry=e1');
    expect(entryUrl('w', '?kind=topic&entry=e1', null)).toBe('/w/w/knowledge?kind=topic');
    expect(entryUrl('w', '?entry=e1', null)).toBe('/w/w/knowledge');
  });
});
