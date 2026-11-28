import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingView } from '../../components/Landing';
import { SignInHero } from '../../components/SignInHero';
import { atPlanCap, isBillingOwner, planCapMessage } from '../../lib/plan-limits';
import { pricingCta } from '../../lib/pricing';
import { JoinBar } from '../../components/JoinBar';
import {
  createThreadNavController,
  readChannelThread,
  resolveChannelCloseHref,
  type ThreadPayload,
} from '../../lib/thread-nav';
import {
  isIntraChannelSideNav,
  nextPendingPanelState,
  resolveClosingPanelClick,
} from '../../components/PanelSlot';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

void (async () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 4. PR-B server-side thread reader (`readChannelThread`): enforces session auth + workspace & channel membership + channel post ownership, and resolves former-member (`gone`) avatars:
  const mockMe = {
    id: 'me',
    name: 'Malachi',
    description: '',
    kind: 'human' as const,
    skills: [],
    public: false,
    workspaces: [
      {
        id: 'ws1',
        name: 'WS 1',
        owner: true,
        channels: [
          {
            id: 'ch1',
            workspaceId: 'ws1',
            name: 'dev',
            owner: true,
            doneThreads: ['post-done'],
            publicThreads: ['post-pub'],
            roles: { bot1: 'implementer' },
          },
        ],
      },
    ],
    channels: ['ch1'],
    lastSeen: '2026-10-27T00:00:00Z',
  };

  const unauthRes = await readChannelThread(
    { ws: 'ws1', key: 'channel:ch1', postId: 'post-a' },
    { getToken: async () => undefined, getMe: async () => undefined, fetchHub: async () => ({}) as never },
  );
  assert.equal(unauthRes.status, 401, 'Unauthenticated thread read must return 401');

  const wrongWsRes = await readChannelThread(
    { ws: 'ws-other', key: 'channel:ch1', postId: 'post-a' },
    { getToken: async () => 'tok', getMe: async () => mockMe, fetchHub: async () => ({}) as never },
  );
  assert.equal(wrongWsRes.status, 403, 'Non-member workspace thread read must return 403');

  const wrongChannelRes = await readChannelThread(
    { ws: 'ws1', key: 'channel:ch-secret', postId: 'post-a' },
    { getToken: async () => 'tok', getMe: async () => mockMe, fetchHub: async () => ({}) as never },
  );
  assert.equal(wrongChannelRes.status, 403, 'Non-member channel thread read must return 403');

  const wrongPostConvRes = await readChannelThread(
    { ws: 'ws1', key: 'channel:ch1', postId: 'post-other-ch' },
    {
      getToken: async () => 'tok',
      getMe: async () => mockMe,
      fetchHub: async (p) => {
        if (p === '/messages/post-other-ch') {
          return { message: { id: 'post-other-ch', conversation: 'channel:ch-other', seq: 1, fromId: 'me', from: 'Malachi', text: 'root', at: '2026-10-27T00:00:00Z' } } as never;
        }
        return { messages: [], seen: {}, older: false, activity: [] } as never;
      },
    },
  );
  assert.equal(wrongPostConvRes.status, 404, 'Post belonging to a different channel must return 404');

  const validThreadRes = await readChannelThread(
    { ws: 'ws1', key: 'channel:ch1', postId: 'post-done', replies: 15 },
    {
      getToken: async () => 'tok',
      getMe: async () => mockMe,
      fetchHub: async (p) => {
        if (p === '/messages/post-done') {
          return { message: { id: 'post-done', conversation: 'channel:ch1', seq: 10, fromId: 'me', from: 'Malachi', text: 'root post', at: '2026-10-27T00:00:00Z' } } as never;
        }
        if (p === '/conversations/thread%3Ach1%3Apost-done/messages?limit=15') {
          return {
            messages: [{ id: 'rep-1', conversation: 'thread:ch1:post-done', seq: 1, fromId: 'gone-agent', from: 'Former Bot', text: 'reply 1', at: '2026-10-27T00:01:00Z' }],
            seen: { bot1: 1 },
            older: false,
            unread: 1,
            activity: [{ agentId: 'bot1', state: 'working', text: 'testing', thread: 'post-done', at: '2026-10-27T00:01:05Z' }],
          } as never;
        }
        if (p === '/agents?channel=ch1') {
          return [{ id: 'bot1', name: 'Bot One', kind: 'mailbox' }] as never;
        }
        if (p === '/agents/gone-agent') {
          return { id: 'gone-agent', name: 'Former Bot', kind: 'mailbox', avatar: 'seed-gone' } as never;
        }
        throw new Error(`Unexpected hub path: ${p}`);
      },
    },
  );
  assert.equal(validThreadRes.status, 200);
  if (validThreadRes.status === 200) {
    assert.equal(validThreadRes.body.post.id, 'post-done');
    assert.equal(validThreadRes.body.replies.length, 1);
    assert.equal(validThreadRes.body.done, true);
    assert.equal(validThreadRes.body.people['bot1']?.role, 'implementer');
    assert.equal(validThreadRes.body.people['gone-agent']?.name, 'Former Bot', 'Must resolve former-member avatars for thread replies');
  }

  // 5. PR-B behavioral tests: SSR hydration seed, send in Thread A -> switch to Thread B (zero flash of Thread A),
  //    delayed/out-of-order/failed requests, back/forward via popstate, and live-stream freshness refetch:
  const makeThreadPayload = (postId: string, replyTexts: string[] = []): ThreadPayload => ({
    post: { id: postId, conversation: 'channel:ch1', seq: 1, fromId: 'me', from: 'Malachi', text: `Root ${postId}`, at: '2026-10-27T00:00:00Z' },
    replies: replyTexts.map((t, idx) => ({
      id: `${postId}-r${idx + 1}`,
      conversation: `thread:ch1:${postId}`,
      seq: idx + 1,
      fromId: idx % 2 === 0 ? 'me' : 'bot',
      from: idx % 2 === 0 ? 'Malachi' : 'Bot',
      text: t,
      at: `2026-10-27T00:00:0${idx + 1}Z`,
    })),
    seen: { me: replyTexts.length },
    older: false,
    activity: [],
    unread: 0,
    people: {},
    done: false,
    shared: false,
  });

  const pushedUrls: string[] = [];
  const observedStates: string[] = [];
  let resolveThreadB: ((data: ThreadPayload) => void) | undefined;
  let resolveThreadC: ((data: ThreadPayload) => void) | undefined;
  let failThreadD = true;
  let threadBFetchCount = 0;

  const navCtrl = createThreadNavController({
    ws: 'ws1',
    conversationKey: 'channel:ch1',
    meId: 'me',
    initialSearch: 'thread=post-a',
    initialThread: { threadId: 'post-a', data: makeThreadPayload('post-a', ['initial in A']) },
    pushHistory: (url) => pushedUrls.push(url),
    fetchThread: async ({ threadId }) => {
      if (threadId === 'post-a') {
        return makeThreadPayload('post-a', ['initial in A', 'sent in A']);
      }
      if (threadId === 'post-b') {
        threadBFetchCount += 1;
        if (threadBFetchCount === 1) {
          return new Promise<ThreadPayload>((r) => {
            resolveThreadB = r;
          });
        }
        return makeThreadPayload('post-b', ['b-reply-1', 'b-fresh-from-event']);
      }
      if (threadId === 'post-c') {
        return new Promise<ThreadPayload>((r) => {
          resolveThreadC = r;
        });
      }
      if (threadId === 'post-d') {
        if (failThreadD) throw new Error('Hub 503');
        return makeThreadPayload('post-d', ['d-recovered']);
      }
      throw new Error(`Unknown thread ${threadId}`);
    },
    onChange: () => {
      const vs = navCtrl.getViewState();
      observedStates.push(vs.kind === 'thread' || vs.kind === 'thread-loading' || vs.kind === 'thread-error' ? `${vs.kind}:${vs.threadId}` : vs.kind === 'panel' ? `panel:${vs.panel}` : 'none');
    },
  });

  // 5a. SSR hydration: initial render with ?thread=post-a + initialThread seed renders Thread A immediately (no skeleton flash):
  const initialVs = navCtrl.getViewState();
  assert.equal(initialVs.kind, 'thread', 'SSR-seeded thread must render immediately on first paint without skeleton flash');
  if (initialVs.kind === 'thread') {
    assert.equal(initialVs.threadId, 'post-a');
    assert.equal(initialVs.data.replies.length, 1);
  }

  // 5b. Repro (Send in Thread A -> Click Thread B while send is in flight -> Send in A resolves + a live event arrives while B is still loading):
  observedStates.length = 0;
  navCtrl.navigate('/w/ws1/c/channel%3Ach1?thread=post-b');
  assert.equal(pushedUrls.at(-1), '/w/ws1/c/channel%3Ach1?thread=post-b');
  assert.deepEqual(navCtrl.getViewState(), {
    kind: 'thread-loading',
    threadId: 'post-b',
    replyLimit: 10,
  });

  // While Thread B is still loading (delayed fetch), Thread A's sendInConversation resolves AND an older SSR seed for Thread A lands:
  navCtrl.recordSentReply('post-a', {
    id: 'post-a-r2',
    conversation: 'thread:ch1:post-a',
    seq: 2,
    fromId: 'me',
    from: 'Malachi',
    text: 'sent in A',
    at: '2026-10-27T00:00:02Z',
  });
  navCtrl.seedThread('post-a', makeThreadPayload('post-a', ['initial in A']));

  // Verify Thread A NEVER flashed back onto the screen while Thread B is loading, and Thread A's cache kept the sent reply:
  assert.ok(
    observedStates.every((s) => s === 'thread-loading:post-b'),
    `Thread A must NEVER flash while Thread B is loading; observed states: ${observedStates.join(', ')}`,
  );
  assert.equal(navCtrl.getCachedThread('post-a')?.replies.at(-1)?.text, 'sent in A', 'Thread A cache must retain the newly sent reply');

  // 5c. Out-of-order delayed requests: switch from B (still delayed) to C, resolve C first, then resolve delayed B:
  navCtrl.navigate('/w/ws1/c/channel%3Ach1?thread=post-c');
  assert.equal(navCtrl.getViewState().kind, 'thread-loading');
  resolveThreadC?.(makeThreadPayload('post-c', ['c-reply-1']));
  await wait(10);
  const vsOnC = navCtrl.getViewState();
  assert.equal(vsOnC.kind, 'thread');
  if (vsOnC.kind === 'thread') assert.equal(vsOnC.threadId, 'post-c');

  // Now delayed Thread B resolves while user is viewing Thread C: must cache B without overriding C!
  resolveThreadB?.(makeThreadPayload('post-b', ['b-reply-1']));
  await wait(10);
  const vsStillOnC = navCtrl.getViewState();
  assert.equal(vsStillOnC.kind, 'thread');
  if (vsStillOnC.kind === 'thread') {
    assert.equal(vsStillOnC.threadId, 'post-c', 'Late resolution of Thread B must not override active Thread C');
  }
  assert.equal(navCtrl.getCachedThread('post-b')?.replies[0]?.text, 'b-reply-1', 'Delayed Thread B response is cached under post-b');

  // 5d. Failed request + retry: switch to Thread D (fails with 503) -> shows thread-error for D (never C), then retry succeeds:
  navCtrl.navigate('/w/ws1/c/channel%3Ach1?thread=post-d');
  await wait(10);
  const vsErrorD = navCtrl.getViewState();
  assert.equal(vsErrorD.kind, 'thread-error', 'Failed thread fetch must show error state for target thread, never previous thread');
  if (vsErrorD.kind === 'thread-error') {
    assert.equal(vsErrorD.threadId, 'post-d');
    assert.match(vsErrorD.error, /Hub 503/);
  }
  failThreadD = false;
  await navCtrl.retryThread('post-d');
  const vsRecoveredD = navCtrl.getViewState();
  assert.equal(vsRecoveredD.kind, 'thread');
  if (vsRecoveredD.kind === 'thread') {
    assert.equal(vsRecoveredD.threadId, 'post-d');
    assert.equal(vsRecoveredD.data.replies[0]?.text, 'd-recovered');
  }

  // 5e. Transitions (thread -> panel -> none -> back/forward via popstate) & live-stream freshness refetch:
  navCtrl.navigate('/w/ws1/c/channel%3Ach1?panel=channel&section=settings');
  assert.deepEqual(navCtrl.getViewState(), { kind: 'panel', panel: 'channel', section: 'settings' });

  navCtrl.navigate('/w/ws1/c/channel%3Ach1');
  assert.deepEqual(navCtrl.getViewState(), { kind: 'none' });

  // Browser Back (popstate) to ?thread=post-b: renders immediately (0ms) from cache and triggers silent background refresh:
  navCtrl.onPopState('?thread=post-b');
  const vsPopStateB = navCtrl.getViewState();
  assert.equal(vsPopStateB.kind, 'thread', 'Back navigation to cached Thread B must render immediately without skeleton flash');
  if (vsPopStateB.kind === 'thread') {
    assert.equal(vsPopStateB.threadId, 'post-b');
    assert.equal(vsPopStateB.refreshing, true, 'Cached thread must silently revalidate in background on open');
  }
  await wait(10);
  // Background refresh (or a live event: refreshActiveThread) delivers 'b-fresh-from-event':
  await navCtrl.refreshActiveThread();
  assert.equal(
    navCtrl.getCachedThread('post-b')?.replies.at(-1)?.text,
    'b-fresh-from-event',
    'Targeted refetch on a live event must update active thread cache with fresh replies',
  );
  // Live replies: another thread's reply is ignored; one in the open thread is appended and counted unread.
  const liveB = navCtrl.getCachedThread('post-b');
  if (!liveB) throw new Error('post-b must be cached');
  navCtrl.seedThread('post-b', { ...liveB, people: { bot: { id: 'bot', name: 'Bot' } } as ThreadPayload['people'] });
  const liveReply = { ...liveB.replies[0], id: 'post-b-live', seq: 99, fromId: 'bot', text: 'live in B' };
  navCtrl.recordLiveReply({ ...liveReply, id: 'post-x-live', thread: 'post-x' });
  assert.equal(navCtrl.getCachedThread('post-b')?.replies.length, liveB.replies.length, 'Another thread reply must not touch the open thread');
  navCtrl.recordLiveReply({ ...liveReply, thread: 'post-b' });
  assert.equal(navCtrl.getCachedThread('post-b')?.replies.at(-1)?.text, 'live in B', 'Live reply in the open thread must append locally');
  assert.equal(navCtrl.getCachedThread('post-b')?.unread, liveB.unread + 1, "Someone else's live reply must count as unread");
  navCtrl.recordLiveReply({ ...liveReply, thread: 'post-b' });
  assert.equal(navCtrl.getCachedThread('post-b')?.replies.length, liveB.replies.length + 1, 'The same live event twice must not append twice');
  assert.equal(navCtrl.getCachedThread('post-b')?.unread, liveB.unread + 1, 'The same live event twice must not count unread twice');
  navCtrl.updateThreadMeta('post-b', { done: true });
  navCtrl.seedThread('post-b', { ...navCtrl.getCachedThread('post-b')!, people: { bot: { id: 'bot', name: 'Bot' }, me: { id: 'me', name: 'Malachi' } } as ThreadPayload['people'] });
  navCtrl.recordLiveReply({ ...liveReply, id: 'post-b-mine', seq: 100, fromId: 'me', thread: 'post-b' });
  assert.equal(navCtrl.getCachedThread('post-b')?.unread, liveB.unread + 1, 'My own live reply must not count as unread');
  assert.equal(navCtrl.getCachedThread('post-b')?.done, false, 'A live reply reopens a done thread (the hub reopens it)');
  navCtrl.seedThread('post-b', { ...navCtrl.getCachedThread('post-b')!, done: true });
  assert.equal(navCtrl.getCachedThread('post-b')?.done, false, 'A stale seed must not mark the reopened thread done again');
  // Someone it can't draw: fetched whole instead.
  const fetchesBeforeStranger = threadBFetchCount;
  navCtrl.recordLiveReply({ ...liveReply, id: 'post-b-stranger', seq: 101, fromId: 'stranger', thread: 'post-b' });
  assert.equal(threadBFetchCount, fetchesBeforeStranger + 1, 'A live reply from someone not in people must refetch the thread');
  await wait(10);
  // setThreadActivity: replaces a cached thread's activity; a thread not cached is left alone.
  const working = [{ agentId: 'bot', state: 'working', text: 'on it', thread: 'post-b', at: '2026-10-27T00:02:00Z' }] as ThreadPayload['activity'];
  navCtrl.setThreadActivity('post-b', working);
  assert.deepEqual(navCtrl.getCachedThread('post-b')?.activity, working, 'setThreadActivity must set a cached thread’s activity');
  navCtrl.setThreadActivity('post-nowhere', working);
  assert.equal(navCtrl.getCachedThread('post-nowhere'), undefined, 'setThreadActivity must not cache a thread it never loaded');
  // A live reply while the open thread is still loading (not cached) fetches it whole.
  const pendingFetches: string[] = [];
  const loadingCtrl = createThreadNavController({
    ws: 'ws1',
    conversationKey: 'channel:ch1',
    meId: 'me',
    initialSearch: 'thread=post-l',
    fetchThread: ({ threadId }) => {
      pendingFetches.push(threadId);
      return new Promise<ThreadPayload>(() => {});
    },
  });
  loadingCtrl.navigate('/w/ws1/c/channel%3Ach1?thread=post-l');
  const fetchesBeforeLive = pendingFetches.length;
  loadingCtrl.recordLiveReply({ ...liveReply, thread: 'post-l' });
  assert.equal(pendingFetches.length, fetchesBeforeLive + 1, 'A live reply for an uncached open thread must fetch it');
  assert.equal(loadingCtrl.getCachedThread('post-l'), undefined, 'A live reply must not cache a thread it never loaded');
  loadingCtrl.dispose();

  // 5f. Optimistic `done`/`shared` overrides + `markThreadSeen` cache persistence across A -> B -> A switches:
  const unreadPayload = {
    ...makeThreadPayload('post-unread', ['r1', 'r2']),
    unread: 2,
    seen: {},
  };
  navCtrl.seedThread('post-unread', unreadPayload);
  assert.equal(navCtrl.getCachedThread('post-unread')?.unread, 2);
  navCtrl.markThreadSeen('post-unread', 2);
  assert.equal(navCtrl.getCachedThread('post-unread')?.unread, 0, 'markThreadSeen must clear unread in cache immediately');
  assert.equal(navCtrl.getCachedThread('post-unread')?.seen['me'], 2, 'markThreadSeen must record seen[me] in cache');
  // Switching A -> B -> A must preserve unread: 0 and seen['me']: 2 even if a stale SSR snapshot of post-unread is seeded:
  navCtrl.updateThreadMeta('post-unread', { done: true, shared: true });
  navCtrl.seedThread('post-unread', unreadPayload);
  assert.equal(navCtrl.getCachedThread('post-unread')?.unread, 0, 'Stale SSR seed must not regress unread back to > 0');
  assert.equal(navCtrl.getCachedThread('post-unread')?.seen['me'], 2, 'Stale SSR seed must not regress seen[me]');
  assert.equal(navCtrl.getCachedThread('post-unread')?.done, true, 'Stale SSR seed must not overwrite optimistic done=true');
  assert.equal(navCtrl.getCachedThread('post-unread')?.shared, true, 'Stale SSR seed must not overwrite optimistic shared=true');

  // Preserving older replies loaded via loadOlderReplies when a smaller SSR snapshot (older: true) is seeded:
  const expandedPayload: ThreadPayload = {
    ...makeThreadPayload('post-older', ['r1', 'r2', 'r3', 'r4']),
    older: false,
  };
  const partialSsrPayload: ThreadPayload = {
    ...makeThreadPayload('post-older', []),
    replies: expandedPayload.replies.slice(2),
    older: true,
  };
  navCtrl.seedThread('post-older', expandedPayload, 20);
  navCtrl.seedThread('post-older', partialSsrPayload, 10);
  assert.deepEqual(
    navCtrl.getCachedThread('post-older')?.replies.map((r) => r.text),
    ['r1', 'r2', 'r3', 'r4'],
    'Seeding a partial SSR snapshot must not drop older replies already loaded in cache',
  );
  assert.equal(
    navCtrl.getCachedThread('post-older')?.older,
    false,
    'Seeding a partial SSR snapshot must preserve existing.older when older replies are retained',
  );

  // 5g. Cross-route PanelSlot vs intra-channel ChannelShell separation:
  assert.equal(
    isIntraChannelSideNav(
      '/w/ws1/c/channel%3Ach1',
      '?thread=post-a',
      new URL('http://localhost/w/ws1/c/channel%3Ach1?thread=post-b'),
    ),
    true,
    'Intra-channel thread switch is handled by ChannelShell, not PanelSlot',
  );
  assert.equal(
    isIntraChannelSideNav(
      '/w/ws1/c/channel%3Ach1',
      '?thread=post-a',
      new URL('http://localhost/w/ws1/c/channel%3Ach1?panel=channel&section=settings'),
    ),
    true,
    'Intra-channel panel switch is handled by ChannelShell, not PanelSlot',
  );
  assert.equal(
    isIntraChannelSideNav(
      '/w/ws1/c/channel%3Ach1',
      '?thread=post-a',
      new URL('http://localhost/w/ws1/c/channel%3Ach1?filter=done'),
    ),
    false,
    'Timeline filter change is a full route transition',
  );
  assert.equal(
    isIntraChannelSideNav(
      '/w/ws1/c/channel%3Ach1',
      '?thread=post-a',
      new URL('http://localhost/w/ws1/c/channel%3Ach2'),
    ),
    false,
    'Cross-channel navigation is handled by PanelSlot (replace)',
  );
  assert.equal(
    resolveClosingPanelClick('ws1', '/w/ws1/c/channel%3Ach1', '?thread=post-a', 'http://localhost/w/ws1/c/channel%3Ach2'),
    'replace',
    'Switching from Channel 1 to Channel 2 must replace stale panel children with skeleton',
  );
  assert.equal(
    resolveClosingPanelClick('ws1', '/w/ws1/c/channel%3Ach1', '?thread=post-a', 'http://localhost/w/ws1/agents/bot-1'),
    'replace',
    'Switching from Channel 1 to an Agent profile must replace stale panel children with skeleton',
  );
  assert.equal(
    resolveClosingPanelClick('ws1', '/w/ws1/c/channel%3Ach1', '?thread=post-a', 'http://localhost/w/ws1/c/channel%3Ach1?thread=post-a'),
    'reopen',
    'Clicking the same open channel URL while closing must reopen immediately',
  );
  assert.deepEqual(
    nextPendingPanelState({ kind: 'close-aside' }, '/w/ws1/agents/bot-1', new URLSearchParams('panel=details')),
    { kind: 'close-aside' },
    'close-aside stays pending while ?panel= is still in URL',
  );
  assert.equal(
    nextPendingPanelState({ kind: 'close-aside' }, '/w/ws1/agents/bot-1', new URLSearchParams('')),
    null,
    'close-aside clears once side pane query param is gone',
  );
  assert.equal(
    resolveChannelCloseHref('/w/ws1/c/channel%3Ach1', '?thread=post-a&replies=20&filter=done&posts=60'),
    '/w/ws1/c/channel%3Ach1?posts=60&filter=done',
    'resolveChannelCloseHref strips thread/panel/section/replies and preserves live posts/filter',
  );
  assert.equal(
    resolveChannelCloseHref('/w/ws1/c/channel%3Ach1', '?panel=channel&section=settings'),
    '/w/ws1/c/channel%3Ach1',
    'resolveChannelCloseHref strips panel and section when closing side pane',
  );

  navCtrl.dispose();

  // Sign-up is open: no invite-code input, waitlist form or invite-only copy anywhere.
  const signInHtml = renderToStaticMarkup(createElement(SignInHero, {}));
  assert.doesNotMatch(signInHtml, /Join the waitlist|name="inviteCode"/, 'Sign-in hero has no invite-code field or waitlist form');
  const landingHtml = renderToStaticMarkup(createElement(LandingView, {}));
  assert.doesNotMatch(landingHtml, /Invite-only|Join the waitlist/, 'Landing has no invite-only or waitlist copy');
  assert.equal(pricingCta('Free', { signedIn: false, proLive: false }).label, 'Get started');
  assert.equal(pricingCta('Pro', { signedIn: false, proLive: false }).label, 'Join the Pro waitlist');
  assert.equal(atPlanCap({ count: 8, max: 8 }), true);
  assert.equal(atPlanCap({ count: 2, max: null }), false);
  assert.equal(planCapMessage('participants', { count: 8, max: 8 }), '8/8 participants');
  assert.equal(planCapMessage('workspaces', { count: 2, max: 2 }), '2/2 workspaces');
  assert.equal(isBillingOwner(['alice', 'bob'], 'alice'), true);
  assert.equal(isBillingOwner(['alice', 'bob'], 'bob'), false);
  const joinBarHtml = renderToStaticMarkup(createElement(JoinBar, { signedIn: false }));
  assert.doesNotMatch(joinBarHtml, /Join the waitlist/, 'Public channel JoinBar has no waitlist CTA');
  assert.match(joinBarHtml, /Get started/, 'Public channel JoinBar shows Get started');

  const pricingPageSrc = readFileSync(path.resolve(import.meta.dirname, '../../app/(site)/pricing/page.tsx'), 'utf8');
  assert.doesNotMatch(pricingPageSrc, /export\s+function\s+pricingCta/, '/pricing page.tsx must not export non-page helper pricingCta');
  const publicChannelPageSrc = readFileSync(path.resolve(import.meta.dirname, '../../app/(site)/p/[id]/page.tsx'), 'utf8');
  assert.doesNotMatch(publicChannelPageSrc, /export\s+function\s+JoinBar/, '/p/[id] page.tsx must not export non-page component JoinBar');

})().catch((err) => {
  console.error(err);
  process.exit(1);
});
