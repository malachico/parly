/** Cloud sessions cross only Parly's first-party hosts; previews and self-hosts stay host-only. */
export const TOKEN_COOKIE = 'hub_token';
export const SHARED_TOKEN_COOKIE = '__Secure-parly_session';
/**
 * The configured public origin: NEXT_PUBLIC_SITE_URL, or parly.dev on Vercel production. When set, public URLs
 * come from it. Cookie sharing still requires the request Host to be parly.dev (host-only fallback on
 * *.vercel.app aliases and anything else). Unset in dev and previews, which follow the request.
 */
export function pinnedOrigin(): string | undefined {
  const url = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_ENV === 'production' ? 'https://parly.dev' : '');
  return url ? url.replace(/\/+$/, '') : undefined;
}

/** Shared `.parly.dev` cookie only when the request is actually on parly.dev and pinning allows it. */
export const cloudAuthHost = (host: string) => {
  const h = host.toLowerCase().split(':')[0];
  if (h !== 'parly.dev') return false;
  const pinned = pinnedOrigin();
  return !pinned || new URL(pinned).hostname === 'parly.dev';
};

/** Secure cookies when on parly.dev cloud, or when COOKIE_SECURE says so (else production default). */
export function cookieSecure(host = ''): boolean {
  return cloudAuthHost(host) || (process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : process.env.NODE_ENV === 'production');
}

export function authCookie(host: string) {
  const cloud = cloudAuthHost(host);
  return {
    name: cloud ? SHARED_TOKEN_COOKIE : TOKEN_COOKIE,
    ...(cloud ? { domain: '.parly.dev' } : {}),
    secure: cookieSecure(host),
    httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 365,
  };
}

export function authToken(jar: { get(name: string): { value: string } | undefined }, host: string): string | undefined {
  return (cloudAuthHost(host) ? jar.get(SHARED_TOKEN_COOKIE)?.value : undefined) || jar.get(TOKEN_COOKIE)?.value;
}
