import type { GraphEntries, GraphEntry, GraphKind, GraphNodeDetails } from './actions/graph';
import { channelHref, knowledgeHref } from './routes';

/** The kinds the Knowledge page lists, in its order: skills have their own library. */
export const KNOWLEDGE_KINDS = ['decision', 'person', 'topic', 'doc'] as const satisfies GraphKind[];
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KIND_LABEL: Record<KnowledgeKind, string> = { decision: 'Decisions', person: 'People', topic: 'Topics', doc: 'Docs' };

/** A hub status meaning the entry is missing or not yours to read, as opposed to the hub failing. */
export const isMissing = (status: number) => status === 404 || status === 403;

/** The search to send: the trimmed text at 2 characters or more, else none (the hub ignores shorter ones). */
export const searchQuery = (q: string) => (q.trim().length >= 2 ? q.trim() : undefined);

/** Nothing recorded yet in any kind: the graph is still filling in, not a filter that matched nothing. */
export const isFillingIn = (data: Pick<GraphEntries, 'entries' | 'counts'>) =>
  data.entries.length === 0 && Object.values(data.counts).every((n) => !n);

/** `entries` by kind, in KNOWLEDGE_KINDS order, empty kinds left out. */
export const groupByKind = (entries: GraphEntry[]) =>
  KNOWLEDGE_KINDS.map((kind) => ({ kind, entries: entries.filter((e) => e.kind === kind) })).filter((g) => g.entries.length > 0);

/** A next page appended to `prev`: an entry already shown (a merged group can span pages) is not repeated. */
export const appendPage = (prev: GraphEntry[], next: GraphEntry[]) => [...prev, ...next.filter((e) => !prev.some((p) => p.id === e.id))];

/** Every kind's singular label, skills included (a neighbour can be one). */
export const KIND_NAME: Record<GraphKind, string> = { decision: 'Decision', person: 'Person', topic: 'Topic', doc: 'Doc', skill: 'Skill' };

/** The Knowledge page URL with `?entry=` set to `id` (or cleared), the other params in `search` kept. */
export function entryUrl(ws: string, search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id) params.set('entry', id);
  else params.delete('entry');
  const qs = params.toString();
  return `${knowledgeHref(ws)}${qs ? `?${qs}` : ''}`;
}

/** Each source message as a chat link, in its thread when it has one (as the canvas opens a message); a DM (no channel) has none to give. */
export const sourceLinks = (ws: string, sources: GraphEntry['sources']) =>
  sources
    .filter((s) => s.channelId)
    .flatMap((s) =>
      (s.messageIds.length ? s.messageIds : [undefined]).map((m) => ({
        key: `${s.channelId}:${s.thread ?? ''}:${m ?? ''}`,
        inThread: Boolean(s.thread),
        href: channelHref(ws, s.channelId, { ...(s.thread ? { thread: s.thread } : {}), ...(m ? { at: m } : {}) }),
      })),
    );

/** The drawer's breadcrumbs after visiting `id`: back to it when it's already on the trail, else onto the end (the last `max` kept). */
export function trailTo(trail: string[], id: string, max = 8): string[] {
  const at = trail.indexOf(id);
  return at >= 0 ? trail.slice(0, at + 1) : [...trail, id].slice(-max);
}

/** Connections by relation, in the hub's order; a neighbour past the node cap (no entry in `nodes`) is left out. */
export function connectionGroups(details: Pick<GraphNodeDetails, 'neighbours' | 'nodes'>) {
  const byId = new Map(details.nodes.map((n) => [n.id, n]));
  return Object.entries(details.neighbours)
    .map(([relation, list]) => ({
      relation,
      items: list.flatMap((n) => {
        const entry = byId.get(n.id);
        return entry ? [{ entry, direction: n.direction }] : [];
      }),
    }))
    .filter((g) => g.items.length > 0);
}
