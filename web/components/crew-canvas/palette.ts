import type { attentionGroups } from '@/lib/attention';
import { presenceLabel } from '@/components/CanvasPanels';
import { openPalette, type PaletteItem } from '@/components/CommandPalette';
import { startTour } from '@/components/Tour';
import { joinChannel } from '@/lib/actions';
import type { CanvasAgent, CanvasBox, CanvasTeam, WaitingItem } from '@/lib/hub';
import { shortTime } from '@/lib/labels';
import { agentHref, channelHref, chatHref, dmHref, knowledgeHref, skillsHref, wsHref } from '@/lib/routes';

export type CanvasContextMenu = {
  x: number;
  y: number;
  world: { x: number; y: number };
  teamId?: string;
  agentId?: string;
};

/** Right-click (or a long press): quick actions for what's under the pointer. */
export function buildContextMenuItems({
  menu,
  teams,
  agentsById,
  guest,
  ws,
  meId,
  canUseNotes,
  pushPanel,
  setOpenDayAgentId,
  setPendingRemove,
  setShowBench,
  flyToBox,
  addNote,
  startNewTeam,
  connectAgent,
  tidyUp,
  fitAll,
}: {
  menu: CanvasContextMenu | null;
  teams: CanvasTeam[];
  agentsById: Map<string, CanvasAgent>;
  guest: boolean;
  ws: string;
  meId: string;
  canUseNotes: boolean;
  pushPanel: (href: string, opts?: { scroll?: boolean }) => void;
  setOpenDayAgentId: (id: string) => void;
  setPendingRemove: (agentId: string, fromTeamId: string) => void;
  setShowBench: (show: boolean) => void;
  flyToBox: (box: CanvasBox, targetScale?: number) => void;
  addNote: () => void;
  startNewTeam: (at?: { x: number; y: number }) => void;
  connectAgent: () => void;
  tidyUp: () => void;
  fitAll: () => void;
}): { label: string; run: () => void; danger?: boolean }[] {
  if (!menu) return [];
  const team = menu.teamId ? teams.find((t) => t.channelId === menu.teamId) : undefined;
  const agent = menu.agentId ? agentsById.get(menu.agentId) : undefined;
  if (agent) {
    return [
      ...(guest && agent.kind !== 'human' ? [] : [{ label: `Message ${agent.name}`, run: () => pushPanel(dmHref(ws, agent.id)) }]),
      ...(agent.kind !== 'human' ? [{ label: 'Log', run: () => setOpenDayAgentId(agent.id) }] : []),
      ...(agent.myCloud ? [{ label: 'Tools', run: () => pushPanel(`${agentHref(ws, agent.id)}?only=tools`) }, { label: 'Triggers', run: () => pushPanel(`${agentHref(ws, agent.id)}?only=triggers`) }] : []),
      { label: 'Profile', run: () => pushPanel(agentHref(ws, agent.id)) },
      ...(team && agent.id !== meId && !guest ? [{ label: `Take out of ${team.name}`, run: () => setPendingRemove(agent.id, team.channelId), danger: true }] : []),
    ];
  }
  if (team) {
    return [
      { label: 'Open the conversation', run: () => pushPanel(channelHref(ws, team.channelId)) },
      { label: 'Add an agent', run: () => setShowBench(true) },
      { label: 'Zoom to this team', run: () => flyToBox(team.canvas, 1.05) },
      { label: 'Team settings', run: () => pushPanel(channelHref(ws, team.channelId, { panel: 'channel', from: 'canvas' })) },
    ];
  }
  return [
    ...(canUseNotes ? [{ label: 'Add note', run: () => addNote() }] : []),
    { label: 'New team here', run: () => startNewTeam(menu.world) },
    { label: 'Add an agent', run: () => connectAgent() },
    { label: 'Tidy up the canvas', run: () => tidyUp() },
    { label: 'Fit canvas', run: () => fitAll() },
    { label: 'Search  ⌘K', run: openPalette },
  ];
}

