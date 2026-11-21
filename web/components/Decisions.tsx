'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorNote } from '@/components/ui';
import { channelDecisions, relatedDecisions, type Decision } from '@/lib/actions';
import { chatHref } from '@/lib/routes';

/** Where a decision was recorded: its first source's channel, and thread if any. */
export const decisionHref = (d: Decision) => {
  const s = d.sources[0];
  return chatHref(d.workspaceId, s?.key ?? '', s?.thread ? { thread: s.thread } : undefined);
};

function DecisionList({ decisions }: { decisions: Decision[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {decisions.map((d) => (
        <li key={d.id} className="min-w-0">
          <Link href={decisionHref(d)} className="block rounded-lg px-2 py-1.5 hover:bg-[var(--subtle)]">
            <span className="block break-words text-sm">{d.title || 'Untitled decision'}</span>
            {d.sources[0]?.text && <span className="block truncate text-xs text-[var(--muted)]">{d.sources[0].text}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The channel panel's Decisions tab: what was decided here lately. */
export function DecisionsPanel({ channelId }: { channelId: string }) {
  const [decisions, setDecisions] = useState<Decision[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setDecisions(undefined);
    channelDecisions(channelId).then((d) => live && setDecisions(d));
    return () => {
      live = false;
    };
  }, [channelId]);
  if (decisions === undefined) return <p className="text-sm text-[var(--muted)]">Loading…</p>;
  if (decisions === null) return <ErrorNote error="Couldn't load decisions." />;
  if (!decisions.length) return <p className="text-sm text-[var(--muted)]">No decisions recorded in this channel yet.</p>;
  return <DecisionList decisions={decisions} />;
}

/** Under a thread: decisions recorded in it and what they link to, collapsed. Nothing when there are none. */
export function RelatedDecisions({ channelId, thread }: { channelId: string; thread: string }) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  useEffect(() => {
    let live = true;
    setDecisions([]);
    relatedDecisions(channelId, thread).then((d) => live && setDecisions(d));
    return () => {
      live = false;
    };
  }, [channelId, thread]);
  if (!decisions.length) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-[var(--muted)]">Related decisions ({decisions.length})</summary>
      <DecisionList decisions={decisions} />
    </details>
  );
}
