import { describe, expect, it } from 'vitest';
import { MAX_MAP_NODES, type MapInput, neighbourLayout, nextFocus } from '../web/lib/graphLayout.js';

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
