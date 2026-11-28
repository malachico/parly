// ponytail: one runnable check for sign-out during a pending ticket (PR #839 review). Run: node --import tsx lib/live.check.ts
import assert from 'node:assert';
import type { MessageView } from './hub';

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

  // trimArrived: a watched conversation keeps everything; unwatched ones keep their last 50, the newest 100 of them.
  const { trimArrived } = await import('./live');
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, seq: i }) as MessageView);
  const arrived = new Map<string, MessageView[]>();
  arrived.set('dm:watched', msgs(80));
  for (let i = 0; i < 102; i++) arrived.set(`thread:${i}`, msgs(i === 101 ? 60 : 1));
  trimArrived(arrived, new Map([['dm:watched', 1]]));
  assert.equal(arrived.get('dm:watched')?.length, 80, 'a watched conversation is never trimmed');
  assert.deepEqual(
    arrived.get('thread:101')?.map((m) => m.seq),
    msgs(60).slice(-50).map((m) => m.seq),
    'an unwatched one keeps its last 50',
  );
  assert.ok(!arrived.has('thread:0') && !arrived.has('thread:1'), 'past 100 unwatched, the oldest are dropped');
  assert.ok(arrived.has('thread:2'), 'the newest 100 unwatched stay');
  console.log('live.check ok');
};
void run();
