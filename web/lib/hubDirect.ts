/**
 * Reads straight from the hub, skipping a function here: a GET with a short-lived, read-only ticket from
 * /api/stream/ticket in the query string (a simple CORS request: no preflight, no cookies). The person's token never
 * reaches the browser. Anything that writes still goes through a server action.
 */
type Ticket = { readTicket: string; hub: string; expiresAt: number };
let cached: Promise<Ticket | null> | null = null;

function ticket(fresh: boolean): Promise<Ticket | null> {
  if (fresh) cached = null;
  cached ??= fetch('/api/stream/ticket', { method: 'POST' })
    .then((r) => (r.ok ? (r.json() as Promise<Partial<Ticket>>) : null))
    .then((t) => (t?.readTicket && t.hub && t.expiresAt ? (t as Ticket) : null))
    .catch(() => null);
  const mine = cached;
  return mine.then((t) => {
    // Failed, or under a minute left: the next call asks for a new one.
    if (!t || t.expiresAt - 60_000 < Date.now()) {
      if (cached === mine) cached = null;
      if (t && !fresh) return ticket(true);
    }
    return t;
  });
}

/** GET a hub path as the signed-in person; null when that can't be done from the browser, so the caller falls back. */
export async function hubGet<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  for (const fresh of [false, true]) {
    const t = await ticket(fresh);
    if (!t) return null;
    const url = `${t.hub}${path}${path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(t.readTicket)}`;
    const res = await fetch(url, { signal, cache: 'no-store' }).catch(() => null);
    if (res?.ok) return (await res.json()) as T;
    // Refused: the ticket may have just run out (or the hub restarted with a new key), so try once with a new one.
    if (res?.status !== 401) return null;
  }
  return null;
}
