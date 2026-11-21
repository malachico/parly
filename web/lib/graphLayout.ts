/**
 * Deterministic ring layout for the graph neighbour map: the entry in the middle, its
 * neighbours on a ring, and (at depth 2) theirs on an outer ring near their parent.
 * Angles only, no simulation: the same details always draw the same picture.
 */

/** The parts of a graph entry the map needs (structurally a `GraphEntry`). */
export type MapEntry = { id: string; kind: string; title: string };

/** The parts of `GraphNodeDetails` the map needs. */
export type MapInput = {
  node: MapEntry;
  neighbours: Record<string, { id: string; direction: 'out' | 'in' }[]>;
  nodes: MapEntry[];
  edges: { kind: string; from: string; to: string }[];
};

export type PlacedNode = MapEntry & { ring: 0 | 1 | 2; angle: number; x: number; y: number; parent?: string };
export type PlacedEdge = { from: string; to: string; kinds: string[] };
export type MapLayout = { nodes: PlacedNode[]; edges: PlacedEdge[]; inner: number; outer: number };

/** Centre included. */
export const MAX_MAP_NODES = 30;

const KIND_ORDER = ['decision', 'topic', 'person', 'doc', 'skill'];
const INNER_MIN = 130;
const RING_GAP = 105;
// Least arc between neighbours on a ring; a crowded ring grows instead of overlapping.
const MIN_ARC = 40;
const TOP = -Math.PI / 2;

const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i === -1 ? KIND_ORDER.length : i;
};
const byKindTitle = (a: MapEntry, b: MapEntry) =>
  kindRank(a.kind) - kindRank(b.kind) || a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const ringRadius = (count: number, least: number) => Math.max(least, (count * MIN_ARC) / (2 * Math.PI));
const at = (angle: number, r: number) => ({ x: Math.round(Math.cos(angle) * r * 100) / 100, y: Math.round(Math.sin(angle) * r * 100) / 100 });

export function neighbourLayout(d: MapInput): MapLayout {
  const centre = d.node.id;
  const entries = new Map(d.nodes.filter((n) => n.id !== centre).map((n) => [n.id, n]));

  // Ring 1: everything the centre names as a neighbour, whatever the relation.
  const firstIds = new Set<string>();
  for (const rel of Object.keys(d.neighbours).sort()) for (const n of d.neighbours[rel] ?? []) if (entries.has(n.id)) firstIds.add(n.id);
  const ring1 = [...firstIds]
    .map((id) => entries.get(id)!)
    .sort(byKindTitle)
    .slice(0, MAX_MAP_NODES - 1);
  const ring1Index = new Map(ring1.map((n, i) => [n.id, i]));

  // Ring 2: the rest, each under the first ring-1 entry it shares an edge with (orphans last).
  const parentOf = new Map<string, number>();
  for (const e of d.edges) {
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      const p = ring1Index.get(b);
      if (p === undefined || firstIds.has(a) || a === centre) continue;
      parentOf.set(a, Math.min(parentOf.get(a) ?? Infinity, p));
    }
  }
  const ring2 = [...entries.values()]
    .filter((n) => !firstIds.has(n.id))
    .sort((a, b) => (parentOf.get(a.id) ?? Infinity) - (parentOf.get(b.id) ?? Infinity) || byKindTitle(a, b))
    .slice(0, MAX_MAP_NODES - 1 - ring1.length);

  const inner = ringRadius(ring1.length, INNER_MIN);
  const outer = ring2.length ? ringRadius(ring2.length, inner + RING_GAP) : inner;
  const ring1Angle = (i: number) => TOP + (2 * Math.PI * i) / ring1.length;

  // Outer slots are evenly spaced in parent order, then the whole ring is turned to sit
  // as close as it can to the parents (circular mean of the offsets): spacing is never
  // lost to one busy parent.
  const slot = (k: number) => (2 * Math.PI * k) / ring2.length;
  let sin = 0;
  let cos = 0;
  ring2.forEach((n, k) => {
    const p = parentOf.get(n.id);
    if (p === undefined) return;
    sin += Math.sin(ring1Angle(p) - slot(k));
    cos += Math.cos(ring1Angle(p) - slot(k));
  });
  const turn = sin || cos ? Math.atan2(sin, cos) : TOP;

  const nodes: PlacedNode[] = [{ id: centre, kind: d.node.kind, title: d.node.title, ring: 0, angle: 0, x: 0, y: 0 }];
  ring1.forEach((n, i) => {
    const angle = ring1Angle(i);
    nodes.push({ id: n.id, kind: n.kind, title: n.title, ring: 1, angle, ...at(angle, inner) });
  });
  ring2.forEach((n, k) => {
    const angle = turn + slot(k);
    const p = parentOf.get(n.id);
    nodes.push({ id: n.id, kind: n.kind, title: n.title, ring: 2, angle, ...at(angle, outer), ...(p === undefined ? {} : { parent: ring1[p]!.id }) });
  });

  // One line per pair, carrying every relation between them.
  const placed = new Set(nodes.map((n) => n.id));
  const pairs = new Map<string, PlacedEdge>();
  const addEdge = (kind: string, from: string, to: string) => {
    if (from === to || !placed.has(from) || !placed.has(to)) return;
    const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    const e = pairs.get(key);
    if (!e) pairs.set(key, { from, to, kinds: [kind] });
    else if (!e.kinds.includes(kind)) e.kinds.push(kind);
  };
  for (const rel of Object.keys(d.neighbours).sort()) for (const n of d.neighbours[rel] ?? []) addEdge(rel, n.direction === 'out' ? centre : n.id, n.direction === 'out' ? n.id : centre);
  for (const e of [...d.edges].sort((a, b) => `${a.from} ${a.to} ${a.kind}`.localeCompare(`${b.from} ${b.to} ${b.kind}`))) addEdge(e.kind, e.from, e.to);

  const edges = [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, e]) => ({ ...e, kinds: e.kinds.sort() }));
  return { nodes, edges, inner, outer };
}

