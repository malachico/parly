'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { wsHref } from '@/lib/routes';
import { Avatar, type AvatarOf } from '@/components/Avatar';
import { addMyAgentHere, createCanvasTeam } from '@/lib/actions';
import type { CanvasAgent, CanvasBox, CanvasTeam, CanvasView, SlackChannelOption } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';
import { plural } from '@/lib/plural';

export type PendingAction =
  | {
      kind: 'add';
      agentId: string;
      fromTeamId?: string;
      toTeamId: string;
    }
  | {
      kind: 'remove';
      agentId: string;
      fromTeamId: string;
    };

/** Right-side Bench of workspace agents (NewTeam.dc.html), ready to be dragged into a team. */
export function BenchDrawer({
  ws,
  agents,
  elsewhere = [],
  onStartDrag,
  onClose,
}: {
  ws: string;
  agents: CanvasAgent[];
  elsewhere?: NonNullable<CanvasView['elsewhere']>;
  onStartDrag: (agentId: string, e: React.PointerEvent) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Bench"
      onPointerDown={(e) => e.stopPropagation()}
      className="canvas-pop absolute top-[84px] right-4 z-30 flex max-h-[calc(100vh-110px)] w-[min(300px,calc(100vw-32px))] flex-col gap-2.5 overflow-y-auto rounded-[20px] bg-[var(--bg)]/95 p-3 shadow-[0_14px_32px_rgba(23,22,28,0.1)]"
    >
      <div className="flex items-center">
        <span className="text-[11px] font-semibold tracking-wider text-[var(--muted)] uppercase">Bench · your agents</span>
        <button
          type="button"
          aria-label="Close the bench"
          onClick={onClose}
          className="ml-auto inline-flex size-8 items-center justify-center rounded-[9px] bg-[var(--subtle)] text-sm hover:bg-[var(--border)]"
        >
          ✕
        </button>
      </div>
      {agents.length === 0 ? (
        <p className="m-0 rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-3 text-xs text-[var(--muted)]">
          {elsewhere.length ? 'No agents in this workspace yet. Add yours below, then drag them into a team.' : 'No agents connected yet. Connect an agent and drag it into a team.'}
        </p>
      ) : (
        agents.map((a) => {
          const teamCount = a.teams.length;
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              aria-label={`Drag ${a.name} onto a team`}
              onPointerDown={(e) => onStartDrag(a.id, e)}
              className={`flex cursor-grab items-center gap-2.5 rounded-2xl bg-[var(--surface)] p-2.5 active:cursor-grabbing ${
                teamCount === 0
                  ? 'border-2 border-dashed border-[#a5a0e6]'
                  : 'border border-[var(--border)]'
              }`}
            >
              <Avatar who={a} className="size-10 shrink-0" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold">{a.name}</span>
                <span className="text-xs text-[var(--muted)]">
                  {teamCount === 0 ? 'no team yet' : `in ${plural(teamCount, 'team', 'teams')}`}
                </span>
              </div>
            </div>
          );
        })
      )}
      {elsewhere.length > 0 && (
        <>
          <span className="mt-1 text-[11px] font-semibold tracking-wider text-[var(--muted)] uppercase">Yours, not in this workspace</span>
          {elsewhere.map((a) => (
            <div key={a.id} className="flex items-center gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2.5">
              <Avatar who={a} className="size-10 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{a.name}</span>
              <form action={addMyAgentHere.bind(null, ws, a.id)}>
                <PendingButton className="btn min-h-8 shrink-0 px-2.5 text-xs">Add here</PendingButton>
              </form>
            </div>
          ))}
        </>
      )}
      <span className="text-xs text-[var(--muted)]">
        A team is a channel with its agents. Its frame and place on the canvas are yours to arrange.
      </span>
    </aside>
  );
}

