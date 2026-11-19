import assert from 'node:assert/strict';
import { authCookie, authToken, SHARED_TOKEN_COOKIE, TOKEN_COOKIE } from '../../lib/auth-cookie';
import { siteOrigin } from '../../lib/site';

// Pinned origin fixes public links; cookies still follow the request Host (host-only off parly.dev).
void (async () => {
  const env = { site: process.env.NEXT_PUBLIC_SITE_URL, vercel: process.env.VERCEL_ENV };
  const jar = (names: Record<string, string>) => ({ get: (n: string) => (n in names ? { value: names[n]! } : undefined) });
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_ENV = 'production';
    assert.equal(await siteOrigin(), 'https://parly.dev');
    assert.equal(authCookie('parly.dev').name, SHARED_TOKEN_COOKIE);
    assert.equal(authCookie('parly.dev').domain, '.parly.dev');
    // vercel.app alias / forged Host: host-only, not .parly.dev (avoids sign-in loop).
    assert.equal(authCookie('parly-xxx.vercel.app').name, TOKEN_COOKIE);
    assert.equal('domain' in authCookie('parly-xxx.vercel.app'), false);
    assert.equal(authCookie('attacker.example').name, TOKEN_COOKIE);
    assert.equal(authToken(jar({ [SHARED_TOKEN_COOKIE]: 's' }), 'attacker.example'), undefined);
    assert.equal(authToken(jar({ [SHARED_TOKEN_COOKIE]: 's', [TOKEN_COOKIE]: 't' }), 'attacker.example'), 't');

    process.env.NEXT_PUBLIC_SITE_URL = 'https://self.example/';
    assert.equal(await siteOrigin(), 'https://self.example');
    const own = authCookie('parly.dev');
    assert.equal(own.name, TOKEN_COOKIE);
    assert.equal('domain' in own, false, 'a forged parly.dev Host must not widen the cookie domain');
    assert.equal(authToken(jar({ [SHARED_TOKEN_COOKIE]: 's' }), 'parly.dev'), undefined);

    // Dev and previews (nothing pinned) still follow the request.
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.VERCEL_ENV;
    assert.equal(authCookie('parly.dev').name, SHARED_TOKEN_COOKIE);
    assert.equal(authCookie('localhost:3000').name, TOKEN_COOKIE);
  } finally {
    if (env.site === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = env.site;
    if (env.vercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env.vercel;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
