import type { Workspace } from '@/lib/hub';

// Plain module (not 'use client') so server components like CanvasHome can call menuWorkspace().
export type MenuWorkspace = {
  id: string;
  name: string;
  archived?: boolean;
  public?: boolean;
  /** A shared room: who's across the table, whether my side still needs setting up, and the app that opened it. */
  room?: { others: string[]; needsSetup: boolean; appId?: string; app?: { id: string; name: string; workspaceId: string } };
};

/** A workspace as the menu shows it. An app's room has the app's agents on both sides: nothing there for me to set up. */
export function menuWorkspace(w: Workspace): MenuWorkspace {
  return {
    id: w.id,
    name: w.name,
    archived: w.archived,
    ...(w.public || w.publicShowcase ? { public: true } : {}),
    ...(w.room ? { room: { others: w.room.sides.filter((s) => s.id !== w.room!.mySide?.id).map((s) => s.name), needsSetup: !w.room.mySide && !w.room.appId, ...(w.room.appId ? { appId: w.room.appId } : {}), ...(w.room.app ? { app: w.room.app } : {}) } } : {}),
  };
}
