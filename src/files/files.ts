import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import { newId, nowIso, type WirePart } from '../lib/wire.js';
import type { AgentRecord } from '../registry/types.js';
import { FileRecordStore, md5Base64, type FileStore } from './store.js';

/** Stored file document (collection `files`, doc id = file id). Bytes live in the FileStore under `key`. */
export interface FileRecord {
  id: string;
  ownerId: string;
  name: string;
  mediaType: string;
  size: number;
  /** base64 MD5, bound into the upload URL so GCS rejects other bytes. */
  md5: string;
  key: string;
  status: 'pending' | 'ready';
  createdAt: string;
  /** A TTL index deletes the record after this; a bucket lifecycle rule deletes the bytes. */
  expiresAt: Date;
}

/** Shown in browsers (images and video); everything else downloads. Never SVG or HTML (they can run script). */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']);
/** Bigger files go through a signed upload URL instead of the MCP request body. */
export const INLINE_UPLOAD_MAX = 5 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;
const UPLOAD_URL_TTL_MS = 15 * 60_000;
/** Download links for hub users (who reach them via GET /files/:id) and for endpoint agents (no hub token). */
const DOWNLOAD_TTL_MS = 5 * 60_000;
const ENDPOINT_DOWNLOAD_TTL_MS = 60 * 60_000;

interface FileView {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  status: FileRecord['status'];
}

export function fileView(f: FileRecord): FileView {
  return { id: f.id, name: f.name, mediaType: f.mediaType, size: f.size, status: f.status };
}

/**
 * File uploads and attachments. Uploading is owner-only; who may download is decided by the
 * messages a file is attached to (HubService.fileForDownload), so attaching never needs its own
 * write. Without a store (FILES_BUCKET unset) every call says uploads aren't configured.
 */
export class Files {
  /**
   * File parts made by partsFor in this process. Only these may carry a fileId: anything that
   * arrives over the wire (A2A messages, artifacts, endpoint agents' replies) can claim any
   * metadata, so it can't be what grants access to a file.
   */
  private readonly minted = new WeakSet<WirePart>();

  private readonly records: FileRecordStore;

  constructor(
    db: Database,
    private readonly store: FileStore | undefined,
    private readonly maxBytes: number,
    private readonly ttlMs: number,
    private readonly publicUrl: string,
  ) {
    this.records = new FileRecordStore(db);
  }

  private requireStore(): FileStore {
    if (!this.store) throw new HubError('unsupported', 'File uploads are not configured on this hub');
    return this.store;
  }

  /** Starts an upload: returns the URL the client PUTs the bytes to, with the headers it must send. */
  async create(caller: AgentRecord, input: { name?: string; mediaType?: string; size?: number; md5?: string }) {
    const store = this.requireStore();
    const record = this.newRecord(caller, input.name, input.mediaType, input.size);
    if (typeof input.md5 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(input.md5)) {
      throw new HubError('invalid', 'md5 must be the base64 MD5 of the file (24 characters)');
    }
    record.md5 = input.md5;
    const upload = await store.signedPut(record.key, { contentType: record.mediaType, md5: record.md5, size: record.size, ttlMs: UPLOAD_URL_TTL_MS });
    await this.records.add(record);
    return { file: fileView(record), upload: { method: 'PUT' as const, ...upload } };
  }

  /** Marks an upload ready once the stored object matches what was declared. */
  async complete(caller: AgentRecord, id: string): Promise<FileView> {
    const store = this.requireStore();
    const record = await this.owned(caller, id);
    if (record.status === 'ready') return fileView(record);
    const stored = await store.stat(record.key);
    if (!stored) throw new HubError('conflict', `Nothing uploaded for file ${id} yet`);
    if (stored.size !== record.size || stored.md5 !== record.md5 || stored.contentType !== record.mediaType) {
      throw new HubError('conflict', `Uploaded bytes for file ${id} don't match its declared size, md5 or type`);
    }
    await this.records.markReady(id);
    return fileView({ ...record, status: 'ready' });
  }

