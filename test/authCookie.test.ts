import { afterEach, expect, it } from 'vitest';
import { authCookie, cookieSecure, SHARED_TOKEN_COOKIE, TOKEN_COOKIE } from '../web/lib/auth-cookie.js';

const prev = {
  secure: process.env.COOKIE_SECURE,
  node: process.env.NODE_ENV,
  site: process.env.NEXT_PUBLIC_SITE_URL,
  vercel: process.env.VERCEL_ENV,
};

afterEach(() => {
  if (prev.secure === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = prev.secure;
  process.env.NODE_ENV = prev.node;
  if (prev.site === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = prev.site;
  if (prev.vercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = prev.vercel;
});

it('cookieSecure follows COOKIE_SECURE over NODE_ENV so http self-hosts keep flash cookies', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.COOKIE_SECURE;
  expect(cookieSecure('localhost')).toBe(true);
  process.env.COOKIE_SECURE = '0';
  expect(cookieSecure('localhost')).toBe(false);
  process.env.COOKIE_SECURE = '1';
  expect(cookieSecure('localhost')).toBe(true);
  expect(cookieSecure('parly.dev')).toBe(true);
});

it('Vercel production keeps host-only cookies on vercel.app aliases', () => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  process.env.VERCEL_ENV = 'production';
  const cloud = authCookie('parly.dev');
  expect(cloud.name).toBe(SHARED_TOKEN_COOKIE);
  expect(cloud.domain).toBe('.parly.dev');
  const alias = authCookie('parly-abc.vercel.app');
  expect(alias.name).toBe(TOKEN_COOKIE);
  expect(alias).not.toHaveProperty('domain');
});
