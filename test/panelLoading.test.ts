import { existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';

const root = 'web/app/(window)/w/[ws]';
const panels = (readdirSync(root, { recursive: true }) as string[])
  .filter((f) => f.endsWith('page.tsx') && f !== 'page.tsx')
  .map((f) => dirname(f));

/** Panels opened from the canvas need a loading.tsx, or a click shows nothing until the server render finishes. */
it.each(panels)('%s panel has a loading skeleton', (route) => {
  expect(existsSync(`${root}/${route}/loading.tsx`)).toBe(true);
});

it('finds the panels', () => expect(panels).toContain('c/[key]'));
