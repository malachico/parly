import type { Agent } from '@/lib/hub';
import { OWN_AGENT } from '@/lib/roomStatus';

/** What a side tells its agent, in parts it can act on (put together by briefOf in actions.ts). */
const INSTRUCTIONS = [
  { name: 'want', label: 'What do you want out of this?', placeholder: 'e.g. A webhook we can rely on, live by March' },
  { name: 'redLines', label: "What won't you compromise on?", placeholder: 'e.g. No SLA above 99.5%; no customer emails leave our side' },
  { name: 'share', label: 'What may your agent tell the other side?', placeholder: 'e.g. Our event volumes, not our pricing' },
] as const;

/** A side of a shared room: its name, who speaks for it, and its private instructions. */
export function RoomSideFields({ bots, name, cloud }: { bots: Agent[]; name?: string; cloud?: boolean }) {
  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold">Your name or company</span>
        <input name="side" required maxLength={60} defaultValue={name} placeholder="e.g. Acme" className="input" dir="auto" />
        <span className="text-[13px] text-[var(--muted)]">The other side sees this.</span>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-semibold">Who speaks for you</legend>
        {bots.length === 0 && !cloud ? (
          <p className="text-[13px] text-[var(--muted)]">
            You have no agents yet, so you&apos;ll take part yourself: you write in the room and approve the result.
          </p>
        ) : (
          // ponytail: one agent per side at setup; required radios stop an accidental room with nobody talking, without JS.
          <ul className="flex flex-col gap-1.5">
            {cloud && (
              <li>
                <label className="flex min-h-11 items-center gap-3 rounded-lg border border-[var(--border)] px-3 py-2 hover:bg-[var(--subtle)]">
                  <input type="radio" name="bots" value={OWN_AGENT} required defaultChecked className="size-4" />
                  <span className="flex min-w-0 flex-col">
                    <span>Create a dedicated agent</span>
                    <span className="text-[13px] text-[var(--muted)]">It works in this room only, and uses your credits.</span>
                  </span>
                </label>
              </li>
            )}
            {bots.length > 0 && (
              <li>
                {/* Open without the dedicated option: then these are the only agents to choose from. */}
                <details open={!cloud}>
                  <summary className="cursor-pointer py-3 text-sm text-[var(--muted)]">Pick an existing agent</summary>
                  <ul className="flex flex-col gap-1.5">
                    {bots.map((b) => (
                      <li key={b.id}>
                        <label className="flex min-h-11 items-center gap-3 rounded-lg border border-[var(--border)] px-3 hover:bg-[var(--subtle)]">
                          <input type="radio" name="bots" value={b.id} required defaultChecked={!cloud && bots.length === 1} className="size-4" />
                          <span className="truncate">{b.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
            <li>
              <label className="flex min-h-11 items-center gap-3 rounded-lg border border-[var(--border)] px-3 hover:bg-[var(--subtle)]">
                <input type="radio" name="bots" value="" required className="size-4" />
                <span>No agent, I&apos;ll take part myself</span>
              </label>
            </li>
          </ul>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">Instructions for your agent</legend>
        <p className="text-[13px] text-[var(--muted)]">Only your side&apos;s agent gets these. The other side never sees them, but your agent uses them when it talks to theirs. Short is fine.</p>
        {INSTRUCTIONS.map((f) => (
          <label key={f.name} className="flex flex-col gap-1">
            <span className="text-sm">{f.label}</span>
            <textarea name={f.name} rows={2} maxLength={1000} dir="auto" placeholder={f.placeholder} className="input min-h-14 py-2" />
          </label>
        ))}
        <details>
          <summary className="cursor-pointer text-sm text-[var(--muted)]">More options</summary>
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-sm">Anything else</span>
            <textarea name="brief" rows={2} maxLength={1000} dir="auto" placeholder="Context, tone, who to ask" className="input min-h-14 py-2" />
          </label>
        </details>
      </fieldset>
    </>
  );
}
