import { PendingButton } from './PendingButton';
import { saveRoomBrief } from '@/lib/actions';

/**
 * My side's private instructions, to change while the talks go on. Only my side's private chat shows them.
 * `brief` undefined: they couldn't be read, and an empty form saved over them would erase them.
 */
export function RoomBrief({ ws, brief, back }: { ws: string; brief: string | undefined; back: string }) {
  if (brief === undefined) return <p className="card mb-5 text-sm text-[var(--muted)]">Your instructions couldn&apos;t be loaded just now. Reload to see or change them.</p>;
  return (
    <details className="card mb-5">
      <summary className="cursor-pointer text-sm font-semibold">Instructions for your agent</summary>
      <form action={saveRoomBrief.bind(null, ws, back)} className="mt-3 flex flex-col gap-2">
        <label htmlFor="room-brief" className="text-[13px] text-[var(--muted)]">
          Only your side sees these. Your agent gets any change with its next message.
        </label>
        <textarea id="room-brief" name="brief" rows={6} maxLength={4000} defaultValue={brief} dir="auto" className="input min-h-32 py-2" />
        <PendingButton className="btn self-start">Save instructions</PendingButton>
      </form>
    </details>
  );
}
