import Link from 'next/link';
import { QuotePreview, QuoteReplyTarget } from '@/components/MessageQuote';
import { memo } from 'react';
import { Avatar, type AvatarOf, type People } from '@/components/Avatar';
import { Clamp } from '@/components/Clamp';
import { ImagePreview } from '@/components/ImagePreview';
import { Markdown, type Mentioned } from '@/components/Markdown';
import { DoneButton } from '@/components/DoneButton';
import type { ActivityItem, MessageView } from '@/lib/hub';
import { seenMarks } from '@/lib/receipts';
import { DayLabel, LocalTime } from '@/components/LocalTime';
import { continues, dayLabel, shortTime, formatSize } from '@/lib/labels';
import { agentHref, dmHref, skillsHref } from '@/lib/routes';
import { plural } from '@/lib/plural';

/** A stable default, so memoized rows don't see a new `people` every render. */
const NO_PEOPLE: People = {};

const whoOf = (people: People, id: string): AvatarOf => people[id] ?? { id };

/** A thread's replies at a glance: how many, the last one's time, the last few people (ids, latest first). */
type ThreadSummary = { count: number; lastAt: string; people: string[]; unread?: number; done?: boolean; doneAt?: string; doneBy?: string };

/** Two messages from one sender this close together share one name and avatar, like Slack. */

/**
 * A conversation's messages, oldest first. In a channel each post links to its thread (with a summary of its
 * replies); a direct conversation is one timeline. `seen`: how far each participant has read (message seq).
 */
export function Timeline({
  messages,
  meId,
  hrefBase,
  ws,
  people = NO_PEOPLE,
  seen = {},
  threads,
  activity,
  channel,
  filter,
  doneThreads,
  channelOwner,
  onToggleDone,
  quoteKey,
}: {
  messages: MessageView[];
  meId: string;
  hrefBase: string;
  ws?: string;
  people?: People;
  seen?: Record<string, number>;
  /** A channel's threads at a glance, by post id. */
  threads?: Record<string, ThreadSummary>;
  /** Live agent states in this conversation (and in a channel's threads, with `thread` set to the post id). */
  activity?: ActivityItem[];
  channel?: boolean;
  /** Optional active channel filter (e.g. "done") preserved when opening a thread. */
  filter?: string;
  /** Post ids of threads marked as done in this channel. */
  doneThreads?: string[];
  /** Whether the viewer is an owner of this channel (may mark any thread as done or reopen it). */
  channelOwner?: boolean;
  /** The composer draft key receiving inline quote replies; omitted for public/read-only views. */
  quoteKey?: string;
  /** Server action binder for toggling Done/Reopen on a post's thread. */
  onToggleDone?: (postId: string, done: boolean) => (formData: FormData) => void | Promise<void>;
}) {
  const marks = seenMarks(messages, seen, meId);
  const doneSet = new Set(doneThreads ?? []);
  const activeIds = new Set((activity ?? []).filter((a) => a.state === 'reading' || a.state === 'working').map((a) => a.agentId));
  return (
    <ol data-quote-messages data-quote-key={quoteKey} className="flex flex-col overflow-x-clip" aria-label="Messages">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const href = `${hrefBase}${hrefBase.includes('?') ? '&' : '?'}thread=${encodeURIComponent(m.id)}${filter && !hrefBase.includes('filter=') ? `&filter=${encodeURIComponent(filter)}` : ''}`;
        const sum = channel ? threads?.[m.id] : undefined;
        const isDone = Boolean(channel && (doneSet.has(m.id) || sum?.done));
        const canToggleDone = Boolean(channel && onToggleDone && (channelOwner || m.fromId === meId));
        const isLast = i === messages.length - 1;
        const threadAct = (activity ?? []).filter(
          (a) =>
            a.agentId !== meId &&
            (a.state === 'reading' || a.state === 'working') &&
            (a.thread === m.id || (!a.thread && isLast && filter !== 'done')),
        );
        const seenIds = (marks.get(m.id) ?? []).filter((id) => !activeIds.has(id));
        return (
          <TimelineItem
            key={m.id}
            m={m}
            prevAt={prev?.at}
            meId={meId}
            ws={ws}
            people={people}
            grouped={!(prev && channel && threads?.[prev.id]) && continues(prev, m)}
            href={href}
            sum={sum}
            isDone={isDone}
            channel={channel}
            hrefBase={hrefBase}
            onToggleDone={canToggleDone ? onToggleDone : undefined}
            seenIds={seenIds}
            threadAct={threadAct}
            quoteKey={quoteKey}
          />
        );
      })}
    </ol>
  );
}

