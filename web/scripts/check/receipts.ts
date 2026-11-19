import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar } from '../../components/Avatar';
import { pruneOptimisticMessages } from '../../components/Composer';
import { ActivityBar, Timeline, ThreadView } from '../../components/Thread';
import assert from 'node:assert/strict';
import { seenMarks } from '../../lib/receipts';
import { message, people, post } from './fixtures';

// One avatar per participant, under the newest message they've seen.
const three = [message(1), message(2), message(3)];
assert.deepEqual([...seenMarks(three, { bot: 2 }, 'me')], [['m2', ['bot']]]);
// Never the viewer's own.
assert.deepEqual([...seenMarks(three, { me: 3 }, 'me')], []);
// Nobody who hasn't seen anything loaded.
assert.deepEqual([...seenMarks(three, { bot: 0 }, 'me')], []);
// Not someone whose own later message already shows they read up to it.
const answered = [message(1), message(2, 'bot'), message(3)];
assert.deepEqual([...seenMarks(answered, { bot: 2 }, 'me')], []);
assert.deepEqual([...seenMarks(answered, { bot: 3 }, 'me')], [['m3', ['bot']]]);
// Two at the same message share it.
assert.deepEqual([...seenMarks(three, { bot: 3, other: 3 }, 'me')], [['m3', ['bot', 'other']]]);

// The timeline shows it once, under that message, and nothing about tasks or work under way.
const html = renderToStaticMarkup(createElement(Timeline, { messages: three, meId: 'me', hrefBase: '/c', people, seen: { bot: 2 } }));
assert.equal(html.match(/Seen by Bot/g)?.length, 2); // aria label and tooltip
assert.ok(html.indexOf('Seen by Bot') > html.indexOf('m2') && html.indexOf('Seen by Bot') < html.indexOf('m3'));
assert.ok(!/working on it|typing-dots/.test(html));

// A channel post links to its thread, with the replies at a glance (or a visible Reply link before the first reply).
const channelEmpty = renderToStaticMarkup(createElement(Timeline, { messages: [post], meId: 'me', hrefBase: '/c', people, channel: true, threads: {} }));
assert.match(channelEmpty, />Reply</);
const channel = renderToStaticMarkup(createElement(Timeline, { messages: [post], meId: 'me', hrefBase: '/c', people, channel: true, threads: { m1: { count: 2, lastAt: post.at, people: ['bot'] } } }));
assert.match(channel, /Reply in thread/);
assert.match(channel, /2 replies/);

// The thread panel: the post, its replies, and who has seen them.
const replies = [{ ...message(1, 'bot', 'r1'), conversation: 'thread:c:m1', thread: 'm1' }, { ...message(2, 'me', 'r2'), conversation: 'thread:c:m1', thread: 'm1' }];
const thread = renderToStaticMarkup(createElement(ThreadView, { post, replies, meId: 'me', ws: 'ws1', people, seen: { other: 2 } }));
assert.match(thread, /2 replies/);
assert.match(thread, /Seen by Other/);
assert.match(thread, /href="\/w\/ws1\/c\/agent%3Abot"/);
assert.match(thread, /href="\/w\/ws1\/c\/agent%3Aother"/);

// Live agent activity: compact 3-dot + avatar group under the post, with tooltip/aria-label and no waking or per-agent text lines.
const barHtml = renderToStaticMarkup(
  createElement(ActivityBar, {
    items: [
      { agentId: 'waker', state: 'waking', at: post.at },
      { agentId: 'other', state: 'reading', at: post.at },
      { agentId: 'bot', state: 'working', text: 'running tests...', thread: 'm1', at: post.at },
    ],
    people: { ...people, waker: { id: 'waker', name: 'Waker' } },
    hrefBase: '/c',
  }),
);
assert.doesNotMatch(barHtml, /Waker|Waking|⚡|👀|✍️/);
assert.equal(barHtml.match(/activity-dot/g)?.length, 3);
assert.match(barHtml, /\[animation-delay:400ms\]/);
assert.match(barHtml, /\[animation-delay:800ms\]/);
assert.match(barHtml, /aria-label="Other is reading…, Bot is working: running tests…"/);
assert.match(barHtml, /title="Other is reading…"/);
assert.match(barHtml, /title="Bot is working: running tests…"/);
assert.match(barHtml, /href="\/c\?thread=m1"/);
assert.equal(renderToStaticMarkup(createElement(ActivityBar, { items: [{ agentId: 'bot', state: 'waking', at: post.at }], people })), '');

