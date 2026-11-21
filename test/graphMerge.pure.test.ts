import { describe, expect, it } from 'vitest';
import { mergedReadableGraph } from '../src/graph/acl.js';
import { canonicalIdFor, type GraphNodeKind, normalizeKey, sameEntity } from '../src/graph/store.js';
import type { AgentRecord } from '../src/registry/types.js';

type Row = { _id: string; workspaceId: string; conversationId: string; kind: GraphNodeKind; key: string; title: string; text?: string; canonicalId?: string };

/** GraphStore.upsertNode's merge step over an in-memory graph_nodes: an existing row keeps its canonicalId ($setOnInsert). */
function upsert(rows: Row[], n: { conversationId: string; kind: GraphNodeKind; title: string; key?: string; text?: string }): Row {
  const key = normalizeKey(n.key ?? n.title);
  const _id = `${n.conversationId}/${n.kind}/${key}`;
  const canonicalId = n.kind === 'person' || n.kind === 'topic' ? canonicalIdFor({ workspaceId: 'w', kind: n.kind, key, title: n.title }, rows.filter((r) => r.kind === n.kind)) : undefined;
  const existing = rows.find((r) => r._id === _id);
  if (existing) return Object.assign(existing, { title: n.title, text: n.text });
  const row: Row = { _id, workspaceId: 'w', conversationId: n.conversationId, kind: n.kind, key, title: n.title, text: n.text, ...(canonicalId ? { canonicalId } : {}) };
  rows.push(row);
  return row;
}
const groups = (rows: Row[]) => new Set(rows.map((r) => r.canonicalId)).size;
const reader = { id: 'r', workspaces: ['w'] } as unknown as AgentRecord;
const chatReading = (...readable: string[]) => ({ readableConversations: async () => new Set(readable) });

describe('merging duplicate graph entries', () => {
  it('never shows a reader text from a source it cannot read, through the merged entry', async () => {
    const rows: Row[] = [];
    const a = upsert(rows, { conversationId: 'channel:open', kind: 'person', title: 'Dana', text: 'Dana owns billing.' });
    const b = upsert(rows, { conversationId: 'channel:secret', kind: 'person', title: 'Dana Levi', key: 'agent-dana', text: 'Dana is leaving in March.' });
    const d = upsert(rows, { conversationId: 'channel:secret', kind: 'decision', title: 'Hire a replacement' });
    expect(b.canonicalId).toBe(a.canonicalId);
    const edges = [{ workspaceId: 'w', kind: 'involves', from: d._id, to: b._id, fromConversationId: d.conversationId, toConversationId: b.conversationId }];

    const both = await mergedReadableGraph(reader, chatReading('channel:open', 'channel:secret'), { nodes: rows, edges });
    const dana = both.nodes.find((n) => n.kind === 'person')!;
    expect(dana.title).toBe('Dana Levi');
    expect(dana.sources.map((s) => s.text).sort()).toEqual(['Dana is leaving in March.', 'Dana owns billing.']);
    expect(both.edges).toEqual([{ ...edges[0], from: d._id, to: dana.id }]);

    const restricted = await mergedReadableGraph(reader, chatReading('channel:open'), { nodes: rows, edges });
    expect(restricted.nodes).toEqual([{ id: a._id, workspaceId: 'w', kind: 'person', title: 'Dana', sources: [{ nodeId: a._id, conversationId: 'channel:open', title: 'Dana', text: 'Dana owns billing.' }] }]);
    expect(restricted.edges).toEqual([]);
    const seen = JSON.stringify(restricted);
    for (const leak of ['leaving', 'Levi', 'secret', 'agent-dana', b._id, 'replacement']) expect(seen).not.toContain(leak);
  });

  it('derives a merged entry id only from sources the reader can read, whichever source came first', async () => {
    const rows: Row[] = [];
    const hidden = upsert(rows, { conversationId: 'channel:secret', kind: 'person', title: 'Dana Levi', key: 'agent-dana' });
    const open = upsert(rows, { conversationId: 'channel:open', kind: 'person', title: 'Dana' });
    expect(open.canonicalId).toBe(hidden.canonicalId); // the group is named after the hidden source's key
    const out = await mergedReadableGraph(reader, chatReading('channel:open'), { nodes: rows, edges: [] });
    expect(out.nodes.map((n) => n.id)).toEqual([open._id]);
    expect(JSON.stringify(out)).not.toContain(hidden.canonicalId!);
  });

  it('merges one person under name variants, across threads', () => {
    const rows: Row[] = [];
    upsert(rows, { conversationId: 'thread:c:1', kind: 'person', title: 'Ana Gomez', key: 'agent-ana' });
    upsert(rows, { conversationId: 'thread:c:2', kind: 'person', title: 'ana' });
    upsert(rows, { conversationId: 'thread:c:3', kind: 'person', title: 'Ana' });
    upsert(rows, { conversationId: 'thread:c:4', kind: 'person', title: 'Ana G.', key: 'agent-ana' }); // same agent, renamed
    expect(groups(rows)).toBe(1);
  });

  it('keeps different people apart: two agents, and "Dan" between "Dan Smith" and "Dan Jones" in either order', () => {
    expect(sameEntity({ kind: 'person', key: 'agent-1', title: 'Ana' }, { kind: 'person', key: 'agent-2', title: 'Ana' })).toBe(false);
    for (const order of [['Dan Smith', 'Dan Jones', 'Dan'], ['Dan', 'Dan Smith', 'Dan Jones']]) {
      const rows: Row[] = [];
      for (const [i, title] of order.entries()) upsert(rows, { conversationId: `thread:c:${i}`, kind: 'person', title: title! });
      const of = (t: string) => rows.find((r) => r.title === t)!.canonicalId;
      expect(of('Dan Smith')).not.toBe(of('Dan Jones'));
    }
  });

  it('merges reworded topics, not distinct ones with similar names', () => {
    const topic = (title: string) => ({ kind: 'topic' as const, key: normalizeKey(title), title });
    expect(sameEntity(topic('Mongo migrations'), topic('migration to Mongo'))).toBe(true);
    expect(sameEntity(topic('Q3 launch'), topic('q3 Launch!'))).toBe(true);
    expect(sameEntity(topic('Q3 launch'), topic('Q4 launch'))).toBe(false);
    expect(sameEntity(topic('release'), topic('release notes'))).toBe(false);
    expect(sameEntity(topic('billing'), { ...topic('billing'), kind: 'person' })).toBe(false);
  });

  it('is idempotent: re-upserting, or purging and re-extracting a source, lands in the same group', () => {
    const rows: Row[] = [];
    const first = upsert(rows, { conversationId: 'thread:c:1', kind: 'topic', title: 'Mongo migrations' });
    upsert(rows, { conversationId: 'thread:c:2', kind: 'topic', title: 'migration to Mongo' });
    const group = first.canonicalId;
    upsert(rows, { conversationId: 'thread:c:1', kind: 'topic', title: 'Mongo migrations' });
    upsert(rows, { conversationId: 'thread:c:2', kind: 'topic', title: 'migration to Mongo' });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.canonicalId === group)).toBe(true);
    rows.splice(0, 1); // purge thread 1 (the group's first member), then re-extract it
    expect(upsert(rows, { conversationId: 'thread:c:1', kind: 'topic', title: 'Mongo migrations' }).canonicalId).toBe(group);
    rows.length = 0; // purge everything; the group's id is derived from its key, so a rerun rebuilds it as it was
    expect(upsert(rows, { conversationId: 'thread:c:1', kind: 'topic', title: 'Mongo migrations' }).canonicalId).toBe(group);
  });
});
