import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThreadHeader } from '../../components/ThreadHeader';
import { ChannelHeader } from '../../components/ChannelHeader';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { panelHtml } from './panels';

// Channel header counts people and bots, while settings opens its actual section directly.
const channelHeaderProps = { ws: 'ws', conversationKey: 'channel:ch', name: 'Long channel', description: 'Purpose', peopleCount: 3, botCount: 8, document: true, thread: 'post', panel: 'channel', channel: { id: 'ch', public: true } };
const channelHeader = renderToStaticMarkup(createElement(ChannelHeader, channelHeaderProps));
assert.match(channelHeader, /aria-label="3 people"/);
assert.match(channelHeader, /aria-label="8 bots"/);
assert.match(channelHeader, /aria-label="Channel settings"[^>]*href="\/w\/ws\/c\/channel%3Ach\?panel=channel&amp;section=settings"/);
assert.doesNotMatch(channelHeader, /filter=done|Show done threads|Showing done|Members and channel details/);
assert.match(channelHeader, /panel=doc/);
assert.match(channelHeader, /Public channel: anyone can read/);
assert.doesNotMatch(channelHeader, /Slack|Telegram/);
assert.match(panelHtml, /Slack linked/);
assert.match(panelHtml, /Telegram linked/);
assert.match(panelHtml, /href="\/w\/ws1\/c\/channel%3Ach1\?filter=done"[^>]*>Completed threads/);
assert.match(panelHtml, /href="\/w\/ws1\/c\/channel%3Ach1"[^>]*>Open threads/);
const emptyChannelHeader = renderToStaticMarkup(createElement(ChannelHeader, { ...channelHeaderProps, peopleCount: 0, botCount: 0, channel: { id: 'ch' }, document: false }));
assert.match(emptyChannelHeader, /aria-label="0 people"/);
assert.match(emptyChannelHeader, /aria-label="0 bots"/);
assert.doesNotMatch(emptyChannelHeader, /Public channel:|Shared document/);
assert.match(channelHeader, /Long channel: close channel details/);
assert.match(panelHtml, /href="\/p\/ch1"[^>]*>🌐 Public link/);
// A room's tabs take the title's place, and the page keeps its heading for screen readers.
const roomHeader = renderToStaticMarkup(createElement(ChannelHeader, { ...channelHeaderProps, tabs: createElement('nav', null, 'tabs') }));
assert.match(roomHeader, /<h1 class="sr-only">[^<]+<\/h1><nav>tabs<\/nav>/);
assert.doesNotMatch(roomHeader, /open channel details/);
assert.match(roomHeader, /aria-label="Channel settings"/);
const closedDetailsHeader = renderToStaticMarkup(createElement(ChannelHeader, { ...channelHeaderProps, panel: undefined }));
assert.match(channelHeader, /aria-label="Long channel: close channel details"[^>]*href="\/w\/ws\/c\/channel%3Ach\?thread=post"/);
assert.match(closedDetailsHeader, /aria-label="Long channel: open channel details"[^>]*href="\/w\/ws\/c\/channel%3Ach\?thread=post&amp;panel=channel"/);

assert.match(panelHtml, /role="tab" aria-selected="true"[^>]*>Settings/);

// Thread header actions stay icon-only; sharing is editable only by owners of private channels.
const threadHeaderProps = { channelName: 'dev', backHref: '/w/ws/c/channel%3Ach', done: false, doneAction: async () => {}, publicHref: '/p/ch?thread=post', shared: false, channelPublic: false, shareAction: async () => ({ ok: true as const }) };
const threadHeaderHtml = renderToStaticMarkup(createElement(ThreadHeader, threadHeaderProps));
assert.match(threadHeaderHtml, /aria-label="Back to channel"/);
assert.doesNotMatch(threadHeaderHtml, /aria-label="Close thread"|>✓ Done<|>Share publicly</);
assert.match(threadHeaderHtml, /aria-label="Mark thread as done"/);
assert.match(threadHeaderHtml, /aria-label="Share thread"/);
assert.match(threadHeaderHtml, /Anyone with the link can read this thread and its files/);
assert.doesNotMatch(threadHeaderHtml, /aria-label="Copy link"/);
const sharedThreadHtml = renderToStaticMarkup(createElement(ThreadHeader, { ...threadHeaderProps, shared: true }));
assert.match(sharedThreadHtml, /aria-label="Copy link"/);
assert.match(sharedThreadHtml, /role="switch"[^>]*checked/);
const publicChannelShare = renderToStaticMarkup(createElement(ThreadHeader, { ...threadHeaderProps, channelPublic: true, shareAction: undefined }));
assert.match(publicChannelShare, /role="switch"[^>]*disabled[^>]*checked/);
assert.match(publicChannelShare, /This channel is public/);
const privateNonOwnerShare = renderToStaticMarkup(createElement(ThreadHeader, { ...threadHeaderProps, shareAction: undefined, doneAction: undefined }));
assert.match(privateNonOwnerShare, /role="switch"[^>]*disabled/);
assert.doesNotMatch(privateNonOwnerShare, /aria-label="Copy link"|aria-label="Mark thread as done"/);

// PR-B: PanelSlot keeps cross-route transitions (closingFrom, replacingFrom, nav, close-aside) while delegating
// intra-channel thread transitions (`targetThread` / `pending === 'thread'`) to ChannelShell.
const panelSlotSrc = readFileSync(new URL('../../components/PanelSlot.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(
  panelSlotSrc,
  /targetThread|pending === 'thread'/,
  'PanelSlot must delegate thread transitions to ChannelShell while keeping cross-route nav/close-aside',
);

// PR-A: sendInConversation must not call revalidatePath (which triggers a competing server-action RSC Flight render
// and races in-flight thread navigations); message freshness is handled by optimistic Composer state + LiveRefresh.
const chatActionsSrc = readFileSync(new URL('../../lib/actions/chat.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  chatActionsSrc,
  /revalidatePath\s*\(/,
  'sendInConversation must not call revalidatePath (which races thread switches and double-refreshes alongside LiveRefresh)',
);
