import { expect, it } from 'vitest';
import { clientIpFromHeaders } from '../web/lib/clientIp.js';

const hdr = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });

it('self-hosts ignore spoofable X-Forwarded-For unless TRUST_PROXY=1', () => {
  const forged = hdr({ 'x-forwarded-for': '203.0.113.9' });
  expect(clientIpFromHeaders(forged, {})).toBe('');
  expect(clientIpFromHeaders(forged, { TRUST_PROXY: '1' })).toBe('203.0.113.9');
  expect(clientIpFromHeaders(forged, { VERCEL: '1' })).toBe('203.0.113.9');
});

it('trusts the last X-Forwarded-For entry (the proxy appended it; earlier entries are client-forged)', () => {
  // Client forged the first entry; the single trusted proxy appended the real client IP last.
  const forged = hdr({ 'x-forwarded-for': '198.51.100.7, 203.0.113.9' });
  expect(clientIpFromHeaders(forged, { TRUST_PROXY: '1' })).toBe('203.0.113.9');
  expect(clientIpFromHeaders(forged, {})).toBe('');
});

it('self-hosts ignore spoofable X-Vercel-Forwarded-For unless VERCEL=1', () => {
  const forged = hdr({ 'x-vercel-forwarded-for': '198.51.100.7', 'x-forwarded-for': '203.0.113.9' });
  expect(clientIpFromHeaders(forged, {})).toBe('');
  expect(clientIpFromHeaders(forged, { TRUST_PROXY: '1' })).toBe('203.0.113.9');
  expect(clientIpFromHeaders(forged, { VERCEL: '1' })).toBe('198.51.100.7');
});
