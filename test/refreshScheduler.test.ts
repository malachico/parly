import { afterEach, describe, expect, it, vi } from 'vitest';

// Review #47: one live message used to re-render the page twice (LiveRefresh's settle timer, then MarkRead's own
// router.refresh once the read landed). Both now go through one scheduler that holds while a read is in flight.
describe('refreshScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('a live message and the mark-read it causes share one router.refresh, after the read lands', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { scheduleRefresh, holdRefresh, SETTLE_MS } = await import('../web/lib/refreshScheduler.js');
    const refresh = vi.fn();
    const after = vi.fn();

    // Fast read: lands inside the settle window.
    scheduleRefresh(refresh, after); // LiveRefresh: the message event
    const release = holdRefresh(); // MarkRead: read in flight
    scheduleRefresh(refresh, after); // more events in the burst
    vi.advanceTimersByTime(100);
    scheduleRefresh(refresh); // MarkRead: read landed
    release();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(2); // each LiveRefresh `then` runs (it no-ops past the first)

    // Slow read: the settle timer fires while held, so the one refresh waits for the read instead of racing it.
    scheduleRefresh(refresh, after);
    const slow = holdRefresh();
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduleRefresh(refresh);
    slow();
    slow(); // a second release is a no-op
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(2);

    // A failed read still releases: the live refresh isn't lost.
    scheduleRefresh(refresh);
    holdRefresh()();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
  it('a hung read releases after five seconds and cannot freeze later events', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { scheduleRefresh, holdRefresh, SETTLE_MS } = await import('../web/lib/refreshScheduler.js');
    const refresh = vi.fn();
    const release = holdRefresh();
    scheduleRefresh(refresh);
    vi.advanceTimersByTime(4999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    release(); // late completion must not decrement holds twice
    const next = holdRefresh();
    scheduleRefresh(refresh);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    next();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('unmount cancels only that caller, including its after-refresh event', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { scheduleRefresh, cancelRefresh, SETTLE_MS } = await import('../web/lib/refreshScheduler.js');
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const after = vi.fn();
    scheduleRefresh(mounted);
    scheduleRefresh(unmounted, after);
    cancelRefresh(unmounted);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    scheduleRefresh(unmounted, after);
    cancelRefresh(unmounted);
    expect(vi.getTimerCount()).toBe(0);
  });

});
