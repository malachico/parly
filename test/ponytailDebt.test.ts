import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/** Roots scanned for `ponytail:` markers (same set as docs/ponytail-debt.md). */
const ROOTS = ['src', 'web', 'plugins', 'containers', 'cloudbuild', 'test', 'scripts'];
const EXTRA = ['vitest.config.ts'];
const EXT = /\.(ts|tsx|js|mjs|cjs|sh|ya?ml)$/;
// `public` is web's built plugin copies (CI runs build-plugins); don't double-count those.
const SKIP_DIR = new Set(['node_modules', 'dist', '.next', 'coverage', 'public']);
const START = /^(\s*)(?:\/\/|#|\/\*|\*)\s*ponytail:\s*(.+?)(?:\*\/)?\s*$/;
const CONT: Record<string, RegExp> = {
  '//': /^(\s*)\/\/\s*(.*?)\s*$/,
  '#': /^(\s*)#\s*(.*?)\s*$/,
  '*': /^(\s*)\*\s*(.*?)\s*$/,
  '/*': /^(\s*)(?:\*|\/\*)\s*(.*?)\s*(?:\*\/)?\s*$/,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

function kindOf(line: string): string | null {
  if (/^\s*\/\//.test(line)) return '//';
  if (/^\s*#/.test(line)) return '#';
  if (/^\s*\/\*/.test(line)) return '/*';
  if (/^\s*\*/.test(line)) return '*';
  return null;
}

function scanFile(file: string): string[] {
  const texts: string[] = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(START);
    if (!m) continue;
    const kind = kindOf(lines[i]!);
    let text = m[2]!.trim().replace(/\s*\*\/\s*$/, '');
    let j = i + 1;
    const contRe = kind ? CONT[kind] : undefined;
    while (j < lines.length && contRe) {
      const c = lines[j]!.match(contRe);
      if (!c) break;
      const piece = c[2]!.trim().replace(/\s*\*\/\s*$/, '');
      if (!piece || /^ponytail:/.test(piece)) break;
      if (
        !/[.;:]$/.test(text) ||
        /^[a-z(]/.test(piece) ||
        /^(near-|and |or |so |then |the |a |an |to |from |if |when |once |until )/.test(piece)
      ) {
        text = `${text} ${piece}`;
        j++;
        continue;
      }
      break;
    }
    texts.push(text.replace(/\s+/g, ' ').trim());
    i = j - 1;
  }
  return texts;
}

function scanTree(): string[] {
  const keys: string[] = [];
  for (const root of ROOTS) {
    try {
      statSync(root);
    } catch {
      continue;
    }
    for (const file of walk(root)) {
      const rel = file.replaceAll('\\', '/');
      for (const text of scanFile(file)) keys.push(`${rel}\t${text}`);
    }
  }
  for (const file of EXTRA) {
    try {
      statSync(file);
    } catch {
      continue;
    }
    for (const text of scanFile(file)) keys.push(`${file}\t${text}`);
  }
  return keys.sort();
}

function parseLedger(md: string): { keys: string[]; noTrigger: number } {
  const keys: string[] = [];
  let noTrigger = 0;
  let file = '';
  for (const line of md.split(/\r?\n/)) {
    const heading = line.match(/^## `([^`]+)`\s*$/);
    if (heading) {
      file = heading[1]!;
      continue;
    }
    const row = line.match(/^- (`no-trigger` )?(.+)$/);
    if (row && file) {
      if (row[1]) noTrigger++;
      keys.push(`${file}\t${row[2]}`);
    }
  }
  return { keys: keys.sort(), noTrigger };
}

test('every ponytail: shortcut is listed in docs/ponytail-debt.md', () => {
  const ledger = readFileSync('docs/ponytail-debt.md', 'utf8');
  const fromCode = scanTree();
  const { keys: allDoc, noTrigger } = parseLedger(ledger);
  // The public mirror strips private files (scripts/public-tree.sh); their rows can't be checked there.
  // Only filter on that stripped tree, so the private repo still catches stale rows.
  const stripped = !existsSync('scripts/deploy.sh');
  const fromDoc = stripped ? allDoc.filter((k) => existsSync(k.split('\t')[0]!)) : allDoc;
  expect(fromDoc).toEqual(fromCode);
  if (stripped) return;
  expect(ledger).toMatch(
    new RegExp(`\\*\\*${fromCode.length} markers, ${noTrigger} with no trigger\\.\\*\\*`),
  );
});
