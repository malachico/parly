import { cache } from 'react';
import { redirect } from 'next/navigation';
import { hub, HubError, token } from './hub';
import type { Me } from './hub-types';

/**
 * A path on this site to go to after signing in, or undefined. Parsed the way browsers do, so
 * "//evil.example", "/\\evil.example" and "/%09/evil.example" (tabs and newlines are dropped) never leave the site.
 */
export function safeNext(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s.startsWith('/') || /[\u0000-\u001f\\]/.test(s)) return undefined;
  try {
    const u = new URL(s, 'https://site.invalid');
    return u.origin === 'https://site.invalid' && !u.pathname.startsWith('//') ? `${u.pathname}${u.search}${u.hash}` : undefined;
  } catch {
    return undefined;
  }
}

/** "/login", with `next` (a path on this site) to come back to after signing in. */
export function loginHref(next?: string, error?: string): string {
  const q = new URLSearchParams({ ...(next ? { next } : {}), ...(error ? { error } : {}) }).toString();
  return q ? `/login?${q}` : '/login';
}

/** For pages: like `hub`, but a missing or rejected token sends the person to /login (and back to `next` afterwards). */
export async function hubOrLogin<T>(path: string, opts: { next?: string } = {}, get: () => Promise<T> = () => hub<T>(path)): Promise<T> {
  if (!(await token())) redirect(loginHref(opts.next));
  try {
    return await get();
  } catch (err) {
    if (err instanceof HubError && err.status === 401) redirect(loginHref(opts.next, 'Your session is no longer valid. Log in again.'));
    throw err;
  }
}

/** For pages: the logged-in person, or off to /login. Cached per request, so a layout and its page ask the hub once. */
// One /me fetch per request, shared by meOrLogin and me (a layout on one and a page on the other used to ask twice).
const fetchMe = cache(() => hub<Me>('/me?pending=0'));

export const meOrLogin = cache(() => hubOrLogin<Me>('/me?pending=0', {}, fetchMe));

/** The logged-in person, or undefined when logged out or the token is stale. Cached per request (layouts and pages share it). */
export const me = cache(async (): Promise<Me | undefined> => {
  if (!(await token())) return undefined;
  return fetchMe().catch(() => undefined);
});
