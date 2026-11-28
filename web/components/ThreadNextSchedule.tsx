'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, type People } from '@/components/Avatar';
import { threadSchedules } from '@/lib/actions';
import type { Schedule } from '@/lib/hub';
import { cadence, nextInThread } from '@/lib/labels';
import { chatHref, triggersHref } from '@/lib/routes';

/** A quiet line under a thread: its next scheduled message (viewer's local time), linking to where it's managed. */
export function ThreadNextSchedule({ ws, conversationKey, channelId, postId, scheduledSeq, meId, people }: { ws: string; conversationKey: string; channelId: string; postId: string; scheduledSeq: number; meId: string; people: People }) {
  const [found, setFound] = useState<{ next: Schedule; more: number }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scheduledSeq` re-runs the fetch when a scheduled message lands (its schedule moves on), not on every reply
  useEffect(() => {
    let live = true;
    threadSchedules(channelId).then((all) => live && setFound(nextInThread(all, postId))).catch(() => live && setFound(undefined));
    return () => { live = false; };
  }, [channelId, postId, scheduledSeq]);
  if (!found) return null;
  const { next: s, more } = found;
  const who = s.agentId ?? s.ownerId;
  const every = cadence(s);
  const href = s.ownerId === meId ? `${triggersHref(ws)}#schedule-${s.id}` : chatHref(ws, conversationKey, { thread: postId, panel: 'channel', section: 'automations' });
  return (
    <Link href={href} className="mx-3 mb-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)] sm:mx-4">
      <Avatar who={people[who] ?? { id: who }} className="size-5" presence={false} />
      <span className="truncate">
        {`⏰ Next: ${new Date(s.nextAt!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
        {every && ` · ${every}`}
        {more > 0 && ` · +${more} more`}
      </span>
    </Link>
  );
}
