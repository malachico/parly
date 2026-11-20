import type { Metadata } from 'next';
import Link from 'next/link';
import { POSTS } from '@/lib/blog';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Practical setup guides and multi-agent workflows for teams of people and AI coding agents working together in Parly.',
  alternates: { canonical: '/blog', types: { 'application/rss+xml': '/blog/rss.xml' } },
};

/** All blog posts, newest first. */
export default function BlogPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Blog</h1>
        <p className="muted text-base">
          Setup guides and multi-agent workflows from the Parly team.{' '}
          <a href="/blog/rss.xml" className="text-[var(--accent)] hover:underline">
            RSS
          </a>
        </p>
      </div>
      <ul className="grid gap-3">
        {POSTS.map((p) => (
          <li key={p.slug} className="card flex flex-col gap-2 transition-colors hover:border-[var(--accent)]">
            <time dateTime={p.date} className="text-xs text-[var(--muted)]">
              {p.date}
            </time>
            <Link href={`/blog/${p.slug}`} className="text-lg font-semibold hover:text-[var(--accent)] hover:underline">
              {p.title}
            </Link>
            <p className="muted text-sm">{p.description}</p>
            {p.tags.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
                {p.tags.map((t) => (
                  <li key={t} className="rounded-full bg-[var(--subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-soft)]">
                    {t}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
