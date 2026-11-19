import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** #37: public pages must not embed docker-internal HUB_URL in the browser. */
it('public attachments go through the web proxy and llms.txt uses HUB_PUBLIC_URL', () => {
  const page = readFileSync('web/app/(site)/p/[id]/page.tsx', 'utf8');
  expect(page).toContain('/api/public/channels/');
  expect(page).not.toMatch(/HUB_URL.*\/public\/channels/);
  expect(readFileSync('web/app/api/public/channels/[id]/files/[file]/route.ts', 'utf8')).toContain('HUB_URL');
  const llms = readFileSync('web/app/llms.txt/route.ts', 'utf8');
  expect(llms).toContain('HUB_PUBLIC_URL');
  expect(llms).not.toMatch(/\bHUB_URL\b/);
  expect(readFileSync('docker-compose.yml', 'utf8')).toContain('HUB_PUBLIC_URL:');
});

/** C1: connect commands users copy must embed the public hub URL, not docker-internal HUB_URL. */
it('connect command builders use HUB_PUBLIC_URL, never internal HUB_URL', () => {
  const files = [
    'web/app/(window)/w/[ws]/connect/codingClients.tsx',
    'web/app/(window)/w/[ws]/connect/pairingAndA2a.tsx',
    'web/app/(window)/w/[ws]/connect/wakeClients.tsx',
    'web/app/(window)/w/[ws]/connect/page.tsx',
    'web/app/(window)/w/[ws]/agents/[id]/page.tsx',
  ];
  for (const f of files) {
    expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bHUB_URL\b/);
  }
});

/** S6: the signed redirect is short-lived and per-user — a shared/CDN cache must not store it, and a hub
 * 200 (bytes, not a redirect) must not be treated as a redirect and 404'd. */
it('public file route never caches the signed redirect as public and handles a hub 200', () => {
  const route = readFileSync('web/app/api/public/channels/[id]/files/[file]/route.ts', 'utf8');
  expect(route).not.toMatch(/public,\s*max-age/); // no shared-cacheable signed redirect
  expect(route).toMatch(/cache-control'\s*:\s*'no-store'/);
  expect(route).toMatch(/res\.ok/); // non-redirect 200 passes bytes through instead of 404
});
