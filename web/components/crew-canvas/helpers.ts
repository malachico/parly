import { frameHeight, slotPosition } from '@/lib/canvasLayout';
import type { CanvasConversation } from '@/lib/attention';
import type { DragCreatureState, PlacedCreature } from '@/components/CanvasWorld';
import type { CanvasAgent, CanvasBox, CanvasTeam, WaitingItem } from '@/lib/hub';

export type UndoAction = {
  text: string;
  agentId: string;
  addChannelId?: string;
  removeChannelId?: string;
  /** Tidy up: where each team was before. */
  boxes?: Record<string, CanvasBox>;
};

/** On a phone, teams as a list: the one with the latest message first (the canvas keeps its own layout). */
export function byRecent(teams: CanvasTeam[], conversations: CanvasConversation[], lockedIds?: readonly string[]): CanvasTeam[] {
  const last = new Map(conversations.map((c) => [c.key, c.updatedAt]));
  const at = (t: CanvasTeam) => last.get(`channel:${t.channelId}`) ?? '';
  if (!lockedIds || lockedIds.length === 0) {
    return [...teams].sort((a, b) => at(b).localeCompare(at(a)));
  }
  const pos = new Map(lockedIds.map((id, idx) => [id, idx]));
  return [...teams].sort((a, b) => {
    const ia = pos.get(a.channelId);
    const ib = pos.get(b.channelId);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return at(b).localeCompare(at(a));
  });
}

/** Screen-space drag threshold for a team frame so a mobile tap (1–3px jitter) never misfires as a drag at overview zoom. */
export function hasFrameMoved(sx: number, sy: number, clientX: number, clientY: number): boolean {
  return Math.hypot(clientX - sx, clientY - sy) > 6;
}

/** The team under a point; where frames overlap, one other than `prefer` wins (a creature dropped on another team). */
export function findTeamAt(teams: CanvasTeam[], wx: number, wy: number, prefer?: string): CanvasTeam | undefined {
  const under = teams.filter((t) => {
    const h = frameHeight(t.canvas, t.members.length);
    return wx >= t.canvas.x && wx <= t.canvas.x + t.canvas.w && wy >= t.canvas.y && wy <= t.canvas.y + h;
  });
  return under.find((t) => t.channelId !== prefer) ?? under[0];
}

/** The box around every item on the canvas (teams and notes). */
export function bounds(items: { canvas: CanvasBox }[]) {
  return {
    minX: Math.min(...items.map((t) => t.canvas.x)),
    minY: Math.min(...items.map((t) => t.canvas.y)),
    maxX: Math.max(...items.map((t) => t.canvas.x + t.canvas.w)),
    maxY: Math.max(...items.map((t) => t.canvas.y + t.canvas.h)),
  };
}

/** Frames for the open channels I'm not in: a 3-wide grid below the lowest team, so the list never overflows. */
export function joinBoxes(teams: { canvas: CanvasBox; members: string[] }[], channels: { id: string; name: string }[]) {
  const x0 = teams.length ? Math.min(...teams.map((t) => t.canvas.x)) : 40;
  const y0 = teams.length ? Math.max(...teams.map((t) => t.canvas.y + frameHeight(t.canvas, t.members.length))) + 80 : 40;
  return channels.map((c, i) => ({ ...c, canvas: { x: x0 + (i % 3) * 640, y: y0 + Math.floor(i / 3) * 320, w: 580, h: 260 } }));
}

/** The zoom limits. */
export const clampScale = (s: number) => Math.max(0.25, Math.min(2.2, s));

/** Placed creature instances across teams. */
export function buildPlacedCreatures(
  teams: CanvasTeam[],
  agentsById: Map<string, CanvasAgent>,
  dragCreature: DragCreatureState | null,
  waitingByTeamAgent: Map<string, WaitingItem>,
): PlacedCreature[] {
  const out: PlacedCreature[] = [];
  for (const t of teams) {
    const memberAgents = t.members
      .map((id) => agentsById.get(id))
      .filter((a): a is CanvasAgent => Boolean(a))
      // Everyone in the team: agents first, then the people.
      .sort((a, b) => Number(a.kind === 'human') - Number(b.kind === 'human'));
    memberAgents.forEach((a, k) => {
      const pos = slotPosition(t.canvas, k);
      const pid = `${t.channelId}:${a.id}`;
      const draggingThis = dragCreature && dragCreature.pid === pid && dragCreature.moved;
      out.push({
        pid,
        agent: a,
        team: t,
        x: draggingThis ? dragCreature.x : pos.x,
        y: draggingThis ? dragCreature.y : pos.y,
        role: t.roles?.[a.id],
        waitingItem: waitingByTeamAgent.get(pid),
      });
    });
  }
  if (dragCreature && dragCreature.pid.startsWith('bench:') && dragCreature.moved) {
    const a = agentsById.get(dragCreature.agentId);
    if (a && teams[0]) {
      out.push({
        pid: dragCreature.pid,
        agent: a,
        team: teams[0],
        x: dragCreature.x,
        y: dragCreature.y,
      });
    }
  }
  return out;
}

/** Multi-team links when a creature is selected in detail view. */
export function buildCrossTeamLinks(
  selAgentId: string | null,
  overview: boolean,
  placedCreatures: PlacedCreature[],
): string[] {
  if (!selAgentId || overview) return [];
  const mine = placedCreatures.filter((p) => p.agent.id === selAgentId);
  const out: string[] = [];
  for (let k = 1; k < mine.length; k++) {
    const a0 = mine[0]!;
    const b0 = mine[k]!;
    const x1 = a0.x + 66;
    const y1 = a0.y + 84;
    const x2 = b0.x + 66;
    const y2 = b0.y + 84;
    out.push(`M ${x1} ${y1} C ${x1 + (x2 - x1) * 0.3} ${y1 - 140}, ${x2 - (x2 - x1) * 0.3} ${y2 - 140}, ${x2} ${y2}`);
  }
  return out;
}
