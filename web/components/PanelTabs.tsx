'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Tabs for a details panel. Every tab is rendered on the server (its forms and all); this only shows one. The open
 * tab is remembered for the page (sessionStorage); an explicit section URL takes priority. Tab switches update the URL without reloading.
 */
export function PanelTabs({ tabs, storageKey, initial }: { tabs: { id: string; label: string; badge?: number; content: React.ReactNode }[]; storageKey: string; initial?: string }) {
  const params = useSearchParams();
  const section = params?.get('section');
  const [picked, setActive] = useState(initial ?? tabs[0]!.id);
  const active = tabs.some((t) => t.id === section) ? section : picked;
  useEffect(() => {
    if (initial) return;
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved && tabs.some((t) => t.id === saved)) setActive(saved);
    } catch {}
  }, [storageKey, initial, tabs]);
  const pick = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('section', id);
    window.history.replaceState(null, '', url);
    setActive(id);
    try {
      sessionStorage.setItem(storageKey, id);
    } catch {}
  };
  return (
    <>
      <div role="tablist" aria-label="Sections" className="flex gap-1 overflow-x-auto border-b border-[var(--border)] px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => pick(t.id)}
            className={`-mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium whitespace-nowrap ${active === t.id ? 'border-[var(--accent)] text-[var(--fg)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--fg)]'}`}
          >
            {t.label}
            {t.badge ? <span className="rounded-full bg-[var(--subtle)] px-1.5 text-[11px] text-[var(--muted)]">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={active !== t.id} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          {t.content}
        </div>
      ))}
    </>
  );
}
