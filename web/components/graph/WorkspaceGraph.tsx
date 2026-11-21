'use client';

import { useMemo } from 'react';
import { styleOf } from '@/components/graph/NeighbourMap';
import type { GraphEdge, GraphEntry } from '@/lib/actions/graph';
import { truncate, workspaceLayout } from '@/lib/graphLayout';

const R = 8;
// Titles under every dot only while they stay readable; past that, hover or focus shows them.
const MAX_LABELS = 60;

/** The Knowledge page's graph: every entry shown as a dot coloured by kind, lines for how they connect. Plain SVG. */
export function WorkspaceGraph({ entries, edges, selected, onOpen }: { entries: GraphEntry[]; edges: GraphEdge[]; selected: string | null; onOpen: (e: GraphEntry) => void }) {
  const { nodes, size } = useMemo(() => workspaceLayout(entries, edges), [entries, edges]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const kinds = [...new Set(nodes.map((n) => n.kind))];
  const pad = 70;
  const s = size + pad;

  return (
    <div className="space-y-2">
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
      <div className="card overflow-hidden !p-0">
        <svg viewBox={`${-s} ${-s} ${2 * s} ${2 * s}`} className="block max-h-[70vh] w-full" role="group" aria-label="Knowledge graph">
          {edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            return (
              <line key={`${e.kind}-${e.from}-${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth="1.25">
                <title>{`${a.title} ${e.kind} ${b.title}`}</title>
              </line>
            );
          })}
          {nodes.map((n) => {
            const st = styleOf(n.kind);
            const on = selected === n.id;
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${st.label}: ${n.title}`}
                aria-current={on ? 'true' : undefined}
                className="group cursor-pointer outline-none"
                onClick={() => onOpen(entryById.get(n.id)!)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  onOpen(entryById.get(n.id)!);
                }}
              >
                <title>{n.title}</title>
                <circle cx={n.x} cy={n.y} r={R + 5} fill="none" stroke="var(--accent)" strokeWidth="2.5" className={on ? '' : 'opacity-0 group-focus-visible:opacity-100'} />
                <circle cx={n.x} cy={n.y} r={R} fill={st.fill} stroke={st.stroke} strokeWidth="1.5" className="transition-[stroke-width] group-hover:[stroke-width:3]" />
                <text
                  x={n.x}
                  y={n.y + R + 12}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--fg)"
                  className={`select-none ${nodes.length > MAX_LABELS && !on ? 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100' : ''}`}
                >
                  {truncate(n.title, 22)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
