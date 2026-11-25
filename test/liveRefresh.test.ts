import { afterEach, expect, it, vi } from 'vitest';

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

it('useAutoRecover stops auto-retrying a child that keeps throwing; Try again still works and starts a fresh budget', async () => {
  visiblePage();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.resetModules();
  const { AUTO_RECOVER_MAX_RETRIES, useAutoRecover } = await import('../web/lib/autoRecover.js');
  const error = new TypeError('network error');
  // Each retry resets the boundary, the child throws again and the fallback mounts afresh.
  let last: ReturnType<typeof useAutoRecover> | undefined;
  const retry = vi.fn(() => {
    hooks.cleanup?.();
    last = useAutoRecover({ error, retry, scope: 'panel' });
  });
  last = useAutoRecover({ error, retry, scope: 'panel' });
  expect(last.gaveUp).toBe(false);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(retry).toHaveBeenCalledTimes(AUTO_RECOVER_MAX_RETRIES);
  expect(vi.getTimerCount()).toBe(0);
  expect(last.gaveUp).toBe(true);
  // Another boundary failing now still gets its own auto-retries.
  const canvasRetry = vi.fn();
  useAutoRecover({ error, retry: canvasRetry, scope: 'canvas' });
  await vi.advanceTimersByTimeAsync(800);
  expect(canvasRetry).toHaveBeenCalledTimes(1);
  hooks.cleanup?.();
  // Try again works, and if the next blip comes within the quiet window it auto-retries again.
  last.recover!();
  expect(retry).toHaveBeenCalledTimes(AUTO_RECOVER_MAX_RETRIES + 1);
  expect(last.gaveUp).toBe(false);
  await vi.advanceTimersByTimeAsync(800);
  expect(retry).toHaveBeenCalledTimes(AUTO_RECOVER_MAX_RETRIES + 2);
  // After a quiet spell (say the laptop slept) the next failure gets a fresh budget.
  await vi.advanceTimersByTimeAsync(120_000);
  const before = retry.mock.calls.length;
  hooks.cleanup?.();
  useAutoRecover({ error, retry, scope: 'panel' });
  await vi.advanceTimersByTimeAsync(800);
  expect(retry.mock.calls.length).toBeGreaterThan(before);
});

it('the workspace layout gives the canvas its own error boundary, so a canvas failure leaves the open panel up', async () => {
  const stub = (name: string) => ({ [name]: () => null });
  vi.doMock('../web/node_modules/next/headers.js', () => ({ cookies: async () => ({ get: () => undefined }) }));
  vi.doMock('@/lib/routes', () => ({ WORKSPACE_COOKIE: 'ws' }));
  vi.doMock('@/lib/hub', () => ({ meOrLogin: async () => ({ id: 'me', workspaces: [{ id: 'acme', name: 'Acme' }] }) }));
  for (const name of ['CanvasBoundary', 'CanvasHome', 'FindDialog', 'HireAgentDialog', 'NewChannelDialog', 'NewWorkspaceDialog', 'PanelSlot', 'RememberWorkspace', 'RoomBar']) {
    vi.doMock(`@/components/${name}`, () => stub(name));
  }
  const { default: WorkspaceLayout } = await import('../web/app/(window)/w/[ws]/layout.js');
  const { CanvasBoundary } = await import('@/components/CanvasBoundary');
  const { CanvasHome } = await import('@/components/CanvasHome');
  const { PanelSlot } = await import('@/components/PanelSlot');
  type El = { type?: unknown; props?: { children?: unknown } };
  const find = (node: unknown, type: unknown): El | undefined => {
    if (Array.isArray(node)) return node.map((n) => find(n, type)).find(Boolean);
    if (!node || typeof node !== 'object') return undefined;
    return (node as El).type === type ? (node as El) : find((node as El).props?.children, type);
  };
  const tree = await WorkspaceLayout({ children: null, params: Promise.resolve({ ws: 'acme' }) });
  const boundary = find(tree, CanvasBoundary);
  expect(find(boundary, CanvasHome)).toBeDefined();
  expect(find(tree, PanelSlot)).toBeDefined();
  expect(find(boundary, PanelSlot)).toBeUndefined();
});
