'use client';

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { MarkRead, THREAD_READ_EVENT } from '@/components/MarkRead';
import { ScrollToBottom } from '@/components/ScrollToBottom';
import { Timeline } from '@/components/Thread';
import { setThreadDone } from '@/lib/actions';
import type { ActivityItem } from '@/lib/hub';
import { subscribeLive, useLiveMessages } from '@/lib/live';

type Props = Omit<ComponentProps<typeof Timeline>, 'onToggleDone'> & {
  /** The hub's id for this conversation ("dm:…" or "channel:…"): live events are matched by it. */
  conversation: string;
  /** The page's conversation key ("agent:…", "channel:…"), to mark live messages read. */
  readKey: string;
  /** Channel only: Done/Reopen on a post's thread (server action arguments). */
  done?: { ws: string; channelId: string; filter?: string };
  /** Keeps the newest message in view as messages arrive; `key` is what was asked for (the conversation, a message), not what's new, so it doesn't remount and jump. */
  scroll: { key: string; focusId?: string };
  /** Shown while there are no messages. */
  empty: ReactNode;
};

/**
 * The open conversation's timeline, kept current from the live stream: messages arrive with their data (no page
 * refresh), a channel's thread summaries count new replies, and the activity bar follows the agents.
 */
export function LiveTimeline({ conversation, readKey, done, scroll, empty, messages, threads, activity, meId, filter, ...rest }: Props) {
  const all = useLiveMessages(conversation, messages);
  // The "done" filter shows finished threads only: a new post isn't one.
  const shown = filter === 'done' ? messages : all;
  const [liveThreads, setLiveThreads] = useState(threads);
  const [liveActivity, setLiveActivity] = useState<ActivityItem[] | undefined>(activity);
  // Thread replies already counted: a reconnect can replay part of a batch.
  const counted = useRef(new Set<string>());
  useEffect(() => {
    setLiveThreads(threads);
    counted.current.clear();
  }, [threads]);
  useEffect(() => setLiveActivity(activity), [activity]);
  useEffect(() => {
    const clear = (e: Event) => {
      const post = (e as CustomEvent<string>).detail;
      setLiveThreads((t) => (t?.[post]?.unread ? { ...t, [post]: { ...t[post]!, unread: undefined } } : t));
    };
    window.addEventListener(THREAD_READ_EVENT, clear);
    return () => window.removeEventListener(THREAD_READ_EVENT, clear);
  }, []);

  useEffect(
    () =>
      subscribeLive((e) => {
        if (e.type === 'activity') {
          if (e.conversation === conversation) setLiveActivity(e.activity);
          return;
        }
        if (e.type === 'read') {
          // Read in another tab: that thread's badge clears here too.
          const prefix = `thread:${conversation.slice('channel:'.length)}:`;
          if (e.conversation.startsWith(prefix)) {
            const post = e.conversation.slice(prefix.length);
            setLiveThreads((t) => (t?.[post]?.unread ? { ...t, [post]: { ...t[post]!, unread: undefined } } : t));
          }
          return;
        }
        const m = e.message;
        // A reply in one of this channel's threads: its post's summary counts it (ChannelShell appends it to an open thread pane).
        if (m.thread && m.conversation.startsWith(`thread:${conversation.slice('channel:'.length)}:`) && !counted.current.has(m.id)) {
          counted.current.add(m.id);
          setLiveThreads((t) => {
            const sum = t?.[m.thread!] ?? {
              count: 0,
              lastAt: m.at,
              people: [],
            };
            return {
              ...t,
              [m.thread!]: {
                ...sum,
                count: sum.count + 1,
                lastAt: m.at,
                people: [m.fromId, ...sum.people.filter((p) => p !== m.fromId)].slice(0, 3),
                unread: m.fromId === meId ? sum.unread : (sum.unread ?? 0) + 1,
              },
            };
          });
        }
      }),
    [conversation, meId],
  );

  // Others' messages that arrived while it's open are read: tell the hub, as MarkRead does for the page's own.
  const rendered = new Set(messages.map((m) => m.id));
  const liveUnread = all.filter((m) => !rendered.has(m.id) && m.fromId !== meId).length;
  return (
    <>
      {liveUnread > 0 && <MarkRead conversationKey={readKey} unread={liveUnread} />}
      <ScrollToBottom key={scroll.key} count={shown.length} latest={shown.at(-1)?.seq} target="thread-scroll" focusId={scroll.focusId} />
      {shown.length === 0 ? (
        empty
      ) : (
        <Timeline
          {...rest}
          messages={shown}
          meId={meId}
          filter={filter}
          threads={liveThreads}
          activity={liveActivity}
          onToggleDone={done ? (postId, d) => setThreadDone.bind(null, done.ws, done.channelId, postId, d, done.filter) : undefined}
        />
      )}
    </>
  );
}
