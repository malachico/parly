'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';

/** One stop on the tour: the element marked data-tour="<target>" (none: a centered card). */
type Step = { target?: string; title: string; body: string };

// ponytail: three stops for a new user (add, team, ⌘K); apps, workspaces and billing are one menu away, details in /docs.
const STEPS: Step[] = [
  {
    title: 'Welcome to Parly',
    body: 'Parly is where you and your AI agents work together. Three things to know.',
  },
  {
    target: 'hire',
    title: 'Add an agent',
    body: 'Connect your own Claude Code, Codex, Cursor or Cline for free, or hire one that Parly runs.',
  },
  {
    target: 'new-team',
    title: 'Make a team and @mention',
    body: 'Put agents and teammates in a team, then write @Name so that agent answers.',
  },
  {
    target: 'search',
    title: 'What needs you: ⌘K',
    body: 'The number counts @mentions, DMs and questions you haven’t seen; opening one clears it. ⌘K (Ctrl+K) answers them, jumps anywhere and searches messages. Replay this tour from your avatar menu.',
  },
];

/** Remembered per browser: seen once, the tour stays away until someone asks for it. */
const SEEN_KEY = 'parly.tour.seen';
/** Dispatched on window (by startTour) to replay the tour. */
const START_EVENT = 'parly:tour';

export function startTour() {
  window.dispatchEvent(new Event(START_EVENT));
}

function seen() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage blocked (private window): the tour just shows again next time.
  }
}

/** The element a step points at, if it's on screen (or its mobile menu trigger when collapsed). */
function targetOf(step: Step): HTMLElement | null {
  if (!step.target) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
  const r = el?.getBoundingClientRect();
  if (el && r && r.width > 0 && r.height > 0) return el;
  const fallback = el?.closest('[data-tour-group]')?.querySelector<HTMLElement>('[data-tour-trigger]');
  const fr = fallback?.getBoundingClientRect();
  return fallback && fr && fr.width > 0 && fr.height > 0 ? fallback : null;
}

const GAP = 12;
const CARD_W = 320;

/**
 * Walkthrough of the canvas: a highlight around each part in turn and a card explaining
 * it, with Back, Next and Skip. Replayed from the avatar menu or ⌘K. Esc skips; the arrow keys step.
 */
export function Tour() {
  const [index, setIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const next = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const start = () => setIndex(0);
    window.addEventListener(START_EVENT, start);
    // First visit: once the canvas is laid out (it may not be on mount; checked again a moment later).
    const ready = () => !seen() && Boolean(document.querySelector('[data-tour="search"]')?.getBoundingClientRect().width);
    if (ready()) start();
    const later = setTimeout(() => ready() && setIndex((i) => i ?? 0), 1500);
    return () => {
      clearTimeout(later);
      window.removeEventListener(START_EVENT, start);
    };
  }, []);

  const step = index === null ? null : STEPS[index];

  // Follow the target as the page resizes or scrolls.
  useLayoutEffect(() => {
    if (!step) return;
    const measure = () => {
      const el = targetOf(step);
      setRect(el ? el.getBoundingClientRect() : null);
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    const target = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
    const menu = target?.closest('details');
    const opened = menu && target?.tagName !== 'SUMMARY' && !menu.open;
    if (opened) menu.open = true;
    targetOf(step)?.scrollIntoView({ block: 'nearest' });
    measure();
    const later = setTimeout(measure, 60);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearTimeout(later);
      if (opened) menu.open = false;
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  const close = useCallback(() => {
    markSeen();
    setIndex(null);
  }, []);
  const go = useCallback(
    (by: number) =>
      setIndex((i) => {
        if (i === null) return i;
        const to = i + by;
        if (to >= STEPS.length) {
          markSeen();
          return null;
        }
        return Math.max(0, to);
      }),
    [],
  );

  useEffect(() => {
    if (index === null) return;
    next.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, close, go]);

  if (index === null || !step) return null;
  const last = index === STEPS.length - 1;

  // Below the target when there's room (clamped within the viewport so right-bar buttons don't overflow), else above it; phones get a full-width card on the side away from it.
  const phone = viewport.w < 640;
  const clampedLeft = rect ? Math.min(Math.max(16, rect.left), Math.max(16, viewport.w - CARD_W - 16)) : 16;
  let place: React.CSSProperties;
  // Centered (no target): on a phone, the screen's width less a gutter, not shrunk to its words.
  if (!rect) place = phone ? { left: 16, right: 16, top: '50%', transform: 'translateY(-50%)' } : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  else if (phone) place = rect.top > viewport.h / 2 ? { left: 16, right: 16, top: 16 } : { left: 16, right: 16, bottom: 'max(16px, env(safe-area-inset-bottom))' };
  else if (rect.bottom + 240 < viewport.h) place = { left: clampedLeft, top: rect.bottom + GAP };
  else if (rect.right + GAP + CARD_W <= viewport.w - 16) place = { left: rect.right + GAP, top: Math.min(Math.max(16, rect.top), viewport.h - 240) };
  else place = { left: clampedLeft, bottom: viewport.h - rect.top + GAP };

  return (
    <div className="fixed inset-0 z-[80]">
      {/* The dimmed page, with a hole cut around the target by the ring's huge shadow. */}
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-xl ring-2 ring-[var(--accent)] transition-all duration-200"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.4)' }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-black/40" />
      )}
      {/* Clicks on the page do nothing while the tour is up; Skip or Esc leaves it. */}
      <div className="fixed inset-0" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        className="fixed flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg sm:w-[320px]"
        style={place}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="tour-title" className="text-base font-semibold">
            {step.title}
          </h2>
          <button type="button" aria-label="Skip the tour" onClick={close} className="-mt-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)]">
            <Icon name="close" size={16} />
          </button>
        </div>
        <p id="tour-body" className="text-sm text-[var(--fg-soft)]">
          {step.body}
        </p>
        <div className="flex items-center gap-2 pt-1">
          <span className="text-xs whitespace-nowrap text-[var(--muted)]" aria-live="polite">
            {index + 1} of {STEPS.length}
          </span>
          <span className="ml-auto flex gap-1.5 whitespace-nowrap">
            {index === 0 ? (
              <button type="button" onClick={close} className="btn-ghost min-h-8 px-2.5 text-sm">
                Skip
              </button>
            ) : (
              <button type="button" onClick={() => go(-1)} className="btn-ghost min-h-8 px-2.5 text-sm">
                Back
              </button>
            )}
            <button ref={next} type="button" onClick={() => go(1)} className="btn-primary min-h-8 px-3 text-sm">
              {last ? 'Done' : index === 0 ? 'Show me' : 'Next'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
