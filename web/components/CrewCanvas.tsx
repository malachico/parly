'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createPortal } from 'react-dom';
import { AgentDayDrawer, NeedsYouPopover, SelectedAgentCard } from '@/components/CanvasPanels';
import { Activity, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { attentionCount, attentionGroups, liveConversations, markDestinationRead, type CanvasConversation } from '@/lib/attention';
import { AddToTeam, BenchDrawer, ConfirmTeamMemberDialog, EmptyCanvasCard, type PendingAction } from '@/components/CanvasModals';
import type { AvatarOf } from '@/components/Avatar';
import { CanvasNoteCard, NoteEditor } from '@/components/CanvasNotes';
import { deleteCanvasNote, saveCanvasNote } from '@/lib/actions/canvas';
import { CanvasCards } from '@/components/CanvasCards';
import { CanvasChrome, CanvasWorld, type DragCreatureState, type DragFrameState } from '@/components/CanvasWorld';
import { canvasMembershipChange, saveChannelCanvas } from '@/lib/actions';
import { frameHeight, tidyLayout } from '@/lib/canvasLayout';
import type {
  CanvasNote,
  CanvasAgent,
  CanvasBox,
  CanvasTeam,
  CanvasView,
  SlackChannelOption,
  WaitingItem,
} from '@/lib/hub';
import { CommandPalette, type PaletteItem } from '@/components/CommandPalette';
import type { MenuWorkspace } from '@/components/AccountMenu';
import { notifyPanelNav } from '@/components/PanelSlot';
import { panelClosing, panelCoversCanvas, subscribePanelClosing } from '@/lib/panelClosing';
import { agentHref, channelHref, chatHref, dmHref, wsHref } from '@/lib/routes';
import {
  buildCrossTeamLinks,
  buildPlacedCreatures,
  bounds,
  byRecent,
  joinBoxes,
  clampScale,
  findTeamAt,
  hasFrameMoved,
  type UndoAction,
} from '@/components/crew-canvas/helpers';
import { buildContextMenuItems, buildPaletteItems, type CanvasContextMenu } from '@/components/crew-canvas/palette';

// Local state that resets whenever the server sends a new value. Adjusting during render
// (instead of an effect) skips one stale render; a `key` would remount and lose zoom/selection.
function useServerState<T>(server: T) {
  const [state, setState] = useState(server);
  const [seen, setSeen] = useState(server);
  if (seen !== server) {
    setSeen(server);
    setState(server);
  }
  return [state, setState] as const;
}

// The two route readers below are their own components so a panel navigation re-renders them, not the whole canvas.

// "(N) Parly" in the tab while anything needs you; re-applied after a navigation sets the page's own title.
function NeedsYouTitle({ count }: { count: number }) {
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, the page title changes with it.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [count, pathname]);
  return null;
}

// Below md the panel is full width (PanelSlot), so the canvas behind it is invisible: hide it. Activity keeps its state and DOM.
const phoneQuery = '(max-width: 767.98px)';
const subscribePhone = (onChange: () => void) => {
  const mq = window.matchMedia(phoneQuery);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
};
function HiddenBehindPanel({ ws, children }: { ws: string; children: ReactNode }) {
  const path = usePathname();
  const params = useSearchParams();
  const phone = useSyncExternalStore(subscribePhone, () => window.matchMedia(phoneQuery).matches, () => false);
  const closing = useSyncExternalStore(subscribePanelClosing, panelClosing, () => false);
  const covered = phone && panelCoversCanvas(ws, path, params.get('panel'), closing);
  return <Activity mode={covered ? 'hidden' : 'visible'}>{children}</Activity>;
}

