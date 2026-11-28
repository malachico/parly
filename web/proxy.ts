import { NextResponse, type NextRequest } from 'next/server';

import { authToken } from './lib/auth-cookie';
import { WORKSPACE_COOKIE } from './lib/routes';
const HUB_URL = (process.env.HUB_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

/**
 * A channel's link in the app (/w/<ws>/c/channel:<id>, or /c/channel:<id>) opened by someone signed out: when the
 * channel, or the thread in ?thread=, is public, it opens read-only at /p/<id> instead of asking them to log in.
 * Anything else carries on to the page, which sends them to /login as before. And "/": the landing page signed out,
 * your workspace signed in.
 */
export async function proxy(request: NextRequest) {
  const host = request.headers.get('host') ?? request.nextUrl.host;
  // Talent moved out of Parly: it is Shyhire now.
  if (host.toLowerCase().split(':')[0] === 'talent.parly.dev') return NextResponse.redirect('https://shyhire.com');
  if (authToken(request.cookies, host)) {
    const { pathname } = request.nextUrl;
    if (pathname !== '/' && pathname !== '/connect') return NextResponse.next();
    // "/" and "/connect" go straight to the remembered workspace, same query, without a /me round trip. A stale
    // cookie (removed from it) is sent back to /home by the workspace layout.
    const remembered = request.cookies.get(WORKSPACE_COOKIE)?.value;
    if (remembered) {
      const to = request.nextUrl.clone();
      to.pathname = `/w/${encodeURIComponent(remembered)}${pathname === '/' ? '' : '/connect'}`;
      return NextResponse.redirect(to);
    }
    // No cookie: "/connect" picks one itself; "/" is the static landing page, so someone signed in gets
    // their workspace instead (app/(window)/home), same query.
    if (pathname !== '/') return NextResponse.next();
    const home = request.nextUrl.clone();
    home.pathname = '/home';
    return NextResponse.rewrite(home);
  }
  const m = /^\/(?:w\/[^/]+\/)?c\/([^/]+)$/.exec(request.nextUrl.pathname);
  const key = m ? safeDecode(m[1]!) : undefined;
  const channel = key?.startsWith('channel:') ? key.slice('channel:'.length) : undefined;
  if (!channel) return NextResponse.next();
  const thread = request.nextUrl.searchParams.get('thread') ?? undefined;
  const id = encodeURIComponent(channel);
  const path = thread ? `/public/channels/${id}/threads/${encodeURIComponent(thread)}` : `/public/channels/${id}?limit=1`;
  // ponytail: short timeout — middleware must not hang the request if the hub is down (#18)
  const open = await fetch(`${HUB_URL}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(3_000) }).then((r) => r.ok, () => false);
  if (!open) return NextResponse.next();
  const to = new URL(`/p/${id}`, request.url);
  if (thread) to.searchParams.set('thread', thread);
  return NextResponse.redirect(to);
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

export const config = {
  matcher: [
    '/',
    '/connect',
    '/w/:ws/c/:key',
    '/c/:key',
    { source: '/((?!_next/|_vercel/|favicon.ico|icon.png|apple-icon.png|robots.txt|sitemap.xml|manifest.webmanifest).*)', has: [{ type: 'host', value: 'talent.parly.dev' }] },
  ],
};
