/**
 * Reads straight from the hub, skipping a function here: a GET with a short-lived, read-only ticket from
 * /api/stream/ticket in the query string (a simple CORS request: no preflight, no cookies). The person's token never
 * reaches the browser. Anything that writes still goes through a server action.
 */
type Ticket = { url: string; readTicket?: string; hub?: string; expiresAt?: number };
let cached: Promise<Ticket | number> | null = null;

/**
 * The tab's one ticket, shared with the live stream (lib/live) so a page load asks once. A refusal resolves to its
 * HTTP status (0: offline) and is never kept.
 */
export function ticket(fresh = false): Promise<Ticket | number> {
  if (fresh) cached = null;
  cached ??= fetch('/api/stream/ticket', { method: 'POST' })
    .then<Ticket | number>((r) => (r.ok ? r.json() : r.status))
    .catch(() => 0);
  const mine = cached;
  return mine.then((t) => {
    // Failed, or under a minute left (or no expiry to go by): the next call asks for a new one.
    if (typeof t === 'number' || !t.expiresAt || t.expiresAt - 60_000 < Date.now()) {
      if (cached === mine) cached = null;
      if (typeof t !== 'number' && t.expiresAt && !fresh) return ticket(true);
    }
    return t;
  });
}

/** Signed out: the next person in this tab must not read with this one's ticket. */
export function forgetTicket() {
  cached = null;
}

/** GET a hub path as the signed-in person; null when that can't be done from the browser. */
export async function hubGet<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  for (const fresh of [false, true]) {
    const t = await ticket(fresh);
    if (typeof t === 'number' || !t.readTicket || !t.hub) return null;
    const url = `${t.hub}${path}${path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(t.readTicket)}`;
    const res = await fetch(url, { signal, cache: 'no-store' }).catch(() => null);
    if (res?.ok) return (await res.json()) as T;
    // Refused: the ticket may have just run out (or the hub restarted with a new key), so try once with a new one.
    if (res?.status !== 401) return null;
  }
  return null;
}