/** Shallow prop equality, with arrays compared item by item (the rows' id/activity lists are rebuilt each render). */
function sameProps<P extends object>(a: P, b: P): boolean {
  const ka = Object.keys(a) as (keyof P)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = a[k], y = b[k];
    return x === y || (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]));
  });
}

/** One Timeline row; memoized so a new or updated message re-renders only its own row. */
const TimelineItem = memo(function TimelineItem({
  m,
  prevAt,
  meId,
  ws,
  people,
  grouped,
  href,
  sum,
  isDone,
  channel,
  hrefBase,
  onToggleDone,
  seenIds,
  threadAct,
  quoteKey,
}: {
  m: MessageView;
  prevAt?: string;
  meId: string;
  ws?: string;
  people: People;
  grouped: boolean;
  href: string;
  sum?: ThreadSummary;
  isDone: boolean;
  channel?: boolean;
  hrefBase: string;
  /** Set only when the viewer may toggle this thread. */
  onToggleDone?: (postId: string, done: boolean) => (formData: FormData) => void | Promise<void>;
  seenIds: string[];
  threadAct: ActivityItem[];
  quoteKey?: string;
}) {
  return (
    <li>
      <DayDivider at={m.at} prev={prevAt} />
      <MessageRow
        quoteKey={quoteKey}
        m={m}
        meId={meId}
        ws={ws}
        people={people}
        grouped={grouped}
        action={
          channel && (
            <div className="flex items-center gap-2">
              {onToggleDone && <DoneButton done={isDone} action={onToggleDone(m.id, !isDone)} />}
            <Link href={href} scroll={false} prefetch={false} className="text-xs font-medium text-[var(--muted)] hover:text-[var(--accent)]">
                Reply in thread
              </Link>
            </div>
          )
        }
      >
        {(seenIds.length > 0 || threadAct.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
            <SeenBy ids={seenIds} people={people} ws={ws} />
            <ActivityBar items={threadAct} people={people} hrefBase={channel ? hrefBase : undefined} ws={ws} />
          </div>
        )}
        {sum ? (
          <Link href={href} scroll={false} prefetch={false} className="mt-1 flex w-fit flex-wrap items-center gap-2 rounded-md py-0.5 text-sm hover:underline">
            {isDone && <span className="chip text-[var(--ok-fg)]">✓ Done</span>}
            <span className="flex -space-x-1.5">
              {sum.people.map((id) => (
                <Avatar key={id} who={whoOf(people, id)} className="size-5" halo="var(--bg)" />
              ))}
            </span>
            <span className="font-semibold text-[var(--accent)]">
              {plural(sum.count, 'reply', 'replies')}
            </span>
            {(sum.unread ?? 0) > 0 && (
              <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[11px] leading-none font-bold text-white">{sum.unread} new</span>
            )}
            <span className="text-xs text-[var(--muted)]">Last reply {shortTime(sum.lastAt)}</span>
          </Link>
        ) : (
          channel && (
            <Link
              href={href}
              scroll={false}
              prefetch={false}
              className="mt-1 flex w-fit flex-wrap items-center gap-2 rounded-md py-0.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--accent)] hover:underline"
            >
              {isDone && <span className="chip text-[var(--ok-fg)]">✓ Done</span>}
              <span>Reply</span>
            </Link>
          )
        )}
      </MessageRow>
    </li>
  );
}, sameProps);

/** "Codex is reading…", or "Codex is working: running the tests…". */
function formatActivity(a: ActivityItem, people: People): string {
  const name = people[a.agentId]?.name ?? 'Agent';
  const detail = a.text?.trim().replace(/[.…]+$/, '');
  return a.state === 'reading'
    ? `${name} is reading${detail ? `: ${detail}` : ''}…`
    : `${name} is working${detail ? `: ${detail}` : ''}…`;
}

/**
 * Compact live agent activity under a post: one three-dot indicator with the avatars of everyone currently
 * reading or working on it (never waking-only agents), with each agent's exact status in the tooltip and
 * accessible label.
 */
