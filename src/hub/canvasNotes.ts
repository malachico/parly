import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import { isOwner } from '../lib/admin.js';
import { newId, nowIso } from '../lib/wire.js';
import { isShowcaseGuest, type Registry } from '../registry/registry.js';
import type { AgentRecord, CanvasBox } from '../registry/types.js';
import type { Files, FileRecord } from '../files/files.js';
import { HubStore } from './hubStore.js';

export interface CanvasNote {
  id: string;
  workspaceId: string;
  authorId: string;
  text: string;
  files: { id: string; name: string; mediaType: string }[];
  canvas: CanvasBox;
  createdAt: string;
  updatedAt: string;
  version: number;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const validId = (id: string) => {
  if (!id || id.length > 200 || /[/\\]/.test(id) || id === '.' || id === '..') throw new HubError('invalid', 'Invalid note or file id');
  return id;
};

/** Workspace notes: any member reads them (showcase guests included); only full members create, edit or delete. */
export class CanvasNotes {
  private readonly store: HubStore;

  constructor(db: Database, private readonly registry: Registry, private readonly files: Files) {
    this.store = new HubStore(db);
  }

  private async workspace(caller: AgentRecord, workspaceId: string, write = false) {
    const workspace = await this.registry.requireWorkspaceMembership(caller, validId(workspaceId));
    if (write && isShowcaseGuest(workspace, caller)) throw new HubError('forbidden', 'Showcase guests can read notes but not change them');
    return workspace;
  }

  async list(caller: AgentRecord, workspaceId: string): Promise<CanvasNote[]> {
    await this.workspace(caller, workspaceId);
    const rows = await this.store.listNotes(workspaceId);
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(caller: AgentRecord, workspaceId: string, id: string): Promise<CanvasNote> {
    await this.workspace(caller, workspaceId);
    const note = await this.store.getNote(workspaceId, validId(id));
    if (!note) throw new HubError('not_found', 'Note not found');
    return note;
  }

  async save(caller: AgentRecord, workspaceId: string, input: unknown, id?: string): Promise<CanvasNote> {
    const workspace = await this.workspace(caller, workspaceId, true);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HubError('invalid', 'A note must be an object');
    const body = input as Record<string, unknown>;
    const previous = id ? await this.get(caller, workspaceId, id) : undefined;
    if (previous && previous.authorId !== caller.id && !isOwner(workspace, caller)) throw new HubError('forbidden', 'Only the author or workspace owner can change a note');
    if (previous && body.version !== previous.version) throw new HubError('conflict', 'This note changed. Reload before saving');
    const text = body.text === undefined ? previous?.text ?? '' : body.text;
    if (typeof text !== 'string' || text.length > 20_000) throw new HubError('invalid', 'Note text is limited to 20000 characters');
    const fileIds = body.files === undefined ? previous?.files.map((file) => file.id) ?? [] : body.files;
    if (!Array.isArray(fileIds) || fileIds.length > 10 || !fileIds.every((file) => typeof file === 'string')) throw new HubError('invalid', 'A note supports up to 10 image file ids');
    const ids = [...new Set((fileIds as string[]).map(validId))];
    const newFiles = ids.filter((fileId) => !previous?.files.some((file) => file.id === fileId));
    // Only ready, caller-owned uploads can become new attachments; retained files stay usable by an owner editing.
    await this.files.partsFor(caller, newFiles);
    const files = await Promise.all(ids.map(async (fileId) => {
      const file = await this.files.get(fileId);
      if (!file || file.status !== 'ready' || !IMAGE_TYPES.has(file.mediaType)) throw new HubError('invalid', 'Notes accept ready PNG, JPEG, GIF or WebP uploads');
      return { id: file.id, name: file.name, mediaType: file.mediaType };
    }));
    if (!text.trim() && !files.length) throw new HubError('invalid', 'Add text or an image to the note');
    const box = (body.canvas ?? previous?.canvas) as CanvasBox | undefined;
    const finite = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
    if (!finite(box?.x, -1e6, 1e6) || !finite(box?.y, -1e6, 1e6) || !finite(box?.w, 180, 2000) || !finite(box?.h, 120, 2000)) throw new HubError('invalid', 'Note canvas needs finite x/y and width 180–2000, height 120–2000');
    const now = nowIso();
    const note: CanvasNote = {
      id: previous?.id ?? newId(), workspaceId, authorId: previous?.authorId ?? caller.id,
      text, files, canvas: { x: Math.round(box!.x), y: Math.round(box!.y), w: Math.round(box!.w), h: Math.round(box!.h) },
      createdAt: previous?.createdAt ?? now, updatedAt: now, version: (previous?.version ?? 0) + 1,
    };
    if (!previous) {
      await this.store.createNote(workspaceId, note);
    } else if (!(await this.store.updateNoteIfVersion(workspaceId, note, previous.version))) {
      throw new HubError('conflict', 'This note changed. Reload before saving');
    }
    return note;
  }

  async delete(caller: AgentRecord, workspaceId: string, id: string, version: unknown): Promise<void> {
    const workspace = await this.workspace(caller, workspaceId, true);
    await this.store.deleteNote(workspaceId, validId(id), (note) => {
      if (note.authorId !== caller.id && !isOwner(workspace, caller)) throw new HubError('forbidden', 'Only the author or workspace owner can delete a note');
      if (version !== note.version) throw new HubError('conflict', 'This note changed. Reload before deleting');
    });
  }

  async file(caller: AgentRecord, workspaceId: string, id: string, fileId: string): Promise<FileRecord> {
    const note = await this.get(caller, workspaceId, id);
    if (!note.files.some((file) => file.id === validId(fileId))) throw new HubError('not_found', 'Note attachment not found');
    const file = await this.files.get(fileId);
    if (!file || file.status !== 'ready') throw new HubError('not_found', 'Note attachment not found');
    return file;
  }
}
