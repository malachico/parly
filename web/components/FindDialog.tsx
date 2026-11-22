'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import { Dialog } from '@/components/Modal';
import { channelMemberCounts, searchDirectory, searchMessages, type DirectoryEntry, type MessageHit } from '@/lib/actions';
import { type GraphEntry, listGraphEntries } from '@/lib/actions/graph';
import { shortTime } from '@/lib/labels';
import { agentHref, channelHref, chatHref, dmHref, knowledgeHref } from '@/lib/routes';
import { plural } from '@/lib/plural';

type Show = 'everyone' | 'agents' | 'people' | 'messages';
const SHOWS: { key: Show; label: string }[] = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'agents', label: 'Agents' },
  { key: 'people', label: 'People' },
  { key: 'messages', label: 'Messages' },
];

/** Adds `name=value` to the current URL (or removes it with undefined); keeps the other params. */
export function useParamHref() {
  const path = usePathname();
  const params = useSearchParams();
  return (name: string, value: string | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (value === undefined) next.delete(name);
    else next.set(name, value);
    const qs = next.toString();
    return `${path}${qs ? `?${qs}` : ''}`;
  };
}

/**
 * The directory as a dialog: everyone you can message, and your channels in this workspace. Open
 * while the URL has ?find=<query>, so the phone's back button closes it. "Message" opens the
 * conversation (new or not).
 */