export function ActivityBar({ items, people = {}, hrefBase, ws }: { items?: ActivityItem[]; people?: People; hrefBase?: string; ws?: string }) {
  const byAgent = new Map<string, ActivityItem>();
  for (const a of items ?? []) {
    if (a.state !== 'reading' && a.state !== 'working') continue;
    const prev = byAgent.get(a.agentId);
    if (!prev || a.state === 'working' || prev.state !== 'working') byAgent.set(a.agentId, a);
  }
  const active = [...byAgent.values()];
  if (!active.length) return null;
  const summary = active.map((a) => formatActivity(a, people)).join(', ');
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={summary}
      title={summary}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--subtle)] px-2 py-0.5"
    >
      <span aria-hidden className="inline-flex items-center gap-0.5 px-0.5">
        <span className="activity-dot size-1 rounded-full bg-[var(--ok-fg)]" />
        <span className="activity-dot size-1 rounded-full bg-[var(--ok-fg)] [animation-delay:400ms]" />
        <span className="activity-dot size-1 rounded-full bg-[var(--ok-fg)] [animation-delay:800ms]" />
      </span>
      <span className="flex flex-wrap items-center gap-0.5">
        {active.map((a) => {
          const who = whoOf(people, a.agentId);
          const label = formatActivity(a, people);
          const href =
            a.thread && hrefBase
              ? `${hrefBase}${hrefBase.includes('?') ? '&' : '?'}thread=${encodeURIComponent(a.thread)}`
              : ws && !who.webhookChannel
                ? dmHref(ws, a.agentId)
                : undefined;
          return href ? (
            <Link
              key={`${a.agentId}:${a.thread ?? ''}`}
              href={href}
              scroll={false}
              prefetch={false}
              title={label}
              aria-label={label}
              className="flex rounded-full"
            >
              <Avatar who={who} className="size-4" />
            </Link>
          ) : (
            <span key={`${a.agentId}:${a.thread ?? ''}`} title={label} className="flex rounded-full">
              <Avatar who={who} className="size-4" />
            </span>
          );
        })}
      </span>
    </div>
  );
}

/** One post and its replies, for the thread panel. `older` (a LoadOlder) stands above the replies when some aren't loaded. */
export function ThreadView({
  post,
  replies,
  meId,
  ws,
  people = NO_PEOPLE,
  seen = {},
  activity,
  older,
  quoteKey,
}: {
  post: MessageView;
  replies: MessageView[];
  meId: string;
  ws?: string;
  people?: People;
  seen?: Record<string, number>;
  activity?: ActivityItem[];
  older?: React.ReactNode;
  quoteKey?: string;
}) {
  const marks = seenMarks(replies, seen, meId);
  const threadAct = (activity ?? []).filter((a) => a.agentId !== meId && (a.state === 'reading' || a.state === 'working'));
  const activeIds = new Set(threadAct.map((a) => a.agentId));
  const postSeenIds = replies.length === 0 ? (seenMarks([post], seen, meId).get(post.id) ?? []).filter((id) => !activeIds.has(id)) : [];
  return (
    <div data-quote-messages data-quote-key={quoteKey} className="flex flex-col overflow-x-clip">
      <MessageRow quoteKey={quoteKey} m={post} meId={meId} ws={ws} people={people} grouped={false}>
        {replies.length === 0 && (postSeenIds.length > 0 || threadAct.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
            <SeenBy ids={postSeenIds} people={people} ws={ws} />
            <ActivityBar items={threadAct} people={people} ws={ws} />
          </div>
        )}
      </MessageRow>
      <div className="my-3 flex items-center gap-3 text-xs text-[var(--muted)]">
        {plural(replies.length, 'reply', 'replies')}
        <span className="h-px flex-1 bg-[var(--border)]" />
      </div>
      {older}
      <ol className="flex flex-col" aria-label="Replies">
        {replies.map((r, i) => {
          const isLast = i === replies.length - 1;
          const replyAct = isLast ? threadAct : [];
          const seenIds = (marks.get(r.id) ?? []).filter((id) => !activeIds.has(id));
          return (
            <ReplyItem
              key={r.id}
              m={r}
              meId={meId}
              ws={ws}
              people={people}
              grouped={continues(replies[i - 1], r)}
              seenIds={seenIds}
              replyAct={replyAct}
              quoteKey={quoteKey}
            />
          );
        })}
      </ol>
    </div>
  );
}

/** One reply in ThreadView, memoized like TimelineItem. */
const ReplyItem = memo(function ReplyItem({
  m,
  meId,
  ws,
  people,
  grouped,
  seenIds,
  replyAct,
  quoteKey,
}: {
  m: MessageView;
  meId: string;
  ws?: string;
  people: People;
  grouped: boolean;
  seenIds: string[];
  replyAct: ActivityItem[];
  quoteKey?: string;
}) {
  return (
    <li>
      <MessageRow quoteKey={quoteKey} m={m} meId={meId} ws={ws} people={people} grouped={grouped}>
        {(seenIds.length > 0 || replyAct.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
            <SeenBy ids={seenIds} people={people} ws={ws} />
            <ActivityBar items={replyAct} people={people} ws={ws} />
          </div>
        )}
      </MessageRow>
    </li>
  );
}, sameProps);

