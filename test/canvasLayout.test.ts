import { describe, expect, it } from 'vitest';
import { CARD_AVATAR, cardAvatarOverlap, tidyLayout, type Frame } from '../web/lib/canvasLayout.js';

const overlaps = (a: Frame, b: Frame) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('tidyLayout', () => {
  it('leaves no two frames overlapping, keeps sizes, and keeps reading order', () => {
    const frames: Frame[] = [
      { id: 'a', x: 100, y: 100, w: 580, h: 420 },
      { id: 'b', x: 150, y: 120, w: 700, h: 600 }, // on top of a
      { id: 'c', x: -300, y: 900, w: 400, h: 300 },
      { id: 'd', x: 2000, y: 50, w: 580, h: 420 },
      { id: 'e', x: 120, y: 110, w: 580, h: 900 }, // tall, also on a
    ];
    const pos = tidyLayout(frames);
    const placed = frames.map((f) => ({ ...f, ...pos.get(f.id)! }));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i]!, placed[j]!)).toBe(false);
    // Reading order: top to bottom, then left to right (d is highest, then a, e, b, c).
    expect([...pos.keys()]).toEqual(['d', 'a', 'e', 'b', 'c']);
    expect(pos.get('d')).toEqual({ x: 40, y: 40 });
  });
});

describe('cardAvatarOverlap', () => {
  it('fits 8 avatars plus the +N chip inside default and new frame widths', () => {
    for (const w of [360, 520, 580, 960]) {
      const o = cardAvatarOverlap(w, 9);
      expect(CARD_AVATAR + 8 * (CARD_AVATAR - o)).toBeLessThanOrEqual(w - 98);
    }
  });
  it('keeps the normal overlap when there is room', () => {
    expect(cardAvatarOverlap(2000, 9)).toBe(16);
  });
});
