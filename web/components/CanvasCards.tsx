'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { createCanvasTeam } from '@/lib/actions';
import { Avatar } from '@/components/Avatar';
import { presenceLabel } from '@/lib/presence';
import { statusStale, workingIn } from '@/lib/labels';
import type { CanvasAgent, CanvasTeam } from '@/lib/hub';
import { Icon } from '@/components/Icon';
import { agentHref, channelHref, dmHref } from '@/lib/routes';
import { hexRgb, TINTS } from '@/lib/canvasLayout';
import { plural } from '@/lib/plural';

/**
 * The canvas as cards, for phones (where panning and zooming are awkward): each team a card with its members, what
 * they're doing and what needs you; a tap opens the conversation or an agent. Agents in no team come last.
 */
export function CanvasCards({ ws, guest, teams, agentsById, meId, onLog, onAdd, onboarding, onCreated, notes }: { ws: string; guest?: boolean; teams: CanvasTeam[]; agentsById: Map<string, CanvasAgent>; meId: string; onLog: (agentId: string) => void; onAdd: (channelId: string) => void; onboarding?: ReactNode; notes?: ReactNode; onCreated?: (channelId: string) => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  // A new team from a phone: just a name; its frame goes below the others on the canvas, and its conversation opens.
  const newTeam = (e: React.FormEvent) => {
    e.preventDefault();
    const below = teams.reduce((y, t) => Math.max(y, t.canvas.y + t.canvas.h), 0);
    startTransition(async () => {
      const r = await createCanvasTeam(ws, { name, mode: 'new', canvas: { x: 40, y: below ? below + 60 : 40, w: 580, h: 420 } });
      if (!r.ok) return setError(r.error);
      setName('');
      setError('');
      if (onCreated) onCreated(r.channelId);
      else router.push(channelHref(ws, r.channelId, { panel: 'channel' }));
    });
  };
  // "Malachi's Claude Code" → "Claude Code": on a small face, the person's name in front is all most of these share.
  const people = [...agentsById.values()].filter((a) => a.kind === 'human').flatMap((a) => [a.name, a.name.split(' ')[0]!]);
  const shortName = (name: string) => {
    const p = people.find((n) => n && new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['’]s \\S`).test(name));
    return p ? name.slice(p.length + 3) : name;
  };
  const loose = [...agentsById.values()].filter((a) => a.kind !== 'human' && a.teams.length === 0);
  // Like a creature on the canvas: its face (with presence), name, and what it's doing; a tap opens your conversation
  // with it (yourself: your profile), a long press its log.
  const face = (a: CanvasAgent) => (
    <li key={a.id} className="w-[72px]">
      <Link
        href={a.id === meId || (guest && a.kind !== 'human') ? agentHref(ws, a.id) : dmHref(ws, a.id)}
        onContextMenu={(e) => {
          if (a.kind === 'human') return;
          e.preventDefault();
          onLog(a.id);
        }}
        title={a.status && !statusStale(a.status) ? `${a.name}: ${a.status.text}` : `${a.name} · ${presenceLabel(a.presence).text}`}
        className="flex flex-col items-center gap-1"
      >
        <Avatar who={a} className="size-12" />
        <span className="line-clamp-2 w-full text-center text-[11px] leading-tight font-semibold break-words">{a.id === meId ? 'You' : shortName(a.name)}</span>
      </Link>
    </li>
  );
  const action = 'inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--fg)] hover:bg-[var(--subtle)]';
  return (
    // Its own scrolling: the canvas underneath doesn't pan or open its menu.
    <div
      data-cards
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="absolute inset-0 z-[15] overflow-y-auto bg-[var(--bg)] px-4 pt-20 pb-10"
    >
      <ul className="mx-auto flex max-w-xl flex-col gap-3">
        {onboarding && <li>{onboarding}</li>}
        {teams.map((t, i) => {
          const members = t.members.flatMap((id) => agentsById.get(id) ?? []).sort((a, b) => Number(a.kind === 'human') - Number(b.kind === 'human'));
          const working = members.filter((a) => a.kind !== 'human' && workingIn(a.status, t.channelId)).length;
          return (
            // The team's frame, as on the canvas: its tint, name, actions and faces.
            <li key={t.channelId} className="rounded-[22px] p-4" style={{ background: `rgb(${hexRgb(TINTS[i % TINTS.length]!).replaceAll(',', ' ')} / var(--tint-alpha))` }}>
              <div className="flex items-center gap-1">
                <h2 className="min-w-0 flex-1 truncate text-base font-bold">{t.name}</h2>
                <span className="flex items-center gap-0.5 rounded-xl bg-[var(--bg)]/80 p-0.5">
                  <Link href={channelHref(ws, t.channelId)} aria-label={`Open the ${t.name} conversation`} title="Open the conversation" className={`relative ${action}`}>
                    <Icon name="chat" size={17} />
                    {t.needsYou > 0 && <span aria-label={`${t.needsYou} needs you in ${t.name}`} className="absolute -top-1 -right-1 rounded-full bg-[var(--bad-fg)] px-1.5 text-[10px] font-bold text-white">{t.needsYou > 9 ? '9+' : t.needsYou}</span>}
                  </Link>
                  <button type="button" onClick={() => onAdd(t.channelId)} aria-label={`Add member to ${t.name}`} title="Add member" className={action}>
                    <Icon name="person-plus" size={17} />
                  </button>
                  <Link href={channelHref(ws, t.channelId, { panel: 'channel', from: 'canvas' })} aria-label={`${t.name} settings`} title="Team settings" className={action}>
                    <Icon name="more" size={17} />
                  </Link>
                </span>
              </div>
              <ul className="mt-3 flex flex-wrap gap-x-2 gap-y-3">{members.map(face)}</ul>
              <p className="mt-3 text-[11px] text-[var(--muted)]">
                {members.length ? `${working ? `${working} working · ` : ''}${plural(members.length, 'member', 'members')}` : 'No one yet: add an agent'}
              </p>
            </li>
          );
        })}
        {loose.length > 0 && (
          <li className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-4">
            <h2 className="text-base font-bold">Not in a team</h2>
            <ul className="mt-3 flex flex-wrap gap-x-2 gap-y-3">{loose.map(face)}</ul>
          </li>
        )}
        <li id="new-team" className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-4">
          <form onSubmit={newTeam} className="flex flex-col gap-2">
            <h2 className="text-base font-bold">New team</h2>
            <div className="flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Name, e.g. launch" aria-label="Team name" className="input min-w-0 flex-1" />
              <button disabled={pending} className="btn-primary shrink-0">
                {pending ? 'Creating…' : 'Create'}
              </button>
            </div>
            {error && <p className="text-xs text-[var(--bad-fg)]">{error}</p>}
            <p className="text-xs text-[var(--muted)]">Then add agents and people to it from its members.</p>
          </form>
        </li>
        {/* Notes after the teams: on a phone the teams are what you came for. */}
        {notes && <li>{notes}</li>}
      </ul>
    </div>
  );
}
