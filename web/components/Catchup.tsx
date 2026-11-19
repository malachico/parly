'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Modal';
import { Icon } from './Icon';
import { Tip } from './Tip';
import { Markdown, messageDir } from './Thread';
import { markConversationRead, markThreadRead } from '@/lib/actions';
import type { CatchupResponse } from '@/lib/catchup';

export const CATCHUP_RATE_LIMIT_ERROR = 'Too many summaries, try again shortly';

export function buildCatchupUrl(input: {
  ws: string;
  conversationKey: string;
  thread?: string;
  sinceSeq?: number;
}): string {
  const qs = new URLSearchParams({ ws: input.ws });
  if (input.thread) qs.set('thread', input.thread);
  if (input.sinceSeq !== undefined && Number.isInteger(input.sinceSeq) && input.sinceSeq >= 0) {
    qs.set('sinceSeq', String(input.sinceSeq));
  }
  return `/api/conversations/${encodeURIComponent(input.conversationKey)}/catchup?${qs}`;
}

export function CatchupSummary({
  summary,
  markedRead,
  markingRead,
  onMarkRead,
}: {
  summary: CatchupResponse;
  markedRead?: boolean;
  markingRead?: boolean;
  onMarkRead?: () => void;
}) {
  if (summary.caughtUp) return <p role="status" className="py-8 text-center text-[var(--muted)]">You're all caught up ✨</p>;
  const sections = (
    [
      ['Decisions', summary.decisions],
      ['Action items', summary.actionItems],
      ['Open questions', summary.openQuestions],
    ] as const
  ).filter(([, items]) => Array.isArray(items) && items.length > 0);
  return <div className="min-w-0 space-y-5">
    <p className="text-xs text-[var(--muted)]">{summary.messageCount} messages{summary.capped ? ' · Latest 80 messages only' : ''} · AI summary</p>
    <section className="rounded-xl border border-[var(--border)] bg-[var(--subtle)] px-3.5 py-3"><h3 className="mb-1.5 text-sm font-semibold">TL;DR</h3><div dir="auto"><Markdown text={summary.tldr} /></div></section>
    {sections.map(([title, items]) => <section key={title} className="min-w-0">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <ul className="list-disc space-y-2 px-5">{items.map((item, i) => <li key={i} dir={messageDir(item) ?? 'ltr'} className="min-w-0 break-words"><Markdown text={item} /></li>)}</ul>
    </section>)}
    {onMarkRead && (
      <div className="flex items-center justify-end border-t border-[var(--border)] pt-3">
        {markedRead ? (
          <span role="status" className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--ok-fg)]">
            <Icon name="check" size={15} />
            Marked as read
          </span>
        ) : (
          <button type="button" disabled={markingRead} onClick={onMarkRead} className="btn-ghost min-h-9 px-3 text-xs font-medium">
            {markingRead ? 'Marking as read…' : 'Mark as read'}
          </button>
        )}
      </div>
    )}
  </div>;
}

/** Key by workspace + conversation so summaries and the pre-MarkRead cursor never cross destinations. */
export function Catchup({ ws, conversationKey, thread, initialSinceSeq }: { ws: string; conversationKey: string; thread?: string; initialSinceSeq: number }) {
  // Retain the cursor from entry: live refreshes arrive after MarkRead has already advanced it.
  const [sinceSeq, setSinceSeq] = useState<number | undefined>(initialSinceSeq);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<CatchupResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [markedRead, setMarkedRead] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const url = buildCatchupUrl({ ws, conversationKey, thread, sinceSeq });
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 429 ? CATCHUP_RATE_LIMIT_ERROR : response.status === 401 ? 'Please sign in again to catch up.' : 'Unable to catch up right now. Please try again.');
      const result = await response.json() as CatchupResponse;
      if (!controller.signal.aborted) setSummary(result);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to catch up right now.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const router = useRouter();
  const handleMarkRead = async () => {
    if (markingRead || markedRead) return;
    setMarkingRead(true);
    try {
      if (thread && conversationKey.startsWith('channel:')) {
        await markThreadRead(conversationKey.slice('channel:'.length), thread);
      } else {
        await markConversationRead(conversationKey);
      }
      setSinceSeq(undefined);
      setMarkedRead(true);
      router.refresh();
    } catch {
      // Keep button retryable on network failure
    } finally {
      setMarkingRead(false);
    }
  };
  const close = () => { request.current?.abort(); setLoading(false); setOpen(false); };
  return <>
    <Tip label="Catch me up" align="end"><button type="button" aria-label="Catch me up" title="Catch me up" onClick={() => { setOpen(true); if (!summary || markedRead) { setMarkedRead(false); void load(); } }} className="inline-flex h-11 min-w-9 shrink-0 items-center justify-center rounded-[9px] px-1.5 text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)] sm:h-9 sm:px-2"><Icon name="catchup" size={18} /></button></Tip>
    <Dialog open={open} onClose={close} title="Catch me up" wide>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1" aria-busy={loading}>
        {loading ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-[var(--muted)]"><span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />Catching you up…</p> : error ? <div role="alert" className="space-y-3"><p className="text-sm text-[var(--bad-fg)]">{error}</p><button type="button" onClick={() => void load()} className="btn-ghost">Try again</button></div> : summary ? <CatchupSummary summary={summary} markedRead={markedRead} markingRead={markingRead} onMarkRead={handleMarkRead} /> : null}
      </div>
    </Dialog>
  </>;
}