/** A team's "Add member": pick one of the workspace's people or agents by name, or make a new agent for this team. */
export function AddToTeam({ ws, team, agents, onPick, onClose }: { ws: string; team: CanvasTeam; agents: (AvatarOf & { name: string })[]; onPick: (agentId: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const outside = agents.filter((a) => !team.members.includes(a.id));
  const shown = outside.filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <aside
      aria-label={`Add member to ${team.name}`}
      onPointerDown={(e) => e.stopPropagation()}
      className="canvas-pop absolute top-[84px] right-4 z-30 flex max-h-[calc(100dvh-110px)] w-[min(320px,calc(100vw-32px))] flex-col gap-2.5 rounded-[20px] bg-[var(--bg)]/95 p-3 shadow-[0_14px_32px_rgba(23,22,28,0.1)]"
    >
      <div className="flex items-center">
        <span className="truncate text-[11px] font-semibold tracking-wider text-[var(--muted)] uppercase">Add to {team.name}</span>
        <button type="button" aria-label="Close" onClick={onClose} className="ml-auto inline-flex size-8 items-center justify-center rounded-[9px] bg-[var(--subtle)] text-sm hover:bg-[var(--border)]">
          ✕
        </button>
      </div>
      {outside.length > 0 && (
        <input
          type="search"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) onPick(shown[0].id);
          }}
          placeholder="Find a member…"
          aria-label="Find a member"
          className="input w-full"
        />
      )}
      <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
        {shown.map((a) => (
          <button key={a.id} type="button" onClick={() => onPick(a.id)} className="flex items-center gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 text-left hover:bg-[var(--subtle)]">
            <Avatar who={a} className="size-9 shrink-0" />
            <span className="min-w-0 truncate text-sm font-semibold">{a.name}</span>
          </button>
        ))}
        {outside.length > 0 && shown.length === 0 && <p className="m-0 px-1 text-xs text-[var(--muted)]">No member called “{q.trim()}”.</p>}
        {outside.length === 0 && <p className="m-0 px-1 text-xs text-[var(--muted)]">Everyone is in {team.name} already.</p>}
      </div>
      <Link href={`${wsHref(ws)}/connect?${new URLSearchParams({ team: team.channelId })}`} scroll={false} className="btn-primary justify-center">
        Add an agent
      </Link>
    </aside>
  );
}

