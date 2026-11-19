'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

type Tab = { key: string; label: string; logo: ReactNode };

/**
 * The connect page's client picker. Every client's steps come rendered from the server once, so switching
 * is instant: no server round trip (and no hub calls) per tab. `first` (pairing code, a just-made agent,
 * the sign-in note) shows until a tab is picked. The URL keeps ?client= so a reload or a share lands on the tab.
 */
export function ClientTabs({ initial, tabs, panels, first }: { initial: string; tabs: Tab[]; panels: Record<string, ReactNode>; first?: ReactNode }) {
  const [client, setClient] = useState(initial);
  const [picked, setPicked] = useState(false);
  const steps = useRef<HTMLDivElement>(null);

  // Opened from a link to the steps (#connect-steps): bring them into view.
  useEffect(() => {
    if (window.location.hash === '#connect-steps') steps.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const pick = (key: string) => {
    setClient(key);
    setPicked(true);
    const url = new URL(window.location.href);
    url.searchParams.set('client', key);
    url.hash = '';
    window.history.replaceState(null, '', url);
    requestAnimationFrame(() => steps.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <>
      <nav aria-label="Client" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tabs.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => pick(c.key)}
            className={`flex min-h-13 items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium sm:min-h-20 sm:flex-col sm:justify-center sm:gap-1.5 sm:p-2.5 sm:text-center ${
              c.key === client ? 'border-2 border-[var(--accent)] bg-[var(--accent-soft)]' : 'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--subtle)]'
            }`}
            aria-pressed={c.key === client}
          >
            {c.logo}
            <span>{c.label}</span>
          </button>
        ))}
      </nav>
      <div id="connect-steps" ref={steps} className="scroll-mt-4 space-y-6">
        {/* key: a form's half-typed state belongs to its client. */}
        <div key={client} className="space-y-6">{(!picked && first) || panels[client]}</div>
      </div>
    </>
  );
}
