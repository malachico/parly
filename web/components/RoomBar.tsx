import { AccountMenu, WorkspaceMenu } from '@/components/AccountMenu';
import { RoomClose } from '@/components/RoomClose';
import { logout } from '@/lib/actions';
import type { Me, Workspace } from '@/lib/hub';
import { menuWorkspace } from '@/lib/menuWorkspace';

/** A Shared Room's only chrome: the canvas's account and workspace menus, so you can still leave the room. */
export async function RoomBar({ me, workspace }: { me: Me; workspace: Workspace }) {
  return (
    <div className="relative z-20 flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] p-1">
      <AccountMenu me={{ id: me.id, name: me.name, avatar: me.avatar, admin: me.admin }} logout={logout} />
      <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-[var(--border)]" />
      <WorkspaceMenu ws={workspace.id} workspaceName={workspace.name} workspaces={me.workspaces.map(menuWorkspace)} />
      <RoomClose ws={workspace.id} shared={workspace.room!.shared} corner={workspace.room!.mySide?.corner} />
    </div>
  );
}
