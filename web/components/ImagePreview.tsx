'use client';

import { useRef, useState, type MouseEvent, type TouchEvent, type WheelEvent } from 'react';
import { Icon } from '@/components/Icon';

type ZoomState = { scale: number; x: number; y: number };
export const INITIAL_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

export function clampZoom(scale: number): number {
  return Number.isFinite(scale) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale)) : MIN_ZOOM;
}

export function applyZoom(prev: ZoomState, nextScale: number, focal?: { x: number; y: number }): ZoomState {
  const scale = clampZoom(nextScale);
  if (scale <= 1.01) return INITIAL_ZOOM;
  if (!focal || prev.scale <= 0) return { scale, x: prev.x, y: prev.y };
  const r = scale / prev.scale;
  return { scale, x: prev.x * r + focal.x * (1 - r), y: prev.y * r + focal.y * (1 - r) };
}

export function applyPan(prev: ZoomState, dx: number, dy: number): ZoomState {
  return prev.scale <= 1 ? INITIAL_ZOOM : { scale: prev.scale, x: prev.x + dx, y: prev.y + dy };
}

/** An attached image: a thumbnail that opens it large in a dialog. Esc, a click outside it or ✕ closes it. */
export function ImagePreview({ src, name }: { src: string; name: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState<ZoomState>(INITIAL_ZOOM);
  const gRef = useRef<{ dist?: number; base?: number; x?: number; y?: number; drag?: boolean; moved?: boolean }>({});

  const reset = () => {
    setZoom(INITIAL_ZOOM);
    gRef.current = {};
  };

  const open = () => {
    reset();
    ref.current?.showModal();
    ref.current?.focus();
  };

  const focalOf = (el: HTMLElement | null, cx: number, cy: number) => {
    const r = el?.getBoundingClientRect();
    return r ? { x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2) } : undefined;
  };
  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      gRef.current = {
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1,
        base: zoom.scale,
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
        moved: true,
      };
    } else if (e.touches.length === 1 && zoom.scale > 1) {
      const t = e.touches[0]!;
      gRef.current = { x: t.clientX, y: t.clientY, drag: true, moved: false };
    }
  };

  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    const g = gRef.current;
    if (e.touches.length === 2 && g.dist && g.base !== undefined) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1;
      const mx = (a.clientX + b.clientX) / 2;
      const my = (a.clientY + b.clientY) / 2;
      const dx = g.x !== undefined ? mx - g.x : 0;
      const dy = g.y !== undefined ? my - g.y : 0;
      g.x = mx;
      g.y = my;
      const focal = focalOf(e.currentTarget, mx, my);
      const target = g.base * (dist / g.dist);
      setZoom((prev) => applyPan(applyZoom(prev, target, focal), dx, dy));
    } else if (e.touches.length === 1 && g.drag && g.x !== undefined && g.y !== undefined) {
      const t = e.touches[0]!;
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (Math.hypot(dx, dy) > 2) g.moved = true;
      g.x = t.clientX;
      g.y = t.clientY;
      setZoom((prev) => applyPan(prev, dx, dy));
    }
  };

  const onTouchEnd = () => {
    gRef.current.dist = undefined;
    gRef.current.drag = false;
  };

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (zoom.scale > 1 && e.button === 0) gRef.current = { x: e.clientX, y: e.clientY, drag: true, moved: false };
  };

  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const g = gRef.current;
    if (!g.drag || g.x === undefined || g.y === undefined) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.hypot(dx, dy) > 3) g.moved = true;
    g.x = e.clientX;
    g.y = e.clientY;
    setZoom((prev) => applyPan(prev, dx, dy));
  };

  const onMouseUp = () => {
    gRef.current.drag = false;
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const focal = focalOf(e.currentTarget, e.clientX, e.clientY);
    setZoom((prev) => applyZoom(prev, prev.scale * Math.exp(-e.deltaY * 0.002), focal));
  };

  const onDoubleClick = (e: MouseEvent<HTMLImageElement>) => {
    e.stopPropagation();
    const focal = focalOf(e.currentTarget.parentElement, e.clientX, e.clientY);
    setZoom((prev) => (prev.scale > 1 ? INITIAL_ZOOM : applyZoom(prev, 2.5, focal)));
  };

  return (
    <>
      <button type="button" onClick={open} title={name} className="block max-w-full cursor-zoom-in">
        {/* Signed short-lived redirect; next/image can't optimize it. */}
        <img src={src} alt={name} loading="lazy" referrerPolicy="no-referrer" className="h-64 w-72 max-w-full rounded-lg border border-[var(--border)] object-contain" />
      </button>
      <dialog
        ref={ref}
        aria-label={name}
        tabIndex={-1}
        autoFocus
        onClose={reset}
        onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
        className="fixed inset-0 m-0 h-dvh w-screen max-h-none max-w-none border-0 bg-transparent p-0 outline-none backdrop:bg-black/85 backdrop:backdrop-blur"
      >
        <div
          onClick={(e) => {
            if (gRef.current.moved) {
              gRef.current.moved = false;
              return;
            }
            if (e.target === e.currentTarget) ref.current?.close();
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
          className={`relative flex h-full w-full items-center justify-center overflow-hidden select-none ${zoom.scale > 1 ? 'touch-none cursor-grab active:cursor-grabbing' : ''}`}
        >
          <div className="absolute top-3 right-3 z-10 flex gap-2 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)]">
            {zoom.scale > 1 && (
              <button type="button" aria-label="Reset zoom" onClick={reset} className="btn-ghost min-h-9 bg-black/50 px-2.5 text-xs text-white">
                {Math.round(zoom.scale * 100)}%
              </button>
            )}
            <a href={src} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" className="btn-ghost min-h-9 bg-black/50 px-2.5 text-white">
              ↗
            </a>
            <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="btn-ghost min-h-9 bg-black/50 px-2.5 text-white">
              <Icon name="close" size={16} />
            </button>
          </div>
          {/* Same signed redirect as the thumbnail. */}
          <img
            src={src}
            alt={name}
            referrerPolicy="no-referrer"
            draggable={false}
            onDoubleClick={onDoubleClick}
            style={zoom.scale > 1 ? { transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`, transformOrigin: 'center center' } : undefined}
            className="max-h-[96dvh] max-w-[96vw] object-contain select-none"
          />
        </div>
      </dialog>
    </>
  );
}
