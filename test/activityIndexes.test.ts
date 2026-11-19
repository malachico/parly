import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MONGO_INDEXES } from '../src/db/mongo.js';

/** Every activity query must lead with an indexed field, or Mongo scans the whole collection. */
it('every activity query field has an index', () => {
  const src = readFileSync('src/chat/store.ts', 'utf8');
  const fields = [...src.matchAll(/activityCol\.where\('(\w+)'/g)].map((m) => m[1]);
  expect(fields.length).toBeGreaterThan(0);
  const leading = MONGO_INDEXES.filter((i) => i.collection === 'activity').map((i) => Object.keys(i.keys)[0]);
  for (const f of fields) expect(leading).toContain(f);
});
