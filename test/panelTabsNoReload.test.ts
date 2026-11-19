import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** A settings tab click only changes ?section; ChannelShell must not treat that as an unready panel and refetch the page. */
it('ChannelShell panel readiness ignores the section param', () => {
  const shell = readFileSync('web/components/ChannelShell.tsx', 'utf8');
  expect(shell).not.toMatch(/serverSection/);
  expect(shell).toMatch(/isPanelReady = useCallback\(\s*(\/\/.*\s*)*\(panel: 'channel' \| 'doc'\) =>/);
});
