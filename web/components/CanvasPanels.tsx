'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Markdown } from '@/components/Markdown';
import {
  markCanvasWaitingRead,
  fetchAgentDay,
  replyCanvasWaiting,
} from '@/lib/actions';
import type {
  AgentDayView,
  AgentStatus,
  CanvasAgent,
  CanvasBox,
  CanvasTeam,
  WaitingItem,
} from '@/lib/hub';
import { shortTime, statusStale } from '@/lib/labels';
import { presenceLabel } from '@/lib/presence';
import { agentHref, channelHref, chatHref, dmHref } from '@/lib/routes';
import { Tip } from '@/components/Tip';
import { RowSkeleton } from '@/components/PanelSkeleton';

// First page of each agent's log, so reopening a drawer shows it at once while it refreshes.
const dayCache = new Map<string, AgentDayView>();

// crew-canvas/palette.ts still imports it from here.
export { presenceLabel };

/** Screen 3 (NeedsYou.dc.html): Answering "needs you" directly on the canvas. */
export function NeedsYouPopover({
  ws,
  item,
  channelName,
  onAnswered,
  onClose,
}: {
  ws: string;
  item: WaitingItem;
  channelName?: string;
  onAnswered: (replyTo: string) => void;
  /** Also on "open thread"; it was marked read when the popover opened. */
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Seeing it is reading it.
  useEffect(() => {
    void markCanvasWaitingRead(ws, item.replyTo);
  }, [ws, item.replyTo]);

  const openHref = (() => {
    if (item.kind === 'mention') {
      const [, chId, postId] = item.open.split(':');
      const targetCh = item.channelId ?? chId ?? '';
      return channelHref(ws, targetCh, {
        ...(postId && postId !== item.messageId ? { thread: postId } : {}),
        ...(item.messageId ? { at: item.messageId } : {}),
      });
    }
    return chatHref(ws, item.replyTo, item.messageId ? { at: item.messageId } : undefined);
  })();

  const sendAnswer = (answerText: string) => {
    if (!answerText.trim() || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await replyCanvasWaiting(item.replyTo, answerText, ws);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setText('');
      onAnswered(item.replyTo);
    });
  };

  return (
    <div
      role="dialog"
      aria-label={`${item.from} asks you`}
      onPointerDown={(e) => e.stopPropagation()}
      className="canvas-pop relative z-40 flex max-h-[calc(var(--app-h,100dvh)-32px)] w-[min(560px,calc(100vw-32px))] flex-col gap-3.5 rounded-[22px] bg-[var(--surface)] p-4.5 shadow-[0_24px_60px_rgba(23,22,28,0.18)]"
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--muted)]">
        <b className="text-[15px] text-[var(--fg)]">{item.from} asks you</b>
        <span>· {channelName ? `in #${channelName}` : 'direct message'}</span>
        <span>· {shortTime(item.at)}</span>
        <span>·</span>
        <Link
          href={openHref}
          onClick={onClose}
          className="font-medium text-[var(--accent)] hover:underline"
        >
          open thread
        </Link>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto inline-flex size-7 items-center justify-center rounded-lg bg-[var(--subtle)] text-xs"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--subtle)] px-3.5 py-3">
        <Markdown text={item.text} className="text-[15px] leading-relaxed" />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendAnswer(text);
        }}
        className="flex items-center gap-2 rounded-[14px] border border-[var(--border-strong)] px-3 py-2"
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write your answer… (goes to the thread, and to Slack)"
          aria-label={`Answer ${item.from}`}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <button
          type="submit"
          disabled={pending || !text.trim()}
          className="h-8.5 rounded-[9px] bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Sending…' : 'Answer'}
        </button>
      </form>
      {error && <p className="m-0 text-xs text-[var(--bad-fg)]">{error}</p>}
      <span className="text-xs text-[var(--muted)]">
        Answering clears “needs you” and flies to the next one.
      </span>
    </div>
  );
}

