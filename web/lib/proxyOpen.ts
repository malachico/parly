import { HUB_FETCH_TIMEOUT_MS, HUB_URL, token } from '@/lib/hub';

/**
 * The hub's GET /<kind>/:id/open, for when the browser can't read it directly (no ticket, or the hub refused):
 * the same query, the person's token added here, the hub's status passed through.
 */
// ponytail: nothing calls this now; kept for tabs still open on the old bundle, delete it and the two /open routes after the next deploy
export async function proxyOpen(kind: 'agents' | 'channels', req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await token();
  if (!t) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;
  const res = await fetch(`${HUB_URL}/${kind}/${encodeURIComponent(id)}/open${new URL(req.url).search}`, {
    headers: { authorization: `Bearer ${t}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!res) return Response.json({ error: 'Hub unreachable' }, { status: 502 });
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
}
