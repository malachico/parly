'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/** Esc goes to `href` (closes a side panel), unless something nearer handled it or a half-written text would be left. */
export function EscClose({ href, onClose }: { href: string; onClose?: () => void }) {
  const router = useRouter();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target;
      if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value) return;
      if (closeRef.current) {
        closeRef.current();
        return;
      }
      const link = [...document.querySelectorAll<HTMLAnchorElement>('[data-main] ~ aside a[href], a[aria-label^="Close"]')].find(
        (a) => new URL(a.href, location.href).href === new URL(href, location.href).href,
      );
      if (link) link.click();
      else router.push(href, { scroll: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [href, router]);
  return null;
}

