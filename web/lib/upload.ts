import SparkMD5 from 'spark-md5';
import { completeUpload, startUpload } from '@/lib/actions/chat';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function uploadFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Files are limited to 25MB');
  if (file.size === 0) throw new Error('This file is empty');
  // Storage checks the MD5 the URL was signed for, so only these exact bytes are accepted.
  const md5 = btoa(SparkMD5.ArrayBuffer.hash(await file.arrayBuffer(), true));
  const started = await startUpload({ name: file.name, mediaType: file.type || 'application/octet-stream', size: file.size, md5 });
  if (!started.ok) throw new Error(started.error);
  const put = await fetch(started.url, { method: 'PUT', headers: started.headers, body: file });
  if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
  const done = await completeUpload(started.id);
  if (!done.ok) throw new Error(done.error);
  return started.id;
}
