'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { RoutineSetup } from './shared';

/** Polls /api/routines while the tab is visible; re-renders the page once, when the setup it was drawn with changes. */
export function RoutineWait({ setup }: { setup: RoutineSetup }) {
  const router = useRouter();
  useEffect(() => {
    const drawn = JSON.stringify(setup);
    let done = false;
    const poll = async () => {
      if (done || document.visibilityState !== 'visible') return;
      // The page stops waiting 10 minutes after it fired: re-render once then, changed or not.
      if (Date.now() - Date.parse(setup.at) < 10 * 60_000) {
        const body = await fetch('/api/routines', { cache: 'no-store' })
          .then((r) => (r.ok ? (r.json() as Promise<{ setup: RoutineSetup | null }>) : undefined))
          .catch(() => undefined);
        if (!body || done || JSON.stringify(body.setup ?? undefined) === drawn) return;
      }
      done = true;
      router.refresh();
    };
    const every = setInterval(poll, 4000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      done = true;
      clearInterval(every);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [router, setup]);
  return null;
}
