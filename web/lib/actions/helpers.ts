import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HubError } from '../hub';
import { authCookie, cloudAuthHost, cookieSecure, SHARED_TOKEN_COOKIE, TOKEN_COOKIE } from '../auth-cookie';
import { agentHref, channelHref, wsHref } from '../routes';

export const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

/** Runs `fn`; a hub error sends the person back to `back` with the message shown. */
export async function attempt<T>(back: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HubError) {
      // The query goes before any #anchor, or the browser keeps it in the anchor and the error is lost.
      const [path, hash] = back.split('#');
      redirect(`${path}${path!.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}${hash ? `#${hash}` : ''}`);
    }
    throw err;
  }
}

export async function setToken(value: string) {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  const { name, ...policy } = authCookie(requestHeaders.get('host') ?? '');
  if (name !== TOKEN_COOKIE) jar.set(TOKEN_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  jar.set(name, value, policy);
}

export async function clearToken() {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  const host = requestHeaders.get('host') ?? '';
  const { name: _name, ...policy } = authCookie(host);
  jar.set(TOKEN_COOKIE, '', { ...policy, domain: undefined, maxAge: 0 });
  if (cloudAuthHost(host)) jar.set(SHARED_TOKEN_COOKIE, '', { ...policy, maxAge: 0 });
}

/** A secret or notice shown once on the next page view; it rides in a short-lived cookie instead of the URL. */
export async function setFlash(name: string, value: string, path = '/') {
  const host = (await headers()).get('host') ?? '';
  // Same Secure policy as the session cookie (#36): http self-hosts with COOKIE_SECURE=0 keep flash tokens.
  (await cookies()).set(name, value, {
    httpOnly: true,
    secure: cookieSecure(host),
    sameSite: 'lax',
    path,
    maxAge: 120,
  });
}

/** Reads a JSON flash cookie set by setFlash; undefined when it is missing or not JSON. */
export async function readFlash<T>(name: string): Promise<T | undefined> {
  try {
    return JSON.parse((await cookies()).get(name)?.value ?? '') as T;
  } catch {
    return undefined;
  }
}

/** Where the connect page returns to, keeping the chosen client tab. */
export const connectBack = (client: string) => `/connect?client=${encodeURIComponent(client)}`;

/** Workspace details: where workspace admin actions return to. */
export const workspaceDetails = (ws: string) => wsHref(ws, { panel: 'workspace' });

/** Channel details: where channel admin actions return to. */
export const channelDetails = (ws: string, channelId: string) => channelHref(ws, channelId, { panel: 'channel' });

/**
 * The agent page to come back to: the full profile, or just its tools or triggers when that's where the form was
 * (`only`, a hidden field), with any other query (`?trigger=`) and the section's anchor.
 */
export function agentPage(ws: string, agentId: string, form: FormData | undefined, hash: string, query: Record<string, string> = {}) {
  const only = form?.get('only');
  const q = new URLSearchParams({ ...(only === 'tools' || only === 'triggers' ? { only } : {}), ...query }).toString();
  return `${agentHref(ws, agentId)}${q ? `?${q}` : ''}${hash}`;
}
