'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountMenu, CanvasMenu, WorkspaceMenu, type MenuWorkspace } from '@/components/AccountMenu';
import { Avatar } from '@/components/Avatar';
import { NewTeamDialog } from '@/components/CanvasModals';
import { Tip } from '@/components/Tip';
import { presenceLabel } from '@/lib/presence';
import { openPalette } from '@/components/CommandPalette';
import { CopyButton } from '@/components/CopyButton';
import { Icon } from '@/components/Icon';
import { SlackLogo } from '@/components/SlackLogo';
import { cardAvatarOverlap, frameHeight, hexRgb, TINTS } from '@/lib/canvasLayout';
import type { CanvasAgent, CanvasBox, CanvasTeam, SlackChannelOption, WaitingItem } from '@/lib/hub';
import { credits, shortTime, workingIn } from '@/lib/labels';
import { appsHref, channelHref, devAppsHref, skillsHref, triggersHref, wsHref } from '@/lib/routes';
import { plural } from '@/lib/plural';

export type PlacedCreature = {
  pid: string;
  agent: CanvasAgent;
  team: CanvasTeam;
  x: number;
  y: number;
  role?: string;
  waitingItem?: WaitingItem;
};

export type DragCreatureState = {
  pid: string;
  agentId: string;
  fromTeamId?: string;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
  moved: boolean;
};

export type DragFrameState = {
  channelId: string;
  mode: 'move' | 'resize';
  sx: number;
  sy: number;
  box0: CanvasBox;
  moved: boolean;
};

