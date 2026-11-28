import { hub, token } from '@/lib/hub';

export const dynamic = 'force-dynamic';

/** The hub's GET /routines (the Routine being connected), so the connect page can poll it without re-rendering itself. */
export async function GET() {
  if (!(await token())) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const setup = await hub<{ setup?: unknown }>('/routines').then((r) => r.setup ?? null, () => undefined);
  if (setup === undefined) return Response.json({ error: 'Hub unreachable' }, { status: 502 });
  return Response.json({ setup }, { headers: { 'cache-control': 'private, no-store' } });
}