const channelWithActivity = renderToStaticMarkup(
  createElement(Timeline, {
    messages: [post],
    meId: 'me',
    hrefBase: '/c',
    people,
    seen: { bot: 1, other: 1 },
    channel: true,
    threads: {},
    activity: [
      { agentId: 'other', state: 'waking', thread: 'm1', at: post.at },
      { agentId: 'bot', state: 'working', text: 'fixing bug', thread: 'm1', at: post.at },
    ],
  }),
);
assert.equal(channelWithActivity.match(/activity-dot/g)?.length, 3);
assert.match(channelWithActivity, /title="Bot is working: fixing bug…"/);
assert.match(channelWithActivity, /aria-label="Seen by Other"/);
assert.doesNotMatch(channelWithActivity, /Seen by Bot/);
const channelAfterActivity = renderToStaticMarkup(createElement(Timeline, {
  messages: [post], meId: 'me', hrefBase: '/c', people, seen: { bot: 1 }, channel: true, threads: {}, activity: [],
}));
assert.match(channelAfterActivity, /aria-label="Seen by Bot"/);
assert.doesNotMatch(channelAfterActivity, /activity-dot/);

assert.doesNotMatch(channelWithActivity, /Waking|· ✍️|· 👀|>Bot is working/);

// Active agents appear only in ActivityBar, whether or not their read cursor has arrived.
const channelActiveBeforeSeen = renderToStaticMarkup(
  createElement(Timeline, {
    messages: [post],
    meId: 'me',
    hrefBase: '/c',
    people,
    seen: {},
    channel: true,
    threads: {},
    activity: [{ agentId: 'bot', state: 'working', text: 'fixing bug', thread: 'm1', at: post.at }],
  }),
);
assert.doesNotMatch(channelActiveBeforeSeen, /Seen by Bot/);
assert.match(channelActiveBeforeSeen, /title="Bot is working: fixing bug…"/);

// Channel-level activity (!a.thread, e.g. agent reading/working on a new channel post before a thread exists) attaches to the latest post.
const post2 = { ...message(2), conversation: 'channel:c', channelId: 'c' };
const channelLevelActivity = renderToStaticMarkup(
  createElement(Timeline, {
    messages: [post, post2],
    meId: 'me',
    hrefBase: '/c',
    people,
    seen: { bot: 1 },
    channel: true,
    threads: {},
    activity: [{ agentId: 'bot', state: 'reading', at: post2.at }],
  }),
);
assert.equal(channelLevelActivity.match(/activity-dot/g)?.length, 3);
assert.ok(
  channelLevelActivity.indexOf('Bot is reading…') > channelLevelActivity.indexOf('m2'),
  'Channel-level (!a.thread) activity must render under the latest channel post',
);
assert.doesNotMatch(channelLevelActivity, /Seen by Bot/);

// DM activity (!a.thread, channel=false) attaches to the latest message in the DM timeline.
const dmActivity = renderToStaticMarkup(
  createElement(Timeline, {
    messages: three,
    meId: 'me',
    hrefBase: '/c',
    people,
    activity: [{ agentId: 'bot', state: 'working', text: 'drafting reply', at: three[2].at }],
  }),
);
assert.equal(dmActivity.match(/activity-dot/g)?.length, 3);
assert.ok(
  dmActivity.indexOf('Bot is working: drafting reply…') > dmActivity.indexOf('m3'),
  'DM activity must render under the latest message in the DM timeline',
);
assert.doesNotMatch(dmActivity, /Seen by Bot/);