/** World transform layer: cross-team links, team frames, placed creatures, and the new-team frame. */
export function CanvasWorld({
  notes,
  ws,
  tx,
  ty,
  s,
  anim,
  overview,
  teams,
  agentsById,
  placedCreatures,
  crossTeamLinks,
  selAgentId,
  waiting,
  dragCreature,
  dragFrame,
  showNewTeam,
  newTeamBox,
  slackChannels,
  joinableChannels,
  toWorld,
  onStartDragFrame,
  onStartDragCreature,
  onSelectCreature,
  onOpenWaiting,
  onAddToTeam,
  onFlyToBox,
  onOpenTeam,
  onOpenCreature,
  onResizeNewTeamBox,
  onCreatedNewTeam,
  onCancelNewTeam,
}: {
  notes?: ReactNode;
  ws: string;
  tx: number;
  ty: number;
  s: number;
  anim: boolean;
  overview: boolean;
  teams: CanvasTeam[];
  agentsById: Map<string, CanvasAgent>;
  placedCreatures: PlacedCreature[];
  crossTeamLinks: string[];
  selAgentId: string | null;
  waiting: WaitingItem[];
  dragCreature: DragCreatureState | null;
  dragFrame: DragFrameState | null;
  showNewTeam: boolean;
  newTeamBox: CanvasBox;
  slackChannels: SlackChannelOption[];
  joinableChannels: { id: string; name: string }[];
  toWorld: (clientX: number, clientY: number) => { x: number; y: number };
  onStartDragFrame: (state: DragFrameState) => void;
  onStartDragCreature: (state: DragCreatureState) => void;
  onSelectCreature: (agentId: string, teamId: string) => void;
  onOpenWaiting: (item: WaitingItem) => void;
  onAddToTeam: (channelId: string) => void;
  onFlyToBox: (box: CanvasBox, scale?: number) => void;
  onOpenTeam: (channelId: string) => void;
  onOpenCreature: (agentId: string) => void;
  onResizeNewTeamBox: (box: CanvasBox) => void;
  onCreatedNewTeam: (channelId: string, box: CanvasBox) => void;
  onCancelNewTeam: () => void;
}) {
  return (
    <div
      data-world
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 4000,
        height: 3000,
        transformOrigin: '0 0',
        transform: `translate(${tx}px, ${ty}px) scale(${s})`,
        transition: anim ? 'transform 0.45s cubic-bezier(0.2, 0.7, 0.2, 1)' : 'none',
      }}
    >
      <svg
        width="4000"
        height="3000"
        viewBox="0 0 4000 3000"
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        aria-hidden="true"
      >
        {crossTeamLinks.map((d, idx) => (
          <path
            key={`cross-${idx}`}
            d={d}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={3}
            strokeDasharray="10 10"
            opacity={0.55}
          />
        ))}
      </svg>

      {/* Team frames */}
      {teams.map((t, i) => {
        const tint = TINTS[i % TINTS.length]!;
        const memberObjs = t.members.map((id) => agentsById.get(id)).filter((a): a is CanvasAgent => Boolean(a));
        const botMembers = memberObjs.filter((a) => a.kind !== 'human');
        const peopleCount = memberObjs.length - botMembers.length;
        const displayMembers = [...memberObjs].sort((a, b) => Number(a.kind === 'human') - Number(b.kind === 'human'));
        const busy = botMembers.filter((a) => workingIn(a.status, t.channelId));
        const idle = botMembers.filter((a) => !workingIn(a.status, t.channelId));
        const workingCount = busy.length;
        const readyCount = idle.filter((a) => a.presence.state === 'listening').length;
        const asleepCount = idle.filter((a) => a.presence.state === 'wakes').length;
        const awayCount = idle.filter((a) => a.presence.state === 'quiet').length;
        const parts: string[] = [];
        if (workingCount) parts.push(`${workingCount} working`);
        if (readyCount) parts.push(`${readyCount} ready`);
        if (asleepCount) parts.push(`${asleepCount} asleep`);
        if (awayCount) parts.push(`${awayCount} away`);
        if (peopleCount) parts.push(plural(peopleCount, 'person', 'people'));
        if (parts.length === 0) {
          parts.push(memberObjs.length ? plural(memberObjs.length, 'member', 'members') : 'empty');
        }
        const summary = parts.join(' · ');

        const selHere = Boolean(selAgentId && t.members.includes(selAgentId));
        const opacity = !selAgentId || selHere || !overview ? 1 : 0.28;
        const needs = t.needsYou > 0;

        return (
          <section
            key={t.channelId}
            data-team={t.channelId}
            role="button"
            tabIndex={0}
            aria-label={`${t.name} (${summary}${needs ? `, ${t.needsYou} needs you` : ''})`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              onStartDragFrame({
                channelId: t.channelId,
                mode: 'move',
                sx: e.clientX,
                sy: e.clientY,
                box0: t.canvas,
                moved: false,
              });
            }}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest('a, button')) return;
              e.stopPropagation();
              onOpenTeam(t.channelId);
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onFlyToBox(t.canvas, 1.05);
              }
            }}
            className={
              needs && overview
                ? 'canvas-breathe cursor-grab outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] active:cursor-grabbing'
                : 'cursor-grab outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] active:cursor-grabbing'
            }
            style={{
              position: 'absolute',
              left: t.canvas.x,
              top: t.canvas.y,
              width: t.canvas.w,
              height: frameHeight(t.canvas, memberObjs.length),
              boxSizing: 'border-box',
              borderRadius: 40,
              background: `rgb(${hexRgb(tint).replaceAll(',', ' ')} / var(--tint-alpha))`,
              border: needs ? '4px solid var(--accent)' : selHere ? '4px solid #a5a0e6' : `2px solid ${tint}`,
              opacity,
              transition: 'opacity 0.2s',
            }}
          >
            {overview ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col gap-5.5 p-11">
                <div className="flex items-center gap-4">
                  <span className="truncate leading-tight font-bold tracking-tight" style={{ fontSize: Math.max(52, 15 / s) }}>
                    {t.name}
                  </span>
                  {needs && (
                    <span className="relative inline-flex size-18 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white">
                      <Icon name="bell" size={38} className="canvas-ring" />
                      <span className="absolute -top-1.5 -right-1.5 inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-[#e5484d] px-2 text-[20px] leading-none font-bold text-white ring-4 ring-white">
                        {t.needsYou > 9 ? '9+' : t.needsYou}
                      </span>
                    </span>
                  )}
                </div>
                {(() => {
                  const extra = displayMembers.length - 8;
                  const ml = -cardAvatarOverlap(t.canvas.w, Math.min(displayMembers.length, 8) + (extra > 0 ? 1 : 0));
                  return (
                    <div className="flex pl-2.5">
                      {displayMembers.slice(0, 8).map((m, i) => {
                        const p = presenceLabel(m.presence);
                        return (
                          <div
                            key={m.id}
                            style={{ filter: p.stale ? 'saturate(0.35)' : 'none', marginLeft: i ? ml : 0 }}
                            className="shrink-0 rounded-full border-[5px] border-white bg-[var(--surface)]"
                          >
                            <Avatar who={m} className="size-24" />
                          </div>
                        );
                      })}
                      {extra > 0 && (
                        <div
                          style={{ marginLeft: ml }}
                          className="flex size-[106px] shrink-0 items-center justify-center rounded-full border-[5px] border-white bg-[var(--subtle)] text-[34px] font-bold text-[var(--fg-soft)]"
                        >
                          +{extra}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <span className="truncate text-[var(--fg-soft)]" style={{ fontSize: Math.max(30, 12 / s) }}>
                  {summary}
                </span>
              </div>
            ) : (
              <>
                <div className="absolute top-6 right-7.5 left-7.5 flex items-center gap-2.5">
                  <span className="truncate text-2xl font-bold">{t.name}</span>
                  {t.slackUrl ? (
                    <a
                      href={t.slackUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t.slackPaused ? 'Its Slack channel is archived: nothing syncs until it is back' : 'Open in Slack'}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--surface)] px-2.5 py-0.5 text-[13px] text-[var(--fg-soft)] hover:text-[var(--accent)]"
                    >
                      <SlackLogo size={13} />
                      {t.slackPaused ? 'Slack · archived' : 'Slack'}
                      <span aria-hidden="true">↗</span>
                    </a>
                  ) : (
                    t.slack && <span className="shrink-0 rounded-full bg-[var(--surface)] px-2.5 py-0.5 text-[13px] text-[var(--fg-soft)]">Slack</span>
                  )}
                  {needs && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        const w = waiting.find((x) => x.channelId === t.channelId);
                        if (w) onOpenWaiting(w);
                      }}
                      aria-label={`${t.needsYou} ${t.needsYou === 1 ? 'needs' : 'need'} you`}
                      title="Needs you"
                      className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                    >
                      <Icon name="bell" size={17} className="canvas-ring" />
                      <span className="absolute -top-1 -right-1 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-[#e5484d] px-1 text-[11px] leading-none font-bold text-white ring-2 ring-white">
                        {t.needsYou > 9 ? '9+' : t.needsYou}
                      </span>
                    </button>
                  )}
                  <div onPointerDown={(e) => e.stopPropagation()} className="ml-auto flex items-center gap-0.5 rounded-xl bg-[var(--surface)] p-1 shadow-[0_2px_8px_rgba(23,22,28,0.06)]">
                    <Tip label="Open the conversation">
                      <Link
                        href={channelHref(ws, t.channelId)}
                        scroll={false}
                        aria-label={`Open the ${t.name} conversation`}
                        className="inline-flex size-8 items-center justify-center rounded-[9px] bg-[var(--fg)] text-[var(--bg)] hover:opacity-90"
                      >
                        <Icon name="chat" size={16} />
                      </Link>
                    </Tip>
                    <Tip label="Add member">
                      <button
                        type="button"
                        onClick={() => onAddToTeam(t.channelId)}
                        aria-label={`Add member to ${t.name}`}
                        className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[9px] text-[var(--fg)] hover:bg-[var(--subtle)]"
                      >
                        <Icon name="person-plus" size={16} />
                      </button>
                    </Tip>
                    <Tip label="Team settings" align="end">
                      <Link
                        href={channelHref(ws, t.channelId, { panel: 'channel', from: 'canvas' })}
                        aria-label={`${t.name} settings`}
                        className="inline-flex size-8 items-center justify-center rounded-[9px] text-[var(--fg)] hover:bg-[var(--subtle)]"
                      >
                        <Icon name="more" size={16} />
                      </Link>
                    </Tip>
                  </div>
                </div>
                <div className="pointer-events-none absolute right-7.5 bottom-5 left-7.5 flex items-center text-xs text-[var(--muted)]">
                  <span>{summary}</span>
                </div>
                <button
                  type="button"
                  aria-label={`Resize ${t.name}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartDragFrame({
                      channelId: t.channelId,
                      mode: 'resize',
                      sx: e.clientX,
                      sy: e.clientY,
                      box0: { ...t.canvas, h: frameHeight(t.canvas, memberObjs.length) },
                      moved: false,
                    });
                  }}
                  className="absolute right-2 bottom-2 size-4 cursor-nwse-resize rounded-sm border-r-2 border-b-2 border-[var(--muted)]/50"
                />
              </>
            )}
          </section>
        );
      })}

      {/* Placed creatures inside teams (detail view) */}
      {!overview &&
        placedCreatures.map((p) => {
          const a = p.agent;
          const pres = presenceLabel(a.presence);
          const dragging = Boolean(dragCreature && dragCreature.pid === p.pid && dragCreature.moved);
          const frameMoving = Boolean(dragFrame && dragFrame.channelId === p.team.channelId && dragFrame.moved);
          const selected = selAgentId === a.id;
          const badgeText = p.role ?? '';

          const statusIsStale = !workingIn(a.status, p.team.channelId);
          const isAskingHere = Boolean(p.waitingItem);
          const ariaDesc = `${a.name}, in ${p.team.name}, ${pres.text}${
            isAskingHere ? `, asks you: ${p.waitingItem!.text}` : a.status && !statusIsStale ? `, working on: ${a.status.text}` : a.status ? ', idle' : ''
          }`;

          return (
            <div
              key={p.pid}
              data-agent={a.id}
              data-team={p.team.channelId}
              role="button"
              tabIndex={0}
              aria-label={ariaDesc}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const w = toWorld(e.clientX, e.clientY);
                onStartDragCreature({
                  pid: p.pid,
                  agentId: a.id,
                  fromTeamId: p.team.channelId,
                  dx: w.x - p.x,
                  dy: w.y - p.y,
                  sx: e.clientX,
                  sy: e.clientY,
                  ox: p.x,
                  oy: p.y,
                  x: p.x,
                  y: p.y,
                  moved: false,
                });
              }}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('a, button')) return;
                e.stopPropagation();
                onOpenCreature(a.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  if (p.waitingItem) onOpenWaiting(p.waitingItem);
                  else onSelectCreature(a.id, p.team.channelId);
                }
              }}
              style={{
                position: 'absolute',
                left: p.x,
                top: p.y,
                width: 132,
                zIndex: dragging ? 50 : selected || isAskingHere ? 20 : 2,
                transition: dragging || frameMoving ? 'none' : 'left 0.25s ease, top 0.25s ease',
              }}
              className="flex cursor-grab flex-col items-center gap-1.5 outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] active:cursor-grabbing"
            >
              {isAskingHere ? (
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenWaiting(p.waitingItem!);
                  }}
                  className="max-w-[165px] rounded-xl bg-[var(--accent)] px-2.5 py-1.5 text-center text-xs leading-snug text-white shadow-[0_6px_16px_rgba(67,56,202,0.3)]"
                >
                  <span className="line-clamp-2 font-medium">Asks you: {p.waitingItem!.text}</span>
                  <span className="block text-[11px] opacity-80">{shortTime(p.waitingItem!.at)} · click to answer</span>
                </button>
              ) : a.status ? (
                <div
                  style={{ opacity: statusIsStale ? 0.72 : 1 }}
                  className="max-w-[160px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-center text-xs leading-snug shadow-[0_6px_16px_rgba(23,22,28,0.08)]"
                >
                  <span className={`line-clamp-2 ${statusIsStale ? 'text-[var(--muted)]' : ''}`}>{statusIsStale ? 'Idle' : a.status.text}</span>
                  <span className="block text-[11px] text-[var(--muted)]">{statusIsStale ? `last seen ${shortTime(a.status.at)}` : shortTime(a.status.at)}</span>
                </div>
              ) : null}
              <div className={a.presence.state === 'listening' && !dragging ? 'canvas-bob relative' : 'relative'}>
                <div
                  style={{
                    boxShadow:
                      selected || isAskingHere
                        ? '0 0 0 4px var(--accent)'
                        : dragging
                          ? '0 14px 30px rgba(23,22,28,0.25)'
                          : '0 2px 6px rgba(23,22,28,0.08)',
                    filter: pres.stale ? 'saturate(0.35) opacity(0.75)' : 'none',
                  }}
                  className={`rounded-full border-4 border-white bg-[var(--surface)] ${isAskingHere ? 'canvas-breathe' : ''}`}
                >
                  <Avatar who={a} className="size-19.5" />
                </div>
              </div>

              <span className="max-w-[140px] truncate text-sm font-semibold">{a.name}</span>
              {badgeText && (
                <span className="-mt-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] text-[var(--accent-ink)]">
                  {badgeText}
                </span>
              )}
            </div>
          );
        })}

      {notes}
      {/* Screen 5: New team frame on the canvas */}
      {showNewTeam && (
        <NewTeamDialog
          ws={ws}
          box={newTeamBox}
          scale={s}
          slackChannels={slackChannels}
          joinableChannels={joinableChannels}
          onResizeBox={onResizeNewTeamBox}
          onCreated={onCreatedNewTeam}
          onCancel={onCancelNewTeam}
        />
      )}
    </div>
  );
}

/** Top floating bar (where you are, search, actions) and bottom view controls (fit, tidy, zoom). */
export function CanvasChrome({
  ws,
  workspaceName,
  shareUrl,
  me,
  billing,
  workspaces,
  logout,
  botAgentsCount,
  workspaceOwner,
  attentionCount,
  focusedTeamName,
  selAgentName,
  showNewTeam,
  cards,
  showBench,
  overview,
  s,
  onFitAll,
  onSwitchLayout,
  onToggleBench,
  onNewTeam,
  onNewNote,
  onTidyUp,
  onZoomIn,
  onZoomOut,
}: {
  ws: string;
  workspaceName: string;
  /** A public workspace's shareable link (/p/w/<ws>); shown as a copy icon. */
  shareUrl?: string;
  me: { id: string; name: string; avatar?: string; kind?: string; admin?: boolean; hire?: boolean };
  billing?: { plan: 'free' | 'pro' | 'team' | 'enterprise'; leftUsd: number; used: number };
  workspaces: MenuWorkspace[];
  logout: () => Promise<void>;
  botAgentsCount: number;
  /** Owners also get Developer apps (API keys). */
  workspaceOwner?: boolean;
  attentionCount: number;
  focusedTeamName?: string;
  selAgentName?: string;
  showNewTeam: boolean;
  cards: boolean;
  showBench: boolean;
  overview: boolean;
  s: number;
  onFitAll: () => void;
  onSwitchLayout: () => void;
  onToggleBench: () => void;
  onNewTeam: () => void;
  onNewNote?: () => void;
  onTidyUp: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  const menuRow = 'flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-[var(--subtle)]';
  return (
    <>
      <header onPointerDown={(e) => e.stopPropagation()} aria-label="Workspace navigation" className="pointer-events-none absolute top-3.5 right-2.5 left-2.5 z-20 grid grid-cols-[minmax(0,1fr)_44px_auto] items-start gap-3 sm:right-4 sm:left-4 sm:grid-cols-[minmax(0,1fr)_100px_minmax(0,1fr)]">
        <div className="pointer-events-auto flex min-w-0 max-w-full items-center justify-self-start rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_4px_14px_rgba(23,22,28,0.06)]">
          <div className="shrink-0"><AccountMenu me={me} logout={logout} billing={billing} /></div>
          {/* Sets the avatar apart as its own menu, not part of the workspace picker. */}
          <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-[var(--border)]" />
          <WorkspaceMenu ws={ws} workspaceName={workspaceName} workspaces={workspaces} />
        </div>
        <button type="button" onClick={openPalette} data-tour="search" title="Search or jump (⌘K)" aria-label={`Search or jump (⌘K)${attentionCount ? `, ${attentionCount} needs you` : ''}`} className="pointer-events-auto relative flex size-11 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--muted)] shadow-[0_4px_14px_rgba(23,22,28,0.06)] hover:bg-[var(--subtle)] sm:w-full sm:gap-2">
          <Icon name="search" size={22} className="shrink-0" />
          <kbd className="hidden font-sans text-xs sm:inline">⌘K</kbd>
          {attentionCount > 0 && <span data-attention-count aria-hidden="true" className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--bad-fg)] px-1.5 text-[10px] font-semibold text-white">{attentionCount > 9 ? '9+' : attentionCount}</span>}
        </button>
        <div className="pointer-events-auto flex min-w-0 max-w-full items-center gap-1 justify-self-end rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_4px_14px_rgba(23,22,28,0.06)]">
          {shareUrl && <CopyButton value={shareUrl} label="Copy party link" icon="share" />}
          <Link href={`${wsHref(ws)}/connect`} scroll={false} data-tour="hire" title="Add an agent" aria-label="Add an agent" className="flex size-9 items-center justify-center rounded-[9px] bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"><Icon name="plus" size={17} /></Link>
          <CanvasMenu label="Canvas actions" end summary={<Icon name="menu" size={18} />}>
            <Link href={appsHref(ws)} scroll={false} data-tour="apps" className={menuRow}><Icon name="plug" size={16} />Connected apps</Link>
            <Link href={skillsHref(ws)} scroll={false} className={menuRow}><Icon name="book" size={16} />Skills & processes</Link>
            <Link href={triggersHref(ws)} scroll={false} className={menuRow}><Icon name="bolt" size={16} />Triggers</Link>
            {workspaceOwner && <Link href={devAppsHref(ws)} scroll={false} className={menuRow}><Icon name="settings" size={16} />Developer apps</Link>}
            <div className="my-1.5 border-t border-[var(--border)]" />
            <div className="px-2.5 py-2 text-xs font-semibold text-[var(--muted)]">New</div>
            <button type="button" onClick={onNewTeam} data-tour="new-team" className={menuRow}><Icon name="frame-plus" size={17} />New team / channel</button>
            {onNewNote && <button type="button" onClick={onNewNote} className={menuRow}><Icon name="plus" size={17} />Add note</button>}
            <div className="my-1.5 border-t border-[var(--border)]" />
            <button type="button" onClick={onToggleBench} aria-pressed={showBench} className={menuRow}><Icon name="people" size={16} />Bench ({botAgentsCount})</button>
            <button type="button" onClick={onSwitchLayout} className={menuRow}><Icon name="grid" size={16} />{cards ? 'Show the canvas' : 'Show as cards'}</button>
          </CanvasMenu>
        </div>
      </header>
      {focusedTeamName && <button type="button" onClick={onFitAll} className="absolute top-17 left-4 z-10 max-w-[calc(100%-32px)] truncate rounded-lg bg-[var(--surface)] px-2 py-1 text-xs text-[var(--muted)]">All teams / {focusedTeamName}{selAgentName ? ` / ${selAgentName}` : ''}</button>}
      {showNewTeam && <div role="status" className="absolute top-17 right-4 z-10 hidden rounded-xl bg-[var(--fg)] px-3 py-2 text-sm text-[var(--bg)] md:block">Drawing a team · drag to size it · Esc to cancel</div>}
      {billing && (billing.plan === 'free' || billing.used >= 0.8) && !showNewTeam && <Link href="/billing" role="status" className="absolute top-17 right-4 z-10 max-w-[calc(100%-32px)] rounded-xl bg-[var(--accent-soft)] px-3 py-2 text-xs text-[var(--accent-ink)] sm:text-sm">{billing.used >= 1 ? 'Out of credits: cloud agents, apps and triggers are paused' : `${credits(billing.leftUsd)} credits left this month`} · {billing.plan === 'free' ? 'Upgrade to Pro' : 'Top up'}</Link>}
      <div className="pointer-events-none absolute bottom-4 left-4 z-20 hidden rounded-[10px] bg-[var(--surface)]/85 px-3 py-2 text-xs text-[var(--muted)] sm:block">
        {overview
          ? 'Scroll or pinch to zoom · drag to pan · click a team to fly in, double-click to open its chat'
          : 'Drag a creature onto another team to add it · click one to see all its teams'}
      </div>

      <div
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute right-4 bottom-4 z-20 items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_4px_14px_rgba(23,22,28,0.06)] ${cards ? 'hidden' : 'flex'}`}
      >
        <Tip label="Fit canvas" side="top">
          <button
            type="button"
            aria-label="Fit canvas"
            onClick={onFitAll}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[9px] text-[var(--fg)] hover:bg-[var(--subtle)]"
          >
            <Icon name="fit" size={16} />
          </button>
        </Tip>
        <Tip label="Tidy up: arrange the teams in rows" side="top">
          <button
            type="button"
            aria-label="Tidy up: arrange the teams in rows, none overlapping"
            onClick={onTidyUp}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[9px] text-[var(--fg)] hover:bg-[var(--subtle)]"
          >
            <Icon name="tidy" size={16} />
          </button>
        </Tip>
        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-[var(--border)]" />
        <Tip label="Zoom out" side="top">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={onZoomOut}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[9px] text-[var(--fg)] hover:bg-[var(--subtle)]"
          >
            <Icon name="minus" size={16} />
          </button>
        </Tip>
        <span className="w-10 text-center font-mono text-[12px] text-[var(--fg-soft)]">{Math.round(s * 100)}%</span>
        <Tip label="Zoom in" side="top" align="end">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={onZoomIn}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[9px] text-[var(--fg)] hover:bg-[var(--subtle)]"
          >
            <Icon name="plus" size={16} />
          </button>
        </Tip>
      </div>
    </>
  );
}

