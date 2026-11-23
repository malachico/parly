import { expect, it } from 'vitest';
import { ctaFor } from '../web/lib/pricingCta.js';

const out = { href: '/login?next=%2Fbilling', label: 'Go Pro' };

it('keeps the rendered button until the session is known, and signed out', () => {
  expect(ctaFor(undefined, undefined, 'Pro', out)).toEqual(out);
  expect(ctaFor(false, undefined, 'Pro', out)).toEqual(out);
});

// `mine` stays undefined both while /api/pricing is slow and after it fails.
it('signed in with /api/pricing slow or failed: never back through /login', () => {
  expect(ctaFor(true, undefined, 'Pro', out)).toEqual({ href: '/billing', label: 'Go Pro' });
  expect(ctaFor(true, undefined, 'Team', out)).toEqual({ href: '/billing', label: 'Go Pro' });
  expect(ctaFor(true, undefined, 'Free', { href: '/login?next=%2F', label: 'Get started' })).toEqual({ href: '/', label: 'Get started' });
});

it("uses /api/pricing's button once it answers", () => {
  const mine = { href: '/billing', label: 'Upgrade to Pro' };
  expect(ctaFor(true, mine, 'Pro', out)).toBe(mine);
});
