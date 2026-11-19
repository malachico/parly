
/** A team frame on the canvas: where it is, and how big it shows (its height can grow with its members). */
export type Frame = { id: string; x: number; y: number; w: number; h: number };

export const TINTS = ['#d6e4f0', '#f4d9dc', '#dfe8cf', '#e7dcf2', '#f3dfc8', '#d3ebe4', '#f1e6bf', '#e4e1da'];

export function hexRgb(h: string): string {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)].join(' ');
}

// A creature's slot: its status bubble, face, name and badge.
const SLOT_W = 124;
const SLOT_H = 178;
const slotCols = (box: Omit<Frame, 'id'>) => Math.max(2, Math.floor((box.w - 60) / SLOT_W));

/** A team's frame grows to hold everyone in it (its stored height is the least it takes). */
export function frameHeight(box: Omit<Frame, 'id'>, members: number): number {
  return Math.max(box.h, 118 + Math.ceil(members / slotCols(box)) * SLOT_H + 44);
}

export function slotPosition(box: Omit<Frame, 'id'>, index: number): { x: number; y: number } {
  const cols = slotCols(box);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: box.x + 30 + col * SLOT_W,
    y: box.y + 118 + row * SLOT_H,
  };
}

const GAP = 60;
const ORIGIN = 40;

/**
 * "Tidy up": the frames in rows, in their current reading order (top to bottom, then left to right), none overlapping,
 * each keeping its size. Rows wrap at about √n frames, so the board stays roughly square.
 */
export function tidyLayout(frames: Frame[], obstacles: Frame[] = []): Map<string, { x: number; y: number }> {
  const order = [...frames].sort((a, b) => a.y - b.y || a.x - b.x);
  const perRow = Math.max(1, Math.ceil(Math.sqrt(order.length)));
  const out = new Map<string, { x: number; y: number }>();
  let y = ORIGIN;
  for (let i = 0; i < order.length; i += perRow) {
    const row = order.slice(i, i + perRow);
    const width = row.reduce((sum, f) => sum + f.w + GAP, -GAP);
    const height = Math.max(...row.map((f) => f.h));
    // Notes keep their chosen positions; rows move below any note they would cover.
    let hit: Frame | undefined;
    while ((hit = obstacles.find((o) => ORIGIN < o.x + o.w + GAP && ORIGIN + width + GAP > o.x && y < o.y + o.h + GAP && y + height + GAP > o.y))) {
      y = hit.y + hit.h + GAP;
    }
    let x = ORIGIN;
    for (const f of row) {
      out.set(f.id, { x, y });
      x += f.w + GAP;
    }
    y += Math.max(...row.map((f) => f.h)) + GAP;
  }
  return out;
}

/** Overview card avatars are 106px (96 + border). Overlap them more on narrow frames so every chip, +N included, stays in view. */
export const CARD_AVATAR = 106;
export function cardAvatarOverlap(frameWidth: number, chips: number): number {
  const room = frameWidth - 98; // p-11 both sides + pl-2.5
  if (chips < 2) return 16;
  return Math.min(CARD_AVATAR - 10, Math.max(16, Math.ceil((chips * CARD_AVATAR - room) / (chips - 1))));
}
