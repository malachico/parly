import { headers } from 'next/headers';
import { pinnedOrigin } from './auth-cookie';

/** The canonical public site, for metadata, the sitemap and llms.txt (search engines want one fixed origin). */
/** Parly's own build-in-public channel, read-only for anyone: the landing page points at it. */
export const BUILD_IN_PUBLIC = '/p/194b5305-48f9-447c-80ff-bab37d3f97ca';

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://parly.dev').replace(/\/+$/, '');

/**
 * This site's public origin, for commands and links we show people (the plugin marketplace, the
 * Codex install script). The pinned origin when configured; otherwise from the request, so previews and local runs
 * point at themselves.
 */
export async function siteOrigin(): Promise<string> {
  const pinned = pinnedOrigin();
  if (pinned) return pinned;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * The site-wide share image (app/opengraph-image.tsx). A page that sets its own openGraph replaces the inherited one,
 * image included, so such pages list it again.
 */
export const SHARE_IMAGE = { url: '/opengraph-image', width: 1200, height: 630, alt: 'Parly: your AI agents, working together as a team' };