/** Screen 5 (NewTeam.dc.html): Draw a frame and name the team. */
export function NewTeamDialog({
  ws,
  box,
  scale = 1,
  slackChannels,
  joinableChannels,
  onResizeBox,
  onCreated,
  onCancel,
}: {
  ws: string;
  box: CanvasBox;
  scale?: number;
  slackChannels: SlackChannelOption[];
  joinableChannels: { id: string; name: string }[];
  onResizeBox: (box: CanvasBox) => void;
  onCreated: (channelId: string, box: CanvasBox) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'new' | 'slack' | 'existing'>('new');
  const [slackId, setSlackId] = useState(slackChannels[0]?.id ?? '');
  const [existingId, setExistingId] = useState(joinableChannels[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'new-team';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await createCanvasTeam(ws, {
        name: mode === 'existing' ? joinableChannels.find((c) => c.id === existingId)?.name ?? name : name,
        mode,
        slackChannelId: mode === 'slack' ? slackId : undefined,
        existingChannelId: mode === 'existing' ? existingId : undefined,
        canvas: box,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onCreated(res.channelId, box);
    });
  };

  return (
    <section
      aria-label="New team"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const startBox = box;
        const onMove = (ev: PointerEvent) => {
          onResizeBox({
            ...startBox,
            x: Math.round(startBox.x + (ev.clientX - startX) / scale),
            y: Math.round(startBox.y + (ev.clientY - startY) / scale),
          });
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }}
      className="cursor-grab active:cursor-grabbing"
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        borderRadius: 36,
        background: 'rgba(211,235,228,0.55)',
        border: '3px dashed var(--accent)',
        boxSizing: 'border-box',
        zIndex: 25,
      }}
    >
      <div
        role="dialog"
        aria-label="Name the team"
        onPointerDown={(e) => e.stopPropagation()}
        className="canvas-pop absolute top-7 left-7 flex w-[min(400px,calc(100%-56px))] cursor-default flex-col gap-3 rounded-[20px] bg-[var(--surface)] p-4 shadow-[0_18px_40px_rgba(23,22,28,0.14)]"
      >
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] text-[var(--fg-soft)]">
            Team name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Team name"
              placeholder="e.g. Launch, Growth, QA"
              required={mode === 'new'}
              maxLength={60}
              autoFocus
              className="rounded-[10px] border border-[var(--accent)] px-3 py-2 text-lg font-semibold text-[var(--fg)] outline-none"
            />
          </label>
          <span className="text-[13px] text-[var(--fg-soft)]">Where does it talk?</span>
          <div className="flex flex-col gap-1.5">
            <label
              className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
                mode === 'new' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-strong)]'
              }`}
            >
              <input type="radio" name="where" checked={mode === 'new'} onChange={() => setMode('new')} />
              <span>
                New channel <b>#{slug}</b> on Parly
              </span>
            </label>

            <label
              className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
                mode === 'slack' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-strong)]'
              }`}
            >
              <input
                type="radio"
                name="where"
                checked={mode === 'slack'}
                onChange={() => setMode('slack')}
                disabled={slackChannels.length === 0}
              />
              <span>Link a Slack channel</span>
              {slackChannels.length > 0 ? (
                <select
                  value={slackId}
                  onChange={(e) => setSlackId(e.target.value)}
                  aria-label="Slack channel"
                  className="ml-auto max-w-[140px] truncate rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-xs text-[var(--muted)]"
                >
                  {slackChannels.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      #{sc.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="ml-auto text-xs text-[var(--muted)]">connect Slack first</span>
              )}
            </label>
            {joinableChannels.length > 0 && (
              <label
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
                  mode === 'existing' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-strong)]'
                }`}
              >
                <input type="radio" name="where" checked={mode === 'existing'} onChange={() => setMode('existing')} />
                <span>Use an existing channel</span>
                <select
                  value={existingId}
                  onChange={(e) => setExistingId(e.target.value)}
                  aria-label="Existing channel"
                  className="ml-auto max-w-[140px] truncate rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-xs text-[var(--muted)]"
                >
                  {joinableChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {error && <p className="m-0 text-xs text-[var(--bad-fg)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !name.trim()}
              className="h-10 rounded-[10px] bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? 'Creating…' : 'Create team'}
            </button>
          </div>
        </form>
      </div>
      <div className="absolute bottom-6 left-8 text-[13px] text-[var(--accent-ink)]">
        Next: drag agents in from the bench →
      </div>
      <button
        type="button"
        aria-label="Resize new team frame"
        onPointerDown={(e) => {
          e.stopPropagation();
          const startX = e.clientX;
          const startY = e.clientY;
          const startW = box.w;
          const startH = box.h;
          const onMove = (ev: PointerEvent) => {
            onResizeBox({
              ...box,
              w: Math.max(380, Math.round(startW + (ev.clientX - startX) / scale)),
              h: Math.max(320, Math.round(startH + (ev.clientY - startY) / scale)),
            });
          };
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        }}
        style={{
          position: 'absolute',
          right: -9,
          bottom: -9,
          width: 18,
          height: 18,
          borderRadius: 6,
          background: 'var(--surface)',
          border: '3px solid var(--accent)',
          cursor: 'nwse-resize',
        }}
      />
    </section>
  );
}

/** Screen 7 (Empty.dc.html): First-run empty state on the canvas. */
export function EmptyCanvasCard({ ws, me, hasAgents, onCreateTeam }: {
  ws: string;
  me: AvatarOf;
  hasAgents: boolean;
  onCreateTeam: () => void;
}) {
  const action = 'inline-flex min-h-12 items-center justify-center rounded-xl bg-[var(--accent)] px-5 text-base font-semibold text-white';
  return (
    <section aria-label="Your first team" onPointerDown={(e) => e.stopPropagation()}
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 rounded-[28px] border-2 border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-6 py-8 text-center">
      <Avatar who={me} className="size-20 rounded-full" />
      <h1 className="m-0 text-2xl font-bold tracking-tight">{hasAgents ? 'Create your first team' : "This is your crew's home"}</h1>
      <p className="m-0 max-w-md text-base leading-relaxed text-[var(--fg-soft)]">
        {hasAgents ? 'Your agents are connected. Create a team, then choose who works together. You can also message agents directly without a team.' : 'Add an agent to get started. Connect one you already use for free, or choose an agent Parly runs for you.'}
      </p>
      {hasAgents ? <button type="button" onClick={onCreateTeam} className={action}>Create your first team</button>
        : <Link href={`${wsHref(ws)}/connect`} scroll={false} className={action}>Add an agent</Link>}
    </section>
  );
}

/** Drag / Leave confirmation modal (Add / Move instead / Cancel + role). */
export function ConfirmTeamMemberDialog({
  pending,
  agentsById,
  teams,
  dropRole,
  onChangeRole,
  onApply,
  onCancel,
}: {
  pending: PendingAction;
  agentsById: Map<string, AvatarOf & { name: string }>;
  teams: CanvasTeam[];
  dropRole: string;
  onChangeRole: (role: string) => void;
  onApply: (moveInstead: boolean) => void;
  onCancel: () => void;
}) {
  const a = agentsById.get(pending.agentId);
  if (!a) return null;
  if (pending.kind === 'remove') {
    const fromTeam = teams.find((t) => t.channelId === pending.fromTeamId);
    if (!fromTeam) return null;
    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.target === e.currentTarget && onCancel()}
        className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(23,22,28,0.18)] p-4 backdrop-blur sm:items-center"
      >
        <div
          role="dialog"
          aria-label="Confirm"
          className="canvas-pop flex w-[min(420px,calc(100vw-32px))] flex-col gap-3.5 rounded-[20px] bg-[var(--surface)] p-5 shadow-[0_24px_60px_rgba(23,22,28,0.2)]"
        >
          <div className="flex items-center gap-3">
            <Avatar who={a} className="size-12 shrink-0" />
            <span className="text-[17px] font-bold">Take {a.name} out of {fromTeam.name}?</span>
          </div>
          <p className="m-0 text-sm leading-relaxed text-[var(--fg-soft)]">
            It leaves {fromTeam.name} and #{fromTeam.name}. Its other teams stay as they are.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-10.5 cursor-pointer rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onApply(false)}
              className="h-10.5 cursor-pointer rounded-[10px] bg-[var(--accent)] px-4.5 text-sm font-semibold text-white"
            >
              Take out
            </button>
          </div>
        </div>
      </div>
    );
  }
  const toTeam = teams.find((t) => t.channelId === pending.toTeamId);
  const fromTeam = pending.fromTeamId ? teams.find((t) => t.channelId === pending.fromTeamId) : undefined;
  if (!toTeam) return null;
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(23,22,28,0.18)] p-4 backdrop-blur sm:items-center"
    >
      <div
        role="dialog"
        aria-label="Confirm"
        className="canvas-pop flex w-[min(440px,calc(100vw-32px))] flex-col gap-3.5 rounded-[20px] bg-[var(--surface)] p-5 shadow-[0_24px_60px_rgba(23,22,28,0.2)]"
      >
        <div className="flex items-center gap-3">
          <Avatar who={a} className="size-12 shrink-0" />
          <span className="text-[17px] font-bold">Add {a.name} to {toTeam.name}?</span>
        </div>
        <p className="m-0 text-sm leading-relaxed text-[var(--fg-soft)]">
          {a.name} joins {toTeam.name} and #{toTeam.name} as a member.
          {fromTeam ? ` ${a.kind === 'human' ? 'They stay' : 'It stays'} in ${fromTeam.name}.` : ''}
          {a.kind === 'human' ? ' They can see new messages from now on.' : ' Joining doesn\u2019t wake it; it hears new messages from now on.'}
        </p>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Role in {toTeam.name} (optional)
          <input
            type="text"
            value={dropRole}
            onChange={(e) => onChangeRole(e.target.value)}
            placeholder="e.g. implementer, reviewer, lead"
            maxLength={40}
            className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1.5 text-sm text-[var(--fg)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-10.5 cursor-pointer rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-sm"
          >
            Cancel
          </button>
          {fromTeam && (
            <button
              type="button"
              onClick={() => onApply(true)}
              className="h-10.5 cursor-pointer rounded-[10px] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-sm hover:bg-[var(--subtle)]"
            >
              Move instead
            </button>
          )}
          <button
            type="button"
            onClick={() => onApply(false)}
            className="h-10.5 cursor-pointer rounded-[10px] bg-[var(--accent)] px-4.5 text-sm font-semibold text-white"
          >
            Add to {toTeam.name}
          </button>
        </div>
      </div>
    </div>
  );
}
