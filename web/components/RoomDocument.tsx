import Link from 'next/link';
import { PendingButton } from './PendingButton';
import { Icon } from '@/components/Icon';
import { LocalTime } from '@/components/LocalTime';
import { Markdown } from '@/components/Markdown';
import { ErrorNote } from '@/components/ui';
import { approveRoomDocument, writeRoomDocument } from '@/lib/actions';
import type { Workspace } from '@/lib/hub';
import { plural } from '@/lib/plural';

export type RoomDocData = {
  doc?: {
    version: number;
    text: string;
    updatedByName: string;
    updatedAt: string;
    approvals: Record<string, { byName: string; version: number }>;
  };
  /** The version before this one, to show what changed. */
  previous?: { version: number; text: string; updatedByName: string };
  agreed: boolean;
  /** The agents' talks stopped: too many turns with no new version. A person posting in the room restarts them. */
  stuck?: boolean;
  /** The room was closed (e.g. a side passed on it): it's over, so there's nothing to approve. */
  closed?: boolean;
  /** Turns since the last new version (of maxTurns), and the side that spoke last. */
  progress?: { turns: number; maxTurns: number; lastSide?: string; waiting?: { side: string; question: string; options: string[] } };
};

/** Lines removed and added from `a` to `b` (a longest-common-subsequence diff), in document order. */
function lineDiff(a: string, b: string): { kind: 'add' | 'del'; text: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  // ponytail: O(n·m) table; a 50k-character document is a few hundred lines, so this is instant
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { kind: 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) (i++, j++);
    // A replaced line reads removed, then added.
    else if (i < x.length && (j === y.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: 'del', text: x[i++]! });
    else out.push({ kind: 'add', text: y[j++]! });
  }
  return out.filter((d) => d.text.trim());
}

/** The document's checklist: "- [ ] point" is open, "- [x] point" agreed by both sides. */
export function pointsOf(text: string | undefined): { open: string[]; agreed: string[] } {
  const open: string[] = [];
  const agreed: string[] = [];
  for (const line of (text ?? '').split('\n')) {
    const m = /^\s*[-*] \[([ xX])\]\s+(.*)$/.exec(line);
    if (m) (m[1] === ' ' ? open : agreed).push(m[2]!.trim());
  }
  return { open, agreed };
}

/**
 * A shared room's summary beside the room: what the sides worked out, which sides approved this
 * version, a button to approve it for mine, and an editor for the next version.
 */
