'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const tab = (active: boolean) => `flex min-h-9 min-w-0 items-center justify-center rounded-md px-2 text-[13px] font-medium whitespace-nowrap sm:min-h-7 sm:px-3 ${active ? 'bg-[var(--surface)] shadow-sm' : 'text-[var(--muted)] hover:text-[var(--fg-soft)]'}`;

/** A room's two conversations, and who reads each: they're channels underneath, one room to the people in it. Lives in the chat header, in the title's place. */
export function RoomTabs({ sharedHref, cornerHref, inCorner }: { sharedHref: string; cornerHref: string; inCorner: boolean }) {
  return (
    <nav aria-label="Room conversations" className="inline-flex max-w-full gap-0.5 overflow-hidden rounded-lg bg-[var(--subtle)] p-0.5">
      <Link href={sharedHref} aria-current={inCorner ? undefined : 'page'} className={tab(!inCorner)}>
        Shared
      </Link>
      <Link href={cornerHref} aria-current={inCorner ? 'page' : undefined} className={tab(inCorner)}>
        🔒 Private
      </Link>
    </nav>
  );
}

/** Opens the summary beside the room the first time this browser sees one, on a screen wide enough. `open`: it's open already, which counts. Closing it then sticks. */
export function RoomSummaryOpener({ ws, href, open }: { ws: string; href: string; open: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const key = `room-summary-opened:${ws}`;
    if (open) return localStorage.setItem(key, '1');
    if (localStorage.getItem(key) || !matchMedia('(min-width: 1024px)').matches) return;
    localStorage.setItem(key, '1');
    router.replace(href, { scroll: false });
  }, [ws, href, open, router]);
  return null;
}
