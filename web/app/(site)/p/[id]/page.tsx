import type { Metadata } from 'next';
import Link from 'next/link';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { Avatar, AvatarStack, type AvatarOf, type People } from '@/components/Avatar';
import { PublicRefresh } from '@/components/PublicRefresh';
import { Clamp } from '@/components/Clamp';
import { ImagePreview } from '@/components/ImagePreview';
import { JoinBar } from '@/components/JoinBar';
import { LocalTime } from '@/components/LocalTime';
import { ScrollToBottom } from '@/components/ScrollToBottom';
import { INLINE_IMAGES, INLINE_VIDEOS, Markdown } from '@/components/Thread';
import { channelKey, hub, HubError, me, type Channel } from '@/lib/hub';
import { dayLabel, shortTime } from '@/lib/labels';
import { chatHref } from '@/lib/routes';
import { plural } from '@/lib/plural';

type PublicFile = { id: string; name?: string; mediaType?: string };
type PublicMessage = { id: string; seq: number; from: string; fromId: string; text: string; at: string; thread?: string; files?: PublicFile[] };
type PublicPage = {
  channel: { id: string; name: string; workspaceId?: string; open?: boolean; publicShowcase?: boolean; selfJoin?: boolean };
  messages: PublicMessage[];
  threads: Record<string, { count: number; lastAt: string }>;
  people: People;
  older: boolean;
};
type PublicThread = { channel: { id: string; name: string }; post: PublicMessage; replies: PublicMessage[]; people: People };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ thread?: string; join?: string }> };

/** Public reads are shared across visitors for this long (seconds), so N watchers cost one hub call per window. */
const PUBLIC_REVALIDATE = 20;

/** Reads the hub without anyone's token: public channels are for everyone, signed in or not. Cached per request (metadata and page share it) and across visitors. */
const load = cache(async <T,>(path: string): Promise<T> =>
  hub<T>(path, { as: '', revalidate: PUBLIC_REVALIDATE }).catch((err) => {
    if (err instanceof HubError && err.status === 404) notFound();
    throw err;
  }),
) as <T>(path: string) => Promise<T>;

const pagePath = (id: string) => `/public/channels/${encodeURIComponent(id)}?limit=200`;
const threadPath = (id: string, post: string) => `/public/channels/${encodeURIComponent(id)}/threads/${encodeURIComponent(post)}`;

/**
 * The open thread, and the channel's page when the channel is public. A thread shared on its own (?thread=) shows
 * without its channel, which stays private.
 */
const loadBoth = cache(async (id: string, thread?: string) => {
  if (!thread) return { open: undefined, page: await load<PublicPage>(pagePath(id)) };
  // Both at once: the thread must exist (404s), the channel page is optional (private channel).
  const [open, page] = await Promise.all([
    load<PublicThread>(threadPath(id, thread)),
    hub<PublicPage>(pagePath(id), { as: '', revalidate: PUBLIC_REVALIDATE }).catch(() => undefined),
  ]);
  return { open, page };
});

const plain = (text: string) => text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);

/** A shared link shows the channel's name and its latest post (a shared thread: its post). */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { open, page } = await loadBoth((await params).id, (await searchParams).thread);
  if (!page) {
    const title = `A thread in #${open!.channel.name} on Parly`;
    const description = `${open!.post.from}: ${plain(open!.post.text)}`;
    return { title, description, openGraph: { title, description }, robots: { index: false, follow: false } };
  }
  const title = `#${page.channel.name}: live on Parly`;
  const last = page.messages.at(-1) && plain(page.messages.at(-1)!.text);
  const description = last ? `${page.messages.at(-1)!.from}: ${last}` : 'People and AI agents working together, live and read-only.';
  // ponytail: noindex for every public channel; a per-channel "let search engines index it" switch when someone wants one.
  return { title, description, openGraph: { title, description }, robots: { index: false, follow: false } };
}

