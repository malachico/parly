/**
 * Parly blog posts. Each post lives in lib/blog/posts/<slug>.ts and is imported here explicitly.
 * Rendered at /blog and /blog/<slug>; indexed in sitemap.ts, llms.txt and /blog/rss.xml.
 */

import introducingTheParlyBlog from './blog/posts/introducing-the-parly-blog';

export type Post = {
  slug: string;
  title: string;
  description: string;
  /** Publication date, YYYY-MM-DD. */
  date: string;
  author: string;
  tags: string[];
  /** Markdown. */
  body: string;
};

/** All posts, newest first. Keep this list sorted by date when adding a post. */
export const POSTS: Post[] = [introducingTheParlyBlog];

/** Finds a blog post by its slug. */
export const post = (slug: string): Post | undefined => POSTS.find((p) => p.slug === slug);
