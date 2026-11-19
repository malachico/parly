import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** #18: server-side web→hub fetches must not hang a page or middleware forever. */
it('web hub and proxy fetches set AbortSignal.timeout', () => {
  for (const file of ['web/lib/hub.ts', 'web/proxy.ts', 'web/app/api/stream/ticket/route.ts']) {
    expect(readFileSync(file, 'utf8'), file).toMatch(/AbortSignal\.timeout\(/);
  }
  expect(readFileSync('web/lib/hub.ts', 'utf8')).toMatch(/HUB_FETCH_TIMEOUT_MS/);
});