/** A public channel, read-only: what its people and agents say there since it went public. */
export default async function PublicChannelPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { thread, join } = await searchParams;
  const [{ open, page }, signedIn] = await Promise.all([loadBoth(id, thread), me()]);
  const people = { ...page?.people, ...open?.people };

  const canJoin = Boolean(page?.channel.selfJoin || (page?.channel.publicShowcase && page?.channel.open));
  if (signedIn && join === '1' && canJoin && page) {
    const joined = await hub<Channel>(`/channels/${encodeURIComponent(page.channel.id)}/join`, { method: 'POST' }).catch(() => undefined);
    if (joined) {
      redirect(chatHref(joined.workspaceId, channelKey(joined.id)));
    }
  }
  if (!page) {
    const t = open!;
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <Hero name={t.channel.name} kicker="A thread shared from Parly" people={Object.values(people)} />
        <ol className="flex flex-col gap-3">
          <li>
            <Post m={t.post} people={people} channelId={t.channel.id} />
          </li>
          {t.replies.map((r) => (
            <li key={r.id} className="ml-6 sm:ml-12">
              <Post m={r} people={people} channelId={t.channel.id} reply />
            </li>
          ))}
        </ol>
        {t.replies.length === 0 && <p className="text-center text-sm text-[var(--muted)]">No replies yet.</p>}
        <JoinBar signedIn={!!signedIn} />
      </div>
    );
  }

  const last = page.messages.at(-1)?.at;
  let day = '';
  return (
    <div className="placing mx-auto flex max-w-3xl flex-col gap-6">
      <PublicRefresh />
      <ScrollToBottom
        key={id}
        count={page.messages.length}
        target="site-scroll"
        focusId={open ? `msg-${open.replies.at(-1)?.id ?? open.post.id}` : undefined}
      />
      <Hero name={page.channel.name} kicker="Live on Parly" live people={Object.values(people)} last={last} />

      {page.messages.length === 0 && <p className="text-center text-sm text-[var(--muted)]">Nothing here yet. Check back soon.</p>}
      {page.older && <p className="text-center text-xs text-[var(--muted)]">Showing the newest {page.messages.length} posts.</p>}

      <ol className="flex flex-col gap-3">
        {page.messages.map((m) => {
          const d = dayLabel(m.at);
          const divider = d !== day ? (day = d) : '';
          const replies = page.threads[m.id];
          const isOpen = open?.post.id === m.id;
          return (
            <li key={m.id} className="flex flex-col gap-2">
              {divider && (
                <div className="my-2 flex items-center gap-3 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
                  <span className="h-px flex-1 bg-[var(--border)]" />
                  {divider}
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </div>
              )}
              <Post m={m} people={people} channelId={page.channel.id} />
              {replies && !isOpen && (
                <Link
                  href={`?thread=${m.id}`}
                  scroll={false}
                  className="ml-12 inline-flex items-center gap-2 self-start rounded-full border border-[var(--border)] bg-[var(--surface)] py-1 pr-3 pl-1.5 text-[13px] font-medium text-[var(--accent)] hover:bg-[var(--subtle)]"
                >
                  {plural(replies.count, 'reply', 'replies')} <span className="text-xs font-normal text-[var(--muted)]">· {shortTime(replies.lastAt)}</span>
                </Link>
              )}
              {isOpen && (
                <>
                  <ol className="ml-6 flex flex-col gap-2 border-l-2 border-[var(--accent-soft)] pl-4 sm:ml-12">
                    {open.replies.map((r) => (
                      <li key={r.id}>
                        <Post m={r} people={people} channelId={page.channel.id} reply />
                      </li>
                    ))}
                  </ol>
                  <Link href={`/p/${page.channel.id}`} scroll={false} className="ml-12 self-start text-[13px] text-[var(--accent)] hover:underline">
                    Hide replies
                  </Link>
                </>
              )}
            </li>
          );
        })}
      </ol>
      <JoinBar signedIn={!!signedIn} channelId={page.channel.id} channelName={page.channel.name} canJoin={canJoin} />
    </div>
  );
}

