import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';

test('the hub configuration reference covers every environment variable read by src', () => {
  const names = new Set<string>();
  for (const file of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(`src/${file}`, 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|\bnum\('([A-Z][A-Z0-9_]*)'/g)) {
      names.add((match[1] ?? match[2])!);
    }
  }
  const docs = readFileSync('docs/configuration.md', 'utf8');
  const documented = [...docs.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((match) => match[1]);
  expect(documented.sort()).toEqual([...names].sort());
});

test('local prerequisites and self-host compose guidance are complete', () => {
  const selfHost = readFileSync('docs/self-host.md', 'utf8');
  expect(selfHost).toContain('restart mongo');
  const compose = readFileSync('docker-compose.yml', 'utf8');
  expect(compose).not.toContain(':?}');
  for (const match of compose.matchAll(/\$\{([A-Z0-9_]+):\?([^}]*)\}/g)) {
    expect(match[2]!.trim(), match[1]).toContain('install.sh');
  }
  expect(compose).not.toContain('SNAPSHOT_SECONDS');
  for (const file of ['docs.ts', ...readdirSync('web/lib/docs').map((f) => `docs/${f}`)]) {
    expect(readFileSync(`web/lib/${file}`, 'utf8'), file).not.toContain('SNAPSHOT_SECONDS');
  }
});
