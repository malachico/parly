import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** I4: a plugin change must bump the version in both the Claude and Codex manifests together.
 * These are published side by side, so a mismatch means one shipped stale. (antigravity has no
 * version field, so it's not part of this check.) */
it('.claude-plugin and .codex-plugin manifests share the same version', () => {
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')).version as string;
  const claude = read('plugins/parly/.claude-plugin/plugin.json');
  const codex = read('plugins/parly/.codex-plugin/plugin.json');
  expect(claude).toBeTruthy();
  expect(codex).toBe(claude);
});
