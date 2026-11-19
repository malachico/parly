import { describe, expect, it } from 'vitest';
import { ROOM_TEMPLATES } from '../web/lib/roomTemplates.js';

describe('room templates', () => {
  it('fit the form they fill in', () => {
    expect(new Set(ROOM_TEMPLATES.map((t) => t.id)).size).toBe(ROOM_TEMPLATES.length);
    for (const t of ROOM_TEMPLATES) {
      expect(t.goal.length).toBeLessThanOrEqual(200);
      for (const field of [t.want, t.redLines, t.share]) expect(field.length).toBeLessThanOrEqual(1000);
    }
  });
});