export function CrewCanvas({
  ws,
  workspaceName,
  shareUrl,
  me,
  billing,
  workspaces,
  conversations: serverConversations,
  logout,
  initialCanvas,
  initialNotes,
  notesError,
  canUseNotes,
  guest = false,
  workspaceOwner,
  initialWaiting,
  allWorkspaceAgents,
  slackChannels,
  joinableChannels,
}: {
  ws: string;
  workspaceName: string;
  shareUrl?: string;
  me: { id: string; name: string; avatar?: string; kind?: string; admin?: boolean; hire?: boolean; graph?: boolean };
  /** Your plan and credits left, always in sight: Free shows Upgrade. */
  billing?: { plan: 'free' | 'pro' | 'team'; leftUsd?: number; used: number; billedTo?: { name: string; owner?: boolean }; blockedBy?: 'budget' | 'credits' };
  workspaces: MenuWorkspace[];
  conversations: CanvasConversation[];
  logout: () => Promise<void>;
  initialCanvas: CanvasView;
  initialNotes: CanvasNote[];
  notesError?: string;
  canUseNotes: boolean;
  /** A showcase guest: its agents talk only at the tables, so no DMs to them and no team management. */
  guest?: boolean;
  workspaceOwner: boolean;
  initialWaiting: WaitingItem[];
  allWorkspaceAgents: CanvasAgent[];
  slackChannels: SlackChannelOption[];
  joinableChannels: { id: string; name: string }[];
}) {
  const router = useRouter();
  // Live messages and reads re-read the counts from the hub; a fresh server list replaces them.
  const [conversations, setConversations] = useServerState(serverConversations);
  useEffect(() => liveConversations(ws, me.id, setConversations), [ws, me.id, setConversations]);
  const [notes, setNotes] = useServerState(initialNotes);
  const addNoteRef = useRef<() => void>(() => {});
  const [noteEditor, setNoteEditor] = useState<{ note?: CanvasNote; canvas: CanvasBox } | null>(null);
  const saveNote = (note: CanvasNote) => {
    setNotes((current) => [...current.filter((item) => item.id !== note.id), note]);
    setNoteEditor(null);
  };

  const vpRef = useRef<HTMLDivElement | null>(null);
  const panLive = useRef<{ tx: number; ty: number } | null>(null);
  // The team centered mid-pan (null: none; undefined: not panning), so the "All teams / …" crumb follows the drag.
  const [panTeam, setPanTeam] = useState<CanvasTeam | null | undefined>();
  // Match the server during hydration; restore the phone/default preference before painting.
  const [cards, setCards] = useState(false);
  useLayoutEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('parly.canvas.layout');
    } catch {}
    // Mobile is cards regardless of any saved preference (which is desktop-only), so a stale 'canvas' choice can't strand a phone on the canvas.
    setCards(window.innerWidth < 640 ? true : saved === 'cards');
  }, []);
  const switchLayout = () =>
    setCards((c) => {
      try {
        localStorage.setItem('parly.canvas.layout', c ? 'canvas' : 'cards');
      } catch {}
      return !c;
    });
  const [, startTransition] = useTransition();

  const [teams, setTeams] = useServerState<CanvasTeam[]>(initialCanvas.teams);
  const [waiting, setWaiting] = useServerState<WaitingItem[]>(initialWaiting);

  // Combine agents from canvas + any unplaced workspace bots for the Bench.
  const agentsById = useMemo(() => {
    const map = new Map<string, CanvasAgent>();
    for (const a of allWorkspaceAgents) map.set(a.id, a);
    for (const a of initialCanvas.agents) map.set(a.id, a);
    // Keep each agent's teams list synced with current `teams` state.
    for (const [id, a] of map) {
      const inTeams = teams.filter((t) => t.members.includes(id)).map((t) => t.channelId);
      map.set(id, { ...a, teams: inTeams });
    }
    return map;
  }, [allWorkspaceAgents, initialCanvas.agents, teams]);

  const botAgents = useMemo(
    () => [...agentsById.values()].filter((a) => a.kind !== 'human'),
    [agentsById],
  );

  // Owned agents outside this workspace can join through the same membership action.
  const memberAgents = useMemo(() => {
    const map = new Map<string, AvatarOf & { name: string }>(agentsById);
    for (const a of initialCanvas.elsewhere ?? []) if (!map.has(a.id)) map.set(a.id, a);
    return map;
  }, [agentsById, initialCanvas.elsewhere]);
  const addableMembers = [...memberAgents.values()].filter((a) => a.id !== me.id);
  const hasAgents = [...memberAgents.values()].some((a) => a.kind !== 'human');

  // Initial camera: overview (<0.62) when 5+ teams, detail when 1-4 teams so creatures show right away.
  const initialScale = initialCanvas.teams.length > 4 ? 0.46 : 0.85;
  const [tx, setTx] = useState(initialCanvas.teams.length > 4 ? 120 : 60);
  const [ty, setTy] = useState(initialCanvas.teams.length > 4 ? 110 : 75);
  const [s, setS] = useState(initialScale);
  const [anim, setAnim] = useState(false);

  const [selAgentId, setSelAgentId] = useState<string | null>(null);
  const [selTeamId, setSelTeamId] = useState<string | null>(null);
  const [openDayAgentId, setOpenDayAgentId] = useState<string | null>(null);
  const [activeWaiting, setActiveWaiting] = useState<WaitingItem | null>(null);
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeamBox, setNewTeamBox] = useState<CanvasBox>({ x: 520, y: 150, w: 520, h: 420 });
  const [showBench, setShowBench] = useState(false);
  // A team's "Add an agent": pick one for that team (by name), or make a new one for it.
  const [addTo, setAddTo] = useState<string | null>(null);
  // Navigates to a panel route over the canvas and informs `PanelSlot` immediately so it can un-hide (`reopen`),
  // swap stale `children` for a skeleton (`replace`), or hide on close without waiting for the server round-trip.
  const pushPanel = (href: string, opts?: { scroll?: boolean }) => {
    notifyPanelNav(href);
    router.push(href, opts);
  };
  // The + and "Connect an agent": the one Connect, as a panel over the canvas.
  const connectAgent = () => pushPanel(`${wsHref(ws)}/connect`, { scroll: false });
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [dropRole, setDropRole] = useState('');
  const [undoToast, setUndoToast] = useState<UndoAction | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dragging state: either panning the viewport, dragging a creature, or moving/resizing a team frame.
  const [pan, setPan] = useState<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const [dragCreature, setDragCreature] = useState<DragCreatureState | null>(null);
  const [dragFrame, setDragFrame] = useState<DragFrameState | null>(null);

  // Touch pinch-zoom tracking for mobile (iPhone Safari / Chrome).
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; s0: number; cx: number; cy: number; tx0: number; ty0: number } | null>(null);

  const showToast = (action: UndoAction) => {
    setUndoToast(action);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setUndoToast(null), 7000);
  };

  const vpRect = () =>
    vpRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1200, height: 800 };

  const toWorld = (clientX: number, clientY: number) => {
    const r = vpRect();
    return {
      x: (clientX - r.left - tx) / s,
      y: (clientY - r.top - ty) / s,
    };
  };

  const animateTo = (next: { s: number; tx: number; ty: number }) => {
    setAnim(true);
    setS(next.s);
    setTx(next.tx);
    setTy(next.ty);
    setTimeout(() => setAnim(false), 460);
  };

  const flyToBox = (box: CanvasBox, targetScale = 1.05) => {
    const r = vpRect();
    animateTo({
      s: targetScale,
      tx: r.width / 2 - (box.x + box.w / 2) * targetScale,
      ty: r.height / 2 - (box.y + box.h / 2) * targetScale,
    });
  };

  // First run with channels to join: the welcome panel sits at the top and the Join cards, all in view, below it.
  const onboardingRef = useRef<HTMLDivElement | null>(null);
  const joinCardsView = () => {
    const r = vpRect();
    const panel = onboardingRef.current?.firstElementChild?.getBoundingClientRect();
    const top = (panel ? panel.bottom - r.top : 320) + 24;
    const { minX, minY, maxX, maxY } = bounds(joinBoxes([], joinableChannels));
    const fit = Math.max(0.12, Math.min(0.85, (r.width - 48) / (maxX - minX), (r.height - top - 72) / (maxY - minY)));
    return { s: fit, tx: (r.width - (maxX - minX) * fit) / 2 - minX * fit, ty: top - minY * fit };
  };
  // A ref callback, not the arrival effect: the panel can hydrate after it (it sits under a Suspense boundary).
  const joinPlaced = useRef(false);
  const placeJoinCards = (el: HTMLDivElement | null) => {
    onboardingRef.current = el;
    if (!el || joinPlaced.current || !firstRunJoin()) return;
    joinPlaced.current = true;
    const v = joinCardsView();
    setS(v.s);
    setTx(v.tx);
    setTy(v.ty);
  };
  const firstRunJoin = () => !guest && teams.length === 0 && notes.length === 0 && joinableChannels.length > 0;

  const fitAll = (list: CanvasTeam[] = teams) => {
    if (list.length === 0 && firstRunJoin()) {
      animateTo(joinCardsView());
      return;
    }
    const items = [...list, ...notes, ...joinBoxes(list, guest ? [] : joinableChannels)];
    if (items.length === 0) {
      animateTo({ s: 0.85, tx: 80, ty: 80 });
      return;
    }
    const r = vpRect();
    const { minX, minY, maxX, maxY } = bounds(items);
    const bw = Math.max(600, maxX - minX + 160);
    const bh = Math.max(450, maxY - minY + 180);
    // Every team in view, even on a phone (its words are kept readable below).
    const fitScale = Math.max(0.12, Math.min(0.58, Math.min(r.width / bw, (r.height - 80) / bh)));
    animateTo({
      s: fitScale,
      tx: r.width / 2 - ((minX + maxX) / 2) * fitScale,
      ty: (r.height + 40) / 2 - ((minY + maxY) / 2) * fitScale,
    });
  };

  // The view (zoom and where it looks) stays as you left it, per workspace, in this browser.
  const viewKey = `parly.canvas.view.${ws}`;
  const viewRestored = useRef(false);
  useEffect(() => {
    if (!viewRestored.current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(viewKey, JSON.stringify({ tx, ty, s }));
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [tx, ty, s, viewKey]);

  // First view: the one you left; else every team in sight, as close as that allows, but never below the detail
  // threshold for a few teams.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on arrival to set the initial camera; re-running on viewKey/teams/notes/vpRect would keep snapping the view back and fight the user's panning
  useEffect(() => {
    viewRestored.current = true;
    try {
      const v = JSON.parse(localStorage.getItem(viewKey) ?? 'null') as { tx: number; ty: number; s: number } | null;
      // A saved view that shows no team at all isn't restored (it looked like an empty workspace).
      const r0 = vpRect();
      const showsATeam = (w: { tx: number; ty: number; s: number }) =>
        [...initialCanvas.teams, ...initialNotes].length === 0 ||
        [...initialCanvas.teams, ...initialNotes].some((t) => {
          const x = w.tx + t.canvas.x * w.s;
          const y = w.ty + t.canvas.y * w.s;
          return x < r0.width && y < r0.height && x + t.canvas.w * w.s > 0 && y + t.canvas.h * w.s > 0;
        });
      if (v && [v.tx, v.ty, v.s].every(Number.isFinite) && clampScale(v.s) === v.s && showsATeam(v) && !firstRunJoin()) {
        setS(v.s);
        setTx(v.tx);
        setTy(v.ty);
        return;
      }
    } catch {}
    const ts = [...initialCanvas.teams, ...initialNotes];
    if (ts.length === 0) return; // first run with Join cards: placed once the welcome panel mounts (placeJoinCards)
    const r = vpRect();
    const { minX, minY, maxX, maxY } = bounds(ts);
    const fit = Math.min((r.width - 48) / (maxX - minX), (r.height - 120) / (maxY - minY));
    const s1 = ts.length > 4 ? Math.max(0.28, Math.min(0.58, fit)) : Math.max(0.62, Math.min(0.9, fit));
    setS(s1);
    setTx(Math.max(24, (r.width - (maxX - minX) * s1) / 2) - minX * s1);
    setTy(84 - minY * s1);
    // once, on arrival
  }, []);

  // Zooms about a point (the cursor, or the middle): computed once from the current view. (Setting the pan inside
  // the zoom's state updater applied it twice where React re-runs updaters, and the view drifted off the teams.)
  const view = useRef({ s, tx, ty });
  view.current = { s, tx, ty };
  const joinFrames = useMemo(() => (cards || guest ? [] : joinBoxes(teams, joinableChannels)), [cards, guest, teams, joinableChannels]);
  const zoomAt = (factor: number, px: number, py: number, from = view.current) => {
    const { s: s0, tx: tx0, ty: ty0 } = from;
    const s1 = clampScale(s0 * factor);
    const next = { s: s1, tx: px - (px - tx0) * (s1 / s0), ty: py - (py - ty0) * (s1 / s0) };
    view.current = next;
    setS(next.s);
    setTx(next.tx);
    setTy(next.ty);
  };

  // Waiting items mapped by channel and agent.
  const waitingByTeamAgent = useMemo(() => {
    const map = new Map<string, WaitingItem>();
    for (const w of waiting) {
      if (w.channelId) {
        const key = `${w.channelId}:${w.fromId}`;
        if (!map.has(key)) map.set(key, w);
      }
    }
    return map;
  }, [waiting]);

  // Placed creature instances across teams.
  const placedCreatures = useMemo(
    () => buildPlacedCreatures(teams, agentsById, dragCreature, waitingByTeamAgent),
    [teams, agentsById, dragCreature, waitingByTeamAgent],
  );

  // Lock the initial byRecent card order while CrewCanvas stays mounted so background LiveRefresh updates
  // don't re-order cards under the user's finger mid-tap.
  const lockedCardOrderRef = useRef<string[] | null>(null);
  const orderedCardTeams = useMemo(() => {
    const sorted = byRecent(teams, conversations, lockedCardOrderRef.current ?? undefined);
    lockedCardOrderRef.current = sorted.map((t) => t.channelId);
    return sorted;
  }, [teams, conversations]);

  // Pointer & wheel handlers on the canvas viewport.
  const onPointerDownVp = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('[data-cards]')) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      const r = vpRect();
      pinchRef.current = {
        dist: Math.max(20, dist),
        s0: s,
        cx: (pts[0]!.x + pts[1]!.x) / 2 - r.left,
        cy: (pts[0]!.y + pts[1]!.y) / 2 - r.top,
        tx0: panLive.current?.tx ?? tx,
        ty0: panLive.current?.ty ?? ty,
      };
      commitPan();
      return;
    }
    if (e.button !== 0) return;
    setAnim(false);
    setPan({ sx: e.clientX, sy: e.clientY, tx0: panLive.current?.tx ?? tx, ty0: panLive.current?.ty ?? ty });
  };

  const onPointerMoveVp = (e: React.PointerEvent) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      const p = pinchRef.current;
      zoomAt(dist / p.dist, p.cx, p.cy, { s: p.s0, tx: p.tx0, ty: p.ty0 });
      return;
    }
    if (dragCreature) {
      const moved =
        dragCreature.moved || Math.abs(e.clientX - dragCreature.sx) + Math.abs(e.clientY - dragCreature.sy) > 5;
      if (!moved) return;
      const w = toWorld(e.clientX, e.clientY);
      setDragCreature({
        ...dragCreature,
        moved: true,
        x: w.x - dragCreature.dx,
        y: w.y - dragCreature.dy,
      });
      return;
    }
    if (dragFrame) {
      const dx = (e.clientX - dragFrame.sx) / s;
      const dy = (e.clientY - dragFrame.sy) / s;
      const moved = dragFrame.moved || hasFrameMoved(dragFrame.sx, dragFrame.sy, e.clientX, e.clientY);
      if (!moved) return;
      setDragFrame({ ...dragFrame, moved: true });
      setTeams((prev) =>
        prev.map((t) => {
          if (t.channelId !== dragFrame.channelId) return t;
          if (dragFrame.mode === 'move') {
            return { ...t, canvas: { ...t.canvas, x: Math.round(dragFrame.box0.x + dx), y: Math.round(dragFrame.box0.y + dy) } };
          }
          return {
            ...t,
            canvas: {
              ...t.canvas,
              w: Math.max(360, Math.round(dragFrame.box0.w + dx)),
              h: Math.max(280, Math.round(dragFrame.box0.h + dy)),
            },
          };
        }),
      );
      return;
    }
    if (pan) {
      // Pan writes the transform straight to the DOM; React state catches up on pointerup.
      const nx = pan.tx0 + (e.clientX - pan.sx);
      const ny = pan.ty0 + (e.clientY - pan.sy);
      panLive.current = { tx: nx, ty: ny };
      const vp = vpRef.current;
      if (!overview && !cards) {
        const r = vpRect(); // read before the transform write below: no forced layout
        setPanTeam(findTeamAt(teams, (r.width / 2 - nx) / s, (r.height / 2 - ny) / s) ?? null);
      }
      const world = vp?.querySelector<HTMLElement>('[data-world]');
      if (world) world.style.transform = `translate(${nx}px, ${ny}px) scale(${s})`;
      if (vp) vp.style.backgroundPosition = `${nx}px ${ny}px`;
    }
  };

  const commitPan = () => {
    const live = panLive.current;
    panLive.current = null;
    setPanTeam(undefined);
    if (live) {
      setTx(live.tx);
      setTy(live.ty);
    }
    setPan(null);
  };

  const onPointerUpVp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;

    if (dragCreature) {
      const dc = dragCreature;
      setDragCreature(null);
      if (!dc.moved) {
        if (dc.fromTeamId) {
          setSelAgentId(dc.agentId);
          setSelTeamId(dc.fromTeamId);
        } else pushPanel(dc.agentId === me.id || (guest && agentsById.get(dc.agentId)?.kind !== 'human') ? agentHref(ws, dc.agentId) : dmHref(ws, dc.agentId)); // a tap on the bench opens it
        return;
      }
      const target = findTeamAt(teams, dc.x + 66, dc.y + 100, dc.fromTeamId);
      if (!target || target.channelId === dc.fromTeamId) return;
      const agent = agentsById.get(dc.agentId);
      if (!agent) return;
      if (target.members.includes(dc.agentId)) {
        showToast({ text: `${agent.name} is already in ${target.name}`, agentId: dc.agentId });
        return;
      }
      setDropRole('');
      setPending({
        kind: 'add',
        agentId: dc.agentId,
        fromTeamId: dc.fromTeamId,
        toTeamId: target.channelId,
      });
      return;
    }

    if (dragFrame) {
      const df = dragFrame;
      setDragFrame(null);
      if (df.moved) {
        const updated = teams.find((t) => t.channelId === df.channelId);
        if (updated) {
          startTransition(async () => {
            await saveBox(df.channelId, updated.canvas);
          });
        }
      } else if (s < 0.62) {
        // A click on a team from afar flies in (a double-click opens its chat).
        const t = teams.find((x) => x.channelId === df.channelId);
        if (t) flyToBox(t.canvas, 1.05);
      }
      return;
    }

    if (pan) commitPan();
  };

  const applyPending = (moveInstead: boolean) => {
    if (!pending) return;
    const p = pending;
    const agent = memberAgents.get(p.agentId);
    if (!agent) {
      setPending(null);
      return;
    }
    setPending(null);

    if (p.kind === 'remove') {
      const fromTeam = teams.find((t) => t.channelId === p.fromTeamId);
      setTeams((prev) =>
        prev.map((t) => (t.channelId === p.fromTeamId ? { ...t, members: t.members.filter((m) => m !== p.agentId) } : t)),
      );
      setSelAgentId(null);
      if (fromTeam) {
        showToast({
          text: `${agent.name} left ${fromTeam.name}`,
          agentId: p.agentId,
          addChannelId: p.fromTeamId,
        });
      }
      startTransition(async () => {
        await canvasMembershipChange({ ws, agentId: p.agentId, removeChannelId: p.fromTeamId });
      });
      return;
    }

    const toTeam = teams.find((t) => t.channelId === p.toTeamId);
    const fromTeam = p.fromTeamId ? teams.find((t) => t.channelId === p.fromTeamId) : undefined;
    const removeId = moveInstead && p.fromTeamId ? p.fromTeamId : undefined;
    const roleVal = dropRole.trim() || undefined;
    // Onboarding's last step: the first agent on any team takes the person into that team's chat.
    const firstAgent = !teams.some((t) => t.members.some((m) => memberAgents.get(m)?.kind !== 'human'));

    setTeams((prev) =>
      prev.map((t) => {
        if (t.channelId === p.toTeamId && !t.members.includes(p.agentId)) {
          return {
            ...t,
            members: [...t.members, p.agentId],
            roles: roleVal ? { ...(t.roles ?? {}), [p.agentId]: roleVal } : t.roles,
          };
        }
        if (removeId && t.channelId === removeId) {
          return { ...t, members: t.members.filter((m) => m !== p.agentId) };
        }
        return t;
      }),
    );

    if (toTeam) {
      showToast({
        text:
          moveInstead && fromTeam
            ? `${agent.name} moved from ${fromTeam.name} to ${toTeam.name}`
            : `${agent.name} added to ${toTeam.name}`,
        agentId: p.agentId,
        addChannelId: removeId,
        removeChannelId: p.toTeamId,
      });
    }

    startTransition(async () => {
      try {
        const result = await canvasMembershipChange({ ws, agentId: p.agentId, addChannelId: p.toTeamId, removeChannelId: removeId, role: roleVal });
        if (!result.ok) throw new Error(result.error);
        if (firstAgent && agent.kind !== 'human') pushPanel(channelHref(ws, p.toTeamId));
      } catch (error) {
        showToast({ text: error instanceof Error ? error.message : 'Could not add this member', agentId: '' });
        setTeams((current) => current.map((team) => {
          if (team.channelId !== p.toTeamId && team.channelId !== removeId) return team;
          const wasMember = teams.find((before) => before.channelId === team.channelId)?.members.includes(p.agentId);
          return { ...team, members: wasMember ? [...new Set([...team.members, p.agentId])] : team.members.filter((id) => id !== p.agentId) };
        }));
      }
    });
  };

  // A team's place on the canvas, saved; if the hub refuses, say so (the frame would jump back on the next refresh).
  const saveBox = async (channelId: string, box: CanvasBox) => {
    const res = await saveChannelCanvas(channelId, box);
    if (!res.ok) showToast({ text: `Couldn't save where ${teams.find((t) => t.channelId === channelId)?.name ?? 'the team'} is: ${res.error}`, agentId: '' });
  };

  // A new team's frame, drawn in the middle of the view.
  const startNewTeam = (at?: { x: number; y: number }) => {
    const r = vpRect();
    let x = at ? at.x : (r.width / 2 - tx) / s - 260;
    const y = at ? at.y : (r.height / 2 - ty) / s - 210;
    // Not on top of a team: moved right past whatever it would cover.
    for (let i = 0; i < 20; i++) {
      const hit = teams.find((t) => x < t.canvas.x + t.canvas.w + 24 && x + 520 > t.canvas.x - 24 && y < t.canvas.y + t.canvas.h + 24 && y + 420 > t.canvas.y - 24);
      if (!hit) break;
      x = hit.canvas.x + hit.canvas.w + 48;
    }
    const box = { x: Math.round(x), y: Math.round(y), w: 520, h: 420 };
    setNewTeamBox(box);
    setShowNewTeam(true);
    // The bench to drag agents from; on a phone it would cover the new frame.
    if (window.innerWidth >= 640) setShowBench(true);
    // Brought into view at a zoom where its form is readable, so it's never tiny or half off the screen.
    flyToBox(box, Math.max(s, 0.9));
  };

  // Right-click (or a long press): quick actions for what's under the pointer.
  const [menu, setMenu] = useState<CanvasContextMenu | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
    };
  }, [menu]);
  const menuItems = () =>
    buildContextMenuItems({
      menu,
      teams,
      agentsById,
      guest,
      ws,
      meId: me.id,
      canUseNotes,
      pushPanel,
      setOpenDayAgentId,
      setPendingRemove: (agentId, fromTeamId) => setPending({ kind: 'remove', agentId, fromTeamId }),
      setShowBench,
      flyToBox,
      addNote,
      startNewTeam,
      connectAgent,
      tidyUp,
      fitAll,
    });

  const attention = useMemo(() => attentionGroups(waiting, conversations), [waiting, conversations]);
  const needsYouCount = attentionCount(attention);

  // ⌘K: everything on the canvas, and what you can do here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the camera/action closures (connectAgent, flyToBox, tidyUp, startNewTeam, fitAll, pushPanel, router.push) are recreated every render and read the latest state when run; depending on them would rebuild the palette on every render. State values are the real triggers.
  const paletteItems = useMemo(
    (): PaletteItem[] =>
      buildPaletteItems({
        teams,
        attention,
        agentsById,
        meId: me.id,
        ws,
        joinableChannels,
        canUseNotes,
        guest,
        pushPanel,
        pushNewChannel: () => router.push(wsHref(ws, { channel: 'new' }), { scroll: false }),
        flyToBox,
        setActiveWaiting: (item: WaitingItem) => openWaiting(item),
        setSelAgentId,
        setSelTeamId,
        addNote: () => addNoteRef.current(),
        connectAgent,
        startNewTeam,
        tidyUp: () => tidyUp(), // lazy: tidyUp is defined below
        fitAll,
      }),
    // camera functions read the latest state when run
    [teams, attention, agentsById, me.id, ws, joinableChannels, canUseNotes, notes, guest],
  );

  // "Tidy up": every team in rows, none overlapping, sizes kept; saved, with Undo.
  const tidyUp = () => {
    const before = Object.fromEntries(teams.map((t) => [t.channelId, t.canvas]));
    const pos = tidyLayout(teams.map((t) => ({ id: t.channelId, x: t.canvas.x, y: t.canvas.y, w: t.canvas.w, h: frameHeight(t.canvas, t.members.length) })), notes.map((note) => ({ id: note.id, ...note.canvas })));
    const next = teams.map((t) => ({ ...t, canvas: { ...t.canvas, ...pos.get(t.channelId)! } }));
    setTeams(next);
    fitAll(next);
    showToast({ text: 'Teams tidied up', agentId: '', boxes: before });
    startTransition(async () => {
      await Promise.all(next.filter((t) => t.canvas.x !== before[t.channelId]!.x || t.canvas.y !== before[t.channelId]!.y).map((t) => saveBox(t.channelId, t.canvas)));
      // A server action can stream an older canvas while the other saves are still running.
      setTeams(next);
    });
  };

  const handleUndo = () => {
    if (undoToast?.boxes) {
      const boxes = undoToast.boxes;
      setUndoToast(null);
      const next = teams.map((t) => (boxes[t.channelId] ? { ...t, canvas: boxes[t.channelId]! } : t));
      setTeams(next);
      fitAll(next);
      startTransition(async () => {
        await Promise.all(next.filter((t) => boxes[t.channelId]).map((t) => saveBox(t.channelId, t.canvas)));
        setTeams(next);
      });
      return;
    }
    if (!undoToast || (!undoToast.addChannelId && !undoToast.removeChannelId)) return;
    const u = undoToast;
    setUndoToast(null);
    setTeams((prev) =>
      prev.map((t) => {
        if (u.addChannelId && t.channelId === u.addChannelId && !t.members.includes(u.agentId)) {
          return { ...t, members: [...t.members, u.agentId] };
        }
        if (u.removeChannelId && t.channelId === u.removeChannelId) {
          return { ...t, members: t.members.filter((m) => m !== u.agentId) };
        }
        return t;
      }),
    );
    startTransition(async () => {
      await canvasMembershipChange({
        ws,
        agentId: u.agentId,
        addChannelId: u.addChannelId,
        removeChannelId: u.removeChannelId,
      });
    });
  };


  const overview = s < 0.62;
  const channelNames = useMemo(() => new Map(teams.map((t) => [t.channelId, t.name])), [teams]);

  // Multi-team links when a creature is selected in detail view.
  const crossTeamLinks = useMemo(
    () => buildCrossTeamLinks(selAgentId, overview, placedCreatures),
    [selAgentId, overview, placedCreatures],
  );


  // biome-ignore lint/correctness/useExhaustiveDependencies: vpRect is an inline reader of the latest state; teams plus the camera (tx/ty/s) are the real triggers for recomputing which team is centered
  const focusedTeam = useMemo(() => {
    if (overview || cards) return undefined;
    const r = vpRect();
    const cx = (r.width / 2 - tx) / s;
    const cy = (r.height / 2 - ty) / s;
    return findTeamAt(teams, cx, cy);
  }, [overview, cards, tx, ty, s, teams]);

  const selAgent = selAgentId ? agentsById.get(selAgentId) : undefined;
  const openDayAgent = openDayAgentId ? agentsById.get(openDayAgentId) : undefined;
  const addNote = () => {
    const viewport = vpRect();
    setNoteEditor({ canvas: { x: Math.round((viewport.width / 2 - tx) / s - 160), y: Math.round((viewport.height / 2 - ty) / s - 150), w: 320, h: 300 } });
  };
  addNoteRef.current = addNote;
  const noteCards = (placed: boolean) => notes.map((note) => <CanvasNoteCard key={note.id} ws={ws} note={note} placed={placed} scale={s} editable={workspaceOwner || note.authorId === me.id}
    onEdit={() => setNoteEditor({ note, canvas: note.canvas })} onMove={async (canvas) => {
      const result = await saveCanvasNote(ws, { canvas, version: note.version }, note.id);
      if (!result.ok) throw new Error(result.error);
      setNotes((current) => current.map((item) => item.id === note.id ? result.note : item));
    }} />);
  const isFirstRun = teams.length === 0 && notes.length === 0;
  const onNewTeam = () => (cards ? document.getElementById('new-team')?.scrollIntoView({ behavior: 'smooth' }) : startNewTeam());
  const onboarding = <EmptyCanvasCard ws={ws} me={me} hasAgents={hasAgents} canJoin={!guest && joinableChannels.length > 0} onCreateTeam={onNewTeam} />;


  /** Esc closes the topmost open thing; true if something closed. */
  const closeTop = () => {
    if (pending) setPending(null);
    else if (activeWaiting) setActiveWaiting(null);
    else if (showNewTeam) setShowNewTeam(false);
    else if (openDayAgentId) setOpenDayAgentId(null);
    else if (showBench) setShowBench(false);
    else if (addTo) setAddTo(null);
    else if (selAgentId) setSelAgentId(null);
    else return false;
    return true;
  };
  // Also when focus is inside a drawer or a dialog (the canvas handles its own Esc).
  const closeTopRef = useRef(closeTop);
  closeTopRef.current = closeTop;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.target === vpRef.current) return;
      if (closeTopRef.current()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const decNeedsYou = (chId: string | undefined) => {
    if (!chId) return;
    setTeams((prev) => prev.map((t) => (t.channelId === chId && t.needsYou > 0 ? { ...t, needsYou: t.needsYou - 1 } : t)));
  };
  /** Opening it reads it (the popover marks it read), so it leaves Needs you right away. */
  const openWaiting = (item: WaitingItem) => {
    setWaiting((w) => w.filter((x) => x.replyTo !== item.replyTo));
    decNeedsYou(item.channelId);
    setConversations((list) => markDestinationRead(list, item.replyTo));
    setActiveWaiting(item);
  };
  const menuVp = menu ? vpRect() : undefined;
  return (
    <div
      ref={vpRef}
      tabIndex={0}
      aria-label={`${workspaceName} crew canvas`}
      onPointerDown={onPointerDownVp}
      onPointerMove={onPointerMoveVp}
      onPointerUp={onPointerUpVp}
      onPointerCancel={onPointerUpVp}
      onContextMenu={(e) => {
        const el = e.target as HTMLElement;
        // Text fields and links keep the browser's own menu.
        if (el.closest('input, textarea, a, [role="dialog"], aside')) return;
        e.preventDefault();
        const r = vpRect();
        const w = toWorld(e.clientX, e.clientY);
        setMenu({
          x: e.clientX - r.left,
          y: e.clientY - r.top,
          world: { x: w.x, y: w.y },
          teamId: el.closest<HTMLElement>('[data-team]')?.dataset.team,
          agentId: el.closest<HTMLElement>('[data-agent]')?.dataset.agent,
        });
      }}
      onWheel={(e) => {
        // Only the canvas itself zooms: scrolling in a modal, its backdrop or a dialog leaves the workspace be.
        const el = e.target as HTMLElement;
        if (el !== e.currentTarget && (!el.closest('[data-world]') || el.closest('[role="dialog"], input, textarea'))) return;
        const r = vpRect();
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'ArrowLeft') setTx((v) => v + 60);
        else if (e.key === 'ArrowRight') setTx((v) => v - 60);
        else if (e.key === 'ArrowUp') setTy((v) => v + 60);
        else if (e.key === 'ArrowDown') setTy((v) => v - 60);
        else if (e.key === '+' || e.key === '=') zoomAt(1.2, vpRect().width / 2, vpRect().height / 2);
        else if (e.key === '-') zoomAt(0.83, vpRect().width / 2, vpRect().height / 2);
        else if (e.key === '0') fitAll();
        else if (e.key === 'Escape' && !closeTop()) fitAll();
      }}
      style={{
        backgroundColor: 'var(--bg)',
        backgroundImage: 'radial-gradient(var(--dots) 1.3px, transparent 1.3px)',
        backgroundSize: `${Math.max(8, 22 * s)}px ${Math.max(8, 22 * s)}px`,
        backgroundPosition: `${tx}px ${ty}px`,
        cursor: pan || (dragFrame?.mode === 'move' && dragFrame.moved) ? 'grabbing' : 'default',
      }}
      className={`relative h-full min-w-0 flex-1 overflow-clip select-none outline-none ${cards ? 'touch-pan-y' : 'touch-none'}`}
    >
      <NeedsYouTitle count={needsYouCount} />
      <HiddenBehindPanel ws={ws}>
      {cards && <CanvasCards ws={ws} guest={guest} teams={orderedCardTeams} joinable={guest ? [] : joinableChannels} agentsById={agentsById} meId={me.id} onLog={(id) => setOpenDayAgentId(id)} onAdd={setAddTo} notes={notes.length ? <section aria-label="Workspace notes" className="flex flex-col gap-3"><h2 className="text-base font-bold">Notes</h2>{noteCards(false)}</section> : undefined} onboarding={isFirstRun ? onboarding : undefined} onCreated={isFirstRun && hasAgents ? setAddTo : undefined} />}

      {/* Empty-workspace onboarding follows the next useful step */}
      {!cards && isFirstRun && !showNewTeam && (
        <div ref={placeJoinCards} className={`pointer-events-none absolute inset-0 z-10 flex justify-center p-4 pt-20 ${!guest && joinableChannels.length > 0 ? 'items-start' : 'items-center'}`}>
          {onboarding}
        </div>
      )}

      {notesError && <p role="alert" className="pointer-events-auto absolute top-20 left-4 z-20 rounded-xl bg-[var(--surface)] p-3 text-sm text-[var(--bad-fg)]">{notesError}</p>}
      {/* World transform layer */}
      <CanvasWorld
        notes={cards ? undefined : noteCards(true)}
        ws={ws}
        tx={tx}
        ty={ty}
        s={s}
        anim={anim}
        overview={overview}
        teams={teams}
        agentsById={agentsById}
        placedCreatures={placedCreatures}
        crossTeamLinks={crossTeamLinks}
        selAgentId={selAgentId}
        waiting={waiting}
        dragCreature={dragCreature}
        dragFrame={dragFrame}
        showNewTeam={showNewTeam}
        newTeamBox={newTeamBox}
        slackChannels={slackChannels}
        joinableChannels={joinableChannels}
        joinFrames={joinFrames}
        toWorld={toWorld}
        onStartDragFrame={(state) => {
          setAnim(false);
          setDragFrame(state);
        }}
        onStartDragCreature={setDragCreature}
        onSelectCreature={(agentId, teamId) => {
          setSelAgentId(agentId);
          setSelTeamId(teamId);
        }}
        onOpenWaiting={openWaiting}
        onAddToTeam={(channelId) => {
          setShowBench(false);
          setAddTo(channelId);
        }}
        onFlyToBox={flyToBox}
        onOpenTeam={(channelId) => pushPanel(channelHref(ws, channelId))}
        onOpenCreature={(agentId) => pushPanel(agentId === me.id ? agentHref(ws, agentId) : dmHref(ws, agentId))}
        onResizeNewTeamBox={setNewTeamBox}
        onCreatedNewTeam={(chId, createdBox) => {
          if (isFirstRun && hasAgents) setAddTo(chId);
          setShowNewTeam(false);
          setShowBench(true);
          flyToBox(createdBox, 1.0);
        }}
        onCancelNewTeam={() => setShowNewTeam(false)}
      />
      </HiddenBehindPanel>

      <CanvasChrome
        ws={ws}
        workspaceName={workspaceName}
        shareUrl={shareUrl}
        me={me}
        billing={billing}
        workspaces={workspaces}
        logout={logout}
        botAgentsCount={botAgents.length}
        workspaceOwner={workspaceOwner}
        attentionCount={needsYouCount}
        focusedTeamName={(pan && panTeam !== undefined ? panTeam : focusedTeam)?.name}
        selAgentName={selAgent?.name}
        showNewTeam={showNewTeam}
        cards={cards}
        showBench={showBench}
        overview={overview}
        s={s}
        onFitAll={() => fitAll()}
        onSwitchLayout={switchLayout}
        onToggleBench={() => setShowBench((v) => !v)}
        onNewNote={canUseNotes ? addNote : undefined}
        onNewTeam={onNewTeam}
        onTidyUp={tidyUp}
        onZoomOut={() => zoomAt(0.8, vpRect().width / 2, vpRect().height / 2)}
        onZoomIn={() => zoomAt(1.25, vpRect().width / 2, vpRect().height / 2)}
      />

      {/* Selected creature popover card (Canvas.dc.html) */}
      {selAgent && !openDayAgent && (
        <SelectedAgentCard
          ws={ws}
          meId={me.id}
          agent={selAgent}
          guest={guest}
          teams={teams}
          selTeamId={selTeamId}
          onSelectTeam={(tid, box) => {
            setSelTeamId(tid);
            flyToBox(box, 1.05);
          }}
          onOpenLog={setOpenDayAgentId}
          onRemoveFromTeam={(agentId, fromTeamId) => setPending({ kind: 'remove', agentId, fromTeamId })}
          onClose={() => setSelAgentId(null)}
        />
      )}

      {/* Screen 3: Needs you answer popover. Fixed to the visible screen (above a phone's keyboard), not to the canvas, which scrolls on phones. */}
      {activeWaiting && createPortal(
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.target === e.currentTarget && setActiveWaiting(null)}
          className="pointer-events-auto fixed inset-x-0 top-0 z-[80] flex h-[var(--app-h,100dvh)] items-start justify-center overflow-y-auto bg-[rgba(23,22,28,0.14)] p-4 backdrop-blur sm:items-center"
        >
          <NeedsYouPopover
            ws={ws}
            item={activeWaiting}
            channelName={activeWaiting.channelId ? channelNames.get(activeWaiting.channelId) : undefined}
            onAnswered={() => {
              // Already out of Needs you since it opened; move on to the next one.
              if (waiting.length > 0) {
                const next = waiting[0]!;
                openWaiting(next);
                if (next.channelId) {
                  const t = teams.find((tm) => tm.channelId === next.channelId);
                  if (t) flyToBox(t.canvas, 1.05);
                }
              } else {
                setActiveWaiting(null);
              }
            }}
            onClose={() => setActiveWaiting(null)}
          />
        </div>,
        document.body,
      )}

      {/* An agent's log drawer */}
      {openDayAgent && (
        <AgentDayDrawer
          ws={ws}
          agent={openDayAgent}
          guest={guest}
          channelNames={channelNames}
          onClose={() => setOpenDayAgentId(null)}
        />
      )}

      {addTo && !openDayAgent && teams.some((t) => t.channelId === addTo) && (
        <AddToTeam
          ws={ws}
          team={teams.find((t) => t.channelId === addTo)!}
          agents={addableMembers}
          onClose={() => setAddTo(null)}
          onPick={(agentId) => {
            setAddTo(null);
            setDropRole('');
            setPending({ kind: 'add', agentId, toTeamId: addTo });
          }}
        />
      )}

      {/* Bench drawer */}
      {showBench && !openDayAgent && (
        <BenchDrawer
          ws={ws}
          agents={botAgents}
          elsewhere={initialCanvas.elsewhere}
          onClose={() => setShowBench(false)}
          onStartDrag={(agentId, e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const w = toWorld(e.clientX, e.clientY);
            setDragCreature({
              pid: `bench:${agentId}`,
              agentId,
              dx: 66,
              dy: 66,
              sx: e.clientX,
              sy: e.clientY,
              ox: w.x - 66,
              oy: w.y - 66,
              x: w.x - 66,
              y: w.y - 66,
              moved: false,
            });
          }}
        />
      )}

      {noteEditor && <NoteEditor ws={ws} note={noteEditor.note} canvas={noteEditor.canvas} onSaved={saveNote} onClose={() => setNoteEditor(null)} onDelete={async () => {
        if (!noteEditor.note) return;
        const result = await deleteCanvasNote(ws, noteEditor.note);
        if (!result.ok) throw new Error(result.error);
        setNotes((current) => current.filter((note) => note.id !== noteEditor.note!.id));
        setNoteEditor(null);
      }} />}

      {/* Drag / Leave confirmation modal (Add / Move instead / Cancel + role) */}
      {pending && (
        <ConfirmTeamMemberDialog
          pending={pending}
          agentsById={memberAgents}
          teams={teams}
          dropRole={dropRole}
          onChangeRole={setDropRole}
          onApply={applyPending}
          onCancel={() => setPending(null)}
        />
      )}

      {menu && menuVp && (
        <div
          role="menu"
          aria-label="Quick actions"
          onPointerDown={(e) => e.stopPropagation()}
          style={{ left: Math.min(menu.x, menuVp.width - 220), top: Math.min(menu.y, menuVp.height - 230) }}
          className="canvas-pop absolute z-50 flex w-[210px] flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_14px_32px_rgba(23,22,28,0.16)]"
        >
          {menuItems().map((m) => (
            <button
              key={m.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                m.run();
              }}
              className={`flex min-h-9 cursor-pointer items-center rounded-lg px-3 text-left text-sm hover:bg-[var(--subtle)] ${m.danger ? 'text-[var(--bad-fg)]' : ''}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      <CommandPalette
        items={paletteItems}
        dmOf={(id) => pushPanel(dmHref(ws, id))}
        openMessage={(h) => pushPanel(chatHref(ws, h.key, { ...(h.thread ? { thread: h.thread } : {}), at: h.message.id }))}
      />

      {/* Undo toast (Canvas.dc.html) */}
      {undoToast && (
        <div
          role="status"
          onPointerDown={(e) => e.stopPropagation()}
          className="canvas-pop absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3.5 rounded-xl bg-[var(--fg)] px-4 py-2.5 text-sm text-[var(--bg)] shadow-[0_14px_30px_rgba(23,22,28,0.25)]"
        >
          <span>{undoToast.text}</span>
          {(undoToast.addChannelId || undoToast.removeChannelId || undoToast.boxes) && (
            <button
              type="button"
              onClick={handleUndo}
              className="h-8 cursor-pointer rounded-lg bg-[var(--bg)] px-3 text-[13px] font-semibold text-[var(--fg)]"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