/** Where focus goes on an arrow key: Left/Right around the ring, Down one ring out, Up one ring in. */
export function nextFocus(nodes: PlacedNode[], index: number, key: string): number {
  const cur = nodes[index];
  if (!cur) return 0;
  const ring = (r: number) => nodes.flatMap((n, i) => (n.ring === r ? [i] : []));
  const nearest = (r: number) => {
    const on = ring(r);
    let best = on[0];
    let gap = Infinity;
    for (const i of on) {
      const g = Math.abs(Math.atan2(Math.sin(nodes[i]!.angle - cur.angle), Math.cos(nodes[i]!.angle - cur.angle)));
      if (g < gap) [best, gap] = [i, g];
    }
    return best;
  };
  switch (key) {
    case 'ArrowRight':
    case 'ArrowLeft': {
      const on = ring(cur.ring);
      const at = on.indexOf(index);
      return on[(at + (key === 'ArrowRight' ? 1 : on.length - 1)) % on.length] ?? index;
    }
    case 'ArrowDown': {
      if (cur.ring === 0) return ring(1)[0] ?? index;
      if (cur.ring === 1) {
        const child = nodes.findIndex((n) => n.parent === cur.id);
        return child !== -1 ? child : (nearest(2) ?? index);
      }
      return index;
    }
    case 'ArrowUp': {
      if (cur.ring === 2) {
        const p = cur.parent ? nodes.findIndex((n) => n.id === cur.parent) : -1;
        return p !== -1 ? p : (nearest(1) ?? index);
      }
      return 0;
    }
    case 'Home':
      return 0;
    case 'End':
      return nodes.length - 1;
    default:
      return index;
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export type GraphPoint = MapEntry & { x: number; y: number };

/**
 * The workspace graph: a small force layout (connected entries pull together, all push apart,
 * a weak pull to the middle keeps loose ones on screen). Seeded on a spiral in kind/title order
 * and run a fixed number of steps, so the same entries always draw the same picture.
 */
// ponytail: O(n²) per step; fine for a few hundred entries, use a quadtree (Barnes-Hut) past that.
export function workspaceLayout(entries: MapEntry[], edges: { from: string; to: string }[], steps = 150): { nodes: GraphPoint[]; size: number } {
  const sorted = [...entries].sort(byKindTitle);
  const index = new Map(sorted.map((n, i) => [n.id, i]));
  const k = 60; // ideal edge length
  const pts = sorted.map((_, i) => ({ x: Math.cos(i * 2.39996) * k * Math.sqrt(i + 0.5), y: Math.sin(i * 2.39996) * k * Math.sqrt(i + 0.5) }));
  const links = edges.flatMap((e) => {
    const a = index.get(e.from);
    const b = index.get(e.to);
    return a === undefined || b === undefined || a === b ? [] : [[Math.min(a, b), Math.max(a, b)] as const];
  }).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let temp = k * 2;
  for (let s = 0; s < steps; s++) {
    const d = pts.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i]!.x - pts[j]!.x || 0.01;
        const dy = pts[i]!.y - pts[j]!.y;
        const dist2 = Math.max(dx * dx + dy * dy, 1);
        const f = (k * k) / dist2;
        d[i]!.x += dx * f;
        d[i]!.y += dy * f;
        d[j]!.x -= dx * f;
        d[j]!.y -= dy * f;
      }
    for (const [a, b] of links) {
      const dx = pts[a]!.x - pts[b]!.x;
      const dy = pts[a]!.y - pts[b]!.y;
      const f = Math.hypot(dx, dy) / k;
      d[a]!.x -= dx * f;
      d[a]!.y -= dy * f;
      d[b]!.x += dx * f;
      d[b]!.y += dy * f;
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      d[i]!.x -= p.x * 0.02;
      d[i]!.y -= p.y * 0.02;
      const len = Math.hypot(d[i]!.x, d[i]!.y) || 1;
      const move = Math.min(len, temp);
      p.x += (d[i]!.x / len) * move;
      p.y += (d[i]!.y / len) * move;
    }
    temp = Math.max(temp * 0.97, 1);
  }
  const nodes = sorted.map((n, i) => ({ ...n, ...at(Math.atan2(pts[i]!.y, pts[i]!.x), Math.hypot(pts[i]!.x, pts[i]!.y)) }));
  const size = Math.max(k, ...nodes.map((n) => Math.max(Math.abs(n.x), Math.abs(n.y))));
  return { nodes, size };
}
