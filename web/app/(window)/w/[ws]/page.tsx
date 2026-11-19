import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { EscClose } from '@/components/EscClose';
import { WorkspacePanel } from '@/components/WorkspacePanel';
import { hub, meOrLogin, type Agent, type Invite, type WorkspaceSlackStatus, type WorkspaceTelegramStatus } from '@/lib/hub';
import { roomHomeHref, wsHref } from '@/lib/routes';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> };

/**
 * Workspace home (`PLAN-CANVAS.md`): the canvas is rendered by the workspace layout, so the home route renders nothing
 * unless `?panel=workspace` opens the workspace details panel over the canvas. A Shared Room has no canvas: it opens on
 * its shared chat, with any dialog params carried along.
 */
export default async function WorkspaceHome({ params, searchParams }: Props) {
  const { ws } = await params;
  const query = await searchParams;
  const { panel, slack, error } = query;
  const me = await meOrLogin();
  const workspace = me.workspaces.find((w) => w.id === ws);
  if (!workspace) notFound();
  if (panel !== 'workspace') {
    // Rooms are the shared chat and the corner: no ?channel=new here.
    if (workspace.room) redirect(roomHomeHref(ws, workspace.room, { ...query, channel: undefined }));
    return null; // The canvas alone (closing a chat lands here): the layout draws it.
  }

  const [members, invites, visible, slackStatus, telegramStatus, jar] = await Promise.all([
    hub<Agent[]>(`/agents?workspace=${encodeURIComponent(ws)}`).catch(() => [] as Agent[]),
    hub<Invite[]>(`/workspaces/${encodeURIComponent(ws)}/invites`).catch(() => [] as Invite[]),
    hub<Agent[]>('/agents').catch(() => [] as Agent[]),
    hub<WorkspaceSlackStatus>(`/workspaces/${encodeURIComponent(ws)}/slack`).catch(() => undefined),
    hub<WorkspaceTelegramStatus>(`/workspaces/${encodeURIComponent(ws)}/telegram`).catch(() => undefined),
    cookies(),
  ]);
  // ponytail: every bot I can see, in one <select>; a search box when the public directory gets long
  const candidates = visible.filter((a) => a.kind !== 'human' && !a.archived && !a.workspaces.includes(ws));
  const hasOtherWorkspace = me.workspaces.some((w) => w.id !== ws && !w.archived && !w.room);
  return (
    <>
      <EscClose href={wsHref(ws)} />
      <WorkspacePanel
        workspace={workspace}
        meId={me.id}
        members={members}
        invites={invites}
        candidates={candidates}
        hasOtherWorkspace={hasOtherWorkspace}
        invited={jar.get('flash_invited')?.value}
        slack={slackStatus}
        slackInstalled={slack === 'installed'}
        telegram={telegramStatus}
        error={error}
        closeHref={wsHref(ws)}
      />
    </>
  );
}




