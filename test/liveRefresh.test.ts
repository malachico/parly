import { afterEach, describe, expect, it, vi } from 'vitest';

describe('KeepAliveBoundary', () => {
  it('KeepAliveBoundary catches mid-stream TypeError: network error while re-throwing Next.js router errors', async () => {
    const { isNextRouterError, KeepAliveBoundaryInner } = await import('../web/components/KeepAliveBoundary.js');

    expect(isNextRouterError(new TypeError('network error'))).toBe(false);
    expect(isNextRouterError({ digest: 'NEXT_REDIRECT;replace;/login;307;' })).toBe(true);
    expect(isNextRouterError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })).toBe(true);

    // Mid-stream network error is caught instead of bubbling to DefaultGlobalError.
    const netErr = new TypeError('network error');
    expect(KeepAliveBoundaryInner.getDerivedStateFromError(netErr)).toEqual({ error: netErr });

    // Next.js redirect / notFound errors are re-thrown so routing works normally.
    const redirErr = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    expect(() => KeepAliveBoundaryInner.getDerivedStateFromError(redirErr)).toThrow(redirErr);
  });

  it('KeepAliveBoundary auto-retry backoff grows then caps, and stops after a fixed count', async () => {
    const { KEEP_ALIVE_MAX_AUTO_RETRIES, keepAliveRetryDelayMs } = await import('../web/components/KeepAliveBoundary.js');
    expect(keepAliveRetryDelayMs(0)).toBe(1_500);
    expect(keepAliveRetryDelayMs(1)).toBe(3_000);
    expect(keepAliveRetryDelayMs(2)).toBe(6_000);
    expect(keepAliveRetryDelayMs(10)).toBe(30_000);
    expect(KEEP_ALIVE_MAX_AUTO_RETRIES).toBe(5);
  });

  it('KeepAliveBoundary keeps a live recovery control after the auto-retry cap (never freezes a dead DOM)', async () => {
    const { KEEP_ALIVE_MAX_AUTO_RETRIES, KeepAliveBoundaryInner } = await import('../web/components/KeepAliveBoundary.js');
    const boundary = new KeepAliveBoundaryInner({ routeKey: '/r', onRetry: () => {}, children: null });
    // At the retry cap: no more AutoRetry, but recovery must still be reachable (the P0: old code stuck here).
    boundary.state = { error: new TypeError('network error'), routeKey: '/r', autoAttempts: KEEP_ALIVE_MAX_AUTO_RETRIES };

    const nodes: unknown[] = [];
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props) {
        // The fix must never re-inject a stale DOM snapshot.
        expect('dangerouslySetInnerHTML' in props).toBe(false);
        visit(props.children);
      }
    };
    visit(boundary.render());

    const hasTryAgain = nodes.some(
      (n) => (n as { type?: unknown }).type === 'button' && (n as { props?: { onClick?: unknown } }).props?.onClick,
    );
    expect(hasTryAgain).toBe(true);
  });
});


const hooks = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  refresh: vi.fn(),
  event: undefined as ((event: { type: string }) => void) | undefined,
  unsubscribe: vi.fn(),
  busy: false,
}));
vi.mock('../web/node_modules/react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => (() => void) | undefined) => { hooks.cleanup = effect(); },
  useRef: (current: unknown) => ({ current }),
  useTransition: () => [hooks.busy, (fn: () => void) => fn()],
}));
vi.mock('../web/node_modules/next/navigation.js', () => ({ useRouter: () => ({ refresh: hooks.refresh }) }));
vi.mock('@/lib/actions', () => ({ markConversationRead: vi.fn() }));
vi.mock('@/lib/live', () => ({
  subscribeLive: (event: typeof hooks.event) => { hooks.event = event; return hooks.unsubscribe; },
}));

