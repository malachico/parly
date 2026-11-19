'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { MessageView } from '@/lib/hub';

export type Quote = NonNullable<MessageView['replyTo']>;
export const QUOTE_REPLY_EVENT = 'parly:quote-reply';

export function QuotePreview({ quote, quoteKey }: { quote: Quote; quoteKey?: string }) {
  const [unavailable, setUnavailable] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: quote.id is the re-run trigger, not read here — clear the "unavailable" note whenever the quoted message changes
  useEffect(() => setUnavailable(false), [quote.id]);
  return <>
    <button type="button" aria-label={`Go to message from ${quote.from}`} className="mb-1 block w-full min-w-0 rounded-md border-s-2 border-[var(--accent)] bg-[var(--subtle)] px-3 py-2 text-start text-sm" onClick={(e) => {
      const scope = e.currentTarget.closest('[data-quote-messages]') ?? (quoteKey ? document.querySelector(`[data-quote-key="${CSS.escape(quoteKey)}"]`) : null);
      const original = scope?.querySelector<HTMLElement>(`[id="msg-${CSS.escape(quote.id)}"]`);
      if (!original) { setUnavailable(true); return; }
      setUnavailable(false);
      original.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      original.focus({ preventScroll: true });
      original.animate([{ backgroundColor: 'var(--subtle)' }, { backgroundColor: 'transparent' }], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1200 });
    }}>
      <bdi className="block truncate font-medium text-[var(--accent)]">{quote.from}</bdi>
      <span dir="auto" className="line-clamp-2 block break-words">{quote.text}</span>
    </button>
    {unavailable && <p role="status" className="text-xs text-[var(--muted)]">Original message unavailable</p>}
  </>;
}

/** Double-click (double-tap) selects a quote; Enter does the same when focused. */
export function QuoteReplyTarget({ message, quoteKey, children, className }: { message: MessageView; quoteKey?: string; children: ReactNode; className: string }) {
  const interactive = (target: EventTarget) => (target as Element).closest('a,button,input,textarea,select,summary,[role="button"],[contenteditable="true"]');
  const select = () => {
    if (!quoteKey) return;
    window.getSelection()?.removeAllRanges();
    const quote: Quote = { id: message.id, fromId: message.fromId, from: message.from, text: (message.text.trim() || (message.files?.length ? `Attachment: ${message.files[0]?.name ?? 'Attachment'}` : 'Structured message')).replace(/\s+/g, ' ').slice(0, 180) };
    window.dispatchEvent(new CustomEvent(QUOTE_REPLY_EVENT, { detail: { quoteKey, quote } }));
  };
  return <div id={`msg-${message.id}`} tabIndex={quoteKey ? 0 : -1}
    className={`${className} ${quoteKey ? 'touch-manipulation' : ''}`}
    aria-label={quoteKey ? `Message from ${message.from}. Double-click or press Enter to reply.` : undefined}
    onDoubleClick={(e) => {
      if (!quoteKey || interactive(e.target)) return;
      e.preventDefault(); select();
    }}
    onKeyDown={(e) => {
      if (quoteKey && e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); select(); }
    }}>
    {children}
  </div>;
}
