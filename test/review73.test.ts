import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { POPULAR } from '../src/hub/composio.js';
import { appName } from '../src/hub/triggers.js';
import { isSuperAdminEmail } from '../src/lib/admin.js';

describe('review #73', () => {
  it('appName reuses POPULAR (plus native GitHub)', () => {
    expect(appName('gmail')).toBe(POPULAR.gmail);
    expect(appName('googlesheets')).toBe(POPULAR.googlesheets);
    expect(appName('github')).toBe('GitHub');
    expect(POPULAR.github).toBeUndefined();
    expect(appName('obscureapp')).toBe('Obscureapp');
  });

  it('caches SUPER_ADMIN_EMAILS and rebuilds when the env changes', () => {
    const prev = process.env.SUPER_ADMIN_EMAILS;
    try {
      process.env.SUPER_ADMIN_EMAILS = 'a@x.test, B@Y.TEST';
      expect(isSuperAdminEmail('a@x.test')).toBe(true);
      expect(isSuperAdminEmail('b@y.test')).toBe(true);
      expect(isSuperAdminEmail('B@Y.TEST')).toBe(false); // same as before: env lowercased, email not
      process.env.SUPER_ADMIN_EMAILS = 'c@z.test';
      expect(isSuperAdminEmail('a@x.test')).toBe(false);
      expect(isSuperAdminEmail('c@z.test')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SUPER_ADMIN_EMAILS;
      else process.env.SUPER_ADMIN_EMAILS = prev;
    }
  });

  it('loadConfig shares LLM_PRICE_* and names bad PADDLE_PRICES', () => {
    const keys = ['VERTEX_MODEL', 'CLOUD_AGENT_MODEL', 'PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET', 'PADDLE_PRICES', 'LLM_PRICE_INPUT_PER_MTOK', 'LLM_PRICE_OUTPUT_PER_MTOK'] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      process.env.VERTEX_MODEL = 'gemini-test';
      process.env.CLOUD_AGENT_MODEL = 'gemini-cloud';
      process.env.LLM_PRICE_INPUT_PER_MTOK = '3';
      process.env.LLM_PRICE_OUTPUT_PER_MTOK = '9';
      process.env.PADDLE_API_KEY = 'key';
      process.env.PADDLE_WEBHOOK_SECRET = 'sec';
      process.env.PADDLE_PRICES = '{"pro":"pri_ok"}';
      const cfg = loadConfig();
      expect(cfg.vertex?.prices).toEqual({ input: 3, output: 9 });
      expect(cfg.cloudAgents?.prices).toBe(cfg.vertex?.prices);
      expect(cfg.paddle?.prices).toEqual({ pro: 'pri_ok' });

      process.env.PADDLE_PRICES = '{not-json';
      expect(() => loadConfig()).toThrow(/PADDLE_PRICES must be valid JSON/);
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});