afterEach(() => {
  hooks.cleanup?.();
  hooks.cleanup = undefined;
  hooks.busy = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function visiblePage() {
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
}

it('LiveRefresh: live events never re-render the page; a tab shown again does, once', async () => {
  visiblePage();
  const { LiveRefresh } = await import('../web/components/LiveRefresh.js');
  LiveRefresh({});
  expect(hooks.event).toBeUndefined();
  vi.advanceTimersByTime(60_000);
  expect(hooks.refresh).not.toHaveBeenCalled();
  const onVisible = vi.mocked(document.addEventListener).mock.calls.find(([type]) => type === 'visibilitychange')![1] as () => void;
  (document as { visibilityState: string }).visibilityState = 'hidden';
  onVisible();
  expect(hooks.refresh).not.toHaveBeenCalled();
  (document as { visibilityState: string }).visibilityState = 'visible';
  onVisible();
  expect(hooks.refresh).toHaveBeenCalledTimes(1);
  hooks.cleanup?.();
  expect(vi.getTimerCount()).toBe(0);
});

it('MarkRead marks the conversation read without re-rendering the page, even when the read fails', async () => {
  visiblePage();
  const { MarkRead } = await import('../web/components/MarkRead.js');
  const action = vi.fn(() => Promise.reject(new Error('offline')));
  MarkRead({ conversationKey: 'thread', unread: 1, action });
  await vi.runAllTimersAsync();
  expect(action).toHaveBeenCalledTimes(1);
  expect(hooks.refresh).not.toHaveBeenCalled();
});

it('a burst of live messages and reads re-reads the canvas counts once; activity never does', async () => {
  vi.useFakeTimers();
  const fetched = vi.fn(async () => ({ ok: true, json: async () => [{ key: 'channel:c1', kind: 'channel', channel: { name: 'general' }, last: { fromId: 'a', from: 'Ada', text: 'hi' }, updatedAt: '2026-01-01T00:00:00.000Z', unread: 3, mentions: 1 }] }));
  vi.stubGlobal('fetch', fetched);
  const { liveConversations } = await import('../web/lib/attention.js');
  const set = vi.fn();
  const stop = liveConversations('acme', 'me', set);
  hooks.event!({ type: 'activity' });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetched).not.toHaveBeenCalled();
  for (const type of ['message', 'read', 'message', 'message', 'read']) hooks.event!({ type });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(fetched).toHaveBeenCalledWith('/api/conversations?workspace=acme', { cache: 'no-store' });
  expect(set).toHaveBeenCalledWith([expect.objectContaining({ key: 'channel:c1', title: '#general', unread: 3, mentions: 1 })]);
  hooks.event!({ type: 'message' });
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('steady live traffic with a slow hub still updates the counts, one read at a time', async () => {
  vi.useFakeTimers();
  const row = (unread: number) => [{ key: 'channel:c1', kind: 'channel', channel: { name: 'general' }, last: { fromId: 'a', from: 'Ada', text: 'hi' }, updatedAt: '2026-01-01T00:00:00.000Z', unread, mentions: 1 }];
  let inFlight = 0;
  let most = 0;
  const fetched = vi.fn(async () => {
    const unread = fetched.mock.calls.length;
    most = Math.max(most, ++inFlight);
    await new Promise((done) => setTimeout(done, 800));
    inFlight--;
    return { ok: true, json: async () => row(unread) };
  });
  vi.stubGlobal('fetch', fetched);
  const { liveConversations } = await import('../web/lib/attention.js');
  const set = vi.fn();
  const stop = liveConversations('acme', 'me', set);
  for (let i = 0; i < 20; i++) {
    hooks.event!({ type: i % 2 ? 'read' : 'message' });
    await vi.advanceTimersByTimeAsync(400);
  }
  // 8s of events: the first read starts at 400ms, then they run back to back, 800ms each.
  expect(most).toBe(1);
  expect(fetched).toHaveBeenCalledTimes(10);
  expect(set).toHaveBeenCalledTimes(9);
  expect(set).toHaveBeenLastCalledWith([expect.objectContaining({ unread: 9 })]);
  // The traffic ends during the tenth read: it is applied, then exactly one more read follows for the events it missed.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetched).toHaveBeenCalledTimes(11);
  expect(set).toHaveBeenLastCalledWith([expect.objectContaining({ unread: 11 })]);
  // Unsubscribed mid-read: that answer is dropped and nothing follows it.
  hooks.event!({ type: 'message' });
  await vi.advanceTimersByTimeAsync(400);
  hooks.event!({ type: 'message' });
  stop();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetched).toHaveBeenCalledTimes(12);
  expect(set).toHaveBeenCalledTimes(11);
  expect(vi.getTimerCount()).toBe(0);
});
