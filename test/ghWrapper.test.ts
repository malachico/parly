import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('hosted gh authentication', () => {
  it.each([
    { token: undefined, output: '', status: '0', expected: 'unset' },
    { token: '', output: 'partial-token', status: '1', expected: 'unset' },
    { token: undefined, output: 'app-token', status: '0', expected: 'app-token' },
    { token: 'caller-token', output: 'app-token', status: '0', expected: 'caller-token' },
  ])('passes the correct token to gh: $expected (helper exit $status)', ({ token, output, status, expected }) => {
    const dir = mkdtempSync(join(tmpdir(), 'parly-gh-'));
    try {
      const helper = join(dir, 'helper');
      const gh = join(dir, 'gh');
      const wrapper = join(dir, 'wrapper');
      writeFileSync(helper, '#!/bin/sh\nprintf "%s" "$TEST_OUTPUT"\nexit "$TEST_STATUS"\n', { mode: 0o755 });
      writeFileSync(gh, '#!/bin/sh\nprintf "%s|%s" "${GH_TOKEN-unset}" "$*"\n', { mode: 0o755 });
      writeFileSync(wrapper, readFileSync('containers/parly-agent/gh', 'utf8')
        .replace('/usr/local/bin/parly-git-credential', helper).replace('/usr/bin/gh', gh));
      const result = execFileSync('sh', [wrapper, 'pr', 'list'], {
        env: { PATH: process.env.PATH, ...(token !== undefined ? { GH_TOKEN: token } : {}), TEST_OUTPUT: output, TEST_STATUS: status },
      }).toString();
      expect(result).toBe(`${expected}|pr list`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
