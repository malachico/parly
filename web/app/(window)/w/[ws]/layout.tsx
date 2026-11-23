import { cookies } from 'next/headers';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { CanvasHome } from '@/components/CanvasHome';
import { FindDialog } from '@/components/FindDialog';
import { HireAgentDialog } from '@/components/HireAgentDialog';
import { KeepAliveBoundary } from '@/components/KeepAliveBoundary';
import { NewChannelDialog } from '@/components/NewChannelDialog';
import { NewWorkspaceDialog } from '@/components/NewWorkspaceDialog';
import { PanelSlot } from '@/components/PanelSlot';
import { RememberWorkspace } from '@/components/RememberWorkspace';
import { RoomBar } from '@/components/RoomBar';
import { Tour } from '@/components/Tour';
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
  if (!workspace) notFound();
  return (
    <>
      <RememberWorkspace workspaceId={workspace.id} remembered={(await cookies()).get(WORKSPACE_COOKIE)?.value} />
      {workspace.room ? (
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-clip">
          {/* Its own boundary: the chat never waits for the bar's data. */}
          <Suspense fallback={<div className="h-[53px] shrink-0 border-b border-[var(--border)] bg-[var(--surface)]" />}>
            <RoomBar me={user} workspace={workspace} />
          </Suspense>
          <KeepAliveBoundary className="flex min-h-0 min-w-0 flex-1">{children}</KeepAliveBoundary>
        </div>
      ) : (
        <div className="relative flex h-full min-w-0 flex-1 overflow-clip">
          {/* Its own boundary: a panel never waits for the canvas's data (and the canvas keeps showing while it refreshes). */}
          <KeepAliveBoundary className="flex h-full min-w-0 flex-1">
            <Suspense fallback={<div className="h-full flex-1 bg-[var(--bg)]" />}>
              <CanvasHome me={user} workspace={workspace} />
            </Suspense>
          </KeepAliveBoundary>
          <KeepAliveBoundary className="contents">
            <PanelSlot ws={workspace.id}>{children}</PanelSlot>
          </KeepAliveBoundary>
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
      {!workspace.room && <Tour />}
    </>
  );
}