/** Between two messages from different days. Placed here on the server; its label is the reader's day (DayLabel). */
function DayDivider({ at, prev }: { at: string; prev?: string }) {
  const day = dayLabel(at);
  if (!day || day === (prev ? dayLabel(prev) : '')) return null;
  return (
    <div className="my-3 flex items-center gap-3 text-xs font-medium text-[var(--muted)]" role="separator">
      <span className="h-px flex-1 bg-[var(--border)]" />
      <DayLabel at={at} initial={day} />
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}

function MessageRow({
  m,
  meId,
  ws,
  people,
  grouped,
  action,
  children,
  quoteKey,
}: {
  m: MessageView;
  meId: string;
  ws?: string;
  people: People;
  grouped: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
  quoteKey?: string;
}) {
  const mine = m.fromId === meId;
  const mentionsMe = !mine && (m.mentions?.includes(meId) ?? false);
  const who = whoOf(people, m.fromId);
  const authorHref = ws && !who.webhookChannel ? (mine ? agentHref(ws, m.fromId) : dmHref(ws, m.fromId)) : undefined;
  const authorTitle = mine ? 'Your profile' : `Message ${who.name ?? m.from}`;
  return (
    <QuoteReplyTarget message={m} quoteKey={quoteKey}
      className={`group relative -mx-2 flex scroll-mt-16 gap-3 rounded-lg px-2 py-1 ${grouped ? '' : 'mt-2'} ${
        mentionsMe ? 'border-l-2 border-[var(--warn-fg)] bg-[var(--warn-bg)]/60' : 'hover:bg-[var(--subtle)]'
      }`}
    >
      <div className="w-9 shrink-0">
        {grouped ? (
          <LocalTime iso={m.at} className="invisible block pt-0.5 text-right text-[10px] text-[var(--muted)] group-hover:visible group-focus-within:visible [@media(hover:none)]:visible" />
        ) : m.webhook ? (
          // An incoming webhook or an app trigger: not the person who set it up.
          <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-[var(--subtle)] text-lg">
            {/ trigger$/i.test(m.webhook) ? (/^gmail/i.test(m.webhook) ? '📧' : '⚡') : '🪝'}
          </span>
        ) : authorHref ? (
          <Link href={authorHref} title={authorTitle} aria-label={authorTitle} className="block rounded-full">
            <Avatar who={who} className="size-9" trigger={m.scheduled} />
          </Link>
        ) : (
          <Avatar who={who} className="size-9" trigger={m.scheduled} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-2">
            {authorHref && !m.webhook ? (
              <Link href={authorHref} className="font-semibold hover:underline">
                <bdi>{mine ? 'You' : m.from}</bdi>
              </Link>
            ) : (
              <bdi className="font-semibold">{m.webhook ?? (mine ? 'You' : m.from)}</bdi>
            )}
            {m.scheduled && <span className="sr-only">(sent automatically)</span>}
            {m.webhook ? <span className="chip">{mine ? 'set up by you' : `set up by ${m.from}`}</span> : people[m.fromId]?.role && <span className="chip">{people[m.fromId]!.role}</span>}
            <LocalTime iso={m.at} className="text-xs text-[var(--muted)]" />
          </p>
        )}
        {m.replyTo && <QuotePreview quote={m.replyTo} />}
        <Body m={m} mentioned={mentionedIn(m, people, meId)} />
        <UsedSkills skills={m.skills} ws={ws} />
        {children}
        {m.replyTo && action && <div className="mt-1 flex justify-end text-xs">{action}</div>}
      </div>
      {action && !m.replyTo && (
        <div className="absolute top-1 right-2 hidden rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 shadow-sm group-focus-within:block group-hover:block">
          {action}
        </div>
      )}
    </QuoteReplyTarget>
  );
}

/** Who has seen up to this message: one small avatar each; hover for their name. */
function SeenBy({ ids, people, ws }: { ids?: string[]; people: People; ws?: string }) {
  if (!ids?.length) return null;
  const label = (id: string) => `Seen by ${people[id]?.name ?? 'someone'}`;
  return (
    <span className="flex flex-wrap items-center justify-end gap-0.5" aria-label={ids.map(label).join(', ')}>
      {ids.map((id) => {
        const who = whoOf(people, id);
        return ws && !who.webhookChannel ? (
          <Link key={id} href={dmHref(ws, id)} title={label(id)} className="flex rounded-full">
            <Avatar who={who} className="size-4" />
          </Link>
        ) : (
          <span key={id} title={label(id)} className="flex">
            <Avatar who={who} className="size-4" />
          </span>
        );
      })}
    </span>
  );
}

function Body({ m, mentioned = [] }: { m: MessageView; mentioned?: Mentioned[] }) {
  return (
    <>
      {m.text && (
        <Clamp long={m.text.length > 700 || m.text.split('\n').length > 12}>
          <Markdown text={m.text} mentioned={mentioned} />
        </Clamp>
      )}
      {m.files?.length ? <Files files={m.files} /> : null}
      {m.data?.length ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">Data</summary>
          {m.data.map((d, i) => (
            <Json key={i} value={d} />
          ))}
        </details>
      ) : null}
    </>
  );
}

