'use client';

import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import type { GraphNodeDetails } from '@/lib/actions/graph';
import { neighbourLayout, nextFocus, type PlacedNode, truncate } from '@/lib/graphLayout';

export type NeighbourMapProps = {
  details: GraphNodeDetails;
  onSelect: (id: string) => void;
  depth: 1 | 2;
  onDepthChange: (d: 1 | 2) => void;
};

export const KIND_STYLE: Record<string, { fill: string; stroke: string; label: string }> = {
  decision: { fill: 'var(--info-bg)', stroke: 'var(--info-fg)', label: 'Decision' },
  topic: { fill: 'var(--warn-bg)', stroke: 'var(--warn-fg)', label: 'Topic' },
  person: { fill: 'var(--ok-bg)', stroke: 'var(--ok-fg)', label: 'Person' },
  doc: { fill: 'var(--subtle)', stroke: 'var(--fg-soft)', label: 'Doc' },
  skill: { fill: 'var(--bad-bg)', stroke: 'var(--bad-fg)', label: 'Skill' },
};
export const styleOf = (kind: string) => KIND_STYLE[kind] ?? { fill: 'var(--subtle)', stroke: 'var(--muted)', label: kind };

// Room beyond the outer ring for side labels (wide) and top/bottom labels (short).
const PAD_X = 120;
const PAD_Y = 40;
// Relation labels on the lines only while they stay readable.
const MAX_EDGE_LABELS = 10;
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Label just outside the node, anchored away from the centre. */
function labelProps(n: PlacedNode, r: number) {
  if (n.ring === 0) return { x: 0, y: r + 16, textAnchor: 'middle' as const };
  const c = Math.cos(n.angle);
  const s = Math.sin(n.angle);
  const textAnchor = c > 0.35 ? ('start' as const) : c < -0.35 ? ('end' as const) : ('middle' as const);
  const off = r + 6;
  return { x: n.x + c * off, y: n.y + s * off + (textAnchor === 'middle' ? (s > 0 ? 10 : -4) : 4), textAnchor };
}

/** The neighbour map: an entry in the middle, what it's connected to around it. Plain SVG, scales to its container. */
export function NeighbourMap({ details, onSelect, depth, onDepthChange }: NeighbourMapProps) {
  const layout = useMemo(() => neighbourLayout(details), [details]);
  const { nodes, edges, outer } = layout;
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, SVGGElement>());
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const active = focusId && byId.has(focusId) ? focusId : details.node.id;
  const descId = useId();
  const kinds = [...new Set(nodes.map((n) => n.kind))];

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = nodes[i]!;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(n.id);
      return;
    }
    if (!NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    const to = nextFocus(nodes, i, e.key);
    const id = nodes[to]!.id;
    setFocusId(id);
    refs.current.get(id)?.focus();
  };

  const w = outer + PAD_X;
  const h = outer + PAD_Y;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap gap-3 text-xs text-[var(--muted)]" aria-label="Kinds">
          {kinds.map((k) => (
            <li key={k} className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden="true">
                <circle cx="5" cy="5" r="4" fill={styleOf(k).fill} stroke={styleOf(k).stroke} strokeWidth="1.5" />
              </svg>
              {styleOf(k).label}
            </li>
          ))}
        </ul>
        <button type="button" className="btn-ghost !min-h-8 !px-3 text-xs" aria-pressed={depth === 2} onClick={() => onDepthChange(depth === 2 ? 1 : 2)}>
          One more step out
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <svg
          viewBox={`${-w} ${-h} ${2 * w} ${2 * h}`}
          className="block h-full max-h-full w-full"
          role="group"
          aria-label={`Connections of ${details.node.title}`}
          aria-describedby={descId}
        >
          <desc id={descId}>Arrow left and right move around a ring, down moves one ring out, up one ring in. Enter opens an entry.</desc>
          <g>
            {edges.map((e) => {
              const a = byId.get(e.from)!;
              const b = byId.get(e.to)!;
              const rel = e.kinds.join(', ');
              return (
                <g key={`${e.from}-${e.to}`}>
                  <title>{`${a.title} ${rel} ${b.title}`}</title>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth="10" />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth="1.25" />
                  {edges.length <= MAX_EDGE_LABELS && (
                    <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} textAnchor="middle" fontSize="9" fill="var(--muted)" className="select-none">
                      {truncate(rel, 18)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          {nodes.map((n, i) => {
            const st = styleOf(n.kind);
            const r = n.ring === 0 ? 16 : n.ring === 1 ? 10 : 8;
            return (
              <g
                key={n.id}
                ref={(el) => {
                  if (el) refs.current.set(n.id, el);
                  else refs.current.delete(n.id);
                }}
                role="button"
                tabIndex={n.id === active ? 0 : -1}
                aria-label={`${st.label}: ${n.title}`}
                aria-current={n.ring === 0 ? 'true' : undefined}
                className="group cursor-pointer outline-none"
                onClick={() => onSelect(n.id)}
                onFocus={() => setFocusId(n.id)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <title>{n.title}</title>
                <circle cx={n.x} cy={n.y} r={r + 5} fill="none" stroke="var(--accent)" strokeWidth="2.5" className="opacity-0 group-focus-visible:opacity-100" />
                <circle cx={n.x} cy={n.y} r={r} fill={st.fill} stroke={st.stroke} strokeWidth={n.ring === 0 ? 2.5 : 1.5} className="transition-[stroke-width] group-hover:[stroke-width:3]" />
                <text {...labelProps(n, r)} fontSize={n.ring === 0 ? 13 : 11} fontWeight={n.ring === 0 ? 600 : 400} fill={n.ring === 2 ? 'var(--fg-soft)' : 'var(--fg)'} className="select-none">
                  {truncate(n.title, n.ring === 0 ? 30 : 18)}
                </text>
              </g>
            );
          })}
        </svg>
        {nodes.length === 1 && <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-sm text-[var(--muted)]">No connections yet.</p>}
      </div>
    </div>
  );
}
