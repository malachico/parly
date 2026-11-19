import { pruneOptimisticMessages, type OptimisticItem } from '../../components/Composer';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conversationUnread } from '../../lib/receipts';
import { message } from './fixtures';

// 1b. Per-open unread count (conversationUnread): reads `page.unread` directly from GET /conversations/:key/messages
//     (removing the blocking `myConversations` / `GET /conversations` N+1 scan on open), with a fallback to counting
//     loaded messages after `seen[meId]` when `page.unread` is undefined (e.g. older pages or rolling deploy).
assert.equal(
  conversationUnread({ unread: 0, messages: [message(1, 'bot'), message(2, 'bot')], seen: { me: 0 } }, 'me'),
  0,
  'Uses hub page.unread directly when present (even if raw messages after seen exist, e.g. filtered by isFor)',
);
assert.equal(
  conversationUnread({ unread: 4, messages: [message(1, 'bot')], seen: { me: 1 } }, 'me'),
  4,
  'Returns hub page.unread directly when positive',
);
assert.equal(
  conversationUnread({ messages: [message(1, 'me'), message(2, 'bot'), message(3, 'bot')], seen: { me: 1 } }, 'me'),
  2,
  'Falls back to counting loaded messages from others after seen[meId] when page.unread is undefined',
);

// 2. Optimistic message deduplication (pruneOptimisticMessages):
//    - Replaces the optimistic bubble when the real message arrives via LiveRefresh BEFORE the POST returns serverId/serverSeq.
//    - Replaces the optimistic bubble when matched by serverId or serverSeq.
//    - Does not falsely match an older message (seq <= baselineSeq) or another sender's message with the same text.
//    - Consumes rendered messages 1-for-1 when two identical messages ("yes", "yes") are sent back-to-back.
const optA: OptimisticItem = {
  clientId: 'opt-1',
  display: 'hello world',
  rawText: 'hello world',
  baselineSeq: 10,
  sending: true,
};
// Older message with same text (seq 8 <= baselineSeq 10) and another user's message with same text (seq 11, fromId 'bot') do NOT deduplicate optA.
assert.equal(
  pruneOptimisticMessages(
    [optA],
    [
      { id: 'm8', seq: 8, fromId: 'me', text: 'hello world' },
      { id: 'm11', seq: 11, fromId: 'bot', text: 'hello world' },
    ],
    'me',
  ).length,
  1,
  'Optimistic message must stay visible when only an older message or another user message has the same text',
);
// LiveRefresh delivers the real message (seq 12 > baselineSeq 10, fromId 'me') while POST is still in flight (no serverId yet):
assert.deepEqual(
  pruneOptimisticMessages(
    [optA],
    [
      { id: 'm8', seq: 8, fromId: 'me', text: 'hello world' },
      { id: 'm12', seq: 12, fromId: 'me', text: 'hello world' },
    ],
    'me',
  ),
  [],
  'Optimistic bubble must be replaced (not duplicated) as soon as LiveRefresh delivers the real message',
);
// Matching by serverId / serverSeq after POST resolves:
const optResolved: OptimisticItem = {
  ...optA,
  sending: false,
  serverId: 'srv-99',
  serverSeq: 15,
};
assert.deepEqual(
  pruneOptimisticMessages([optResolved], [{ id: 'srv-99', seq: 15, fromId: 'me', text: 'hello world' }], 'me'),
  [],
  'Optimistic bubble with serverId/serverSeq must be removed when the server message renders',
);
// Two identical rapid sends ("yes", "yes") from baselineSeq 10: first arrival (seq 11) removes only the first optimistic bubble.
const rapid1: OptimisticItem = { clientId: 'opt-r1', display: 'yes', rawText: 'yes', baselineSeq: 10, sending: true };
const rapid2: OptimisticItem = { clientId: 'opt-r2', display: 'yes', rawText: 'yes', baselineSeq: 10, sending: true };
assert.deepEqual(
  pruneOptimisticMessages([rapid1, rapid2], [{ id: 'm11', seq: 11, fromId: 'me', text: 'yes' }], 'me').map((o) => o.clientId),
  ['opt-r2'],
  'First arrived identical message must consume only the first optimistic bubble, keeping the second until its own message arrives',
);
assert.deepEqual(
  pruneOptimisticMessages(
    [rapid1, rapid2],
    [
      { id: 'm11', seq: 11, fromId: 'me', text: 'yes' },
      { id: 'm12', seq: 12, fromId: 'me', text: 'yes' },
    ],
    'me',
  ),
  [],
  'Both optimistic bubbles are removed once both real messages arrive',
);
// Cross-thread isolation: an optimistic message created in thread A (`channel:ch1:post-a`) must never appear in thread B (`channel:ch1:post-b`),
// even when thread B has no messages (`rendered = []`) or unrelated messages where `serverId` is absent.
const optFromThreadA: OptimisticItem = {
  clientId: 'opt-thread-a',
  draftKey: 'channel:ch1:post-a',
  display: 'sent in thread A',
  rawText: 'sent in thread A',
  baselineSeq: 5,
  sending: false,
  serverId: 'srv-thread-a',
  serverSeq: 6,
};
assert.deepEqual(
  pruneOptimisticMessages([optFromThreadA], [], 'me', 'channel:ch1:post-b'),
  [],
  'Optimistic message from thread A must not leak into empty thread B',
);
assert.deepEqual(
  pruneOptimisticMessages([optFromThreadA], [{ id: 'm-b1', seq: 1, fromId: 'bot', text: 'hi in B' }], 'me', 'channel:ch1:post-b'),
  [],
  'Optimistic message from thread A must not leak into thread B when thread B has its own messages',
);
assert.equal(
  pruneOptimisticMessages([optFromThreadA], [{ id: 'm-a1', seq: 1, fromId: 'bot', text: 'hi in A' }], 'me', 'channel:ch1:post-a').length,
  1,
  'Optimistic message in thread A stays visible in thread A until srv-thread-a lands in renderedMessages',
);
const convPageSrc = readFileSync(new URL('../../components/DmConversation.tsx', import.meta.url), 'utf8');
const channelShellSrc = readFileSync(new URL('../../components/ChannelShell.tsx', import.meta.url), 'utf8');
assert.equal(
  (convPageSrc.match(/<Composer\s+key=\{/g) ?? []).length + (channelShellSrc.match(/<Composer\s+key=\{/g) ?? []).length,
  2,
  'Both main (DmConversation.tsx) and thread (ChannelShell.tsx) <Composer> instances must be keyed so thread/conversation switches reset optimistic state',
);
assert.match(
  channelShellSrc,
  /<aside\s+key=\{postId\}\s+aria-label="Thread"/,
  'Thread <aside> in ChannelShell.tsx must be keyed by postId so switching threads remounts cleanly',
);