/** ⌘K: everything on the canvas, and what you can do here. */
export function buildPaletteItems({
  teams,
  attention,
  agentsById,
  meId,
  ws,
  joinableChannels,
  canUseNotes,
  guest,
  pushPanel,
  pushNewChannel,
  flyToBox,
  setActiveWaiting,
  setSelAgentId,
  setSelTeamId,
  addNote,
  connectAgent,
  startNewTeam,
  tidyUp,
  fitAll,
}: {
  teams: CanvasTeam[];
  attention: ReturnType<typeof attentionGroups>;
  agentsById: Map<string, CanvasAgent>;
  meId: string;
  ws: string;
  joinableChannels: { id: string; name: string }[];
  canUseNotes: boolean;
  guest: boolean;
  pushPanel: (href: string, opts?: { scroll?: boolean }) => void;
  pushNewChannel: () => void;
  flyToBox: (box: CanvasBox, targetScale?: number) => void;
  setActiveWaiting: (item: WaitingItem) => void;
  setSelAgentId: (id: string) => void;
  setSelTeamId: (id: string) => void;
  addNote: () => void;
  connectAgent: () => void;
  startNewTeam: () => void;
  tidyUp: () => void;
  fitAll: () => void;
}): PaletteItem[] {
  const nameOf = new Map(teams.map((t) => [t.channelId, t.name]));
  const flyToTeam = (id: string) => {
    const t = teams.find((x) => x.channelId === id);
    if (!t) return;
    // A panel open over the canvas would hide where it flies: close it first.
    if (window.location.pathname !== wsHref(ws) || window.location.search) pushPanel(wsHref(ws), { scroll: false });
    flyToBox(t.canvas, 1.05);
  };
  return [
    ...attention.waiting.map((w) => ({
      id: `wait:${w.replyTo}`,
      group: 'Needs you',
      title: `${w.from}: ${w.text.replace(/\s+/g, ' ').slice(0, 80)}`,
      subtitle: `Waiting for your reply · ${w.channelId ? `#${nameOf.get(w.channelId) ?? ''}` : 'Direct message'} · ${shortTime(w.at)}`,
      who: { id: w.fromId, name: w.from, avatar: w.fromAvatar, kind: w.fromKind },
      run: () => setActiveWaiting(w),
      ...(w.channelId ? { locate: () => flyToTeam(w.channelId!) } : {}),
    })),
    ...teams.map((t) => ({
      id: `team:${t.channelId}`,
      group: 'Teams',
      title: t.name,
      subtitle: `${t.members.length} ${t.members.length === 1 ? 'member' : 'members'}${t.slack ? ' · Slack' : ''}${t.needsYou ? ` · ${t.needsYou} need${t.needsYou === 1 ? 's' : ''} you` : ''}`,
      icon: '#',
      run: () => pushPanel(channelHref(ws, t.channelId)),
      locate: () => flyToTeam(t.channelId),
    })),
    ...[...agentsById.values()]
      .filter((a) => a.id !== meId)
      .map((a) => {
        const inTeams = a.teams.map((id) => nameOf.get(id)).filter(Boolean);
        return {
          id: `agent:${a.id}`,
          group: 'Agents and people',
          title: a.name,
          subtitle: [a.status ? a.status.text : presenceLabel(a.presence).text, inTeams.length ? inTeams.map((n) => `#${n}`).join(' ') : 'no team'].join(' · '),
          keywords: inTeams.join(' '),
          who: a,
          run: () => pushPanel(guest && a.kind !== 'human' ? agentHref(ws, a.id) : dmHref(ws, a.id)),
          ...(a.teams[0]
            ? {
                locate: () => {
                  flyToTeam(a.teams[0]!);
                  setSelAgentId(a.id);
                  setSelTeamId(a.teams[0]!);
                },
              }
            : {}),
        };
      }),
    ...(canUseNotes ? [{ id: 'act:note', group: 'Actions' as const, title: 'Add note', icon: '＋', run: () => addNote() }] : []),
    { id: 'act:connect', group: 'Actions', title: 'Add an agent', icon: '＋', run: () => connectAgent() },
    { id: 'act:knowledge', group: 'Actions', title: 'Knowledge', subtitle: 'Decisions, people, topics and docs from your conversations', icon: '🧠', run: () => pushPanel(knowledgeHref(ws)) },
    { id: 'act:skills', group: 'Actions', title: 'Skills & Processes library', subtitle: 'Create reusable playbooks and team workflows', icon: '📘', run: () => pushPanel(skillsHref(ws)) },
    { id: 'act:team', group: 'Actions', title: 'New team', icon: '▢', run: () => startNewTeam() },
    { id: 'act:tidy', group: 'Actions', title: 'Tidy up the canvas', subtitle: 'Teams in rows, none overlapping', icon: '▦', run: () => tidyUp() },
    { id: 'act:all', group: 'Actions', title: 'Fit canvas', subtitle: 'Zoom out to see teams and notes', icon: '⤢', run: () => fitAll() },
    { id: 'act:invite', group: 'Actions', title: 'Invite a person', subtitle: 'Workspace details', icon: '✉', run: () => pushPanel(wsHref(ws, { panel: 'workspace' })) },
    { id: 'act:channel', group: 'Actions', title: 'New channel', icon: '#', run: () => pushNewChannel() },
    ...joinableChannels.map((c) => ({ id: `join:${c.id}`, group: 'Actions', title: `Join #${c.name}`, subtitle: 'An open channel here', icon: '→', run: () => void joinChannel(c.id, ws) })),
    // My conversations: unread ones first (all of them), then the latest few.
    ...[...attention.unread, ...attention.recent]
      .map((c, i) => ({
        id: `conv:${c.key}`,
        group: i < attention.unread.length ? 'Needs you' : 'Recent',
        // Like Slack: a busy channel's every message isn't yours to read, so a number only for what mentions you.
        title: c.mentions ? `${c.title} · ${c.mentions} @you` : c.unread > 0 && c.mentions === undefined ? `${c.title} · ${c.unread} new` : c.title,
        subtitle: `${c.unread > 0 ? 'Unread · ' : ''}${c.preview.replace(/\s+/g, ' ').slice(0, 90)}`,
        ...(c.who ? { who: c.who } : { icon: '#' }),
        // New only in a thread: straight into that thread.
        run: () => pushPanel(chatHref(ws, c.key, c.thread ? { thread: c.thread } : undefined)),
      })),
    { id: 'act:tour', group: 'Actions', title: 'Take the tour', icon: '?', run: startTour },
  ];
}