export function FindDialog({ workspaceId, channels: mine, meId, graph }: { workspaceId: string; channels: { id: string; name: string }[]; meId: string; graph?: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const href = useParamHref();
  const open = params.has('find');
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<Show>('everyone');
  const [agents, setAgents] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [entries, setEntries] = useState<GraphEntry[]>([]);
  const latest = useRef(0);

  // Each time it opens, start from the query in the URL (the rail passes what you typed there).
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed from the URL only on the open→ edge; re-running on every params change would clobber what the user is typing
  useEffect(() => {
    if (open) setQuery(params.get('find') ?? '');
  }, [open]); // once on open; intentionally omit params

  // Channel sizes, once per opening.
  useEffect(() => {
    if (open) void channelMemberCounts(workspaceId).then(setCounts);
  }, [open, workspaceId]);

  useEffect(() => {
    const id = ++latest.current;
    setEntries([]);
    if (!open) return;
    const t = setTimeout(async () => {
      const pending = Promise.all([searchDirectory(query), searchMessages(query)]);
      // Each graph search spends embedding budget; only search from two characters on the message tabs.
      if ((show === 'messages' || show === 'everyone') && query.trim().length >= 2) void listGraphEntries(workspaceId, { q: query.trim() }).then((d) => id === latest.current && setEntries(d.entries)).catch(() => id === latest.current && setEntries([]));
      const [res, found] = await pending;
      if (id !== latest.current) return;
      setHits(found);
      if (res.ok) {
        setAgents(res.agents);
        setError(null);
      } else setError(res.error);
    }, 200);
    return () => clearTimeout(t);
  }, [open, query, show, workspaceId]);

  const close = () => router.replace(href('find', undefined), { scroll: false });
  const q = query.trim().toLowerCase();
  const channels = mine.filter((t) => !q || t.name.toLowerCase().includes(q));
  const shown =
    show === 'messages' ? [] : (agents ?? []).filter((a) => (show === 'agents' ? a.kind !== 'human' : show === 'people' ? a.kind === 'human' : true));

  return (
    <Dialog open={open} onClose={close} title={graph ? 'Find people, channels, messages and knowledge' : 'Find people, channels and messages'} wide>
      <div className="flex flex-col gap-2.5">
        <label htmlFor="find-q" className="sr-only">
          Search
        </label>
        <input
          id="find-q"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people, skills, channels or messages"
          autoComplete="off"
          className="input"
        />
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
          {SHOWS.map((s) => (
            <button key={s.key} type="button" className="pill" aria-pressed={show === s.key} onClick={() => setShow(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2">
        {channels.length > 0 && show === 'everyone' && (
          <section className="pb-3">
            <h3 className="label pb-1.5">Your channels</h3>
            <ul className="flex flex-col gap-px">
              {channels.map((t) => (
                <li key={t.id}>
                  <Link href={channelHref(workspaceId, t.id)} className="flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-[var(--subtle)]">
                    <span className="avatar size-9">#</span>
                    <span className="truncate font-medium">{t.name}</span>
                    {counts[t.id] !== undefined && (
                      <span className="ml-auto shrink-0 text-xs text-[var(--muted)]">
                        {plural(counts[t.id], 'member', 'members')}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {show !== 'messages' && (
          <section>
            <h3 className="label pb-1.5">{show === 'people' ? 'People' : show === 'agents' ? 'Agents' : 'People and agents'}</h3>
            {error && (
              <p role="alert" className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
                {error}
              </p>
            )}
            {agents === null && !error && <p className="py-4 text-sm text-[var(--muted)]">Loading…</p>}
            {agents !== null && shown.length === 0 && <p className="py-4 text-sm text-[var(--muted)]">No one matches.</p>}
            <ul className="flex flex-col gap-px">
              {shown.map((a) => (
                <li key={a.id}>
                  <Entry agent={a} meId={meId} workspaceId={workspaceId} inWorkspace={a.workspaces.includes(workspaceId)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {show === 'messages' && q.length < 2 && <p className="py-4 text-sm text-[var(--muted)]">Type at least 2 characters to search messages.</p>}
        {(show === 'messages' || show === 'everyone') && q.length >= 2 && (
          <section className="pt-3">
            <h3 className="label pb-1.5">Messages</h3>
            {hits.length === 0 ? (
              <p className="py-4 text-sm text-[var(--muted)]">No messages match.</p>
            ) : (
              <ul className="flex flex-col gap-px">
                {hits.map((h) => (
                  <li key={h.message.id}>
                    <Hit hit={h} query={q} workspaceId={workspaceId} people={agents} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {(show === 'messages' || show === 'everyone') && q.length >= 2 && entries.length > 0 && (
          <section className="pt-3">
            <h3 className="label pb-1.5">Knowledge</h3>
            <ul className="flex flex-col gap-px">
              {entries.map((d) => (
                <li key={d.id}>
                  <Link href={knowledgeHref(d.workspaceId, { entry: d.id })} scroll={false} className="flex min-w-0 flex-col rounded-lg px-2 py-2 hover:bg-[var(--subtle)]">
                    <span className="break-words text-sm">{d.title}</span>
                    <span className="text-xs text-[var(--muted)]">{d.kind}</span>
                    {d.summary && <span className="truncate text-sm text-[var(--muted)]">{d.summary}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-[var(--border)] pt-3 text-sm">
        <p className="text-[var(--fg-soft)]">
          <span className="font-medium text-[var(--fg)]">Bring your own agent.</span>{' '}
          <Link href="/connect" className="text-[var(--accent)] hover:underline">
            Connect your Claude Code or Codex
          </Link>{' '}
          and add it to your workspace and channels; it reads its mail at each of your prompts.
        </p>
      </div>
    </Dialog>
  );
}

function Entry({ agent, inWorkspace, workspaceId, meId }: { agent: DirectoryEntry; inWorkspace: boolean; workspaceId: string; meId: string }) {
  const person = agent.kind === 'human';
  const seen = shortTime(agent.lastSeen);
  const kind = person ? 'person' : agent.owner ? `agent · ${agent.owner.id === meId ? 'yours' : `${agent.owner.name}'s`}` : agent.kind === 'endpoint' ? 'agent · A2A' : 'agent';
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--subtle)]">
      <Link href={agentHref(workspaceId, agent.id)} title="Profile" className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar who={agent} className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{agent.name}</span>
            <span className="shrink-0 text-xs text-[var(--muted)]">{kind}</span>
          </span>
          <span className="truncate text-[13px] text-[var(--muted)]">
            {agent.listening ? (
              <span className="font-medium text-[var(--ok-fg)]">● listening now</span>
            ) : agent.wakes ? (
              <span className="font-medium text-[var(--ok-fg)]" title="Not listening, but a message starts its Claude Code Routine">● wakes on message</span>
            ) : seen ? (
              `active ${seen === 'now' ? 'now' : `${seen} ago`}`
            ) : (
              ''
            )}
            {inWorkspace ? ' · in this workspace' : agent.public ? ' · public' : ' · another workspace'}
            {agent.description ? ` · ${agent.description}` : ''}
          </span>
        </div>
      </Link>
      <Link href={dmHref(workspaceId, agent.id)} className="btn min-h-9 px-3">
        Message
      </Link>
    </div>
  );
}

/** A message search result: where it was said, who said it, and the words around the match. */
function Hit({ hit, query, workspaceId, people }: { hit: MessageHit; query: string; workspaceId: string; people: DirectoryEntry[] | null }) {
  const isChannel = hit.key.startsWith('channel:');
  const href = hit.thread ? chatHref(workspaceId, hit.key, { thread: hit.thread }) : chatHref(workspaceId, hit.key);
  const m = hit.message;
  const seen = shortTime(m.at);
  return (
    <Link href={href} scroll={false} className="flex gap-3 rounded-lg px-2 py-2 hover:bg-[var(--subtle)]">
      {/* ponytail: senders outside the directory results draw plain; hub search could return people if that shows. */}
      <Avatar who={people?.find((a) => a.id === m.fromId) ?? { id: m.fromId }} className="size-8" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-[13px] text-[var(--muted)]">
          <span className="truncate">
            {isChannel ? `# ${hit.title}` : hit.title}
            {hit.thread ? ' · thread' : ''} · <span className="font-medium text-[var(--fg)]">{m.from}</span>
          </span>
          {seen && <time className="ml-auto shrink-0 text-xs">{seen}</time>}
        </span>
        <span className="line-clamp-2 text-sm break-words">{snippet(m.text, query)}</span>
      </span>
    </Link>
  );
}

/** The text around the first match, with the match marked. */
function snippet(text: string, query: string): React.ReactNode {
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return text;
  const start = Math.max(0, i - 40);
  return (
    <>
      {start > 0 && '…'}
      {text.slice(start, i)}
      <mark className="rounded-sm bg-[var(--warn-bg)] px-0.5 text-[var(--fg)]">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length, i + query.length + 160)}
    </>
  );
}
