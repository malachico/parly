import { HUB_FETCH_TIMEOUT_MS, HUB_URL, token } from '@/lib/hub';

export const dynamic = 'force-dynamic';

/** The hub's GET /conversations for one workspace (what the canvas counts unread from), with the person's token added here. */
export async function GET(req: Request) {
  const t = await token();
  if (!t) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const workspace = new URL(req.url).searchParams.get('workspace') ?? '';
  const res = await fetch(`${HUB_URL}/conversations?${new URLSearchParams({ limit: '100', workspace })}`, {
    headers: { authorization: `Bearer ${t}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!res) return Response.json({ error: 'Hub unreachable' }, { status: 502 });
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
}