const threadWithActivity = renderToStaticMarkup(
  createElement(ThreadView, {
    post,
    replies,
    meId: 'me',
    ws: 'ws1',
    people,
    seen: { bot: 3, other: 3 },
    activity: [
      { agentId: 'other', state: 'waking', thread: 'm1', at: post.at },
      { agentId: 'bot', state: 'reading', thread: 'm1', at: post.at },
    ],
  }),
);
assert.equal(threadWithActivity.match(/activity-dot/g)?.length, 3);
assert.match(threadWithActivity, /title="Bot is reading…"/);
assert.doesNotMatch(threadWithActivity, /Waking/);
assert.ok(
  threadWithActivity.indexOf('Bot is reading…') > threadWithActivity.indexOf('r2'),
  'When a thread has replies, ActivityBar must render under the latest reply',
);
assert.doesNotMatch(threadWithActivity, /Seen by Bot/);

const emptyThreadWithActivity = renderToStaticMarkup(
  createElement(ThreadView, {
    post,
    replies: [],
    meId: 'me',
    ws: 'ws1',
    people,
    activity: [{ agentId: 'bot', state: 'reading', thread: 'm1', at: post.at }],
  }),
);
assert.equal(emptyThreadWithActivity.match(/activity-dot/g)?.length, 3);
assert.doesNotMatch(emptyThreadWithActivity, /Seen by Bot/);
assert.ok(
  emptyThreadWithActivity.indexOf('Bot is reading…') < emptyThreadWithActivity.indexOf('0 replies'),
  'When a thread has no replies yet, ActivityBar must render under the root post',
);

// A quote is a plain-text, keyboard-operable jump above the body, not a second thread.
const quoteRef = { id: 'm1', fromId: 'bot', from: 'Bot', text: '<img onerror=bad()> quoted שלום' };
const quoteHtml = renderToStaticMarkup(createElement(Timeline, {
  messages: [{ ...message(2), replyTo: quoteRef }], meId: 'me', hrefBase: '/c', people, quoteKey: 'dm:a_b',
}));
assert.match(quoteHtml, /button[^>]*aria-label="Go to message from Bot"/);
assert.match(quoteHtml, /&lt;img onerror=bad\(\)&gt;/);
assert.doesNotMatch(quoteHtml, /title="Reply to message"/);
assert.match(quoteHtml, /tabindex="0"[^>]*aria-label="Message from/);
assert.match(quoteHtml, /data-quote-key="dm:a_b"/);
assert.equal(pruneOptimisticMessages([
  { clientId: 'quoted-opt', display: 'yes', rawText: 'yes', baselineSeq: 1, sending: true, replyTo: quoteRef },
], [{ ...message(2), text: 'yes', fromId: 'me' }], 'me').length, 1, 'Identical text with a different quote must not deduplicate');
assert.equal(pruneOptimisticMessages([
  { clientId: 'quoted-opt', display: 'yes', rawText: 'yes', baselineSeq: 1, sending: true, replyTo: quoteRef },
], [{ ...message(2), text: 'yes', fromId: 'me', replyTo: quoteRef }], 'me').length, 0);

// Avatar presence badges: mailbox listening/wake/offline, endpoint only when online is known.
assert.match(renderToStaticMarkup(createElement(Avatar, { who: { id: 'b', kind: 'mailbox', listening: true }, presence: true })), /Listening now/);
assert.match(renderToStaticMarkup(createElement(Avatar, { who: { id: 'b', kind: 'mailbox', wakes: true }, presence: true })), /Asleep: a message wakes it/);
assert.match(renderToStaticMarkup(createElement(Avatar, { who: { id: 'b', kind: 'mailbox' }, presence: true })), /Offline/);
assert.doesNotMatch(renderToStaticMarkup(createElement(Avatar, { who: { id: 'e', kind: 'endpoint' }, presence: true })), /Online|Offline/);
assert.match(renderToStaticMarkup(createElement(Avatar, { who: { id: 'e', kind: 'endpoint', online: false }, presence: true })), /Offline/);
assert.match(renderToStaticMarkup(createElement(Avatar, { who: { id: 'e', kind: 'endpoint', online: true }, presence: true })), /Online/);
