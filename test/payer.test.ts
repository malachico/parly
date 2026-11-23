import { describe, expect, it } from 'vitest';
import { payerOf } from '../src/billing/payer.js';

const none = async () => undefined;
const linked = async (id: string) => (id === 'o' ? 'ws' : undefined);

describe('payerOf', () => {
  it('bills the owner, a room agent its payerId, a person themself', async () => {
    expect(await payerOf({ id: 'a', payerId: 'p', ownerId: 'o' }, none)).toBe('o');
    expect(await payerOf({ id: 'a', ownerId: 'o' }, none)).toBe('o');
    expect(await payerOf({ id: 'a', payerId: 'p' }, none)).toBe('p');
    expect(await payerOf({ id: 'a' }, none)).toBe('a');
  });

  it("bills the company pool when the person is linked to one, a room agent's opener's included", async () => {
    expect(await payerOf({ id: 'a', ownerId: 'o' }, linked)).toBe('ws');
    expect(await payerOf({ id: 'o' }, linked)).toBe('ws');
    expect(await payerOf({ id: 'a', payerId: 'o' }, linked)).toBe('ws');
    expect(await payerOf({ id: 'x', ownerId: 'z' }, linked)).toBe('z');
  });
});
