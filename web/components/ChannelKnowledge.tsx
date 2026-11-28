'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Tip } from '@/components/Tip';
import { RowSkeleton } from '@/components/PanelSkeleton';
import { ErrorNote } from '@/components/ui';
import { type GraphEntries, listGraphEntries, threadGraphSummary } from '@/lib/actions/graph';
import { appendPage } from '@/lib/knowledge';
import { knowledgeHref } from '@/lib/routes';

// ponytail: unbounded per-tab caches, first page / summary only; refreshed on every open.
const pageCache = new Map<string, GraphEntries>();
const summaryCache = new Map<string, Awaited<ReturnType<typeof threadGraphSummary>>>();

/** A channel's entries of every kind, with paging into older entries. */
export function ChannelKnowledge({ ws, channelId }: { ws: string; channelId: string }) {
  const [data, setData] = useState<GraphEntries | undefined>(() => pageCache.get(`${ws}:${channelId}`));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Once "Load more" runs, the background refresh must not rewind the appended pages.
  const paged = useRef(false);
  useEffect(() => {
    let live = true;
    const key = `${ws}:${channelId}`;
    paged.current = false;
    setData(pageCache.get(key));
    setError(false);
    listGraphEntries(ws, { channel: channelId }).then((page) => {
      if (!live) return;
      if (page.error) setError(true);
      else { pageCache.set(key, page); if (!paged.current) setData(page); }
    }).catch(() => live && setError(true));
    return () => { live = false; };
  }, [ws, channelId]);

  const more = async () => {
    if (!data?.nextCursor || loading) return;
    paged.current = true;
    setLoading(true);
    setError(false);
    try {
      const page = await listGraphEntries(ws, { channel: channelId, cursor: data.nextCursor });
      if (page.error) {
        setError(true);
        return;
      }
      setData((prev) => ({ ...page, entries: appendPage(prev?.entries ?? [], page.entries) }));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return <div className="space-y-3">
    {error && <ErrorNote error="Couldn't load knowledge." />}
    {!data && !error && <RowSkeleton label="Loading knowledge…" />}
    {data?.entries.length === 0 && <p className="text-sm text-[var(--muted)]">Nothing recorded in this channel yet. Knowledge fills in as conversations happen.</p>}
    <ul className="space-y-1">
      {data?.entries.map((entry) => <li key={entry.id}>
        <Link href={knowledgeHref(ws, { entry: entry.id })} scroll={false} className="block rounded-lg px-2 py-2 hover:bg-[var(--subtle)]">
          <span className="block break-words text-sm font-medium">{entry.title}</span>
          <span className="text-xs text-[var(--muted)]">{entry.kind}</span>
          {entry.summary && <span className="line-clamp-2 block break-words text-xs text-[var(--muted)]">{entry.summary}</span>}
        </Link>
      </li>)}
    </ul>
    {data?.nextCursor && <button type="button" className="btn-ghost w-full" disabled={loading} onClick={more}>{loading ? 'Loading…' : 'Load more'}</button>}
  </div>;
}

/** Only entries sourced here count; neighbours from other threads do not. */
export function ThreadRelatedKnowledge({ ws, channelId, thread }: { ws: string; channelId: string; thread: string }) {
  const key = `${ws}:${channelId}:${thread}`;
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof threadGraphSummary>> | undefined>(() => summaryCache.get(key));
  useEffect(() => {
    let live = true;
    setSummary(summaryCache.get(key));
    threadGraphSummary(ws, channelId, thread).then((value) => { summaryCache.set(key, value); if (live) setSummary(value); }).catch(() => live && setSummary(null));
    return () => { live = false; };
  }, [key, ws, channelId, thread]);
  if (!summary?.count || !summary.entry) return null;
  const label = `Related knowledge (${summary.count})`;
  return <Tip label={label} align="end"><Link href={knowledgeHref(ws, { entry: summary.entry })} scroll={false} aria-label={label} title={label} className="inline-flex h-11 min-w-9 shrink-0 items-center justify-center rounded-[9px] px-1.5 text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)] sm:h-9 sm:px-2"><Icon name="graph" size={18} /></Link></Tip>;
}
