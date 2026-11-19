import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Self-hosted sign-in (PASSWORD_LOGIN=1): passwords stored as `scrypt$N$r$p$salt$hash` (base64url), per OWASP. */
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LEN = 32;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...opts, maxmem: 256 * opts.N! * opts.r! }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = (stored ?? '').split('$');
  // No hash: still spend the time, so a missing account doesn't answer faster than a wrong password.
  if (alg !== 'scrypt' || !salt || !hash) {
    await derive(password, randomBytes(16), { N, r: R, p: P });
    return false;
  }
  const want = Buffer.from(hash, 'base64url');
  const got = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}
