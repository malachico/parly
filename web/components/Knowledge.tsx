'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { WorkspaceGraph } from '@/components/graph/WorkspaceGraph';
import { KnowledgeDrawer } from '@/components/KnowledgeDrawer';
import { type GraphEntries, type GraphEntry, listGraphEntries } from '@/lib/actions/graph';
import { appendPage, groupByKind, isFillingIn, KIND_LABEL, KNOWLEDGE_KINDS, type KnowledgeKind, searchQuery } from '@/lib/knowledge';
import { plural } from '@/lib/plural';
import { knowledgeHref } from '@/lib/routes';

const pill = (active: boolean) =>
  `inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-ink)]' : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]'}`;

/** The Knowledge page: kind chips, a search, then a graph (default) or entries grouped by kind, and more pages. An entry sets `?entry=<id>`. */
export function KnowledgeExplorer({ ws, initial }: { ws: string; initial: GraphEntries }) {
  const [kind, setKind] = useState<KnowledgeKind | undefined>();
  const [q, setQ] = useState('');
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const latest = useRef(0);
  const first = useRef(true);
  const selected = useSearchParams().get('entry');
  const query = searchQuery(q);

  // Refetch on a new kind or search (the search debounced); a stale answer is dropped.
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
          setData(d);
          setLoading(false);
        });
      },
      query ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [ws, kind, query]);

  const more = async () => {
    if (!data.nextCursor) return;
    const n = latest.current;
    setLoading(true);
    const d = await listGraphEntries(ws, { kind, q: query, cursor: data.nextCursor });
    if (n !== latest.current) return;
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

  if (isFillingIn(data) && !loading)
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
        <label className="block">
          <span className="label">Search knowledge</span>
          <input type="search" className="input mt-1 w-full" value={q} onChange={(e) => setQ(e.target.value)} placeholder="At least 2 characters" />
        </label>
        <nav aria-label="Filter by kind" className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={!kind} className={pill(!kind)} onClick={() => setKind(undefined)}>
            All <span className="tabular-nums opacity-70">{total}</span>
          </button>
          {KNOWLEDGE_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} className={pill(kind === k)} onClick={() => setKind(k)}>
              {KIND_LABEL[k]} <span className="tabular-nums opacity-70">{data.counts[k] ?? 0}</span>
            </button>
          ))}
        </nav>
        <div role="group" aria-label="View" className="flex gap-2">
          {(['graph', 'list'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} className={pill(view === v)} onClick={() => setView(v)}>
              {v === 'graph' ? 'Graph' : 'List'}
            </button>
          ))}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {loading ? 'Loading' : plural(data.entries.length, 'entry', 'entries')}
      </p>

      {groups.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">{loading ? 'Loading…' : query ? `Nothing matches “${q.trim()}”${kind ? ` in ${KIND_LABEL[kind].toLowerCase()}` : ''}.` : `No ${kind ? KIND_LABEL[kind].toLowerCase() : 'entries'} yet.`}</p>
      ) : view === 'graph' ? (
        <WorkspaceGraph entries={data.entries} edges={data.edges} selected={selected} onOpen={open} />
      ) : (
        groups.map((g) => (
          <section key={g.kind} aria-labelledby={`knowledge-${g.kind}`} className="space-y-1">
            <h2 id={`knowledge-${g.kind}`} className="label">
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
        ))
      )}

      {data.nextCursor && groups.length > 0 && (
        <button type="button" className="btn btn-ghost w-full" disabled={loading} onClick={more}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}

      {selected && <KnowledgeDrawer ws={ws} id={selected} />}
    </div>
  );
}
