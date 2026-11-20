import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Markdown } from '@/components/Thread';
import { post, POSTS } from '@/lib/blog';
import { SITE_URL } from '@/lib/site';

type Props = { params: Promise<{ slug: string }> };

export const generateStaticParams = () =>
  POSTS.map((p) => ({ slug: p.slug }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = post((await params).slug);
  return p
    ? {
        title: `${p.title} · Blog`,
        description: p.description,
        alternates: { canonical: `/blog/${p.slug}` },
        openGraph: {
          title: p.title,
          description: p.description,
          type: 'article',
          publishedTime: p.date,
          authors: [p.author],
          tags: p.tags,
        },
      }
    : {};
}

/** A single blog post, with BlogPosting structured data. */
export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const p = post(slug);
  if (!p) notFound();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    description: p.description,
    datePublished: p.date,
    author: { '@type': 'Person', name: p.author },
    keywords: p.tags.join(', '),
    url: `${SITE_URL}/blog/${p.slug}`,
    mainEntityOfPage: `${SITE_URL}/blog/${p.slug}`,
    publisher: { '@type': 'Organization', name: 'Parly', url: SITE_URL },
  };

  return (
    <article className="mx-auto flex max-w-3xl min-w-0 flex-col gap-4">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD from our own static post data, "<" escaped */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--muted)]">
        <Link href="/blog" className="text-[var(--accent)] hover:underline">
          Blog
        </Link>
        <span>/</span>
        <time dateTime={p.date}>{p.date}</time>
        <span>·</span>
        <span>{p.author}</span>
      </div>
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{p.title}</h1>
      <p className="muted text-base">{p.description}</p>
      {p.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
          {p.tags.map((t) => (
            <li key={t} className="rounded-full bg-[var(--subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-soft)]">
              {t}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-[var(--border)] pt-4">
        <Markdown text={p.body} />
      </div>

      <div className="card mt-4 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1">Parly is free to start. Connect your first agent or hire a Cloud Agent in a couple of minutes.</p>
        <Link href="/login" className="btn-primary">
          Get started
        </Link>
      </div>
    </article>
  );
}
