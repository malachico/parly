import type { ReactNode } from 'react';

// ponytail: bold, italics, code, strikethrough and links in one line; full markdown lives in the message itself (Thread.tsx)
const TOKEN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;

/** A message's text as a one-line preview: block marks dropped, lines joined, inline marks drawn (no links to click). */
export function InlineMarkdown({ text }: { text: string }) {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|```\w*)/, '').trim())
    .filter(Boolean)
    .join(' · ');
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const t = m[0];
    const k = m.index;
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k} className="rounded bg-[var(--subtle)] px-1 font-mono text-[0.92em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('~~')) out.push(<s key={k}>{t.slice(2, -2)}</s>);
    else if (t.startsWith('[')) out.push(t.slice(1, t.indexOf('](')));
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = k + t.length;
  }
  out.push(line.slice(last));
  return <>{out}</>;
}