  /** Small files in one call (for MCP agents that can't PUT to a URL): the hub stores the bytes. */
  async uploadInline(caller: AgentRecord, input: { name?: string; mediaType?: string; contentBase64?: string }): Promise<FileView> {
    const store = this.requireStore();
    if (typeof input.contentBase64 !== 'string') throw new HubError('invalid', 'contentBase64 is required');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length > INLINE_UPLOAD_MAX) {
      throw new HubError('invalid', `Inline uploads are limited to ${INLINE_UPLOAD_MAX / 1024 / 1024}MB; use create_upload for bigger files`);
    }
    const record = this.newRecord(caller, input.name, input.mediaType, bytes.length);
    record.md5 = md5Base64(bytes);
    record.status = 'ready';
    await store.put(record.key, bytes, record.mediaType);
    await this.records.add(record);
    return fileView(record);
  }

  /** The file record, or undefined once it has expired (even before the TTL policy deletes it). */
  async get(id: string): Promise<FileRecord | undefined> {
    if (!id || id.includes('/')) return undefined;
    const f = await this.records.record(id);
    if (!f) return undefined;
    // Stored as a Timestamp, created as a Date.
    return expiresMs(f) > Date.now() ? f : undefined;
  }

  /**
   * Message parts for files the caller is attaching: theirs, and fully uploaded. The part's url is
   * the hub's own GET /files/:id, which checks access; `metadata.fileId` is what grants it.
   */
  async partsFor(caller: AgentRecord, ids: string[] | undefined): Promise<WirePart[]> {
    if (!ids?.length) return [];
    this.requireStore();
    if (ids.length > MAX_FILES_PER_MESSAGE) throw new HubError('invalid', `At most ${MAX_FILES_PER_MESSAGE} files per message`);
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        const f = await this.owned(caller, id);
        if (f.status !== 'ready') throw new HubError('conflict', `File ${id} hasn't finished uploading (call complete_upload)`);
        const part: WirePart = { url: `${this.publicUrl}/files/${f.id}`, filename: f.name, mediaType: f.mediaType, metadata: { fileId: f.id, size: f.size } };
        this.minted.add(part);
        return part;
      }),
    );
  }

  /** Drops file references the hub didn't mint; the rest of each part (text, a plain url) stays. */
  trusted(parts: WirePart[]): WirePart[] {
    return parts.map((p) => {
      if (this.minted.has(p) || p.metadata?.fileId === undefined) return p;
      const { fileId: _forged, ...metadata } = p.metadata;
      return { ...p, metadata };
    });
  }

  /**
   * A short-lived link to the bytes. The caller must already have passed the access check. `attachment` makes
   * the browser save it, even a type it would otherwise show (a video that plays inline still downloads).
   */
  downloadUrl(f: FileRecord, opts: { attachment?: boolean; ttlMs?: number } = {}): Promise<string> {
    const inline = !opts.attachment && INLINE_TYPES.has(f.mediaType);
    return this.requireStore().signedGet(f.key, { filename: f.name, inline, ttlMs: linkTtl(f, opts.ttlMs ?? DOWNLOAD_TTL_MS) });
  }

  /** Endpoint agents have no hub token, so their copies of file parts carry a signed link instead. */
  async forEndpoint(parts: WirePart[]): Promise<WirePart[]> {
    if (!this.store || !parts.some((p) => p.metadata?.fileId)) return parts;
    return Promise.all(
      parts.map(async (p) => {
        const id = p.metadata?.fileId;
        const f = typeof id === 'string' ? await this.get(id) : undefined;
        if (!f) return p;
        return { ...p, url: await this.store!.signedGet(f.key, { filename: f.name, inline: false, ttlMs: linkTtl(f, ENDPOINT_DOWNLOAD_TTL_MS) }) };
      }),
    );
  }

  private async owned(caller: AgentRecord, id: string): Promise<FileRecord> {
    const f = await this.get(id);
    if (!f || f.ownerId !== caller.id) throw new HubError('not_found', `File ${id} not found among your uploads`);
    return f;
  }

  private newRecord(caller: AgentRecord, name: unknown, mediaType: unknown, size: unknown): FileRecord {
    const cleanName = typeof name === 'string' ? name.split(/[\\/]/).pop()!.trim().slice(0, 200) : '';
    if (!cleanName) throw new HubError('invalid', 'name is required');
    const type = mediaType === undefined || mediaType === '' ? 'application/octet-stream' : mediaType;
    if (typeof type !== 'string' || type.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(type)) throw new HubError('invalid', 'mediaType must look like "image/png"');
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) throw new HubError('invalid', 'size must be a positive whole number of bytes');
    if (size > this.maxBytes) throw new HubError('invalid', `Files are limited to ${Math.round(this.maxBytes / 1024 / 1024)}MB`);
    const id = newId();
    return {
      id,
      ownerId: caller.id,
      name: cleanName,
      mediaType: type.toLowerCase(),
      size,
      md5: '',
      key: `files/${id}`,
      status: 'pending',
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + this.ttlMs),
    };
  }
}

/** expiresAt as epoch ms: a Date when created, a Timestamp when read back. */
function expiresMs(f: FileRecord): number {
  const e = f.expiresAt as unknown as { toMillis?: () => number; getTime?: () => number };
  return e.toMillis?.() ?? e.getTime?.() ?? 0;
}

/** A signed link never outlives the file it points to. */
function linkTtl(f: FileRecord, wanted: number): number {
  return Math.max(1000, Math.min(wanted, expiresMs(f) - Date.now()));
}