/** An agent's log: the status updates it posted (kept a week), newest first, 20 at a time and older ones on scroll. */
export function AgentDayDrawer({
  ws,
  agent,
  guest = false,
  channelNames,
  onClose,
}: {
  ws: string;
  guest?: boolean;
  agent: CanvasAgent;
  channelNames: Map<string, string>;
  onClose: () => void;
}) {
  const [day, setDay] = useState<AgentDayView | null>(() => dayCache.get(agent.id) ?? null);
  const [loading, setLoading] = useState(() => !dayCache.has(agent.id));
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [older, setOlder] = useState<AgentStatus[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const end = useRef<HTMLLIElement | null>(null);
  // Bumped per agent/retry: stale load-more answers are dropped, and once paged the refresh doesn't rewind.
  const gen = useRef(0);
  const paged = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is the re-run trigger — "Try again" refetches
  useEffect(() => {
    const cached = dayCache.get(agent.id);
    let live = true;
    gen.current++;
    paged.current = false;
    setLoadingMore(false);
    setDay(cached ?? null);
    setLoading(!cached);
    setFailed(false);
    setOlder([]);
    setNext(cached?.next);
    const fail = () => live && !cached && setFailed(true);
    fetchAgentDay(agent.id).then(
      (res) => {
        if (!live) return;
        if (res.ok) {
          dayCache.set(agent.id, res.day);
          if (!paged.current) {
            setDay(res.day);
            setNext(res.day.next);
          }
        } else fail();
        setLoading(false);
      },
      () => {
        fail();
        if (live) setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [agent.id, retry]);

  // Scrolling to the end loads the next 20, older.
  useEffect(() => {
    const el = end.current;
    if (!el || !next || loadingMore) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const g = gen.current;
      paged.current = true;
      setLoadingMore(true);
      void fetchAgentDay(agent.id, next).then((res) => {
        if (g !== gen.current) return;
        if (res.ok) {
          setOlder((o) => [...o, ...res.day.updates]);
          setNext(res.day.next);
        }
        setLoadingMore(false);
      });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [agent.id, next, loadingMore]);

  const p = presenceLabel(agent.presence);
  const updates = day ? [...day.updates, ...older] : agent.status ? [agent.status] : [];

  return (
    <aside
      aria-label={`${agent.name}'s log`}
      onPointerDown={(e) => e.stopPropagation()}
      className="canvas-pop absolute top-4 right-4 bottom-4 z-[70] flex w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)] shadow-[0_18px_40px_rgba(23,22,28,0.12)]"
    >
      <div className="flex items-center gap-3.5 border-b border-[var(--subtle)] px-5 pt-4.5 pb-3.5">
        <Avatar who={agent} className="size-15 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[19px] font-bold">{agent.name}&apos;s log</span>
          <span className="text-[13px]" style={{ color: p.color }}>
            {p.text}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto inline-flex size-9 items-center justify-center rounded-[9px] bg-[var(--subtle)] hover:bg-[var(--border)]"
        >
          ✕
        </button>
      </div>

      <ol className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-5 py-4">
        {loading ? (
          <li>
            <RowSkeleton label={`Loading ${agent.name}'s updates…`} rows={4} />
          </li>
        ) : failed ? (
          <li role="alert" className="flex flex-col items-center gap-3 py-6 text-center text-sm text-[var(--muted)]">
            Couldn&apos;t load {agent.name}&apos;s updates.
            <button type="button" className="btn-ghost" onClick={() => setRetry((r) => r + 1)}>
              Try again
            </button>
          </li>
        ) : updates.length === 0 ? (
          <li className="py-6 text-center text-sm text-[var(--muted)]">No updates posted in the last week.</li>
        ) : (
          updates.map((u, idx) => {
            const isFirst = idx === 0 && Boolean(day?.status && day.status.at === u.at);
            const isDone = /^done\b/i.test(u.text.trim());
            const dotColor = isFirst && !isDone ? 'var(--accent)' : isDone ? 'var(--ok-fg)' : 'var(--avatar-accent)';
            const prs = [...u.text.matchAll(/(?:\b[a-z0-9_-]+\s+)?PR\s*#\d+|#\d+\b/gi)].map((m) => m[0]);
            const chId = u.conversationId.startsWith('channel:')
              ? u.conversationId.slice('channel:'.length)
              : u.conversationId.startsWith('thread:')
                ? u.conversationId.split(':')[1]
                : undefined;
            const chName = chId ? channelNames.get(chId) : undefined;
            const convHref = chId
              ? channelHref(ws, chId, u.conversationId.startsWith('thread:') ? { thread: u.conversationId.split(':')[2] } : undefined)
              : chatHref(ws, u.conversationId);
            return (
              <li key={`${u.at}-${idx}`} className="flex gap-3.5">
                <div className="flex flex-col items-center">
                  <span className="size-3 shrink-0 rounded-full" style={{ background: dotColor }} />
                  {idx < updates.length - 1 && <span className="w-0.5 flex-1 bg-[var(--border)]" />}
                </div>
                <div className="pb-4">
                  <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <span>
                      {new Date(u.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {shortTime(u.at)}
                    </span>
                    {isFirst && !isDone && <span className="font-semibold text-[var(--accent)]">now</span>}
                    {chName && (
                      <Link href={convHref} className="hover:underline">
                        in #{chName}
                      </Link>
                    )}
                  </div>
                  <div dir="auto" className={`text-[15px] ${isFirst ? 'font-semibold' : ''}`}>
                    {u.text}
                  </div>
                  {prs.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {prs.slice(0, 3).map((pr) => (
                        <span key={pr} className="rounded-full border border-[var(--border-strong)] px-2.5 py-0.5 text-xs">
                          {pr}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })
        )}
        {!loading && next && (
          <li ref={end} className="py-3 text-center text-xs text-[var(--muted)]">
            {loadingMore ? 'Loading older updates…' : ' '}
          </li>
        )}
      </ol>
      <div className="flex items-center gap-2 border-t border-[var(--subtle)] px-5 py-3">
        {agent.presence.state !== 'posts' && !(guest && agent.kind !== 'human') && (
          <Link
            href={dmHref(ws, agent.id)}
            className="inline-flex h-10 items-center rounded-[10px] bg-[var(--accent)] px-4 text-sm font-semibold text-white"
          >
            Message
          </Link>
        )}
        <Link
          href={agentHref(ws, agent.id)}
          className="inline-flex h-10 items-center rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-sm hover:bg-[var(--subtle)]"
        >
          Profile
        </Link>
        <span className="ml-auto text-xs text-[var(--muted)]">what it posted, kept a week</span>
      </div>
    </aside>
  );
}

/** Selected creature popover card (Canvas.dc.html). */
export function SelectedAgentCard({
  ws,
  guest = false,
  meId,
  agent,
  teams,
  selTeamId,
  onSelectTeam,
  onOpenLog,
  onRemoveFromTeam,
  onClose,
}: {
  ws: string;
  guest?: boolean;
  meId: string;
  agent: CanvasAgent;
  teams: CanvasTeam[];
  selTeamId: string | null;
  onSelectTeam: (teamId: string, box: CanvasBox) => void;
  onOpenLog: (agentId: string) => void;
  onRemoveFromTeam: (agentId: string, teamId: string) => void;
  onClose: () => void;
}) {
  const selTeam = selTeamId ? teams.find((t) => t.channelId === selTeamId) : undefined;
  const pres = presenceLabel(agent.presence);
  return (
    <aside
      aria-label={`${agent.name} details`}
      onPointerDown={(e) => e.stopPropagation()}
      className="canvas-pop absolute top-[76px] right-4 z-[70] flex w-[min(320px,calc(100vw-32px))] flex-col gap-3 rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[0_18px_40px_rgba(23,22,28,0.14)]"
    >
      <div className="flex items-center gap-3">
        <Avatar who={agent} className="size-12 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base font-bold">{agent.name}</span>
          <span className="truncate text-xs" style={{ color: pres.color }}>
            {pres.text}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-mt-6 -mr-1.5 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[9px] text-[var(--muted)] hover:bg-[var(--subtle)]"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {agent.status && !statusStale(agent.status) && (
        <p dir="auto" className="m-0 rounded-xl bg-[var(--accent-soft)] px-3 py-2 text-sm break-words">
          {agent.status.text} <span className="text-xs text-[var(--muted)]">· {shortTime(agent.status.at)}</span>
        </p>
      )}
      {agent.teams.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {agent.teams.map((tid) => {
            const tm = teams.find((x) => x.channelId === tid);
            if (!tm) return null;
            return (
              <button
                key={tid}
                type="button"
                title={`Fly to ${tm.name}`}
                onClick={() => onSelectTeam(tid, tm.canvas)}
                className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${
                  selTeamId === tid
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent-ink)]'
                    : 'border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--subtle)]'
                }`}
              >
                {tm.name}
              </button>
            );
          })}
        </div>
      )}
      {agent.schedules && agent.schedules.length > 0 && (
        <ul className="m-0 flex max-h-56 list-none flex-col gap-1.5 overflow-y-auto p-0">
          {agent.schedules.map((sc, i) => (
            <li key={i} className="rounded-xl bg-[var(--bg)] px-3 py-2 text-sm">
              <span className="block text-xs font-semibold text-[var(--accent-ink)]">
                ⏰ {sc.when}
                {!sc.active && <span className="font-normal text-[var(--muted)]"> · paused</span>}
              </span>
              <span dir="auto" className="line-clamp-3 break-words">{sc.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5 border-t border-[var(--border)] pt-3">
        {agent.presence.state !== 'posts' && !(guest && agent.kind !== 'human') && (
          <Tip label="Message">
            <Link
              href={dmHref(ws, agent.id)}
              aria-label="Message"
              className="inline-flex size-9 items-center justify-center rounded-[10px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
            >
              <Icon name="chat" size={17} />
            </Link>
          </Tip>
        )}
        <Tip label="Log">
          <button
            type="button"
            aria-label="Log"
            onClick={() => onOpenLog(agent.id)}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-[10px] text-[var(--fg)] hover:bg-[var(--subtle)]"
          >
            <Icon name="log" size={17} />
          </button>
        </Tip>
        {agent.myCloud && (
          <>
            <Tip label="Tools">
              <Link
                href={`${agentHref(ws, agent.id)}?only=tools`}
                aria-label="Tools"
                className="inline-flex size-9 items-center justify-center rounded-[10px] text-[var(--fg)] hover:bg-[var(--subtle)]"
              >
                <Icon name="plug" size={17} />
              </Link>
            </Tip>
            <Tip label="Triggers: what it hears about">
              <Link
                href={`${agentHref(ws, agent.id)}?only=triggers`}
                aria-label="Triggers"
                className="inline-flex size-9 items-center justify-center rounded-[10px] text-[var(--fg)] hover:bg-[var(--subtle)]"
              >
                <Icon name="bolt" size={17} />
              </Link>
            </Tip>
          </>
        )}
        {agent.kind !== 'human' && (
          <Tip label="Skills & processes">
            <Link
              href={`${agentHref(ws, agent.id)}?only=skills`}
              aria-label="Skills & processes"
              className="inline-flex size-9 items-center justify-center rounded-[10px] text-[var(--fg)] hover:bg-[var(--subtle)]"
            >
              <Icon name="book" size={17} />
            </Link>
          </Tip>
        )}
        <Tip label="Profile">
          <Link
            href={agentHref(ws, agent.id)}
            aria-label="Profile"
            className="inline-flex size-9 items-center justify-center rounded-[10px] text-[var(--fg)] hover:bg-[var(--subtle)]"
          >
            <Icon name="person" size={17} />
          </Link>
        </Tip>
        {selTeam && agent.id !== meId && !guest && (
          <Tip label={`Take out of ${selTeam.name}`} align="end" className="ml-auto inline-flex">
            <button
              type="button"
              aria-label={`Take out of ${selTeam.name}`}
              onClick={() => onRemoveFromTeam(agent.id, selTeam.channelId)}
              className="inline-flex size-9 cursor-pointer items-center justify-center rounded-[10px] text-[var(--bad-fg)] hover:bg-[var(--subtle)]"
            >
              <Icon name="leave" size={17} />
            </button>
          </Tip>
        )}
      </div>
    </aside>
  );
}

