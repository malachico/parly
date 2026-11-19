'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, type AvatarOf } from '@/components/Avatar';
import { searchDirectory, searchMessages, type DirectoryEntry, type MessageHit } from '@/lib/actions';
import { shortTime } from '@/lib/labels';

/** One row: what it shows, what ↵ does, and (teams and creatures) what ⌥↵ does: fly there on the canvas. */
export type PaletteItem = {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  who?: AvatarOf;
  icon?: string;
  /** Extra words it matches on (status, teams, ...). */
  keywords?: string;
  run: () => void;
  locate?: () => void;
};

/** Opens the palette from anywhere (the canvas's search button, "New message"). */
export const openPalette = () => window.dispatchEvent(new Event('parly:palette'));

const GROUPS = ['Needs you', 'Recent', 'Teams', 'Agents and people', 'Actions', 'From the directory', 'Messages'];

/** Best first: a name that starts with the query, then one with a word that does, then anything containing it. */
function score(item: PaletteItem, q: string): number {
  const title = item.title.toLowerCase();
  if (title.startsWith(q)) return 3;
  if (title.split(/[\s#@·]+/).some((w) => w.startsWith(q))) return 2;
  if (`${title} ${item.subtitle ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(q)) return 1;
  return 0;
}

/**
 * ⌘K / Ctrl+K: one box to jump to a team, an agent or a person, answer what needs you, run an action, or find a
 * message. ↵ opens it (as a panel over the canvas), ⌥↵ flies the canvas to it. What's on the canvas filters in the
 * browser; the directory and message text are asked from the hub as you type.
 */
export function CommandPalette({ items, dmOf, openMessage }: { items: PaletteItem[]; dmOf: (id: string) => void; openMessage: (hit: MessageHit) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ q: string; people: DirectoryEntry[]; messages: MessageHit[] }>({ q: '', people: [], messages: [] });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const show = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('parly:palette', show);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('parly:palette', show);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setFound({ q: '', people: [], messages: [] });
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  // The directory and message text: from 2 characters, after a short pause, the newest answer wins.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const [dir, messages] = await Promise.all([searchDirectory(q), searchMessages(q)]);
        if (!stale) setFound({ q, people: dir.ok ? dir.agents.slice(0, 5) : [], messages: messages.slice(0, 6) });
      } catch {
        // Offline, or a deploy made the server action stale: show no hits rather than "Searching…" forever.
        if (!stale) setFound({ q, people: [], messages: [] });
      }
    }, 180);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let shown: PaletteItem[];
    if (!q) {
      // Before typing: what needs you, what's unread, the latest conversations, and the actions.
      const of = (g: string, n = Infinity) => items.filter((i) => i.group === g).slice(0, n);
      shown = [...of('Needs you'), ...of('Recent', 5), ...of('Actions').filter((i) => !i.id.startsWith('join:'))];
    } else {
      shown = items
        .map((i) => ({ i, s: score(i, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => GROUPS.indexOf(a.i.group) - GROUPS.indexOf(b.i.group) || b.s - a.s)
        .map((x) => x.i);
      if (found.q.toLowerCase() === q) {
        const known = new Set(items.map((i) => i.id));
        for (const p of found.people) {
          if (known.has(`agent:${p.id}`)) continue;
          shown.push({ id: `dir:${p.id}`, group: 'From the directory', title: p.name, subtitle: p.kind === 'human' ? 'Person' : p.description || 'Agent', who: p, run: () => dmOf(p.id) });
        }
        for (const h of found.messages) {
          shown.push({ id: `msg:${h.message.id}`, group: 'Messages', title: h.message.text.replace(/\s+/g, ' ').slice(0, 90), subtitle: `${h.message.from} · ${h.title} · ${shortTime(h.message.at)}`, icon: '💬', run: () => openMessage(h) });
        }
      }
    }
    return shown;
  }, [items, query, found, dmOf, openMessage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the re-run trigger, not read here — reset the selection to the top whenever the query changes
  useEffect(() => setActive(0), [query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is the re-run trigger, not read here — scroll the newly selected row into view whenever it changes
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const q = query.trim();
  const searching = q.length >= 2 && found.q.toLowerCase() !== q.toLowerCase();
  const choose = (item: PaletteItem | undefined, locate: boolean) => {
    if (!item) return;
    setOpen(false);
    if (locate && item.locate) item.locate();
    else item.run();
  };
  let group = '';
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-[rgba(23,22,28,0.22)] p-0 backdrop-blur sm:p-4 sm:pt-[14vh]" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div role="dialog" aria-label="Search and actions" className="flex max-h-[min(640px,100dvh)] w-full flex-col overflow-hidden bg-[var(--surface)] shadow-[0_30px_80px_rgba(23,22,28,0.28)] sm:w-[600px] sm:rounded-[18px] sm:border sm:border-[var(--border)]">
        <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, rows.length - 1));
              else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
              else if (e.key === 'Enter') choose(rows[active], e.altKey);
              else if (e.key === 'Escape') setOpen(false);
              else return;
              e.preventDefault();
            }}
            placeholder="Jump to a team, an agent or a person, or search messages…"
            aria-label="Search"
            aria-controls="palette-list"
            className="min-w-0 flex-1 bg-transparent text-base outline-none"
          />
          <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--subtle)]">
            Esc
          </button>
        </div>
        <ul id="palette-list" ref={list} role="listbox" aria-label="Results" aria-busy={searching} className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.length === 0 && <li className="px-3 py-8 text-center text-sm text-[var(--muted)]">{searching ? 'Searching…' : q.length >= 2 ? 'Nothing matches.' : 'Type to search.'}</li>}
          {rows.map((item, i) => {
            const heading = item.group !== group ? (group = item.group) : null;
            return (
              <li key={item.id} role="presentation">
                {heading && <div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-[var(--muted)] uppercase">{heading}</div>}
                <div
                  role="option"
                  aria-selected={i === active}
                  onPointerMove={() => setActive(i)}
                  onClick={(e) => choose(item, e.altKey)}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${i === active ? 'bg-[var(--accent-soft)]' : ''}`}
                >
                  {item.who ? <Avatar who={item.who} className="size-8 shrink-0" /> : <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--subtle)] text-base">{item.icon ?? '•'}</span>}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    {item.subtitle && <span className="truncate text-xs text-[var(--muted)]">{item.subtitle}</span>}
                  </span>
                  {i === active && item.locate && <span className="hidden shrink-0 text-[11px] text-[var(--muted)] sm:inline">⌥↵ locate</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="hidden items-center gap-4 border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)] sm:flex">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>⌥↵ locate on the canvas</span>
          <span className="ml-auto">esc close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