export function RoomDocument({
  ws,
  room,
  data,
  back,
  closeHref,
  error,
}: {
  ws: string;
  room: NonNullable<Workspace['room']>;
  data: RoomDocData;
  back: string;
  closeHref: string;
  error?: string;
}) {
  const doc = data.doc;
  const mine = room.mySide;
  const iApproved = !!(doc && mine && doc.approvals[mine.id]?.version === doc.version);
  return (
    <aside aria-label="Summary for agreement" className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg)] lg:w-[460px] lg:shrink-0">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 sm:py-4">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-lg font-semibold">{data.agreed ? 'Agreement' : 'Summary for agreement'}</h2>
          <span className="truncate text-[13px] text-[var(--muted)]" dir="auto">
            {room.goal}
          </span>
        </div>
        <Link href={closeHref} scroll={false} aria-label="Close summary" className="ml-auto inline-flex size-10 items-center justify-center rounded-lg hover:bg-[var(--subtle)]">
          <Icon name="close" size={20} />
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-4">
          <ErrorNote error={error} />
          {data.stuck && !data.agreed && (
            <p className="rounded-lg bg-[var(--warn-bg)] px-3 py-2.5 text-sm text-[var(--warn-fg)]">
              <span className="font-semibold">The agents are stuck.</span> They went back and forth with no new version of the summary, so they stopped.
              Tell yours what to do in your private chat with it, or post in the shared room to have them carry on.
            </p>
          )}
          {data.agreed && doc && (
            <div className="flex flex-col gap-2 rounded-lg bg-[var(--ok-bg)] px-3 py-2.5 text-sm text-[var(--ok-fg)]">
              <p className="font-semibold">Agreed by both sides, version {doc.version}.</p>
              <p>
                {room.sides.map((s) => `${s.name}: ${doc.approvals[s.id]?.byName ?? ''}`).join(' · ')}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <a href={`data:text/markdown;charset=utf-8,${encodeURIComponent(agreedFile(room.goal, doc, room.sides))}`} download={`${fileName(room.goal)}-v${doc.version}.md`} className="btn min-h-9">
                  Download
                </a>
                <span className="text-[13px]">Carrying on? A person writes the next version below; that reopens it for approval.</span>
              </div>
            </div>
          )}
          {doc ? (
            <>
              <p className="text-[13px] text-[var(--muted)]">
                Version {doc.version} · by {doc.updatedByName} · <LocalTime iso={doc.updatedAt} date />
              </p>
              <div className="card">
                <Markdown text={doc.text} className="text-sm" />
              </div>
              {data.previous && <Changes previous={data.previous} text={doc.text} />}
              <section aria-label="Approvals" className="flex flex-col gap-1.5">
                <h3 className="label">Approvals</h3>
                {room.sides.map((s) => {
                  const a = doc.approvals[s.id];
                  const ok = a?.version === doc.version;
                  return (
                    <div key={s.id} className="flex items-center gap-2 rounded-lg bg-[var(--subtle)] px-3 py-2 text-sm">
                      <span className="flex-1" dir="auto">
                        {s.name}
                      </span>
                      <span className={ok ? 'font-semibold text-[var(--ok-fg)]' : 'text-[var(--muted)]'}>{ok ? `Approved by ${a!.byName}` : 'Waiting'}</span>
                    </div>
                  );
                })}
                {mine && !iApproved && !data.closed && (
                  <form action={approveRoomDocument.bind(null, ws, doc.version, back)}>
                    <PendingButton className="btn-primary mt-1">I read it: approve version {doc.version} for {mine.name}</PendingButton>
                  </form>
                )}
              </section>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">Nothing written yet. The agents write it as they work things out, and you can write the first version yourself.</p>
          )}
          <details className="rounded-lg border border-[var(--border)]">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{doc ? `Edit (makes version ${doc.version + 1} and clears approvals)` : 'Write the first version'}</summary>
            <form action={writeRoomDocument.bind(null, ws, doc?.version ?? 0, back)} className="flex flex-col gap-2 border-t border-[var(--border)] p-3">
              <label htmlFor="room-doc" className="sr-only">
                Document
              </label>
              <textarea id="room-doc" name="text" required rows={14} defaultValue={doc?.text ?? ''} dir="auto" className="input min-h-64 py-2 font-mono text-[13px]" />
              <PendingButton className="btn self-start">Save version {(doc?.version ?? 0) + 1}</PendingButton>
            </form>
          </details>
        </div>
      </div>
    </aside>
  );
}

/** What this version changed from the one before: its removed and added lines. */
function Changes({ previous, text }: { previous: NonNullable<RoomDocData['previous']>; text: string }) {
  const changes = lineDiff(previous.text, text);
  return (
    <details open className="rounded-lg border border-[var(--border)]">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        What changed from version {previous.version} ({plural(changes.length, 'line', 'lines')})
      </summary>
      <ul className="flex flex-col gap-0.5 border-t border-[var(--border)] p-2 font-mono text-[12px]">
        {changes.length === 0 && <li className="text-[var(--muted)]">Only spacing changed.</li>}
        {changes.map((c, i) => (
          <li key={i} dir="auto" className={c.kind === 'add' ? 'rounded bg-[var(--ok-bg)] px-1.5 text-[var(--ok-fg)]' : 'rounded bg-[var(--bad-bg,var(--subtle))] px-1.5 text-[var(--bad-fg)] line-through'}>
            {c.kind === 'add' ? '+ ' : '− '}
            {c.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The agreed document as a file: the text, then who approved it for each side, and when. */
function agreedFile(goal: string, doc: NonNullable<RoomDocData['doc']>, sides: { id: string; name: string }[]): string {
  const approvals = sides.map((s) => `- ${s.name}: approved by ${doc.approvals[s.id]?.byName ?? '?'}`).join('\n');
  return `${doc.text}\n\n---\n\nAgreed: ${goal}, version ${doc.version}, last changed ${doc.updatedAt}\n${approvals}\n`;
}

const fileName = (goal: string) => goal.toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agreement';
