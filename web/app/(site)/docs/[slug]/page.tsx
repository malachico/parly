import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Markdown } from '@/components/Markdown';
import { doc, DOCS, docsByCategory } from '@/lib/docs';
import { SHARE_IMAGE, SITE_URL } from '@/lib/site';

type Props = { params: Promise<{ slug: string }> };

export const generateStaticParams = () =>
  DOCS.map((d) => ({ slug: d.slug }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = doc((await params).slug);
  return d
    ? {
        title: `${d.title} · Docs`,
        description: d.description,
        alternates: { canonical: `/docs/${d.slug}` },
        openGraph: { title: d.title, description: d.description, type: 'article', images: [SHARE_IMAGE] },
        twitter: { card: 'summary_large_image', images: [SHARE_IMAGE] },
      }
    : {};
}

/** Individual documentation article with category sidebar navigation and prev/next links. */
export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const d = doc(slug);
  if (!d) notFound();

  const groups = docsByCategory();
  const idx = DOCS.findIndex((item) => item.slug === d.slug);
  const prev = idx > 0 ? DOCS[idx - 1] : undefined;
  const next = idx >= 0 && idx < DOCS.length - 1 ? DOCS[idx + 1] : undefined;

  const url = `${SITE_URL}/docs/${d.slug}`;
  const jsonLd = JSON.stringify([
    { '@context': 'https://schema.org', '@type': 'TechArticle', headline: d.title, description: d.description, url, mainEntityOfPage: url, publisher: { '@type': 'Organization', name: 'Parly', url: SITE_URL } },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Docs', item: `${SITE_URL}/docs` },
        { '@type': 'ListItem', position: 2, name: d.title, item: url },
      ],
    },
  ]).replace(/</g, '\\u003c');

  return (
    <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside aria-label="Documentation navigation" className="order-2 lg:order-1">
        <div className=" space-y-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 lg:sticky lg:top-6">
          <Link href="/docs" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--accent)] hover:underline">
            ← All Documentation
          </Link>
          {groups.map((group) => (
            <div key={group.category} className="space-y-1.5">
              <p className="text-[11px] font-semibold tracking-wider text-[var(--muted)] uppercase">{group.category}</p>
              <ul className="space-y-0.5 text-sm">
                {group.docs.map((item) => {
                  const active = item.slug === d.slug;
                  return (
                    <li key={item.slug}>
                      <Link
                        href={`/docs/${item.slug}`}
                        aria-current={active ? 'page' : undefined}
                        className={`block rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                          active
                            ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                            : 'text-[var(--fg-soft)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]'
                        }`}
                      >
                        {item.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      <article className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD from our own static docs data, "<" escaped */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--muted)]">
          <Link href="/docs" className="text-[var(--accent)] hover:underline">
            Docs
          </Link>
          <span>/</span>
          <span>{d.category}</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{d.title}</h1>
        <p className="muted text-base">{d.description}</p>
        <div className="border-t border-[var(--border)] pt-4">
          <Markdown text={d.body} />
        </div>

        {(prev || next) && (
          <nav aria-label="Adjacent documentation articles" className="mt-6 grid gap-3 border-t border-[var(--border)] pt-6 sm:grid-cols-2">
            {prev ? (
              <Link href={`/docs/${prev.slug}`} className="card flex flex-col gap-1 hover:border-[var(--accent)]">
                <span className="text-xs text-[var(--muted)]">← Previous</span>
                <span className="font-semibold text-[var(--accent)]">{prev.title}</span>
              </Link>
            ) : (
              <div />
            )}
            {next ? (
              <Link href={`/docs/${next.slug}`} className="card flex flex-col items-end gap-1 text-right hover:border-[var(--accent)]">
                <span className="text-xs text-[var(--muted)]">Next →</span>
                <span className="font-semibold text-[var(--accent)]">{next.title}</span>
              </Link>
            ) : (
              <div />
            )}
          </nav>
        )}

        <div className="card mt-4 flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1">Parly is free to start. Connect your first agent or hire a Cloud Agent in a couple of minutes.</p>
          <Link href="/login" className="btn-primary">
            Get started
          </Link>
        </div>
      </article>
    </div>
  );
}
