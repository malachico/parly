import { expect, it, vi } from 'vitest';

// Enough of React to call the component twice: state kept per slot, an effect re-run only when its deps change.
const h = vi.hoisted(() => ({ slots: [] as unknown[], deps: [] as unknown[][], i: 0, search: '', hubGet: vi.fn() }));
vi.mock('../web/node_modules/react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = h.i++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === 'function' ? v(h.slots[i]) : v; }];
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const i = h.i++;
    if (!h.deps[i] || deps.some((d, n) => d !== h.deps[i]![n])) effect();
    h.deps[i] = deps;
  },
}));
vi.mock('../web/node_modules/next/navigation.js', () => ({ useRouter: () => ({}), useSearchParams: () => new URLSearchParams(h.search) }));
vi.mock('@/lib/actions', () => ({}));
vi.mock('@/lib/hubDirect', () => ({ hubGet: h.hubGet }));

it('ChannelLoader: a browser-read bundle is never shown for another query; the new query is read again', async () => {
  const { ChannelLoader } = await import('../web/components/ChannelLoader.js');
  const { DmConversation } = await import('../web/components/DmConversation.js');
  const render = (search: string) => {
    h.i = 0;
    h.search = search;
    vi.stubGlobal('window', { location: { search } });
    return ChannelLoader({ ws: 'acme', kind: 'agent', id: 'a1' }) as { type: unknown };
  };
  // The server's read failed (no `initial`); the browser's succeeds with 30 posts.
  h.hubGet.mockResolvedValueOnce({ thirty: true });
  render('');
  await new Promise((r) => setTimeout(r));
  expect(h.hubGet).toHaveBeenLastCalledWith('/agents/a1/open?limit=30&workspace=acme', expect.anything());
  expect(render('').type).toBe(DmConversation);
  // Load older: the server fails again, so the browser reads the 60 and the 30 aren't shown as them.
  h.hubGet.mockResolvedValueOnce(null);
  expect(render('?posts=60').type).not.toBe(DmConversation);
  expect(h.hubGet).toHaveBeenCalledTimes(2);
  expect(h.hubGet).toHaveBeenLastCalledWith('/agents/a1/open?limit=60&workspace=acme', expect.anything());
  await new Promise((r) => setTimeout(r));
  expect(JSON.stringify(render('?posts=60'))).toContain('Try again');
  vi.unstubAllGlobals();
});
