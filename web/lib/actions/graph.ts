'use server';

import { hub, HubError } from '../hub';
import { isMissing } from '../knowledge';

export type GraphKind = 'decision' | 'person' | 'topic' | 'doc' | 'skill';

/** One graph entry, as the hub returns it (`GET /graph/entries`, `GET /graph/node/:id`). */
export type GraphEntry = {
  id: string;
  workspaceId: string;
  kind: GraphKind;
  title: string;
  summary?: string;
  /** Where it was said: deep-link to `channelId` (and `thread`), the messages by id. */
  sources: { channelId: string; thread?: string; messageIds: string[] }[];
};

export type GraphEdge = { kind: string; from: string; to: string };

/** `edges` are those between `entries` (both ends on the page). */
export type GraphEntries = { entries: GraphEntry[]; edges: GraphEdge[]; counts: Partial<Record<GraphKind, number>>; nextCursor: string | null; error?: true };

export type GraphNodeDetails = {
  node: GraphEntry;
  /** By relation (`involves`, `about`, `supersedes`, ...): the neighbour and which way the edge points. */
  neighbours: Record<string, { id: string; direction: 'out' | 'in' }[]>;
  /** Every other entry reached, at most 29. */
  nodes: GraphEntry[];
  edges: GraphEdge[];
};

/** The explorer's list in workspace `ws`: newest first, or matching `q`; failed loads carry `error`. */
export async function listGraphEntries(ws: string, opts: { channel?: string; thread?: string; kind?: GraphKind; q?: string; limit?: number; cursor?: string } = {}): Promise<GraphEntries> {
  const params = new URLSearchParams({ workspace: ws });
  for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') params.set(k, String(v));
  return hub<GraphEntries>(`/graph/entries?${params}`).catch(() => ({ entries: [], edges: [], counts: {}, nextCursor: null, error: true }));
}

/** Counts already cover all canonical groups in this thread; only fetch the entry to open. */
export async function threadGraphSummary(ws: string, channel: string, thread: string): Promise<{ count: number; entry?: string } | null> {
  const page = await listGraphEntries(ws, { channel, thread, limit: 1 });
  return page.error ? null : { count: Object.values(page.counts).reduce((sum, n) => sum + n, 0), entry: page.entries[0]?.id };
}

/** One entry with its neighbours (`depth` 2: theirs too); null when it's missing or not yours to read. */
export async function graphNode(id: string, depth: 1 | 2 = 1): Promise<GraphNodeDetails | null> {
  try {
    return await hub<GraphNodeDetails>(`/graph/node/${encodeURIComponent(id)}?depth=${depth}`);
  } catch (err) {
    // Only a 404/403 means gone; an outage rethrows so the drawer offers Try again.
    if (err instanceof HubError && isMissing(err.status)) return null;
    throw err;
  }
}
