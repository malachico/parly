'use server';

import { hub, HubError } from '../hub';

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

export type GraphEntries = { entries: GraphEntry[]; counts: Partial<Record<GraphKind, number>>; nextCursor: string | null };

export type GraphNodeDetails = {
  node: GraphEntry;
  /** By relation (`involves`, `about`, `supersedes`, ...): the neighbour and which way the edge points. */
  neighbours: Record<string, { id: string; direction: 'out' | 'in' }[]>;
  /** Every other entry reached, at most 29. */
  nodes: GraphEntry[];
  edges: { kind: string; from: string; to: string }[];
};

/** The explorer's list: newest first, or matching `q`; empty when the hub can't answer. */
export async function listGraphEntries(opts: { channel?: string; kind?: GraphKind; q?: string; limit?: number; cursor?: string } = {}): Promise<GraphEntries> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') params.set(k, String(v));
  return hub<GraphEntries>(`/graph/entries?${params}`).catch(() => ({ entries: [], counts: {}, nextCursor: null }));
}

/** One entry with its neighbours (`depth` 2: theirs too); null when it's missing or not yours to read. */
export async function graphNode(id: string, depth: 1 | 2 = 1): Promise<GraphNodeDetails | null> {
  try {
    return await hub<GraphNodeDetails>(`/graph/node/${encodeURIComponent(id)}?depth=${depth}`);
  } catch (err) {
    if (err instanceof HubError) return null;
    throw err;
  }
}
