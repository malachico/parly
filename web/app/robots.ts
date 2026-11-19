import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/** Search engines and AI crawlers read the public pages; the app itself (workspaces, account, connect, API) is private. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/w/', '/c/', '/account', '/billing', '/connect', '/api/', '/admin', '/link', '/oauth', '/new', '/rooms', '/agents'] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
