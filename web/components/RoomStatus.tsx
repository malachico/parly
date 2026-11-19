import Link from 'next/link';
import { PendingButton } from './PendingButton';
import { CopyButton } from '@/components/CopyButton';
import { LocalTime } from '@/components/LocalTime';
import { pointsOf, type RoomDocData } from '@/components/RoomDocument';
import { decideInRoom } from '@/lib/actions';
import type { Workspace } from '@/lib/hub';
import { roomStatus } from '@/lib/roomStatus';

/**
 * A shared room at a glance, above its messages: who's in it, where it stands, what it needs from me, and the
 * summary's open and agreed points. Approving happens in the summary itself, so people read the version they approve.
 */
export function RoomStatus({ ws, room, data, docHref, cornerHref, composerId, noAgents, back }: { ws: string; room: NonNullable<Workspace['room']>; data: RoomDocData; docHref: string; cornerHref?: string; composerId: string; noAgents: boolean; back: string }) {
  const doc = data.doc;
  const points = pointsOf(doc?.text);
  const total = points.open.length + points.agreed.length;
  const waiting = data.progress?.waiting;
  const { tone, text, myDecision, canApprove, readyToApprove, isDraft } = roomStatus({ room, doc, agreed: data.agreed, stuck: data.stuck, closed: data.closed, progress: data.progress, noAgents });
  // Loud "approve" CTA only when it's really the person's move: the other side approved, the agents
  // aren't here, or every point is agreed. Quiet while the agents are still talking, and never on a
  // stuck room — that one offers "tell your agent"/"write to the other side", not a loud approve.
  const approveIsPrimary = canApprove && !myDecision && !data.stuck && (readyToApprove || (points.agreed.length > 0 && points.open.length === 0));
  const toneClass = { ok: 'bg-[var(--ok-bg)] text-[var(--ok-fg)]', warn: 'bg-[var(--warn-bg)] text-[var(--warn-fg)]', muted: 'bg-[var(--subtle)] text-[var(--fg-soft)]' }[tone];
  const inviteLink = `/login?next=${encodeURIComponent(`/rooms/${ws}/side`)}`;
  return (
    <section aria-label="Where the room stands" className="card mb-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-[var(--muted)]">Goal of the room</p>
          <p className="font-semibold" dir="auto">
            {room.goal}
          </p>
          {room.sides.length > 0 && (
            <p className="mt-1 text-[13px] text-[var(--muted)]" dir="auto">
              {room.sides.map((s) => `${s.name}${doc?.approvals[s.id]?.version === doc?.version && doc ? ' ✓' : ''}`).join(' ⇄ ')}
              {room.sides.length < 2 && ' ⇄ …'}
            </p>
          )}
        </div>
        <Link href={docHref} scroll={false} className={`${approveIsPrimary ? 'btn-primary' : 'btn-ghost'} min-h-9 text-[13px]`}>
          {approveIsPrimary ? 'Review the summary and approve' : doc ? `Summary · v${doc.version}` : 'Summary'}
        </Link>
      </div>
      <p className={`rounded-lg px-3 py-2 text-sm font-medium ${toneClass}`}>{text}</p>
      {data.stuck && !data.agreed && !waiting && (
        <div className="flex flex-wrap gap-2">
          {cornerHref && (
            <Link href={cornerHref} className="btn min-h-9 text-[13px]">
              Tell your agent
            </Link>
          )}
          <label htmlFor={composerId} className="btn min-h-9 cursor-pointer text-[13px]">
            Write to the other side
          </label>
        </div>
      )}
      {room.sides.length < 2 && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
          <p className="text-sm">We emailed them an invite. You can also send the link yourself. Once they set up their side, the talks start here and end with a summary for you both to approve.</p>
          <div>
            <CopyButton value={inviteLink} label="Copy invite link" showLabel path />
          </div>
          <p className="text-[12px] text-[var(--muted)]">The link only works for the person you invited: they sign in with the email you entered.</p>
        </div>
      )}
      {myDecision && waiting && (
        <form action={decideInRoom.bind(null, ws, back)} className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
          <p className="text-sm font-semibold" dir="auto">
            {waiting.question}
          </p>
          {waiting.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {waiting.options.map((o) => (
                <PendingButton key={o} name="choice" value={o} className="btn min-h-10" dir="auto">
                  {o}
                </PendingButton>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <label htmlFor="decision-other" className="sr-only">
              Or say what you decided
            </label>
            <input id="decision-other" name="other" placeholder="Or say what you decided" className="input" dir="auto" autoComplete="off" />
            <PendingButton className="btn-primary shrink-0">Send</PendingButton>
          </div>
          <p className="text-[12px] text-[var(--muted)]">Only your side's agent gets this; it goes on in the room from it.</p>
        </form>
      )}
      {isDraft && <p className="text-[13px] font-medium text-[var(--fg-soft)]">Draft, not yet approved by both sides</p>}
      {total > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] text-[var(--muted)]">
            {points.agreed.length} of {total} points agreed by the agents
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {points.open.slice(0, 4).map((p) => (
              <li key={`o-${p}`} className="flex gap-2" dir="auto">
                <span aria-hidden className="text-[var(--muted)]">○</span>
                {p}
              </li>
            ))}
            {points.open.length > 4 && <li className="text-[13px] text-[var(--muted)]">and {points.open.length - 4} more open</li>}
          </ul>
        </div>
      )}
      {doc && (
        <p className="text-[12px] text-[var(--muted)]">
          Last change: version {doc.version} by {doc.updatedByName}
          {' · '}<LocalTime iso={doc.updatedAt} date />
        </p>
      )}
    </section>
  );
}
