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
vi.mock('@/lib/refreshScheduler', async () => import('../web/lib/refreshScheduler.js'));

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

it('leaving LiveRefresh cancels its queued render and message event', async () => {
  visiblePage();
  const { LiveRefresh } = await import('../web/components/LiveRefresh.js');
  LiveRefresh({ fallbackMs: 1000 });
  hooks.event?.({ type: 'message' });
  hooks.cleanup?.();
  vi.advanceTimersByTime(6000);
  expect(hooks.unsubscribe).toHaveBeenCalled();
  expect(hooks.refresh).not.toHaveBeenCalled();
  expect(window.dispatchEvent).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('leaving MarkRead releases a hung read and ignores its late completion', async () => {
  visiblePage();
  const { MarkRead } = await import('../web/components/MarkRead.js');
  const { scheduleRefresh, SETTLE_MS } = await import('../web/lib/refreshScheduler.js');
  let finish!: () => void;
  const action = () => new Promise<void>((resolve) => { finish = resolve; });
  MarkRead({ conversationKey: 'old', unread: 1, action });
  const nextPage = vi.fn();
  scheduleRefresh(nextPage);
  vi.advanceTimersByTime(SETTLE_MS);
  expect(nextPage).not.toHaveBeenCalled();
  hooks.cleanup?.();
  vi.advanceTimersByTime(1);
  expect(nextPage).toHaveBeenCalledTimes(1);
  finish();
  await vi.runAllTimersAsync();
  expect(hooks.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});


it('navigation cancels both components even when MarkRead cleans up first', async () => {
  visiblePage();
  const { MarkRead } = await import('../web/components/MarkRead.js');
  const { LiveRefresh } = await import('../web/components/LiveRefresh.js');
  MarkRead({ conversationKey: 'old', unread: 1, action: () => new Promise(() => {}) });
  const leaveRead = hooks.cleanup;
  LiveRefresh({});
  hooks.event?.({ type: 'message' });
  vi.advanceTimersByTime(300);
  leaveRead?.();
  hooks.cleanup?.();
  vi.runAllTimers();
  expect(hooks.refresh).not.toHaveBeenCalled();
  expect(window.dispatchEvent).not.toHaveBeenCalled();
});

it('LiveRefresh: a burst re-renders once after its first second, never while hidden, and fetches no thread of its own', async () => {
  visiblePage();
  const { LiveRefresh } = await import('../web/components/LiveRefresh.js');
  LiveRefresh({});
  hooks.event?.({ type: 'message' });
  vi.advanceTimersByTime(600);
  hooks.event?.({ type: 'message' });
  hooks.event?.({ type: 'activity', conversation: 'c', activity: [{ agentId: 'a' }] } as never);
  vi.advanceTimersByTime(399);
  expect(hooks.refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(hooks.refresh).toHaveBeenCalledTimes(1);
  expect(window.dispatchEvent).not.toHaveBeenCalled();

  // Hidden when the window closes: nothing now, one catch-up when shown.
  hooks.event?.({ type: 'message' });
  (document as { visibilityState: string }).visibilityState = 'hidden';
  vi.advanceTimersByTime(1000);
  expect(hooks.refresh).toHaveBeenCalledTimes(1);
  (document as { visibilityState: string }).visibilityState = 'visible';
  const onVisible = vi.mocked(document.addEventListener).mock.calls.find(([type]) => type === 'visibilitychange')![1] as () => void;
  onVisible();
  vi.advanceTimersByTime(1000);
  expect(hooks.refresh).toHaveBeenCalledTimes(2);
});

it('LiveRefresh: a burst that settles while a re-render is loading waits instead of starting a second', async () => {
  visiblePage();
  hooks.busy = true;
  const { LiveRefresh } = await import('../web/components/LiveRefresh.js');
  LiveRefresh({});
  hooks.event?.({ type: 'message' });
  vi.advanceTimersByTime(1000);
  expect(hooks.refresh).not.toHaveBeenCalled();
});

it('a failed read still re-renders the page, so an optimistic clear does not leave the badges wrong', async () => {
  visiblePage();
  const { MarkRead } = await import('../web/components/MarkRead.js');
  MarkRead({ conversationKey: 'thread', unread: 1, action: () => Promise.reject(new Error('offline')) });
  await vi.runAllTimersAsync();
  expect(hooks.refresh).toHaveBeenCalledTimes(1);
});
