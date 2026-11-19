'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useParamHref } from '@/components/FindDialog';

/** Searches as you type: a short pause after the last key sets ?{param}= in place, no page load (Composio's apps by default). */
export function AppSearch({ param = 'tq', placeholder = 'Search apps: Jira, HubSpot, Stripe, Zendesk…', label = 'Search apps' }: { param?: string; placeholder?: string; label?: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const href = useParamHref();
  const current = params.get(param) ?? '';
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();
  const sent = useRef(current);

  // The URL changed without us (e.g. "← Popular apps"): show what it says.
  useEffect(() => {
    if (current !== sent.current) setValue((sent.current = current));
  }, [current]);

  useEffect(() => {
    const q = value.trim();
    if (q === sent.current.trim()) return;
    const timer = setTimeout(() => {
      sent.current = q;
      startTransition(() => router.replace(href(param, q || undefined), { scroll: false }));
    }, 300);
    return () => clearTimeout(timer);
  }, [value, href, router, param]);

  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="input w-full"
      />
      {pending && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-[var(--muted)]">Searching…</span>}
    </div>
  );
}