/** Skills and processes the author loaded for this message: tinted pills linking to `/w/[ws]/skills/[id]`. */
function UsedSkills({ skills, ws }: { skills?: MessageView['skills']; ws?: string }) {
  if (!skills?.length) return null;
  const pillClass = (type: NonNullable<MessageView['skills']>[number]['type']) =>
    `max-w-[200px] truncate rounded-full border px-2 py-0.5 ${
      type === 'process'
        ? 'border-[var(--warn-fg)]/30 bg-[var(--warn-bg)] text-[var(--warn-fg)]'
        : 'border-[var(--accent)]/30 bg-[var(--accent-soft)] text-[var(--accent-ink)]'
    }`;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
      {skills.map((s) =>
        ws ? (
          <Link
            key={s.id}
            href={skillsHref(ws, s.id)}
            title={s.name}
            className={`${pillClass(s.type)} hover:opacity-80`}
          >
            {s.name}
          </Link>
        ) : (
          <span key={s.id} title={s.name} className={pillClass(s.type)}>
            {s.name}
          </span>
        ),
      )}
    </div>
  );
}

/** Shown inline; matches the hub's own list (never SVG or HTML, which can run script). */
/** What the hub serves inline (Files' INLINE_TYPES); anything else is a download. */
export const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const INLINE_VIDEOS = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

/** Attachments: uploaded images and videos inline, everything else as a download chip. */
function Files({ files }: { files: NonNullable<MessageView['files']> }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-2">
      {files.map((f, i) => {
        // Uploaded files open through our route (it checks access and signs a fresh link); others are plain links.
        const href = f.id ? `/api/files/${encodeURIComponent(f.id)}` : /^https?:\/\//i.test(f.url) ? f.url : undefined;
        const name = f.name || 'file';
        if (!href) return null;
        if (f.id && f.mediaType && INLINE_IMAGES.has(f.mediaType)) {
          return (
            <li key={f.id} className="max-w-full">
              <ImagePreview src={href} name={name} />
            </li>
          );
        }
        if (f.id && f.mediaType && INLINE_VIDEOS.has(f.mediaType)) {
          return (
            <li key={f.id} className="flex max-w-full flex-col items-start gap-1">
              <video
                src={href}
                controls
                preload="metadata"
                playsInline
                title={name}
                className="h-64 w-80 max-w-full rounded-lg border border-[var(--border)] bg-black object-contain"
              />
              <a
                href={`${href}?download=1`}
                download={name}
                className="inline-flex max-w-xs items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span className="truncate">Download {name}</span>
                {f.size !== undefined && <span className="shrink-0">{formatSize(f.size)}</span>}
              </a>
            </li>
          );
        }
        return (
          <li key={f.id ?? `${f.url}:${i}`}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex max-w-xs items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-sm hover:bg-[var(--subtle)]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-[var(--muted)]">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
              <span className="truncate">{name}</span>
              {f.size !== undefined && <span className="shrink-0 text-xs text-[var(--muted)]">{formatSize(f.size)}</span>}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** What a message's mentions may be written as: each person's display name and id, longest first. */
function mentionedIn(m: MessageView, people: People, meId: string): Mentioned[] {
  return (m.mentions ?? [])
    .flatMap((id) => [people[id]?.name, id].filter((x): x is string => Boolean(x)).map((label) => ({ label, me: id === meId })))
    .sort((a, b) => b.label.length - a.label.length);
}

function Json({ value }: { value: unknown }) {
  return <pre className="code mt-1 overflow-x-auto break-normal whitespace-pre">{JSON.stringify(value, null, 2)}</pre>;
}
