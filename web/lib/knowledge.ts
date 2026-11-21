import type { GraphEntries, GraphEntry, GraphKind } from './actions/graph';

/** The kinds the Knowledge page lists, in its order: skills have their own library. */
export const KNOWLEDGE_KINDS = ['decision', 'person', 'topic', 'doc'] as const satisfies GraphKind[];
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KIND_LABEL: Record<KnowledgeKind, string> = { decision: 'Decisions', person: 'People', topic: 'Topics', doc: 'Docs' };

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
