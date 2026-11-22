import { describe, expect, it } from 'vitest';
import { degrees, ensureVisible, labelled, MAX_MAP_NODES, type MapInput, nearestInDirection, neighbourLayout, nextFocus, reconcileActive, workspaceLayout } from '../web/lib/graphLayout.js';

const entry = (id: string, kind = 'decision') => ({ id, kind, title: `Entry ${id}` });

/** A centre with `first` direct neighbours, each with `perParent` of its own. */
function fixture(first: number, perParent: number): MapInput {
  const nodes = [];
  const edges = [];
  const about = [];
  for (let i = 0; i < first; i++) {
    nodes.push(entry(`n${i}`, i % 2 ? 'person' : 'topic'));
    about.push({ id: `n${i}`, direction: 'out' as const });
    edges.push({ kind: 'about', from: 'c', to: `n${i}` });
    for (let j = 0; j < perParent; j++) {
      nodes.push(entry(`n${i}-${j}`));
      edges.push({ kind: 'involves', from: `n${i}-${j}`, to: `n${i}` });
    }
  }
  return { node: entry('c'), neighbours: { about }, nodes, edges };
}

const minGap = (pts: { x: number; y: number }[]) => {
  let gap = Infinity;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) gap = Math.min(gap, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
  return gap;
};

describe('neighbourLayout', () => {
  it('is deterministic whatever order the hub sends', () => {
    const d = fixture(4, 3);
    const shuffled = { ...d, nodes: [...d.nodes].reverse(), edges: [...d.edges].reverse() };
    expect(neighbourLayout(shuffled)).toEqual(neighbourLayout(d));
  });

  it('puts the centre alone when it has no neighbours', () => {
    const l = neighbourLayout({ node: entry('c'), neighbours: {}, nodes: [], edges: [] });
    expect(l.nodes).toEqual([expect.objectContaining({ id: 'c', ring: 0, x: 0, y: 0 })]);
    expect(l.edges).toEqual([]);
  });

  it('caps the map at 30 nodes, direct neighbours first', () => {
    const l = neighbourLayout(fixture(10, 5));
    expect(l.nodes).toHaveLength(MAX_MAP_NODES);
    expect(l.nodes.filter((n) => n.ring === 1)).toHaveLength(10);
    const placed = new Set(l.nodes.map((n) => n.id));
    for (const e of l.edges) expect(placed.has(e.from) && placed.has(e.to)).toBe(true);
  });

  it('keeps nodes apart on a crowded inner ring and under one busy parent', () => {
    for (const d of [fixture(29, 0), fixture(1, 28)]) {
      const l = neighbourLayout(d);
      expect(l.nodes).toHaveLength(MAX_MAP_NODES);
      expect(minGap(l.nodes)).toBeGreaterThan(30);
    }
  });

  it('places outer nodes near their parent and walks the rings by keyboard', () => {
    const l = neighbourLayout(fixture(4, 2));
    const parent = l.nodes.find((n) => n.id === 'n0')!;
    const kids = l.nodes.filter((n) => n.parent === 'n0');
    expect(kids).toHaveLength(2);
    for (const k of kids) expect(Math.abs(Math.atan2(Math.sin(k.angle - parent.angle), Math.cos(k.angle - parent.angle)))).toBeLessThan(Math.PI / 4);
    const i = l.nodes.indexOf(parent);
    expect(l.nodes[nextFocus(l.nodes, i, 'ArrowDown')]!.parent).toBe('n0');
    expect(nextFocus(l.nodes, nextFocus(l.nodes, i, 'ArrowDown'), 'ArrowUp')).toBe(i);
    expect(nextFocus(l.nodes, i, 'ArrowUp')).toBe(0);
    expect(l.nodes[nextFocus(l.nodes, i, 'ArrowRight')]!.ring).toBe(1);
  });
});

