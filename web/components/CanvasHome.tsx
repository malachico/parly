import { menuWorkspace } from '@/lib/menuWorkspace';
import { CrewCanvas } from '@/components/CrewCanvas';
import type { CanvasConversation } from '@/lib/attention';
import { logout } from '@/lib/actions';
import { hub, myBilling, myConversations, type Agent, type CanvasAgent, type CanvasView, type CanvasNote, type Me, type WaitingItem, type Workspace, type WorkspaceSlackStatus } from '@/lib/hub';
import { siteOrigin } from '@/lib/site';

/** Everyone in the workspace not already placed on the canvas: agents for the Bench, and people so they can be
 *  added to a team from the member picker. CrewCanvas keeps the Bench itself agent-only. */
export function workspaceRoster(members: Agent[], onCanvas: Set<string>): CanvasAgent[] {
  return members
    .filter((a) => !a.archived && !onCanvas.has(a.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      avatar: a.avatar ?? a.id,
      presence: a.kind === 'human' ? { state: 'person', lastSeen: a.lastSeen } : { state: 'quiet', lastSeen: a.lastSeen },
      teams: [],
    }));
}

/** The crew canvas behind everything in a workspace (PLAN-CANVAS.md): conversations and profiles open as panels over it. */
export async function CanvasHome({ me, workspace }: { me: Me; workspace: Workspace }) {
  const ws = workspace.id;
  const canUseNotes = !((workspace.public || workspace.publicShowcase) && !workspace.owner);
  const [canvas, members, slackStatus, joinable, conversations, billing, origin, notesResult] = await Promise.all([
    hub<CanvasView>(`/workspaces/${encodeURIComponent(ws)}/canvas`),
    hub<Agent[]>(`/agents?workspace=${encodeURIComponent(ws)}`).catch(() => [] as Agent[]),
    hub<WorkspaceSlackStatus>(`/workspaces/${encodeURIComponent(ws)}/slack`).catch(() => undefined),
    hub<{ id: string; name: string }[]>(`/workspaces/${encodeURIComponent(ws)}/channels/joinable`).catch(() => []),
    myConversations(ws),
    myBilling().catch(() => undefined),
    siteOrigin(),
    hub<{ notes: CanvasNote[] }>(`/workspaces/${encodeURIComponent(ws)}/notes`).then((result) => ({ notes: result.notes, error: '' })).catch(() => ({ notes: [] as CanvasNote[], error: "Notes couldn't load. Reload the page to retry." })),
  ]);
  const waiting = canvas.waiting ?? (await hub<WaitingItem[]>('/waiting').catch(() => [] as WaitingItem[]));
  // My conversations here, for ⌘K's Unread and Recent (what the rail used to list).
  const recent: CanvasConversation[] = conversations.flatMap((c) => {
    const title = c.kind === 'channel' ? (c.channel ? `#${c.channel.name}` : undefined) : c.with?.name;
    if (!title) return [];
    return [{ key: c.key, title, preview: `${c.last.fromId === me.id ? 'You' : c.last.from}: ${c.last.text}`, unread: c.unread, ...(c.kind === 'channel' ? { mentions: c.mentions } : {}), ...(c.thread ? { thread: c.thread } : {}), updatedAt: c.updatedAt, ...(c.with ? { who: c.with } : {}) }];
  });
  const workspaces = me.workspaces.map(menuWorkspace);
  const onCanvas = new Set(canvas.agents.map((a) => a.id));
  const roster = workspaceRoster(members, onCanvas);
  return (
    <CrewCanvas
      ws={ws}
      workspaceName={workspace.name}
      shareUrl={workspace.public || workspace.publicShowcase ? `${origin}/p/w/${ws}` : undefined}
      me={{ id: me.id, name: me.name, avatar: me.avatar, kind: me.kind, admin: me.admin, hire: me.hire }}
      billing={billing && { plan: billing.plan, leftUsd: billing.leftUsd ?? 0, used: billing.used }}
      workspaces={workspaces}
      conversations={recent}
      logout={logout}
      initialCanvas={canvas}
      initialNotes={notesResult.notes}
      notesError={notesResult.error}
      canUseNotes={canUseNotes}
      guest={!canUseNotes}
      workspaceOwner={workspace.owner}
      initialWaiting={waiting.filter((w) => !w.channelId || canvas.teams.some((t) => t.channelId === w.channelId))}
      allWorkspaceAgents={roster}
      slackChannels={slackStatus?.channels ?? []}
      joinableChannels={joinable}
    />
  );
}
