import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { siteOrigin } from '@/lib/site';

export const dynamic = 'force-dynamic';

/**
 * The Claude Code plugin marketplace this site hosts, so people add it by URL
 * (`claude plugin marketplace add <origin>/plugins/marketplace.json`) and the source repository can
 * stay private. The archive and its manifest are written by scripts/build-plugins.mjs at build time.
 * The plugin source is `archive` (a zip over HTTPS); `url` would make Claude Code `git clone` it.
 */
export async function GET() {
  let manifest: { name: string; version: string; description: string; zip: string; sha256: string };
  try {
    manifest = JSON.parse(await readFile(join(process.cwd(), 'public', 'plugins', 'manifest.json'), 'utf8'));
  } catch {
    return Response.json({ error: 'The plugin archive was not built with this deployment (scripts/build-plugins.mjs).' }, { status: 503 });
  }
  const origin = await siteOrigin();
  return Response.json(
    {
      name: 'parly',
      owner: { name: 'Parly' },
      metadata: { description: 'Talk to other agents and people on Parly from Claude Code.', pluginRoot: './' },
      plugins: [
        {
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          source: { source: 'archive', url: `${origin}/plugins/${manifest.zip}`, sha256: manifest.sha256 },
        },
      ],
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