describe('workspaceLayout', () => {
  it('is deterministic, keeps entries apart and pulls connected ones closer than unconnected', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`e${i}`, i % 3 ? 'topic' : 'person'));
    const edges = [{ from: 'e0', to: 'e1' }, { from: 'e1', to: 'e2' }, { from: 'e0', to: 'missing' }];
    const a = workspaceLayout(entries, edges);
    expect(workspaceLayout([...entries].reverse(), [...edges].reverse())).toEqual(a);
    expect(minGap(a.nodes)).toBeGreaterThan(15);
    const p = new Map(a.nodes.map((n) => [n.id, n]));
    const dist = (x: string, y: string) => Math.hypot(p.get(x)!.x - p.get(y)!.x, p.get(x)!.y - p.get(y)!.y);
    const avg = a.nodes.reduce((s, n) => s + dist('e0', n.id), 0) / (a.nodes.length - 1);
    expect(dist('e0', 'e1')).toBeLessThan(avg);
  });

  it('keeps unlinked entries just outside the linked ones instead of flung far out', () => {
    const entries = Array.from({ length: 13 }, (_, i) => entry(`e${i}`, 'topic'));
    const edges = Array.from({ length: 9 }, (_, i) => ({ from: `e${i}`, to: `e${i + 1}` }));
    const { nodes } = workspaceLayout(entries, edges);
    const r = (n: { x: number; y: number }) => Math.hypot(n.x, n.y);
    const linkedMax = Math.max(...nodes.filter((n) => Number(n.id.slice(1)) < 10).map(r));
    for (const n of nodes.filter((n) => Number(n.id.slice(1)) >= 10)) expect(r(n)).toBeLessThanOrEqual(linkedMax + 61);
    expect(minGap(nodes)).toBeGreaterThan(15);
  });
});

describe('degrees, labelled, nearestInDirection', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 10 },
    { id: 'c', x: 0, y: 100 },
    { id: 'd', x: -100, y: -100 },
  ];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
    { from: 'a', to: 'c' },
    { from: 'a', to: 'a' },
    { from: 'a', to: 'zz' },
  ];

  it('counts each pair once and skips loops and unknown ends', () => {
    expect(Object.fromEntries(degrees(nodes, edges))).toEqual({ a: 2, b: 1, c: 1, d: 0 });
  });

  it('labels the best connected first, skips overlaps, but always draws kept ones', () => {
    const deg = degrees(nodes, edges);
    const box = (id: string, x: number) => ({ id, x, y: 0, w: 40, h: 10 });
    expect([...labelled([box('a', 0), box('b', 100), box('c', 10)], deg)].sort()).toEqual(['a', 'b']);
    expect([...labelled([box('a', 0), box('c', 10), box('d', 10)], deg, ['c', 'd'])].sort()).toEqual(['c', 'd']);
    expect([...labelled([box('c', 0), box('d', 10)], deg)]).toEqual(['c']);
  });

  it('moves to the nearest node in the arrow direction, or stays', () => {
    expect(nearestInDirection(nodes, 0, 'ArrowRight')).toBe(1);
    expect(nearestInDirection(nodes, 0, 'ArrowDown')).toBe(2);
    expect(nearestInDirection(nodes, 0, 'ArrowUp')).toBe(3);
    expect(nearestInDirection(nodes, 1, 'ArrowRight')).toBe(1);
    expect(nearestInDirection(nodes, 0, 'Tab')).toBe(0);
  });
});

describe('reconcileActive', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 50, y: 0 },
  ];
  it('keeps a node still drawn, else the nearest, else none', () => {
    expect(reconcileActive({ id: 'a', x: 99, y: 99 }, nodes)).toBe('a');
    expect(reconcileActive({ id: 'gone', x: 40, y: 0 }, nodes)).toBe('b');
    expect(reconcileActive({ id: 'gone', x: 0, y: 0 }, [])).toBeNull();
    expect(reconcileActive(null, nodes)).toBeNull();
  });
});

describe('ensureVisible', () => {
  const vp = { x: 0, y: 0, w: 100, h: 100 };
  it('keeps the same view when the node is already inside the margin', () => {
    const v = { k: 2, x: -50, y: -50, smooth: false };
    expect(ensureVisible(v, { x: 50, y: 50 }, vp, 10)).toBe(v);
  });
  it('pans an offscreen node to just inside the margin, on each side', () => {
    const v = { k: 2, x: 0, y: 0 };
    const at = (n: { x: number; y: number }) => {
      const w = ensureVisible(v, n, vp, 10);
      return [w.k * n.x + w.x, w.k * n.y + w.y];
    };
    expect(at({ x: -20, y: 20 })).toEqual([10, 40]);
    expect(at({ x: 80, y: 20 })).toEqual([90, 40]);
    expect(at({ x: 20, y: -5 })).toEqual([40, 10]);
    expect(at({ x: 20, y: 60 })).toEqual([40, 90]);
    expect(ensureVisible(v, { x: 80, y: 20 }, vp, 10).k).toBe(2);
  });
});
