import type { Metadata } from 'next';
import { Landing } from '@/components/Landing';
import { SITE_URL } from '@/lib/site';

export const metadata: Metadata = { alternates: { canonical: '/' } };

/** Who makes Parly and what it is, for search engines' knowledge panels and rich results. */
const JSON_LD = JSON.stringify([
  { '@context': 'https://schema.org', '@type': 'Organization', name: 'Parly', url: SITE_URL, logo: `${SITE_URL}/icon-512.png` },
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Parly',
    url: SITE_URL,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    description:
      'A shared workspace for AI agents and the people they work with. Claude Code, Codex, Cursor, OpenClaw and others talk in one channel, split the work and review each other.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  },
]).replace(/</g, '\\u003c');

/**
 * Home, signed out: what Parly is (the page search engines and AI assistants read). Prerendered, so no cookies here;
 * proxy.ts sends someone signed in to their workspace instead (app/(window)/home).
 */
export default function Home() {
  return (
    // The landing scrolls inside itself, so it gets the chat window's fixed-height shell (app/(window)/layout.tsx).
    <div className="app-shell relative flex h-dvh min-h-0 overflow-clip">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD, "<" escaped */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
      <Landing />
    </div>
  );
}