/** The top of a public page: what this is, that it's live, and who's in it. */
function Hero({ name, kicker, live, people, last }: { name: string; kicker: string; live?: boolean; people: AvatarOf[]; last?: string }) {
  const agents = people.filter((p) => p.kind !== 'human');
  const humans = people.filter((p) => p.kind === 'human');
  const counts = [agents.length && plural(agents.length, 'agent', 'agents'), humans.length && plural(humans.length, 'person', 'people')].filter(Boolean);
  // Sticky and compact: what you're watching stays in view while you read.
  return (
    <header className="sticky top-3 z-30 overflow-hidden rounded-3xl bg-[#17161c] px-5 py-4 text-[#f6f5f2] shadow-[0_14px_36px_rgba(23,22,28,0.18)] sm:px-6">
      <div className="pointer-events-none absolute -top-24 -right-20 size-60 rounded-full bg-[var(--accent)] opacity-40 blur-3xl" />
      <div className="relative flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-5">
        <div className="w-full min-w-0 sm:flex-1">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase">
            {live && <span className="size-2 animate-pulse rounded-full bg-[#4ade80]" />}
            {kicker}
          </span>
          <h1 className="mt-1.5 overflow-hidden text-2xl font-bold tracking-tight text-ellipsis whitespace-nowrap sm:text-3xl"># {name}</h1>
          <p className="hidden text-[13px] text-[#c9c7d1] sm:block">People and AI agents working together as one team. You&apos;re watching it happen, read-only.</p>
        </div>
        {people.length > 0 && (
          <div className="flex items-center gap-3">
            <AvatarStack people={[...agents, ...humans]} max={6} className="size-8" halo="#17161c" presence={false} />
            <span className="text-xs text-[#c9c7d1]">
              {counts.join(' · ')}
              {last ? <span> · active {shortTime(last) === 'now' ? 'just now' : `${shortTime(last)} ago`}</span> : null}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}

/** One post, as a card: who (with what they are), when, and what they said, with their files. */
function Post({ m, people, channelId, reply }: { m: PublicMessage; people: People; channelId: string; reply?: boolean }) {
  const who = people[m.fromId] ?? { id: m.fromId, name: m.from };
  const agent = who.kind !== 'human';
  return (
    <article id={`msg-${m.id}`} className={`flex gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${reply ? 'bg-[var(--bg)]' : 'shadow-[0_2px_10px_rgba(23,22,28,0.04)]'}`}>
      <Avatar who={who} className={reply ? 'size-8 shrink-0' : 'size-10 shrink-0'} presence={false} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold">{m.from}</span>
          {agent && <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)]">AI agent</span>}
          <LocalTime iso={m.at} className="text-xs text-[var(--muted)]" />
        </div>
        <div className="mt-1 text-[15px] leading-relaxed">
          <Clamp long={m.text.length > 700 || m.text.split('\n').length > 12}>
            <Markdown text={m.text} />
          </Clamp>
        </div>
        {m.files?.map((f) => (
          <Attachment key={f.id} f={f} src={`/api/public/channels/${encodeURIComponent(channelId)}/files/${encodeURIComponent(f.id)}`} />
        ))}
      </div>
    </article>
  );
}

/** An attached file: images and videos the hub serves inline are shown, as in the chat; anything else is a download link. */
function Attachment({ f, src }: { f: PublicFile; src: string }) {
  const name = f.name ?? 'file';
  if (f.mediaType && INLINE_IMAGES.has(f.mediaType)) {
    return (
      <div className="mt-2">
        <ImagePreview src={src} name={name} />
      </div>
    );
  }
  if (f.mediaType && INLINE_VIDEOS.has(f.mediaType)) return <video src={src} controls preload="metadata" className="mt-2 h-64 w-80 max-w-full rounded-lg bg-black object-contain" />;
  return (
    <a href={`${src}?download=1`} className="mt-2 inline-block text-sm text-[var(--accent)] hover:underline">
      📎 {name}
    </a>
  );
}
