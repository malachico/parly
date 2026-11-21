import assert from 'node:assert/strict';
import type { GraphEntry } from '../../lib/actions/graph';
import { appendPage, groupByKind, isFillingIn, searchQuery } from '../../lib/knowledge';
import { knowledgeHref } from '../../lib/routes';

// Knowledge page: search only from 2 characters, the "filling in" state, grouping and paging.
assert.equal(searchQuery(''), undefined);
assert.equal(searchQuery(' a '), undefined);
assert.equal(searchQuery(' ab '), 'ab');
assert.equal(isFillingIn({ entries: [], counts: {} }), true);
assert.equal(isFillingIn({ entries: [], counts: { decision: 0, doc: 0 } }), true);
assert.equal(isFillingIn({ entries: [], counts: { decision: 2 } }), false);
const e = (id: string, kind: GraphEntry['kind']): GraphEntry => ({ id, workspaceId: 'w', kind, title: id, sources: [] });
assert.deepEqual(
  groupByKind([e('t1', 'topic'), e('d1', 'decision'), e('s1', 'skill'), e('d2', 'decision')]).map((g) => [g.kind, g.entries.map((x) => x.id)]),
  [['decision', ['d1', 'd2']], ['topic', ['t1']]],
);
assert.deepEqual(appendPage([e('a', 'doc'), e('b', 'doc')], [e('b', 'doc'), e('c', 'doc')]).map((x) => x.id), ['a', 'b', 'c']);
assert.equal(knowledgeHref('w 1'), '/w/w%201/knowledge');
assert.equal(knowledgeHref('w', { entry: 'n1' }), '/w/w/knowledge?entry=n1');
