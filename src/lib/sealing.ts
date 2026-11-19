import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Seals small secrets at rest (AES-256-GCM): Database holds only ciphertext, so read access to the
 * database alone doesn't reveal them. The 32-byte key comes from CREDENTIALS_KEY (a Secret Manager
 * secret on Cloud Run). ponytail: one static key; move to Cloud KMS (per-decrypt IAM, audit, rotation) if needed.
 */
export function parseSealingKey(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
}

export function unseal(sealed: string, key: Buffer): string {
  if (!sealed.startsWith('v1.')) throw new Error('Unknown sealed format');
  const raw = Buffer.from(sealed.slice(3), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/** Whether two secrets are the same, compared in constant time (different byte lengths are simply different). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
