import { HUB_URL } from '@/lib/hub';

export const dynamic = 'force-dynamic';

/**
 * Public channel attachment: browser hits this origin, we follow the hub's short-lived redirect.
 * Keeps docker-internal `HUB_URL` (e.g. http://hub:8080) out of HTML (#37).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const download = new URL(req.url).searchParams.get('download') ? '?download=1' : '';
  const res = await fetch(`${HUB_URL}/public/channels/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}${download}`, {
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!res) return Response.json({ error: 'File not found' }, { status: 404 });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    // ponytail: `location` is a short-lived signed URL (TTL unknown here — capped at 5min but can shrink to
    // seconds as a file nears expiry), so never let a shared/CDN cache store this redirect and hand the signed
    // link to others or replay it after it expires. no-store is the only safe choice without the real TTL (S6).
    return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
  }
  if (res.ok) {
    // Hub served the bytes directly instead of redirecting: stream them through. Drop content-encoding/-length
    // (fetch already decoded the body, so the original values would mismatch) and don't cache the proxied bytes.
    const headers = new Headers();
    const ct = res.headers.get('content-type');
    const cd = res.headers.get('content-disposition');
    if (ct) headers.set('content-type', ct);
    if (cd) headers.set('content-disposition', cd);
    headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  }
  return Response.json({ error: 'File not found' }, { status: res.status >= 400 ? res.status : 404 });
}
