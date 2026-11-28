'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * A public channel stays live for visitors (who have no event feed): it re-renders every so often while visible.
 * A hidden tab doesn't poll at all; coming back refreshes once and resumes. With `whileInView` it also only polls
 * while its parent section is on screen, catching up once on scroll-in if a refresh is due.
 */
export function PublicRefresh({ everyMs = 20_000, whileInView = false }: { everyMs?: number; whileInView?: boolean }) {
  const router = useRouter();
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    let inView = !whileInView;
    let last = Date.now();
    const tick = () => {
      if (navigator.onLine === false) return;
      last = Date.now();
      router.refresh();
    };
    const sync = () => {
      clearInterval(t);
      t = undefined;
      if (document.hidden || !inView) return;
      t = setInterval(tick, everyMs);
    };
    const onVisible = () => {
      if (!document.hidden && inView) tick();
      sync();
    };
    const target = anchor.current?.parentElement;
    const io =
      whileInView && target
        ? new IntersectionObserver(([e]) => {
            inView = !!e?.isIntersecting;
            if (inView && !document.hidden && Date.now() - last >= everyMs) tick();
            sync();
          })
        : undefined;
    if (io && target) io.observe(target);
    else inView = true;
    sync();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, everyMs, whileInView]);
  return whileInView ? <span ref={anchor} hidden /> : null;
}
