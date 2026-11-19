import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatWorkspaceCookie } from '../../components/RememberWorkspace';
import { Timeline } from '../../components/Thread';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { doc } from '../../lib/docs';
import { people, post } from './fixtures';

// Done threads UI & docs: Timeline shows ✓ Done / Reopen action for thread starter or channel owner, preserves ?filter=done in thread links, and /docs/channels-and-messaging documents Done threads.
const doneTimelineHtml = renderToStaticMarkup(
  createElement(Timeline, {
    messages: [post],
    meId: 'me',
    hrefBase: '/w/ws1/c/channel%3Ac',
    people,
    channel: true,
    filter: 'done',
    doneThreads: ['m1'],
    channelOwner: false,
    onToggleDone: () => () => {},
    threads: { m1: { count: 2, lastAt: post.at, people: ['bot'], done: true } },
  }),
);
assert.match(doneTimelineHtml, />✓ Done</);
assert.match(doneTimelineHtml, />Reopen</);
assert.match(doneTimelineHtml, /href="\/w\/ws1\/c\/channel%3Ac\?thread=m1&amp;filter=done"/);
assert.match(doc('channels-and-messaging')?.body ?? '', /Marking a thread as Done & Reopening/);

// Track D (button feedback): these action forms give instant submit feedback via PendingButton,
// so a click never feels dead. Guard against a regression back to a raw <button> submit.
for (const f of ['NewChannelDialog', 'NewWorkspaceDialog', 'ScheduleForm', 'GatewayConnect', 'RoomDocument', 'RoomStatus']) {
  const src = readFileSync(new URL(`../../components/${f}.tsx`, import.meta.url), 'utf8');
  assert.match(src, /PendingButton/, `${f} must use PendingButton so its submit button shows instant feedback`);
}

// Track B (navigation, workspace cookie sync & scoped revalidation):
assert.equal(
  formatWorkspaceCookie('ws-alpha'),
  'hub_workspace=ws-alpha; path=/; max-age=31536000; samesite=lax',
  'RememberWorkspace formats synchronous client cookie for immediate workspace persistence',
);
const rememberWsSrc = readFileSync(new URL('../../components/RememberWorkspace.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(
  rememberWsSrc,
  /rememberWorkspace\s*\(/,
  'RememberWorkspace must update document.cookie synchronously on the client without firing a Server Action POST',
);
assert.doesNotMatch(
  rememberWsSrc,
  /from\s+['"]@\/lib\/hub['"]/,
  'RememberWorkspace is a Client Component and must not import server-only @/lib/hub',
);
const canvasActionsSrc = readFileSync(new URL('../../lib/actions/canvas.ts', import.meta.url), 'utf8');
assert.doesNotMatch(canvasActionsSrc, /revalidatePath\(\s*['"]\/['"]/, 'canvas.ts must never invalidate root layout "/"');
const crewCanvasSrc = readFileSync(new URL('../../components/CrewCanvas.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(crewCanvasSrc, /router\.refresh\s*\(/, 'CrewCanvas must not trigger redundant router.refresh() after server actions');

// Review #47: LiveRefresh and MarkRead share one refresh scheduler, so a live message re-renders the page once.
const liveRefreshSrc = readFileSync(new URL('../../components/LiveRefresh.tsx', import.meta.url), 'utf8');
const markReadSrc = readFileSync(new URL('../../components/MarkRead.tsx', import.meta.url), 'utf8');
assert.match(liveRefreshSrc, /scheduleRefresh\(/, 'LiveRefresh must refresh through the shared scheduler');
assert.doesNotMatch(liveRefreshSrc, /setTimeout\(/, 'LiveRefresh must not keep its own refresh timer');
assert.match(markReadSrc, /holdRefresh\(\)/, 'MarkRead must hold the shared refresh while its read is in flight');
assert.doesNotMatch(markReadSrc, /\.then\(\(\)\s*=>\s*router\.refresh\(\)/, 'MarkRead must not refresh on its own after a read');
console.log('chat checks passed');
