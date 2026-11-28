import { cookies } from 'next/headers';
import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { CanvasBoundary } from '@/components/CanvasBoundary';
import { CanvasHome } from '@/components/CanvasHome';
import { CanvasSkeleton } from '@/components/CanvasSkeleton';
import { FindDialog } from '@/components/FindDialog';
import { HireAgentDialog } from '@/components/HireAgentDialog';
import { NewChannelDialog } from '@/components/NewChannelDialog';
import { NewWorkspaceDialog } from '@/components/NewWorkspaceDialog';
import { PanelSlot } from '@/components/PanelSlot';
import { RememberWorkspace } from '@/components/RememberWorkspace';
import { RoomBar } from '@/components/RoomBar';
import { meOrLogin } from '@/lib/hub';
import { WORKSPACE_COOKIE } from '@/lib/routes';

type Props = { children: React.ReactNode; params: Promise<{ ws: string }> };

/**
 * One workspace, one view: the crew canvas, with whatever is open (a conversation, a profile, details) as a panel
 * over it. Channels and DMs are in ⌘K; workspaces and the account in the avatar menu on the canvas. A Shared Room has
 * no canvas: its chat fills the window under a slim bar with those same menus.
 */
export default async function WorkspaceLayout({ children, params }: Props) {
  const { ws } = await params;
  const user = await meOrLogin();
  const workspace = user.workspaces.find((w) => w.id === ws);
  if (!workspace) {
    // proxy.ts sends "/" and "/connect" here from the cookie alone: a stale one (removed from it) falls back to /home's pick.
    if ((await cookies()).get(WORKSPACE_COOKIE)?.value === ws) redirect('/home');
    notFound();
  }
  return (
    <>
      <RememberWorkspace workspaceId={workspace.id} />
      {workspace.room ? (
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-clip">
          {/* Its own boundary: the chat never waits for the bar's data. */}
          <Suspense fallback={<div className="h-[53px] shrink-0 border-b border-[var(--border)] bg-[var(--surface)]" />}>
            <RoomBar me={user} workspace={workspace} />
          </Suspense>
          <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
        </div>
      ) : (
        <div className="relative flex h-full min-w-0 flex-1 overflow-clip">
          {/* Its own boundary: a panel never waits for the canvas's data (and the canvas keeps showing while it refreshes). */}
          <div className="flex h-full min-w-0 flex-1">
            {/* error.tsx can't catch its own layout: without this a canvas failure would take the open panel with it. */}
            <CanvasBoundary>
              <Suspense fallback={<CanvasSkeleton />}>
                <CanvasHome me={user} workspace={workspace} />
              </Suspense>
            </CanvasBoundary>
          </div>
          <PanelSlot ws={workspace.id}>{children}</PanelSlot>
        </div>
      )}
      {/* Opened by ?find=, ?channel=new, ?hire=1 and ?workspace=new. */}
      <FindDialog workspaceId={workspace.id} channels={(workspace.channels ?? []).map((c) => ({ id: c.id, name: c.name }))} meId={user.id} graph={user.graph} />
      {user.hire && (
        <HireAgentDialog
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          participants={workspace.participants}
          canUpgrade={workspace.owners?.[0] === user.id}
        />
      )}
      {!workspace.room && <NewChannelDialog workspaceId={workspace.id} workspaceName={workspace.name} />}
      <NewWorkspaceDialog />
    </>
  );
}

