import { HUB_URL, token } from '@/lib/hub';

export const dynamic = 'force-dynamic';

/**
 * Where this tab opens the live stream: the hub's own GET /events/stream with a short-lived ticket, so no function
 * here stays open for the stream's whole life. The person's token never reaches the browser.
 */
export async function POST() {
  const t = await token();
  if (!t) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const res = await fetch(`${HUB_URL}/events/stream/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (!res?.ok) return Response.json({ error: 'No stream ticket' }, { status: res?.status === 401 ? 401 : 404 });
  // The hub's public address, not HUB_URL: that one may only resolve from here (http://hub:8080 in docker-compose).
  // readTicket: a separate few-minute, read-only ticket for the hub's browser reads (lib/hubDirect). Never the token.
  const { url, readTicket, hub, expiresAt } = (await res.json()) as { url: string; readTicket?: string; hub?: string; expiresAt?: number };
  return Response.json({ url, readTicket, hub, expiresAt });
}
