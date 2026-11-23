// ponytail: one runnable check for sign-out during a pending ticket (PR #839 review). Run: node --import tsx lib/live.check.ts
import assert from 'node:assert';

const opened: string[] = [];
class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  constructor(url: string) {
    opened.push(url);
  }
  addEventListener() {}
  close() {}
}
const pending: ((r: unknown) => void)[] = [];
Object.assign(globalThis, { EventSource: FakeEventSource, fetch: () => new Promise((r) => pending.push(r)) });
const reply = (url: string) => ({ ok: true, json: async () => ({ url, expiresAt: Date.now() + 600_000 }) });
const settle = () => new Promise((r) => setTimeout(r, 10));

const run = async () => {
  const { subscribeLive, forgetLive } = await import('./live');

  // A's ticket is still being fetched when A signs out and B signs in.
  subscribeLive(() => {});
  forgetLive();
  subscribeLive(() => {});
  assert.equal(pending.length, 2, 'B asks for its own ticket while A’s is pending');

  // A's late answer opens nothing, and must not leave B without a stream.
  pending[0](reply('https://hub/a?t=1'));
  await settle();
  assert.deepEqual(opened, [], 'A’s stale ticket opens no stream');
  subscribeLive(() => {});
  assert.equal(pending.length, 2, 'A’s stale answer does not clear B’s pending state');

  pending[1](reply('https://hub/b?t=1'));
  await settle();
  assert.deepEqual(opened, ['https://hub/b?t=1'], 'B gets its stream');
  console.log('live.check ok');
};
void run();
