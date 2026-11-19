import { createHash } from 'node:crypto';
import type { Database } from '../db/types.js';
import { Storage } from '@google-cloud/storage';
import { COLLECTIONS } from '../db/types.js';
import type { FileRecord } from './files.js';

/** What GCS reports about an uploaded object. `md5` is base64, as GCS stores it. */
interface StoredObject {
  size: number;
  md5: string;
  contentType: string;
}

/**
 * Where file bytes live. Two implementations: GCS in production, memory in tests (there is no
 * GCS emulator). Signed URLs let clients move bytes without passing through the hub.
 */
export interface FileStore {
  /** A URL that accepts exactly one PUT of these bytes: GCS rejects another size, type or md5. */
  signedPut(key: string, opts: { contentType: string; md5: string; size: number; ttlMs: number }): Promise<{ url: string; headers: Record<string, string> }>;
  /** A short-lived download URL. `inline` lets a browser show it (safe images only); otherwise it downloads. */
  signedGet(key: string, opts: { filename: string; inline: boolean; ttlMs: number }): Promise<string>;
  stat(key: string): Promise<StoredObject | undefined>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
}

export class GcsFileStore implements FileStore {
  private readonly bucket;

  constructor(bucketName: string, storage = new Storage()) {
    this.bucket = storage.bucket(bucketName);
  }

  async signedPut(key: string, opts: { contentType: string; md5: string; size: number; ttlMs: number }) {
    const headers = { 'content-type': opts.contentType, 'content-md5': opts.md5, 'x-goog-content-length-range': `${opts.size},${opts.size}` };
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + opts.ttlMs,
      contentType: opts.contentType,
      contentMd5: opts.md5,
      extensionHeaders: { 'x-goog-content-length-range': headers['x-goog-content-length-range'] },
    });
    return { url, headers };
  }

  async signedGet(key: string, opts: { filename: string; inline: boolean; ttlMs: number }) {
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + opts.ttlMs,
      responseDisposition: contentDisposition(opts.filename, opts.inline),
    });
    return url;
  }

  async stat(key: string): Promise<StoredObject | undefined> {
    try {
      const [meta] = await this.bucket.file(key).getMetadata();
      return { size: Number(meta.size), md5: String(meta.md5Hash ?? ''), contentType: String(meta.contentType ?? '') };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return undefined;
      throw err;
    }
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    await this.bucket.file(key).save(bytes, { contentType, resumable: false, validation: 'md5' });
  }
}

/** Test double. "Signed" URLs are fake strings; `upload` stands in for the client's PUT. */
export class MemoryFileStore implements FileStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async signedPut(key: string, opts: { contentType: string; md5: string; size: number }) {
    return { url: `memory://put/${key}`, headers: { 'content-type': opts.contentType, 'content-md5': opts.md5 } };
  }
  async signedGet(key: string, opts: { filename: string; inline: boolean; ttlMs: number }) {
    return `memory://get/${key}?ttl=${opts.ttlMs}&disposition=${encodeURIComponent(contentDisposition(opts.filename, opts.inline))}`;
  }
  async stat(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.length, md5: md5Base64(o.bytes), contentType: o.contentType } : undefined;
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    this.objects.set(key, { bytes, contentType });
  }
}

export function md5Base64(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('base64');
}

/** RFC 6266 disposition with an ASCII fallback name and the real name in filename*. */
function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** `files/{id}`: file records (metadata in the DB; the bytes are in a FileStore). */
export class FileRecordStore {
  constructor(private readonly db: Database) {}

  private get col() {
    return this.db.collection(COLLECTIONS.files);
  }

  async add(record: FileRecord): Promise<void> {
    await this.col.doc(record.id).create(record);
  }

  async markReady(id: string): Promise<void> {
    await this.col.doc(id).update({ status: 'ready' });
  }

  async record(id: string): Promise<FileRecord | undefined> {
    const snap = await this.col.doc(id).get();
    if (!snap.exists) return undefined;
    return snap.data() as FileRecord;
  }
}
