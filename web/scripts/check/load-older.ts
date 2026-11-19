import { bindLoadOlder } from '../../components/ScrollToBottom';
import assert from 'node:assert/strict';

// LoadOlder (bindLoadOlder):
// 1. close-thread → no replace (revealing [data-main] at scrollTop=0, intersecting, or bare scroll events must never call replace;
//    nor when [data-pending="close-aside"] is present on an ancestor).
// 2. downward touch → no premature load (touch-scrolling downward toward newer messages, small tap jitter <= 6px, downward wheel/keys).
// 3. ordinary upward pagination → one replace (explicit upward wheel, upward touch pull, or ArrowUp/PageUp/Home triggers one replace).
function makeLoadOlderHarness(initialPending: string | null = null, onLoad?: () => void | Promise<void>) {
  let pendingAttr = initialPending;
  let clientHeight = 600;
  let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
  let disconnected = false;
  let observes = 0;
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const FakeObserver = class {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
      ioCallback = cb;
    }
    observe() {
      disconnected = false;
      observes++;
    }
    disconnect() {
      disconnected = true;
    }
  } as unknown as typeof IntersectionObserver;
  const el = {
    isConnected: true,
    closest: (sel: string) => (sel === '[data-pending]' && pendingAttr ? ({} as Element) : null),
  } as unknown as HTMLElement;
  const box = {
    get clientHeight() {
      return clientHeight;
    },
    addEventListener(type: string, fn: (e: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners.get(type)?.delete(fn);
    },
  } as unknown as HTMLElement;
  let replaces = 0;
  const cleanup = bindLoadOlder(
    el,
    box,
    onLoad ??
      (() => {
        replaces++;
      }),
    FakeObserver,
  );
  const emit = (type: string, event: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(event as unknown as Event);
  };
  return {
    get replaces() {
      return replaces;
    },
    get disconnected() {
      return disconnected;
    },
    get observes() {
      return observes;
    },
    setPending: (v: string | null) => {
      pendingAttr = v;
    },
    setClientHeight: (h: number) => {
      clientHeight = h;
    },
    intersect: (isIntersecting: boolean) => {
      ioCallback?.([{ isIntersecting }]);
    },
    emit,
    cleanup,
  };
}

// 1. close-thread → no replace:
{
  const h = makeLoadOlderHarness('close-aside');
  h.setClientHeight(0);
  h.intersect(true);
  h.setClientHeight(600);
  h.intersect(true);
  h.emit('scroll', {});
  h.emit('wheel', { deltaY: -120 });
  assert.equal(h.replaces, 0, 'close-thread must not trigger LoadOlder router.replace');
  h.setPending(null);
  h.emit('scroll', {});
  assert.equal(h.replaces, 0, 'Layout scroll after close-thread without a new upward gesture must not replace');
  h.cleanup();
}

// 2. downward touch → no premature load:
{
  const h = makeLoadOlderHarness(null);
  h.intersect(true);
  h.emit('touchstart', { touches: [{ clientY: 200 }] });
  h.emit('touchmove', { touches: [{ clientY: 204 }] });
  assert.equal(h.replaces, 0, 'Small touch tap jitter must not trigger LoadOlder');
  h.emit('touchstart', { touches: [{ clientY: 240 }] });
  h.emit('touchmove', { touches: [{ clientY: 140 }] });
  assert.equal(h.replaces, 0, 'Downward touch scroll must not trigger premature LoadOlder');
  h.emit('wheel', { deltaY: 100 });
  h.emit('keydown', { key: 'ArrowDown' });
  assert.equal(h.replaces, 0, 'Downward wheel/key must not trigger LoadOlder');
  h.intersect(false);
  h.emit('wheel', { deltaY: -100 });
  h.emit('touchstart', { touches: [{ clientY: 240 }] });
  h.emit('touchmove', { touches: [{ clientY: 140 }] });
  h.intersect(true);
  assert.equal(h.replaces, 0, 'Downward touch after upward gesture must disarm LoadOlder before intersection');
  h.cleanup();
}

// 3. ordinary upward pagination → one replace:
{
  const hWheel = makeLoadOlderHarness(null);
  hWheel.intersect(false);
  hWheel.emit('wheel', { deltaY: -120 });
  assert.equal(hWheel.replaces, 0, 'Upward wheel before top is in view waits for intersection');
  hWheel.intersect(true);
  assert.equal(hWheel.replaces, 1, 'Ordinary upward wheel pagination triggers one replace on intersection');
  hWheel.emit('wheel', { deltaY: -120 });
  hWheel.intersect(true);
  assert.equal(hWheel.replaces, 1, 'LoadOlder only replaces once per mount');
  assert.equal(hWheel.disconnected, true, 'Observer disconnects after loading');
  hWheel.cleanup();

  const hTouch = makeLoadOlderHarness(null);
  hTouch.intersect(true);
  hTouch.emit('touchstart', { touches: [{ clientY: 120 }] });
  hTouch.emit('touchmove', { touches: [{ clientY: 200 }] });
  assert.equal(hTouch.replaces, 1, 'Upward pagination touch pull at top triggers one replace');
  hTouch.cleanup();

  const hKey = makeLoadOlderHarness(null);
  hKey.intersect(true);
  hKey.emit('keydown', { key: 'PageUp' });
  assert.equal(hKey.replaces, 1, 'PageUp at top triggers one replace');
  hKey.cleanup();
}

// 4. failed onLoad re-arms the observer so a later upward gesture can retry:
void (async () => {
  let attempts = 0;
  const h = makeLoadOlderHarness(null, () => {
    attempts++;
    if (attempts === 1) throw new Error('network');
  });
  h.intersect(true);
  h.emit('wheel', { deltaY: -120 });
  await Promise.resolve();
  assert.equal(attempts, 1, 'First upward load runs once');
  assert.equal(h.disconnected, false, 'Failed load re-observes the sentinel');
  h.emit('wheel', { deltaY: -120 });
  await Promise.resolve();
  assert.equal(attempts, 2, 'After a failed load, another upward gesture retries');
  h.cleanup();
})();
