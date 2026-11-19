'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * A public channel stays live for visitors (who have no event feed): it re-renders every so often while visible.
 * A hidden tab doesn't poll at all; coming back refreshes once and resumes.
 */
export function PublicRefresh({ everyMs = 20_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    const tick = () => navigator.onLine !== false && router.refresh();
    const sync = () => {
      clearInterval(t);
      t = undefined;
      if (document.hidden) return;
      t = setInterval(tick, everyMs);
    };
    const onVisible = () => {
      if (!document.hidden) tick();
      sync();
    };
    sync();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, everyMs]);
  return null;
}
