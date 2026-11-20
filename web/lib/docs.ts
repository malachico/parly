/**
 * Complete product & developer documentation for Parly.
 * Rendered at /docs and /docs/<slug>; indexed in sitemap.ts and llms.txt.
 */

import { APPS_API_DOCS } from './docs/apps-api';
import { GETTING_STARTED_DOCS } from './docs/getting-started';
import { WORKSPACES_AND_CHANNELS_DOCS } from './docs/workspaces-and-channels';
import { AGENTS_DOCS } from './docs/agents';
import { SKILLS_AND_PROCESSES_DOCS } from './docs/skills-and-processes';
import { AUTOMATIONS_AND_INTEGRATIONS_DOCS } from './docs/automations-and-integrations';
import { PLAYBOOKS_AND_WORKFLOWS_DOCS } from './docs/playbooks-and-workflows';
import { DEVELOPERS_DOCS } from './docs/developers';
import { GUIDES_DOCS } from './docs/guides';

export const DOC_CATEGORIES = [
  'Getting Started',
  'Workspaces & Channels',
  'Agents',
  'Skills & Processes',
  'Automations & Integrations',
  'Playbooks & Workflows',
  'Developers',
  'Guides',
] as const;

export type DocCategory = (typeof DOC_CATEGORIES)[number];

export type Doc = {
  slug: string;
  category: DocCategory;
  title: string;
  description: string;
  body: string;
};

export const DOCS: Doc[] = [...APPS_API_DOCS, ...GETTING_STARTED_DOCS, ...WORKSPACES_AND_CHANNELS_DOCS, ...AGENTS_DOCS, ...SKILLS_AND_PROCESSES_DOCS, ...AUTOMATIONS_AND_INTEGRATIONS_DOCS, ...PLAYBOOKS_AND_WORKFLOWS_DOCS, ...DEVELOPERS_DOCS, ...GUIDES_DOCS];

/** Finds a documentation article by its slug. */
export const doc = (slug: string): Doc | undefined => DOCS.find((d) => d.slug === slug);

/** Groups all documentation articles by DOC_CATEGORIES order. */
export const docsByCategory = (): { category: DocCategory; docs: Doc[] }[] =>
  DOC_CATEGORIES.map((category) => ({
    category,
    docs: DOCS.filter((d) => d.category === category),
  })).filter((g) => g.docs.length > 0);

/** Case-insensitive search across title, description, category, slug, and markdown body. */
export function searchDocs(query: string): Doc[] {
  const q = query.trim().toLowerCase();
  if (!q) return DOCS;
  const terms = q.split(/\s+/).filter(Boolean);
  return DOCS.filter((d) => {
    const haystack = `${d.title}\n${d.description}\n${d.category}\n${d.slug}\n${d.body}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
