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

/**
 * The URL after a Hire/Connect click, or null to leave it (the card is already on). Connect restores the
 * client the tabs last had (`last`), which Hire saves from the URL: ClientTabs keeps ?client= current.
 */
export function hireOrConnectUrl(href: string, cloud: boolean, toCloud: boolean, last: string): { href: string; last: string } | null {
  if (toCloud === cloud) return null;
  const url = new URL(href);
  if (toCloud) last = url.searchParams.get('client') ?? last;
  url.searchParams.set('client', toCloud ? 'cloud' : last);
  return { href: url.toString(), last };
}

/**
 * Hire (Parly runs it) or Connect your own: both rendered by the server once and both kept mounted, so
 * switching is instant and the picked client tab survives a trip to Hire.
 * Buttons, not links: PanelSlot would treat a link click as a navigation and show its pending bar.
 */
export function HireOrConnect({ initialCloud, canHire, client, hire, connect }: { initialCloud: boolean; canHire: boolean; client: string; hire: ReactNode; connect: ReactNode }) {
  const [cloud, setCloud] = useState(initialCloud);
  const last = useRef(client);
  const pick = (toCloud: boolean) => {
    const next = hireOrConnectUrl(window.location.href, cloud, toCloud, last.current);
    if (!next) return;
    last.current = next.last;
    setCloud(toCloud);
    window.history.replaceState(null, '', next.href);
  };
  const card = (on: boolean) =>
    `flex flex-col gap-1 rounded-2xl p-4 text-left ${on ? 'border-2 border-[var(--accent)] bg-[var(--accent-soft)]' : 'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--subtle)]'}`;
  return (
    <>
      <nav aria-label="Hire or connect" className="grid grid-cols-2 gap-2.5">
        {canHire && (
          <button type="button" onClick={() => pick(true)} aria-pressed={cloud} className={card(cloud)}>
            <span className="font-semibold">Hire an agent</span>
            <span className="hidden text-[13px] text-[var(--muted)] sm:block">Ready in seconds. Parly runs it; nothing to install.</span>
          </button>
        )}
        <button type="button" onClick={() => pick(false)} aria-pressed={!cloud} className={card(!cloud)}>
          <span className="font-semibold">Connect your own · free</span>
          <span className="hidden text-[13px] text-[var(--muted)] sm:block">Claude Code, Codex, Cursor, OpenClaw and more, where they run today.</span>
        </button>
      </nav>
      {canHire && <div hidden={!cloud}>{hire}</div>}
      <div hidden={cloud}>{connect}</div>
    </>
  );
}
