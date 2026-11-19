'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DOC_CATEGORIES, DOCS, searchDocs, type DocCategory } from '@/lib/docs';
import { plural } from '@/lib/plural';

export function DocsHub() {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<DocCategory | 'All'>('All');

  const matched = searchDocs(query).filter((d) => activeCategory === 'All' || d.category === activeCategory);
  const grouped = DOC_CATEGORIES.map((category) => ({
    category,
    docs: matched.filter((d) => d.category === category),
  })).filter((g) => g.docs.length > 0);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <div className="space-y-3">
        <p className="text-xs font-semibold tracking-wider text-[var(--accent)] uppercase">Documentation</p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Everything you can do in Parly</h1>
        <p className="max-w-2xl text-base text-[var(--muted)]">
          Complete how-to guides, team workflow recipes, integration setup, and MCP/A2A developer references for running humans and AI agents together.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <label className="relative block">
          <span className="sr-only">Search documentation</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs (e.g. Claude Code, skills, feature-dev, triggers, Telegram, whoami…)"
            aria-label="Search documentation"
            className="input w-full px-4 py-2.5 text-sm"
          />
        </label>
        <div role="tablist" aria-label="Documentation categories" className="flex flex-wrap gap-1.5">
          {(['All', ...DOC_CATEGORIES] as const).map((cat) => {
            const selected = activeCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveCategory(cat)}
                className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  selected
                    ? 'bg-[var(--accent)] text-white'
                    : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-soft)] hover:bg-[var(--subtle)]'
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {grouped.length === 0 ? (
        <div className="card py-8 text-center">
          <p className="font-medium">No documentation articles matched &ldquo;{query}&rdquo;.</p>
          <p className="muted mt-1 text-sm">Try another keyword or clear the filter to browse all {DOCS.length} guides.</p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setActiveCategory('All');
            }}
            className="btn mt-4"
          >
            Show all documentation
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map(({ category, docs }) => (
            <section key={category} className="space-y-3">
              <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
                <h2 className="text-lg font-semibold tracking-tight">{category}</h2>
                <span className="text-xs text-[var(--muted)]">
                  {plural(docs.length, 'article', 'articles')}
                </span>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2">
                {docs.map((d) => (
                  <li key={d.slug} className="card flex flex-col justify-between gap-2 transition-colors hover:border-[var(--accent)]">
                    <div className="space-y-1">
                      <Link href={`/docs/${d.slug}`} className="font-semibold hover:text-[var(--accent)] hover:underline">
                        {d.title}
                      </Link>
                      <p className="muted text-sm">{d.description}</p>
                    </div>
                    <Link href={`/docs/${d.slug}`} className="text-xs font-medium text-[var(--accent)] hover:underline">
                      Read guide →
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
