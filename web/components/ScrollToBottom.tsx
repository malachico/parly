'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Distance from the bottom to restore after older messages load above, per scroll box (see LoadOlder). */
const keep: Record<string, number> = {};

/**
 * Scrolls `el` to the bottom of the conversation — unless the last message is taller than `el`,
 * in which case it aligns the top of that last message with the top of `el` so its sender stays in view.
 */
export function scrollToEnd(el: HTMLElement) {
  el.scrollTop = el.scrollHeight;
  const msgs = el.querySelectorAll<HTMLElement>('[id^="msg-"]');
  const last = msgs[msgs.length - 1];
  if (!last) return;
  const over = last.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
  if (over < 0) el.scrollTop += over;
}

/**
 * Keeps the newest message in view inside the thread's scroll box: jumps to it on open, and
 * follows new messages only when you were already near the bottom. The first jump can go to an
 * element instead (`focusId`), which flashes briefly so the eye finds it.
 * Images, fonts and a phone's viewport settle after the first paint and move things, so for a
 * moment after opening, the jump is repeated whenever the content resizes, until you scroll. The box
 * starts hidden (.placing) and is shown once in place, so opening never flashes the top first.
 */
export function ScrollToBottom({ count, latest, target, focusId }: { count: number; latest?: number; target: string; focusId?: string }) {
  const seen = useRef(count);
  // The newest message's seq: a full page keeps the same length as one drops off the top, so length alone misses new ones.
  const newest = useRef(latest);
  // How far from the bottom the reader was before the newest render (after it, a new message has already pushed it up).
  const fromBottom = useRef(0);
  // The message the reader is on (the first one in view) and how far it was from the box's top: kept there after a render.
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const focus = useRef(focusId);
  focus.current = focusId;

  // Opening: place it before first paint, keep it placed while things settle, then show it. Its own effect, so a
  // remount (React's dev double run, a refresh) starts it over instead of skipping it.
  useIsoLayoutEffect(() => {
    const el = document.getElementById(target);
    if (!el) return;
    const fid = focus.current;
    const focused = fid ? document.getElementById(fid) : null;
    const place = () =>
      focused ? focused.scrollIntoView({ block: focused.offsetHeight > el.clientHeight ? 'start' : 'center' }) : scrollToEnd(el);
    place();
    el.classList.remove('placing');
    for (const p of el.querySelectorAll('.placing')) p.classList.remove('placing');
    if (focused) focused.animate([{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }], { duration: 2400, easing: 'ease-out' });
    // ponytail: 2s of re-placing after open; longer only if slow images still land late
    let settled = false;
    let hidden = el.clientHeight === 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      settled = true;
    };
    const arm = () => {
      settled = false;
      clearTimeout(timer);
      timer = setTimeout(stop, 2000);
    };
    if (!hidden) arm();
    // The reader has scrolled, tapped or typed here: from then on, nothing moves the box but them.
    let moved = false;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === 0) {
        hidden = true;
        return;
      }
      if (hidden) {
        hidden = false;
        // Shown again (a phone closing the thread over it): back at the bottom only if the reader hasn't scrolled.
        if (moved) return;
        arm();
      }
      if (!settled) place();
    });
    for (const child of [el, ...el.children, ...el.querySelectorAll('.placing')]) observer.observe(child);
    // An image that lands late (after the 2s) still puts it back in place, until the reader moves.
    const onMedia = () => !moved && el.clientHeight > 0 && place();
    el.addEventListener('load', onMedia, true);
    const touched = () => {
      moved = true;
      stop();
    };
    const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    for (const e of events) el.addEventListener(e, touched, { once: true, passive: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      el.removeEventListener('load', onMedia, true);
      for (const e of events) el.removeEventListener(e, touched);
    };
  }, [target]);

  useEffect(() => {
    const el = document.getElementById(target);
    if (!el) return;
    const track = () => {
      fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
      const top = el.getBoundingClientRect().top;
      const first = [...el.querySelectorAll<HTMLElement>('[id^="msg-"]')].find((m) => m.getBoundingClientRect().bottom > top);
      anchor.current = first ? { id: first.id, offset: first.getBoundingClientRect().top - top } : undefined;
    };
    // Measure at most once a frame, not on every scroll event.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        track();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Where opening left it (at a focused message, say), even if the reader hasn't scrolled yet; again once it settles.
    const settle = setTimeout(track, 2100);
    requestAnimationFrame(track);
    return () => {
      clearTimeout(settle);
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, [target]);

  // Later: older messages loaded above keep the reader in place; new ones follow only from near the bottom.
  useIsoLayoutEffect(() => {
    const el = document.getElementById(target);
    if (!el) return;
    const prev = seen.current;
    seen.current = count;
    const prevNewest = newest.current;
    newest.current = latest;
    if (keep[target] !== undefined) {
      el.scrollTop = el.scrollHeight - keep[target]!;
      delete keep[target];
      return;
    }
    // Where the reader was before this render: at the bottom (a little slack) follows, however tall the new message;
    // a third of a phone's screen above it (someone reading the last messages) stays put.
    const nearBottom = fromBottom.current < 80;
    const arrived = latest !== undefined && prevNewest !== undefined ? latest > prevNewest : count > prev;
    if (arrived && nearBottom) scrollToEnd(el);
    else if (arrived && anchor.current) {
      // Reading higher up: a full page drops its oldest message as a new one comes, so put the message being read back where it was.
      const a = document.getElementById(anchor.current.id);
      if (a) el.scrollTop += a.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset;
    }
    fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
  }, [count, latest, target]);
  return null;
}

function getTouchY(e: Event): number | undefined {
  const touches = (e as { touches?: ArrayLike<{ clientY: number }> }).touches;
  return touches?.[0]?.clientY;
}

/**
 * Wires `LoadOlder` to its scroll container `box`. Older messages only load when:
 * 1. `el` is within the top 300px of `box` (`inView` via `IntersectionObserver`),
 * 2. the reader has explicitly gestured upward toward older messages (`wheel` with `deltaY < 0`,
 *    a touch pull dragging content down with `clientY - touchStartY > 6`, or `ArrowUp`/`PageUp`/`Home`),
 * 3. `box` is visible (`clientHeight > 0`) and no panel transition (`[data-pending]`, such as `close-aside`)
 *    is in flight.
 * A bare `scroll` event (from layout shifts, `ScrollToBottom`, or revealing `[data-main]` when closing a
 * mobile thread) or a downward touch/wheel/key gesture never arms pagination.
 */
export function bindLoadOlder(
  el: HTMLElement,
  box: HTMLElement,
  onLoad: () => void | Promise<void>,
  Observer: typeof IntersectionObserver = IntersectionObserver,
): () => void {
  let inView = false;
  let scrolled = false;
  let loaded = false;
  let touchY: number | undefined;
  const load = () => {
    if (loaded || !inView || !scrolled || !box.clientHeight || el.closest('[data-pending]')) return;
    loaded = true;
    io.disconnect();
    // Failed load: re-arm so scrolling to the top can retry (href often unchanged for onLoadOlder).
    let result: void | Promise<void>;
    try {
      result = onLoad();
    } catch {
      loaded = false;
      if (el.isConnected) io.observe(el);
      return;
    }
    if (result && typeof result.then === 'function') {
      void result.catch(() => {
        loaded = false;
        if (el.isConnected) io.observe(el);
      });
    }
  };
  const io = new Observer(
    ([e]) => {
      inView = Boolean(e?.isIntersecting);
      load();
    },
    { root: box, rootMargin: '300px 0px 0px 0px' },
  );
  const onWheel = (e: Event) => {
    const dy = (e as WheelEvent).deltaY;
    if (dy < 0) {
      scrolled = true;
      load();
    } else if (dy > 0) {
      scrolled = false;
    }
  };
  const onTouchStart = (e: Event) => {
    touchY = getTouchY(e);
  };
  const onTouchMove = (e: Event) => {
    const y = getTouchY(e);
    if (touchY === undefined || y === undefined) return;
    const dy = y - touchY;
    if (Math.abs(dy) <= 6) return;
    touchY = y;
    // Pulling content down (dy > 6) scrolls upward toward older messages; swiping up (dy < -6) scrolls downward.
    if (dy > 0) {
      scrolled = true;
      load();
    } else {
      scrolled = false;
    }
  };
  const onKeyDown = (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if (['ArrowUp', 'PageUp', 'Home'].includes(key)) {
      scrolled = true;
      load();
    } else if (['ArrowDown', 'PageDown', 'End', ' '].includes(key)) {
      scrolled = false;
    }
  };
  io.observe(el);
  box.addEventListener('wheel', onWheel, { passive: true });
  box.addEventListener('touchstart', onTouchStart, { passive: true });
  box.addEventListener('touchmove', onTouchMove, { passive: true });
  box.addEventListener('keydown', onKeyDown, { passive: true });
  return () => {
    io.disconnect();
    box.removeEventListener('wheel', onWheel);
    box.removeEventListener('touchstart', onTouchStart);
    box.removeEventListener('touchmove', onTouchMove);
    box.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * At the top of a scroll box: when the reader scrolls up to it, loads `href` (the same page with
 * more older messages) in place, and the box keeps its position.
 * Idle: no "Loading…" copy (that looked like a stuck spinner when Done threads left a short open feed).
 */
export function LoadOlder({
  href,
  target,
  label = 'Loading older messages…',
  onLoadOlder,
}: {
  href: string;
  target: string;
  label?: string;
  onLoadOlder?: () => void | Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // router.replace resolves to void, so it is no pending signal: a transition stays pending for the whole
  // navigation, which both shows the spinner and — since no binding exists while pending — bars a double-fire.
  const [isPending, startTransition] = useTransition();
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  useEffect(() => {
    const el = ref.current;
    const box = document.getElementById(target);
    if (isPending || !el || !box) return;
    return bindLoadOlder(el, box, () => {
      keep[target] = box.scrollHeight - box.scrollTop;
      startTransition(async () => {
        try {
          if (loadOlderRef.current) await loadOlderRef.current();
          else router.replace(href, { scroll: false });
        } catch {
          delete keep[target];
        }
      });
    });
  }, [href, target, router, isPending]);
  return (
    <div ref={ref} className="py-2 text-center text-xs text-[var(--muted)]" aria-busy={isPending || undefined}>
      {isPending ? label : '\u00a0'}
    </div>
  );
}

/** Inside a scroll box: a "Latest ↓" button while the reader is far from the bottom. */
export function JumpToLatest({ target }: { target: string }) {
  const [far, setFar] = useState(false);
  useEffect(() => {
    const el = document.getElementById(target);
    if (!el) return;
    const check = () => setFar(el.scrollHeight - el.scrollTop - el.clientHeight > 600);
    el.addEventListener('scroll', check, { passive: true });
    return () => el.removeEventListener('scroll', check);
  }, [target]);
  if (!far) return null;
  return (
    <button
      type="button"
      onClick={() => document.getElementById(target)?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'smooth' })}
      className="sticky bottom-3 left-full z-10 mr-1 flex h-9 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 text-sm font-medium shadow-md hover:bg-[var(--subtle)]"
    >
      Latest ↓
    </button>
  );
}
