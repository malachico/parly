import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyPan, applyZoom, clampZoom, ImagePreview, INITIAL_ZOOM } from '../../components/ImagePreview';
import { Timeline } from '../../components/Thread';
import { DocsHub } from '../../components/DocsHub';
import { ToolsSection } from '../../components/ToolsSection';
import assert from 'node:assert/strict';
import { doc, DOC_CATEGORIES, DOCS, docsByCategory, searchDocs } from '../../lib/docs';
import { message, people } from './fixtures';

// Documentation (/docs): covers all categories, resolves every slug, has no [VERIFY] placeholders, and renders DocsHub.
assert.ok(DOCS.length >= 13, `Expected at least 13 documentation articles, got ${DOCS.length}`);
assert.equal(doc('admin'), undefined, 'Admin internals must not be publicly indexed in /docs');
assert.ok(DOC_CATEGORIES.includes('Developers'), 'DOC_CATEGORIES must include Developers');
assert.equal(docsByCategory().length, DOC_CATEGORIES.length, 'Every DOC_CATEGORIES entry should have at least one doc');
for (const d of DOCS) {
  assert.ok(d.slug && d.title && d.description && d.body.length > 400, `Doc ${d.slug} must have detailed content`);
  assert.doesNotMatch(d.body, /\[VERIFY/i, `Doc ${d.slug} must not contain unresolved [VERIFY] tags`);
  assert.equal(doc(d.slug)?.slug, d.slug);
}
assert.ok(searchDocs('feature-dev').some((d) => d.slug === 'processes'));
assert.ok(searchDocs('whoami').some((d) => d.slug === 'tool-reference' || d.slug === 'developers'));
const docsHubHtml = renderToStaticMarkup(createElement(DocsHub));
assert.match(docsHubHtml, /Everything you can do in Parly/);
assert.match(docsHubHtml, /href="\/docs\/getting-started"/);
assert.match(docsHubHtml, /href="\/docs\/tool-reference"/);
assert.doesNotMatch(docsHubHtml, /href="\/docs\/admin"/);
assert.doesNotMatch(docsHubHtml, /Developers &amp; Admin/);

// ToolsSection renders native "GitHub" with Connect link when NOT_INSTALLED and Connected badge when ACTIVE.
const toolsAgent = {
  id: 'a1',
  name: 'Joey',
  description: 'Reviewer',
  kind: 'endpoint' as const,
  cloud: true,
  public: false,
  skills: [],
  workspaces: ['ws1'],
  channels: [],
  lastSeen: '2026-10-25T00:00:00Z',
  tools: { toolkits: ['github'], act: false },
};
const toolsNotInstalledHtml = renderToStaticMarkup(
  createElement(ToolsSection, {
    ws: 'ws1',
    agent: toolsAgent,
    tools: {
      available: true,
      connected: [
        {
          slug: 'github',
          name: 'GitHub',
          logo: '/github-mark.svg',
          tools: 5,
          connectable: true,
          native: true,
          account: { id: 'github-app', status: 'NOT_INSTALLED' },
        },
      ],
      popular: [],
    },
  }),
);
assert.match(toolsNotInstalledHtml, />GitHub</);
assert.match(toolsNotInstalledHtml, /<img[^>]+src="\/github-mark\.svg"/);
// Not connected: Connect is a form action (mints single-use state), not a bare GitHub install URL.
assert.match(toolsNotInstalledHtml, />Connect</);
assert.doesNotMatch(toolsNotInstalledHtml, /href="https:\/\/github\.com\/apps\/parly-dev\/installations\/new"/);
assert.doesNotMatch(toolsNotInstalledHtml, /not_installed/);

const toolsInstalledHtml = renderToStaticMarkup(
  createElement(ToolsSection, {
    ws: 'ws1',
    agent: toolsAgent,
    tools: {
      available: true,
      connected: [
        {
          slug: 'github',
          name: 'GitHub',
          logo: '/github-mark.svg',
          tools: 5,
          connectable: true,
          native: true,
          installUrl: 'https://github.com/apps/parly-dev/installations/new',
          account: { id: 'github-app', status: 'ACTIVE' },
        },
      ],
      popular: [],
    },
  }),
);
assert.match(toolsInstalledHtml, />GitHub</);
assert.match(toolsInstalledHtml, /<img[^>]+src="\/github-mark\.svg"/);
assert.match(toolsInstalledHtml, />Connected</);
assert.doesNotMatch(toolsInstalledHtml, />Disconnect</);

// ImagePreview: thumbnail keeps rounded-lg, while opened dialog viewer fills the screen without rounded-lg corner clipping and overlays controls top-right.
const imagePreviewHtml = renderToStaticMarkup(createElement(ImagePreview, { src: '/api/files/f1', name: 'IMG_5018.png' }));
const imgTags = imagePreviewHtml.match(/<img[^>]+>/g) ?? [];
assert.equal(imgTags.length, 2, 'ImagePreview must render thumbnail and dialog images');
assert.match(imgTags[0]!, /h-64 w-72 max-w-full rounded-lg border border-\[var\(--border\)\] object-contain/, 'Thumbnail reserves a stable box before load and on failure');
assert.doesNotMatch(imgTags[1]!, /rounded-lg/, 'Full-screen viewer image must not clip corners with rounded-lg');
assert.match(imgTags[1]!, /max-h-\[96dvh\] max-w-\[96vw\]/, 'Full-screen viewer image scales to 96dvh x 96vw');
assert.match(imagePreviewHtml, /absolute top-3 right-3 z-10 flex gap-2 pt-\[env\(safe-area-inset-top\)\] pr-\[env\(safe-area-inset-right\)\]/, 'Full-screen viewer controls are anchored in a top-right overlay with safe-area padding');
assert.match(imagePreviewHtml, /<dialog[^>]*tabindex="-1"[^>]*autofocus=""[^>]*class="[^"]*outline-none/, 'Dialog suppresses initial control focus ring on open');
const mediaHtml = renderToStaticMarkup(createElement(Timeline, {
  messages: [{ ...message(1, 'bot', '![External image](https://example.com/image.png)'), files: [{ id: 'v1', url: '/v1', name: 'Clip', mediaType: 'video/mp4' }] }], meId: 'me', hrefBase: '/c', people,
}));
assert.match(mediaHtml, /<img[^>]*src="https:\/\/example.com\/image.png"[^>]*loading="lazy"[^>]*referrerPolicy="no-referrer"[^>]*class="h-64 w-72 max-w-full/);
assert.match(mediaHtml, /<video[^>]*class="h-64 w-80 max-w-full[^"]*object-contain/);
assert.equal(clampZoom(0.4), 1);
assert.equal(clampZoom(8), 5);
const zoomed = applyZoom(INITIAL_ZOOM, 2, { x: 40, y: -20 });
assert.deepEqual(zoomed, { scale: 2, x: -40, y: 20 });
assert.deepEqual(applyPan(zoomed, 15, -10), { scale: 2, x: -25, y: 10 });
assert.deepEqual(applyZoom(zoomed, 1), INITIAL_ZOOM, 'Zooming back to 1x resets pan offsets');
assert.deepEqual(applyPan(INITIAL_ZOOM, 15, -10), INITIAL_ZOOM, 'Pan is ignored at 1x scale');
