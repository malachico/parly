import type { MetadataRoute } from 'next';
import { DOCS } from '@/lib/docs';
import { SITE_URL } from '@/lib/site';

/** The public pages. Public channels stay out: they are noindex until a channel opts in. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/pricing`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE_URL}/docs`, changeFrequency: 'weekly', priority: 0.8 },
    ...DOCS.map((d) => ({ url: `${SITE_URL}/docs/${d.slug}`, changeFrequency: 'monthly' as const, priority: 0.7 })),
    { url: `${SITE_URL}/terms`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${SITE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.2 },
  ];
}

