'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { styleOf } from '@/components/graph/NeighbourMap';
import { Icon } from '@/components/Icon';
import type { GraphEdge, GraphEntry } from '@/lib/actions/graph';
import { degrees, ensureVisible, labelled, nearestInDirection, reconcileActive, truncate, workspaceLayout } from '@/lib/graphLayout';
import { plural } from '@/lib/plural';

const radius = (deg: number) => Math.min(16, 6 + 2 * Math.sqrt(deg));
const clampK = (k: number) => Math.min(6, Math.max(0.4, k));

type View = { k: number; x: number; y: number; smooth: boolean };
const FIT: View = { k: 1, x: 0, y: 0, smooth: true };

/**
 * The Knowledge page's graph: every entry a dot coloured by kind and sized by its connections, lines for how they connect. Plain SVG.
 * One tab stop: arrow keys move an active node, Enter opens it. Ctrl/⌘+wheel or a pinch zooms, a mouse drag or two fingers pan.
 */
export function WorkspaceGraph({ entries, edges, selected, onOpen }: { entries: GraphEntry[]; edges: GraphEdge[]; selected: string | null; onOpen: (e: GraphEntry) => void }) {
  const { nodes } = useMemo(() => workspaceLayout(entries, edges), [entries, edges]);
  // Fit the view to the dots themselves (not a square round the origin), so labels stay readable.
  const bounds = useMemo(() => {
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const pad = 120;
    const [x0, y0] = [Math.min(0, ...xs) - pad, Math.min(0, ...ys) - pad];
    const [x1, y1] = [Math.max(0, ...xs) + pad, Math.max(0, ...ys) + pad];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, [nodes]);
  const deg = useMemo(() => degrees(nodes, edges), [nodes, edges]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const nbrs = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      (m.get(e.from) ?? m.set(e.from, new Set()).get(e.from)!).add(e.to);
      (m.get(e.to) ?? m.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    return m;
  }, [edges, byId]);

  const [view, setView] = useState<View>(FIT);
  // Screen px per layout unit at k=1, so labels and dots keep a readable size however far the fit zooms out.
  const [px, setPx] = useState(1);
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const lastActive = useRef<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  // A filter that drops the active node moves it to the nearest one left (or none).
  useEffect(() => setActive(reconcileActive(lastActive.current, nodes)), [nodes]);
  useEffect(() => {
    const n = active ? byId.get(active) : undefined;
    if (n) lastActive.current = { id: n.id, x: n.x, y: n.y };
  }, [active, byId]);

  // Screen pixels → layout units (the SVG scales its viewBox to fit).
  const unit = () => 1 / (svg.current?.getScreenCTM()?.a ?? 1);
  const toLayout = (cx: number, cy: number) => {
    const m = svg.current?.getScreenCTM();
    return m ? { x: (cx - m.e) / m.a, y: (cy - m.f) / m.d } : { x: 0, y: 0 };
  };
  const zoomAt = (v: View, factor: number, p: { x: number; y: number }, smooth: boolean): View => {
    const k = clampK(v.k * factor);
    return { k, x: p.x - ((p.x - v.x) * k) / v.k, y: p.y - ((p.y - v.y) * k) / v.k, smooth };
  };
  const zoom = (factor: number) => setView((v) => zoomAt(v, factor, { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }, true));

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPx(el.getScreenCTM()?.a ?? 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const grow = Math.max(1, 1 / (px * view.k));

  // Wheel and touch need non-passive listeners to keep the page from zooming or scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: helpers only read refs
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const p = toLayout(e.clientX, e.clientY);
      setView((v) => zoomAt(v, Math.exp(-e.deltaY / 200), p, false));
    };
    let pinch: { d: number; mid: { x: number; y: number }; v: View } | null = null;
    const two = (t: TouchList) => {
      const [a, b] = [t[0]!, t[1]!];
      return { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), mid: toLayout((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2) };
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      setView((v) => {
        pinch = { ...two(e.touches), v };
        return v;
      });
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinch) return;
      e.preventDefault();
      const { d, mid } = two(e.touches);
      const start = pinch;
      const z = zoomAt(start.v, d / start.d, start.mid, false);
      setView({ ...z, x: z.x + mid.x - start.mid.x, y: z.y + mid.y - start.mid.y });
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // An opened entry shouldn't sit behind the drawer (a side panel from md up; full screen below).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the selection changes, reading the view at that moment
  useEffect(() => {
    const n = selected ? byId.get(selected) : undefined;
    const m = svg.current?.getScreenCTM();
    if (!n || !m || window.innerWidth < 768) return;
    const free = window.innerWidth - Math.min(560, window.innerWidth - 32) - 32;
    const sx = m.a * (view.k * n.x + view.x) + m.e;
    if (sx < free - 40) return;
    const left = svg.current!.getBoundingClientRect().left;
    setView((v) => ({ ...v, x: v.x - (sx - (left + free) / 2) / m.a, smooth: true }));
  }, [selected, byId]);

  // Arrow keys can move to a node a zoom or pan left offscreen: pan just enough to show it (40 screen px in).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active node moves, reading the view at that moment
  useEffect(() => {
    const n = keyboard && active ? byId.get(active) : undefined;
    if (!n) return;
    setView((v) => {
      const w = ensureVisible(v, n, bounds, 40 / px);
      return w === v ? v : { ...w, smooth: true };
    });
  }, [active]);

  const focusId = hover ?? (keyboard ? active : null) ?? selected;
  const lit = focusId ? new Set([focusId, ...(nbrs.get(focusId) ?? [])]) : null;
  // Labels keep a constant on-screen size, so zooming in makes room for more; hovered, active and their neighbours always show.
  // A label near the edge slides inward so it isn't clipped at the fitted view.
  const labelX = (n: { x: number; title: string }) => {
    const half = truncate(n.title, 22).length * 3.1 * grow;
    return Math.min(Math.max(n.x, bounds.x + half), bounds.x + bounds.w - half);
  };
  const boxes = nodes.map((n) => ({ id: n.id, x: labelX(n), y: n.y + (radius(deg.get(n.id) ?? 0) + 2) * grow, w: truncate(n.title, 22).length * 6.2 * grow, h: 14 * grow }));
  const shown = labelled(boxes, deg, [...(lit ?? []), ...(selected ? [selected] : []), ...(active ? [active] : [])]);
  const activeIndex = nodes.findIndex((n) => n.id === active);
  const open = (id: string) => {
    const e = entryById.get(id);
    if (e) onOpen(e);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (!nodes.length) return;
      if (activeIndex < 0) {
        const start = selected && byId.has(selected) ? selected : [...nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0))[0]!.id;
        setActive(start);
      } else setActive(nodes[nearestInDirection(nodes, activeIndex, e.key)]!.id);
    } else if ((e.key === 'Enter' || e.key === ' ') && active) {
      e.preventDefault();
      open(active);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoom(1.25);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoom(0.8);
    } else if (e.key === '0') {
      e.preventDefault();
      setView(FIT);
    }
  };

  const ctrl = 'inline-flex size-10 items-center justify-center rounded-[10px] text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]';

  return (
    <div className="card relative overflow-hidden !p-0">
      <div
        ref={box}
        role="listbox"
        tabIndex={0}
        aria-label={`Knowledge graph, ${plural(nodes.length, 'entry', 'entries')}`}
        aria-activedescendant={active ? `kg-node-${active}` : undefined}
        onKeyDown={onKeyDown}
        onFocus={(e) => setKeyboard(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => setKeyboard(false)}
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse' || e.button !== 0) return;
          dragged.current = false;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
          d.moved = true;
          dragged.current = true;
          setView((v) => ({ ...v, x: d.vx + dx * unit(), y: d.vy + dy * unit(), smooth: false }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        className="peer relative cursor-grab outline-none [touch-action:pan-y] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
        style={{ height: 'min(70vh, max(320px, calc(100dvh - 15rem)))' }}
      >
        <svg ref={svg} viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`} className="block size-full select-none" aria-hidden="false">
          <g
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
            className={view.smooth ? 'motion-safe:transition-transform motion-safe:duration-200' : ''}
          >
            {edges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const on = !!focusId && (e.from === focusId || e.to === focusId);
              return (
                <line
                  key={`${e.kind}-${e.from}-${e.to}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={on ? 'var(--accent)' : 'var(--border-strong)'}
                  strokeWidth={on ? 2 : 1.25}
                  vectorEffect="non-scaling-stroke"
                  opacity={lit && !on ? 0.2 : 1}
                  className="motion-safe:transition-opacity"
                />
              );
            })}
            {nodes.map((n) => {
              const st = styleOf(n.kind);
              const r = radius(deg.get(n.id) ?? 0) * grow;
              const isActive = keyboard && active === n.id;
              const ring = selected === n.id || isActive || hover === n.id;
              const dim = lit && !lit.has(n.id);
              return (
                <g
                  key={n.id}
                  id={`kg-node-${n.id}`}
                  role="option"
                  aria-selected={selected === n.id}
                  aria-label={`${st.label}: ${n.title}, ${plural(deg.get(n.id) ?? 0, 'connection', 'connections')}`}
                  className="cursor-pointer motion-safe:transition-opacity"
                  opacity={dim ? 0.25 : 1}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                  onClick={() => {
                    if (dragged.current) return;
                    setActive(n.id);
                    open(n.id);
                  }}
                >
                  <title>{n.title}</title>
                  {ring && <circle cx={n.x} cy={n.y} r={r + 5 * grow} fill="none" stroke="var(--accent)" strokeWidth={isActive || selected === n.id ? 2.5 : 1.5} vectorEffect="non-scaling-stroke" />}
                  <circle cx={n.x} cy={n.y} r={r} fill={st.fill} stroke={st.stroke} strokeWidth="1.5" />
                </g>
              );
            })}
            {/* Labels go in a second pass so no later circle paints over them; each node's aria-label already names it. */}
            {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: an SVG <g> without tabIndex is not focusable */}
            <g aria-hidden="true" pointerEvents="none">
            {nodes.map((n) =>
              shown.has(n.id) ? (
                <text
                  key={n.id}
                  x={labelX(n)}
                  y={n.y + radius(deg.get(n.id) ?? 0) * grow + 12 * grow}
                  textAnchor="middle"
                  fontSize={11 * grow}
                  fill="var(--fg)"
                  stroke="var(--surface)"
                  strokeWidth={3 * grow}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  fontWeight={lit?.has(n.id) ? 600 : 400}
                  opacity={lit && !lit.has(n.id) ? 0.25 : 1}
                  className="motion-safe:transition-opacity"
                >
                  {truncate(n.title, 22)}
                </text>
              ) : null,
            )}
            </g>
          </g>
        </svg>
      </div>
      <p className="pointer-events-none absolute top-2 left-2 hidden rounded-md bg-[var(--surface)] px-2 py-1 text-xs text-[var(--muted)] shadow-sm peer-focus-visible:block">Arrow keys to move, Enter to open</p>
      <div className="absolute right-2 bottom-2 flex flex-col rounded-[12px] border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <button type="button" aria-label="Zoom in" className={ctrl} onClick={() => zoom(1.25)}>
          <Icon name="plus" size={18} />
        </button>
        <button type="button" aria-label="Zoom out" className={ctrl} onClick={() => zoom(0.8)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button type="button" aria-label="Fit to screen" className={ctrl} onClick={() => setView(FIT)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
