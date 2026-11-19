import { cookies, headers } from 'next/headers';
import { authToken } from '@/lib/auth-cookie';

/** Whether this browser holds a session cookie (httpOnly, so the static site header asks here). No hub call. */
export async function GET() {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  // ponytail: cookie presence, not a hub-validated session; a stale token shows "Back" until the next page that checks
  return Response.json({ signedIn: Boolean(authToken(jar, requestHeaders.get('host') ?? '')) }, { headers: { 'cache-control': 'private, no-store' } });
}
