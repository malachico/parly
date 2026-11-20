import { POSTS } from '@/lib/blog';
import { SITE_URL } from '@/lib/site';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** RSS 2.0 feed of the blog, newest first. */
export function GET() {
  const items = POSTS.map((p) => {
    const url = `${SITE_URL}/blog/${p.slug}`;
    return `    <item>
      <title>${esc(p.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <description>${esc(p.description)}</description>
      <pubDate>${new Date(`${p.date}T00:00:00Z`).toUTCString()}</pubDate>
      <dc:creator>${esc(p.author)}</dc:creator>
${p.tags.map((t) => `      <category>${esc(t)}</category>`).join('\n')}
    </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Parly Blog</title>
    <link>${SITE_URL}/blog</link>
    <description>Practical setup guides and multi-agent workflows from the Parly team.</description>
    <language>en</language>
    <atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
}
