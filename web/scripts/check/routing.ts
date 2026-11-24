import {
  resolveSideDestination,
  threadCacheKey,
} from '../../lib/thread-nav';
import assert from 'node:assert/strict';
import { conversationRevalidateTarget, isRoomChat, roomHomeHref } from '../../lib/routes';

// PR-B single destination resolution from URL searchParams:
assert.deepEqual(resolveSideDestination(''), { kind: 'none' });
assert.deepEqual(resolveSideDestination('?thread=post-a'), { kind: 'thread', threadId: 'post-a' });
assert.deepEqual(resolveSideDestination('?thread=post-a&replies=20'), { kind: 'thread', threadId: 'post-a', replies: 20 });
assert.deepEqual(resolveSideDestination('?panel=channel&section=settings'), { kind: 'panel', panel: 'channel', section: 'settings' });
assert.deepEqual(resolveSideDestination('?thread=post-a&panel=channel'), { kind: 'panel', panel: 'channel' });
assert.deepEqual(resolveSideDestination('?panel=doc'), { kind: 'panel', panel: 'doc' });
assert.equal(threadCacheKey('ws1', 'channel:ch-a', 'post-1'), 'ws1:channel:ch-a:post-1');
assert.equal(threadCacheKey('ws1', 'ch-a', 'post-1'), 'ws1:channel:ch-a:post-1');

// PR-WEB repro tests:
// 1. Scoped revalidatePath target: revalidates the specific conversation page path, never root layout ('/', 'layout').
assert.deepEqual(conversationRevalidateTarget('ws1', 'channel:ch-1'), {
  path: '/w/ws1/c/channel%3Ach-1',
  type: 'page',
});
assert.deepEqual(conversationRevalidateTarget(undefined, 'agent:a-1'), {
  path: '/(window)/w/[ws]/c/[key]',
  type: 'page',
});

// A Shared Room has no canvas: its home is the shared chat, or setting up your side first. An app room has no side to set up.
assert.equal(roomHomeHref('r1', { shared: 'c1', mySide: { id: 's', name: 'S', corner: 'c2' } }), '/w/r1/c/channel%3Ac1');
assert.equal(roomHomeHref('r1', { shared: 'c1', appId: 'app' }, { find: '1' }), '/w/r1/c/channel%3Ac1?find=1');
assert.equal(roomHomeHref('r1', { shared: 'c1' }), '/rooms/r1/side');
// A room's × hides only on the chats its tabs cover, however the router encodes the path; a DM needs the way back.
const roomChats = { shared: 'c1', mySide: { corner: 'c2' } };
for (const path of ['/w/r1/c/channel%3Ac1', '/w/r1/c/channel:c1', '/w/r1/c/channel%3Ac2']) assert.equal(isRoomChat('r1', roomChats, path), true, path);
for (const path of ['/w/r1/c/agent%3Aa1', '/w/r1/c/channel%3Ac3', '/w/r1/agents/a1']) assert.equal(isRoomChat('r1', roomChats, path), false, path);
assert.equal(isRoomChat('r1', { shared: 'c1' }, '/w/r1/c/channel%3Ac2'), false, 'an app room has no corner');
