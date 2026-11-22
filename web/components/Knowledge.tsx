'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { styleOf } from '@/components/graph/NeighbourMap';
import { WorkspaceGraph } from '@/components/graph/WorkspaceGraph';
import { Icon } from '@/components/Icon';
import { KnowledgeDrawer } from '@/components/KnowledgeDrawer';
import { type GraphEntries, type GraphEntry, listGraphEntries } from '@/lib/actions/graph';
import { appendPage, groupByKind, isFillingIn, KIND_LABEL, KNOWLEDGE_KINDS, type KnowledgeKind, searchQuery } from '@/lib/knowledge';
import { plural } from '@/lib/plural';
import { knowledgeHref } from '@/lib/routes';

const pill = (active: boolean) =>
  `inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-ink)]' : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]'}`;

const seg = (active: boolean) =>
  `inline-flex min-h-10 items-center gap-1.5 rounded-[9px] px-3 text-xs font-medium transition-colors ${active ? 'bg-[var(--surface)] text-[var(--fg)] shadow-sm' : 'text-[var(--muted)] hover:text-[var(--fg)]'}`;

/** The Knowledge page: kind chips, a search, then a graph (default) or entries grouped by kind, and more pages. An entry sets `?entry=<id>`. */
export function KnowledgeExplorer({ ws, initial }: { ws: string; initial: GraphEntries }) {
  const [kind, setKind] = useState<KnowledgeKind | undefined>();
  const [q, setQ] = useState('');
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [retry, setRetry] = useState(0);
  const latest = useRef(0);
  const first = useRef(true);
  const selected = useSearchParams().get('entry');
  const query = searchQuery(q);

  // Refetch on a new kind or search (the search debounced), or on Retry; a stale answer is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` only re-runs the fetch
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const n = ++latest.current;
    const t = setTimeout(
      () => {
        setLoading(true);
        listGraphEntries(ws, { kind, q: query }).then((d) => {
          if (n !== latest.current) return;
          // A failed refresh keeps what's on screen and says so.
          setData((prev) => (d.error && prev.entries.length ? { ...prev, error: d.error } : d));
          setLoading(false);
        });
      },
      query ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [ws, kind, query, retry]);

  const more = async () => {
    if (!data.nextCursor) return;
    const n = latest.current;
    setLoading(true);
    const d = await listGraphEntries(ws, { kind, q: query, cursor: data.nextCursor });
    if (n !== latest.current) return;
    if (d.error) {
      setData((prev) => ({ ...prev, error: d.error }));
      setLoading(false);
      return;
    }
    // ponytail: lines between pages are not drawn; ask the hub for edges among all loaded ids if that matters.
    setData((prev) => ({ ...d, entries: appendPage(prev.entries, d.entries), edges: [...prev.edges, ...d.edges] }));
    setLoading(false);
  };

  // Only the URL changes here; KnowledgeDrawer reads `?entry=`. The native history call skips a server round trip.
  const open = (e: GraphEntry) => {
    const params = new URLSearchParams(window.location.search);
    params.set('entry', e.id);
    window.history.pushState(null, '', `${knowledgeHref(ws)}?${params}`);
  };

  const total = KNOWLEDGE_KINDS.reduce((sum, k) => sum + (data.counts[k] ?? 0), 0);
  const groups = groupByKind(data.entries);

  // Only the first, successful, empty answer means the workspace has nothing yet; once the toolbar shows it stays (no unmount mid-typing).
  if (data === initial && isFillingIn(initial) && !initial.error)
    return (
      <div className="card space-y-1 text-sm">
        <p className="font-medium">Nothing here yet</p>
        <p className="text-[var(--muted)]">
          Knowledge fills in as conversations happen: decisions, the people and topics involved, and the docs shared show up here on their own.
        </p>
        {selected && <KnowledgeDrawer ws={ws} id={selected} />}
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-60">
            <span className="sr-only">Search knowledge</span>
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--muted)]" />
            <input
              type="search"
              className="input w-full !pr-10 !pl-9 [&::-webkit-search-cancel-button]:hidden"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              placeholder="Search decisions, people, topics, docs"
            />
            {q && (
              <button type="button" aria-label="Clear search" className="absolute top-1/2 right-0 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-[8px] text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]" onClick={() => setQ('')}>
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
          <div role="group" aria-label="View" className="ml-auto inline-flex rounded-[11px] bg-[var(--subtle)] p-0.5">
            {(['graph', 'list'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} className={seg(view === v)} onClick={() => setView(v)}>
                <Icon name={v === 'graph' ? 'graph' : 'menu'} size={14} />
                {v === 'graph' ? 'Graph' : 'List'}
              </button>
            ))}
          </div>
        </div>
        <nav aria-label="Filter by kind" className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={!kind} className={pill(!kind)} onClick={() => setKind(undefined)}>
            All <span className="tabular-nums opacity-70">{total}</span>
          </button>
          {KNOWLEDGE_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} className={pill(kind === k)} onClick={() => setKind(k)}>
              <span aria-hidden="true" className="size-2.5 rounded-full border" style={{ background: styleOf(k).fill, borderColor: styleOf(k).stroke }} />
              {KIND_LABEL[k]} <span className="tabular-nums opacity-70">{data.counts[k] ?? 0}</span>
            </button>
          ))}
        </nav>
      </div>

      <p aria-live="polite" className="sr-only">
        {loading ? 'Loading' : data.error ? 'Couldn’t load knowledge' : plural(data.entries.length, 'entry', 'entries')}
      </p>

      {data.error && data.entries.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[var(--border)] bg-[var(--subtle)] px-3 py-2 text-sm">
          <span>Showing previous results — couldn’t update</span>
          <button type="button" className="btn btn-ghost min-h-10" disabled={loading} onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}

      <div aria-busy={loading} className={`motion-safe:transition-opacity ${loading ? 'opacity-60' : ''}`}>
        {data.error && data.entries.length === 0 ? (
          <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <p className="font-medium">Couldn’t load knowledge</p>
              <p className="text-[var(--muted)]">Check your connection and try again.</p>
            </div>
            <button type="button" className="btn" disabled={loading} onClick={() => setRetry((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : groups.length === 0 ? (
          loading ? (
            <p className="text-sm text-[var(--muted)]">Loading…</p>
          ) : (
            <div className="card space-y-3 text-sm">
              <p className="font-medium">{query ? `No matches for “${q.trim()}”${kind ? ` in ${KIND_LABEL[kind].toLowerCase()}` : ''}` : `No ${kind ? KIND_LABEL[kind].toLowerCase() : 'entries'} yet`}</p>
              <button
                type="button"
                className="btn min-h-10"
                onClick={() => {
                  setQ('');
                  setKind(undefined);
                }}
              >
                Clear search and filters
              </button>
            </div>
          )
        ) : view === 'graph' ? (
          <WorkspaceGraph entries={data.entries} edges={data.edges} selected={selected} onOpen={open} />
        ) : (
          <div className="max-w-2xl space-y-4">
            {groups.map((g) => (
              <section key={g.kind} aria-labelledby={`knowledge-${g.kind}`} className="space-y-1">
                <h2 id={`knowledge-${g.kind}`} className="label flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2.5 rounded-full border" style={{ background: styleOf(g.kind).fill, borderColor: styleOf(g.kind).stroke }} />
                  {KIND_LABEL[g.kind]}
                </h2>
                <ul className="space-y-0.5">
                  {g.entries.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        aria-current={selected === e.id ? 'true' : undefined}
                        onClick={() => open(e)}
                        className={`block w-full rounded-lg px-2 py-2 text-left hover:bg-[var(--subtle)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${selected === e.id ? 'bg-[var(--subtle)]' : ''}`}
                      >
                        <span className="block break-words text-sm font-medium">{e.title}</span>
                        {e.summary && <span className="line-clamp-2 block break-words text-xs text-[var(--muted)]">{e.summary}</span>}
                        <span className="block text-xs text-[var(--muted)]">{plural(e.sources.length, 'source', 'sources')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      {data.nextCursor && groups.length > 0 && (
        <button type="button" className="btn btn-ghost w-full" disabled={loading} onClick={more}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}

      {selected && <KnowledgeDrawer ws={ws} id={selected} />}
    </div>
  );
}
