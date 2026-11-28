'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { EscClose } from '@/components/EscClose';
import { Icon } from '@/components/Icon';
import { NeighbourMap } from '@/components/graph/NeighbourMap';
import { RowSkeleton } from '@/components/PanelSkeleton';
import { type GraphNodeDetails, graphNode } from '@/lib/actions/graph';
import { connectionGroups, entryUrl, KIND_NAME, sourceLinks, trailTo } from '@/lib/knowledge';

// `for` is the requested id: the hub may answer with a merged entry's canonical id instead.
type Load = { state: 'loading' } | { state: 'error' } | { state: 'gone' } | { state: 'ok'; for: string; details: GraphNodeDetails };

// Entries already opened, by `id:depth`: reopening one shows it at once while it refreshes.
const entryCache = new Map<string, GraphNodeDetails>();
const cachedLoad = (id: string, depth: 1 | 2): Load => {
  const details = entryCache.get(`${id}:${depth}`);
  return details ? { state: 'ok', for: id, details } : { state: 'loading' };
};

/** Moves `?entry=` without a server round trip, as the list does; null closes the drawer. */
const go = (ws: string, id: string | null) => window.history.pushState(null, '', entryUrl(ws, window.location.search, id));

/** The Knowledge page's entry drawer for `?entry=<id>`: what it says, where it was said, and what it's connected to. */
export function KnowledgeDrawer({ ws, id }: { ws: string; id: string }) {
  // Depth belongs to the entry it was picked on; a new entry opens at 1.
  const [picked, setPicked] = useState<{ id: string; depth: 1 | 2 }>({ id, depth: 1 });
  const depth = picked.id === id ? picked.depth : 1;
  const setDepth = (d: 1 | 2) => setPicked({ id, depth: d });
  const [load, setLoad] = useState<Load>(() => cachedLoad(id, 1));
  const [retry, setRetry] = useState(0);
  const [trail, setTrail] = useState<string[]>([]);
  const titles = useRef(new Map<string, string>());
  const latest = useRef(0);
  const box = useRef<HTMLElement>(null);
  const titleId = useId();
  // Full screen below md (Tailwind's 768px) it is a modal dialog; as a side panel the page stays reachable.
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setModal(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Modal: everything outside the drawer is inert, so screen readers can't wander into the covered page.
  useEffect(() => {
    if (!modal) return;
    const off: Element[] = [];
    for (let el = box.current; el && el !== document.body; el = el.parentElement)
      for (const s of el.parentElement?.children ?? []) if (s !== el && !s.hasAttribute('inert')) off.push(s);
    for (const s of off) s.setAttribute('inert', '');
    return () => {
      for (const s of off) s.removeAttribute('inert');
    };
  }, [modal]);

  // Focus moves into the drawer on open and back where it was on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => prev?.focus?.();
  }, []);
  // A connection click unmounts the focused button; keep focus in the drawer.
  useEffect(() => {
    if (load.state !== 'loading' && document.activeElement === document.body) box.current?.focus();
  }, [load]);

  // The trail follows the URL, so list clicks, map clicks and back/forward all agree.
  useEffect(() => setTrail((t) => trailTo(t, id)), [id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is the re-run trigger, not read here — "Try again" refetches
  useEffect(() => {
    const n = ++latest.current;
    // Same entry (a depth change or retry) keeps what's shown until the answer lands.
    setLoad((l) => (l.state === 'ok' && l.for === id ? l : cachedLoad(id, depth)));
    graphNode(id, depth).then(
      (details) => {
        if (n !== latest.current) return;
        if (details) {
          entryCache.set(`${id}:${depth}`, details);
          for (const e of [details.node, ...details.nodes]) titles.current.set(e.id, e.title);
          titles.current.set(id, details.node.title);
        } else for (const d of [1, 2]) entryCache.delete(`${id}:${d}`);
        setLoad(details ? { state: 'ok', for: id, details } : { state: 'gone' });
      },
      // A failed refresh keeps the cached entry on screen; only a cold miss shows the error.
      () => n === latest.current && setLoad(entryCache.has(`${id}:${depth}`) ? cachedLoad(id, depth) : { state: 'error' }),
    );
  }, [id, depth, retry]);

  const close = () => go(ws, null);
  const node = load.state === 'ok' ? load.details.node : undefined;

  return (
    <aside
      ref={box}
      tabIndex={-1}
      {...(modal ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId } : { 'aria-label': node ? node.title : 'Knowledge entry' })}
      onKeyDown={(e) => {
        // Modal: Tab and Shift+Tab cycle inside.
        if (e.key !== 'Tab' || !modal) return;
        const f = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')];
        const [first, last] = [f[0], f[f.length - 1]];
        if (!first || !last) return e.preventDefault();
        const at = document.activeElement;
        if (e.shiftKey && (at === first || at === e.currentTarget)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && at === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      className="canvas-pop outline-none fixed inset-0 z-[70] flex flex-col overflow-hidden bg-[var(--surface)] md:inset-auto md:top-4 md:right-4 md:bottom-4 md:w-[min(560px,calc(100vw-32px))] md:rounded-[22px] md:border md:border-[var(--border)] md:shadow-[0_18px_40px_rgba(23,22,28,0.12)]"
    >
      <EscClose href={entryUrl(ws, '', null)} onClose={close} />
      <div className="flex items-start gap-3 border-b border-[var(--subtle)] px-5 pt-4.5 pb-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {trail.length > 1 && (
            <nav aria-label="Visited entries">
              <ol className="flex flex-wrap items-center gap-1 text-xs text-[var(--muted)]">
                {trail.map((t, i) => (
                  <li key={t} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <span aria-hidden="true">›</span>}
                    {t === id ? (
                      <span aria-current="page" className="max-w-40 truncate font-medium text-[var(--fg)]">
                        {titles.current.get(t) ?? '…'}
                      </span>
                    ) : (
                      <button type="button" className="max-w-40 truncate hover:underline" onClick={() => go(ws, t)}>
                        {titles.current.get(t) ?? 'Entry'}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {node && <span className="label">{KIND_NAME[node.kind]}</span>}
          <h2 id={titleId} className="break-words text-[19px] font-bold">{node ? node.title : load.state === 'loading' ? 'Loading…' : 'Knowledge entry'}</h2>
        </div>
        <button type="button" aria-label="Close" onClick={close} className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
          <Icon name="close" size={18} />
        </button>
      </div>

      <div aria-busy={load.state === 'loading'} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {load.state === 'loading' && <RowSkeleton label="Loading this entry…" />}
        {load.state === 'gone' && <p role="status" className="py-6 text-center text-sm text-[var(--muted)]">This entry doesn’t exist, or it was said somewhere you can’t read.</p>}
        {load.state === 'error' && (
          <div className="space-y-2 py-6 text-center text-sm">
            <p role="alert" className="text-[var(--bad-fg)]">Couldn’t load this entry.</p>
            <button type="button" className="btn btn-ghost" onClick={() => setRetry((r) => r + 1)}>
              Try again
            </button>
          </div>
        )}
        {load.state === 'ok' && <Details ws={ws} details={load.details} depth={depth} setDepth={setDepth} />}
      </div>
    </aside>
  );
}

function Details({ ws, details, depth, setDepth }: { ws: string; details: GraphNodeDetails; depth: 1 | 2; setDepth: (d: 1 | 2) => void }) {
  const { node } = details;
  // The entry's own workspace: a pasted link can open one from another of yours.
  const sources = sourceLinks(node.workspaceId || ws, node.sources);
  const groups = connectionGroups(details);
  const open = (to: string) => go(ws, to);

  return (
    <>
      {node.summary && <p className="whitespace-pre-wrap break-words text-sm">{node.summary}</p>}

      <section aria-labelledby="entry-sources" className="space-y-1">
        <h3 id="entry-sources" className="label">
          Where it was said
        </h3>
        {sources.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No messages to link to.</p>
        ) : (
          <ul className="space-y-0.5">
            {sources.map((s, i) => (
              <li key={s.key}>
                <Link href={s.href} className="text-sm text-[var(--accent)] hover:underline">
                  Message {i + 1}
                  {s.inThread ? ' (in a thread)' : ''}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="entry-connections" className="space-y-3">
        <h3 id="entry-connections" className="label">
          Connections
        </h3>
        <div className="h-72">
          <NeighbourMap details={details} onSelect={(to) => to !== node.id && open(to)} depth={depth} onDepthChange={setDepth} />
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No connections yet.</p>
        ) : (
          groups.map((g) => (
            <div key={g.relation} className="space-y-0.5">
              <h4 className="text-xs font-medium text-[var(--muted)]">{g.relation}</h4>
              <ul className="space-y-0.5">
                {g.items.map(({ entry, direction }) => (
                  <li key={`${entry.id}:${direction}`}>
                    <button type="button" onClick={() => open(entry.id)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-[var(--subtle)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
                      <span className="break-words text-sm font-medium">{entry.title}</span>{' '}
                      <span className="text-xs text-[var(--muted)]">
                        {KIND_NAME[entry.kind]}
                        {direction === 'in' ? ' · points here' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </>
  );
}
