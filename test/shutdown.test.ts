import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeShutdown } from '../src/shutdown.js';

describe('makeShutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits non-zero after the crash deadline even if the server never closes, and runs once across triggers', () => {
    const pushShutdown = vi.fn().mockResolvedValue(undefined);
    const idle = vi.fn().mockResolvedValue(undefined);
    // A server that never calls its close callback — the stuck-connection case the deadline guards against.
    const server = { close: vi.fn() };
    const exit = vi.fn();

    const shutdown = makeShutdown(server, { push: { shutdown: pushShutdown }, wakeService: { idle } }, exit, 8000);

    shutdown(1);
    shutdown(1); // a second exception (or a SIGTERM mid-crash) must not restart the drain

    expect(pushShutdown).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('on a clean SIGTERM (code 0) drains after close and exits only once the drain resolves, once across triggers', async () => {
    // A drain we resolve by hand, so we can prove exit waits for it rather than for server.close alone.
    let resolveDrain: (() => void) | undefined;
    const idle = vi.fn(() => new Promise<void>((r) => void (resolveDrain = r)));
    let closeCb: (() => void) | undefined;
    const server = { close: vi.fn((cb: () => void) => void (closeCb = cb)) };
    const exit = vi.fn();

    const shutdown = makeShutdown(server, { push: { shutdown: vi.fn().mockResolvedValue(undefined) }, wakeService: { idle } }, exit, 8000);
    shutdown(0);
    shutdown(1); // a racing uncaughtException mid-SIGTERM must not re-drain or re-arm

    vi.advanceTimersByTime(60_000); // no deadline timer on the clean path
    expect(exit).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled(); // drain waits for the server to close first

    closeCb!();
    expect(idle).toHaveBeenCalledTimes(1); // drain runs on close — exactly once across both triggers
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled(); // and exit waits for the drain, not just the close

    resolveDrain!();
    await vi.advanceTimersByTimeAsync(0); // flush idle().finally()
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
