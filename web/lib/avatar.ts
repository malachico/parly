/**
 * Generated avatars, drawn like the OX logo: one ink line, a little wobbly, the outline overshooting
 * where the pen started. Everything comes from the agent's avatar seed, so a face is the same on
 * every page and render (server or client). Bots are little creatures like the login page's crew
 * (a body, ears or an antenna, white eyes with pupils); people get a friendly face, in one of six skin
 * tones, with a haircut. Pure and dependency-free: `<Avatar>` turns the shapes into SVG.
 */

type AvatarKind = 'human' | 'bot';

/**
 * One path in a 40×40 box: stroked in ink, or filled. `tint` and `white` are filled and outlined in
 * ink; `ink`, `shine` (a white highlight) and `blush` (cheeks) are fills alone.
 */
export interface AvatarShape {
  d: string;
  fill?: 'tint' | 'ink' | 'white' | 'shine' | 'blush';
  /** A fill of its own (hair, skin), outlined in ink. */
  color?: string;
  /** Stroke width, when not the avatar's own. */
  width?: number;
}

interface AvatarArt {
  /** Index into the --av-0 … --av-7 background tints. */
  tint: number;
  /** The head outline, stroked: open, overshooting its start. */
  outline: string;
  /** The same outline closed, filled with the tint under the line. */
  fill: string;
  /** The head's fill when it isn't the tint: a person's skin. */
  skin?: string;
  /** Drawn before the head, which overlaps them: ears, horns. */
  behind: AvatarShape[];
  shapes: AvatarShape[];
}

const TINTS = 8;

type Pt = [number, number];
type Rand = () => number;

/** FNV-1a into mulberry32: a small, stable PRNG per seed. */
function random(seed: string): Rand {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const n = (v: number) => String(Math.round(v * 100) / 100);
const jit = (r: Rand, amount: number) => (r() - 0.5) * 2 * amount;

/** A smooth path through `pts` (Catmull-Rom as cubic Béziers), closed or open. */
function smooth(pts: Pt[], closed: boolean): string {
  const at = (i: number): Pt => (closed ? pts[(i + pts.length) % pts.length]! : pts[Math.max(0, Math.min(pts.length - 1, i))]!);
  let d = `M${n(pts[0]![0])} ${n(pts[0]![1])}`;
  const segments = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(p2[0])} ${n(p2[1])}`;
  }
  return closed ? `${d}Z` : d;
}

/** A hand-drawn line: the middle drifts a little off straight. */
function line(r: Rand, x1: number, y1: number, x2: number, y2: number, wobble = 0.5): string {
  return `M${n(x1)} ${n(y1)}Q${n((x1 + x2) / 2 + jit(r, wobble))} ${n((y1 + y2) / 2 + jit(r, wobble))} ${n(x2)} ${n(y2)}`;
}

/**
 * Points round a superellipse (exponent 2 = ellipse, 4 = rounded square), radius jittered.
 * `overshoot` (radians) carries the pen past the start, like the logo's circle.
 */
function loop(r: Rand, cx: number, cy: number, rx: number, ry: number, opts: { power?: number; wobble?: number; count?: number; overshoot?: number; flare?: number } = {}): Pt[] {
  const { power = 2, wobble = 0.04, count = 10, overshoot = 0, flare = 0 } = opts;
  const start = r() * Math.PI * 2;
  const step = (Math.PI * 2) / count;
  const radius = Array.from({ length: count }, () => 1 + jit(r, wobble));
  const angles = radius.map((_, i) => i * step);
  // Past the start the pen runs a touch inside its first pass, as a hand would.
  if (overshoot) for (let a = 0; a < overshoot + step / 2; a += step) angles.push(Math.PI * 2 + Math.min(a, overshoot));
  const pts: Pt[] = [];
  angles.forEach((angle, i) => {
    const a = start + angle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const k = radius[i % count]! * (i >= count ? 0.965 : 1);
    // Flare widens the bottom (or, below zero, the top): a pear or an egg.
    pts.push([cx + rx * k * (1 + flare * s) * Math.sign(c) * Math.abs(c) ** (2 / power), cy + ry * k * Math.sign(s) * Math.abs(s) ** (2 / power)]);
  });
  return pts;
}

const ring = (r: Rand, cx: number, cy: number, rad: number) => smooth(loop(r, cx, cy, rad, rad, { count: 6, wobble: 0.08 }), true);
const dot = (cx: number, cy: number, rad: number): AvatarShape => ({
  d: `M${n(cx - rad)} ${n(cy)}a${n(rad)} ${n(rad)} 0 1 0 ${n(rad * 2)} 0a${n(rad)} ${n(rad)} 0 1 0 ${n(-rad * 2)} 0`,
  fill: 'ink',
});

/** The outline, stroked with overshoot; the fill is the same path closed, so the tint sits inside the line. */
function outline(pts: Pt[], count: number): { stroke: string; fill: string } {
  return { stroke: smooth(pts, false), fill: smooth(pts.slice(0, count), true) };
}

/** A creature's body: its outline, and where the face and the things on top of it go. */
interface Body {
  outline: string;
  fill: string;
  /** Top of the head at x = 20, where antennas and ears attach. */
  top: number;
  eyeY: number;
  mouthY: number;
  /** Half the body's width at the eyes, which bounds the eyes and cheeks. */
  half: number;
}

const BOT_BODIES = ['blob', 'box', 'tall', 'wide', 'pear', 'egg', 'fluff', 'ghost', 'drop', 'tv'] as const;
const BOT_TOPS = ['none', 'none', 'antenna', 'twin', 'curl', 'sprout', 'tuft', 'bolt', 'cat', 'bear', 'bunny', 'horns', 'ball'] as const;
const BOT_SIDES = ['none', 'none', 'none', 'bolts', 'rings', 'arms'] as const;
const BOT_EYES = ['pair', 'pair', 'pair', 'big', 'odd', 'cyclops', 'three', 'sleepy', 'happy', 'dots'] as const;
const BOT_MOUTHS = ['smile', 'smile', 'grin', 'open', 'o', 'cat', 'flat', 'grille', 'fang', 'zigzag', 'none'] as const;

/** Ten body shapes, after the login crew: a blob, a robot box, a ghost, a puffball… */
function body(r: Rand, kind: (typeof BOT_BODIES)[number]): Body {
  const round = (cy: number, rx: number, ry: number, opts: Parameters<typeof loop>[5] = {}) => {
    const { stroke, fill } = outline(loop(r, 20, cy, rx, ry, { count: 12, overshoot: 0.5, ...opts }), 12);
    return { outline: stroke, fill };
  };
  switch (kind) {
    case 'blob':
      return { ...round(23.5, 14.5, 13.8, { power: 2.2, wobble: 0.035 }), top: 9.7, eyeY: 21.5, mouthY: 29, half: 14.5 };
    case 'box':
      return { ...round(23.5, 15, 12.5, { power: 5, wobble: 0.02 }), top: 11, eyeY: 21.5, mouthY: 29, half: 15 };
    case 'tall':
      return { ...round(22.5, 11.5, 15.5, { power: 3.2, wobble: 0.025 }), top: 7, eyeY: 19.5, mouthY: 27.5, half: 11.5 };
    case 'wide':
      return { ...round(25, 17, 10.5, { power: 4, wobble: 0.025 }), top: 14.5, eyeY: 23.5, mouthY: 30, half: 17 };
    case 'pear':
      return { ...round(23, 12.5, 14, { power: 2.4, flare: 0.22 }), top: 9, eyeY: 21, mouthY: 28.5, half: 12.5 };
    case 'egg':
      return { ...round(22.5, 13.5, 15, { power: 2.1, flare: -0.12 }), top: 7.5, eyeY: 20.5, mouthY: 28.5, half: 13 };
    case 'tv':
      return { ...round(23, 14, 14, { power: 6, wobble: 0.015 }), top: 9, eyeY: 21, mouthY: 29, half: 14 };
    case 'fluff': {
      // A puffball: the radius swells and dips all the way round.
      const count = 18;
      const start = r() * Math.PI * 2;
      const pts = Array.from({ length: count }, (_, i): Pt => {
        const a = start + (i / count) * Math.PI * 2;
        const k = (i % 2 ? 0.9 : 1) + jit(r, 0.025);
        return [20 + 14.5 * k * Math.cos(a), 23.5 + 14 * k * Math.sin(a)];
      });
      const d = smooth(pts, true);
      return { outline: d, fill: d, top: 10, eyeY: 22, mouthY: 29, half: 13.5 };
    }
    case 'ghost': {
      // A dome that ends in a wavy hem.
      const [left, right, hem] = [8.6 + jit(r, 0.4), 31.4 + jit(r, 0.4), 34.5];
      let d = smooth([[left, hem], [left, 20], [left + 2.6, 10.8], [20, 7 + jit(r, 0.4)], [right - 2.6, 10.8], [right, 20], [right, hem]], false);
      const waves = r() < 0.5 ? 3 : 4;
      const step = (right - left) / waves;
      for (let i = 1; i <= waves; i++) d += `Q${n(right - step * (i - 0.5))} ${n(hem - 3.4)} ${n(right - step * i)} ${n(hem)}`;
      d += 'Z';
      return { outline: d, fill: d, top: 7, eyeY: 18.5, mouthY: 25.5, half: 11.4 };
    }
    case 'drop': {
      const pts: Pt[] = [[20, 5.5], [24.5, 11.5], [30.5, 19], [32.4, 27.4], [27.6, 34.8], [20, 36.8], [12.4, 34.8], [7.6, 27.4], [9.5, 19], [15.5, 11.5]];
      const d = smooth(pts.map(([x, y], i) => (i ? [x + jit(r, 0.4), y + jit(r, 0.4)] : [x, y])), true);
      return { outline: d, fill: d, top: 5.5, eyeY: 22, mouthY: 29.5, half: 12 };
    }
  }
}

/** A filled shape in the body's tint, outlined in ink: ears, balls, horns. */
const tinted = (d: string): AvatarShape => ({ d, fill: 'tint' });

/** What sits on the head. Ears and horns go behind the body, so its outline crosses their base. */
function top(r: Rand, b: Body, behind: AvatarShape[], front: AvatarShape[]) {
  const t = b.top;
  const w = Math.min(b.half, 14);
  switch (pick(r, BOT_TOPS)) {
    case 'antenna':
      front.push({ d: line(r, 20, t + 0.4, 20 + jit(r, 1.2), t - 4, 0.4) }, tinted(ring(r, 20, t - 5.6, 1.8)));
      break;
    case 'twin':
      front.push({ d: line(r, 16, t + 1.4, 12.6, t - 3.4, 0.4) }, { d: line(r, 24, t + 1.4, 27.4, t - 3.4, 0.4) }, tinted(ring(r, 12, t - 4.8, 1.6)), tinted(ring(r, 28, t - 4.8, 1.6)));
      break;
    case 'curl':
      front.push({ d: `M16.4 ${n(t + 1)}Q17.4 ${n(t - 4)} 20.6 ${n(t - 2)}Q22.6 ${n(t - 5)} 25 ${n(t + 0.6)}` });
      break;
    case 'sprout':
      front.push({ d: line(r, 20, t + 0.4, 20, t - 3.6, 0.3) }, tinted(`M20 ${n(t - 3.4)}Q23 ${n(t - 8)} 27 ${n(t - 6)}Q24 ${n(t - 1.8)} 20 ${n(t - 3.4)}Z`));
      break;
    case 'tuft':
      front.push({ d: `M16.8 ${n(t + 1.2)}L16 ${n(t - 3)}M20 ${n(t + 0.4)}L20.2 ${n(t - 4.4)}M23.2 ${n(t + 1.2)}L24.2 ${n(t - 3)}` });
      break;
    case 'bolt':
      front.push({ d: `M18.6 ${n(t)}L21 ${n(t - 2.6)}L18.8 ${n(t - 3.2)}L21.4 ${n(t - 6.4)}` });
      break;
    case 'cat': {
      const x = 20 - w * 0.62;
      behind.push(tinted(`M${n(x - 3.4)} ${n(t + 7)}L${n(x - 3.2 + jit(r, 0.6))} ${n(t - 4.4)}L${n(x + 5)} ${n(t + 3)}Z`));
      behind.push(tinted(`M${n(40 - x + 3.4)} ${n(t + 7)}L${n(40 - x + 3.2 + jit(r, 0.6))} ${n(t - 4.4)}L${n(40 - x - 5)} ${n(t + 3)}Z`));
      break;
    }
    case 'bear':
      behind.push(tinted(ring(r, 20 - w * 0.66, t + 2.2, 4)), tinted(ring(r, 20 + w * 0.66, t + 2.2, 4)));
      break;
    case 'bunny': {
      const ear = (x: number, lean: number) => tinted(smooth([[x - 2.6, t + 4], [x - 3 + lean, t - 4], [x + lean, t - 9.4], [x + 3 + lean, t - 4], [x + 2.6, t + 4]], true));
      behind.push(ear(15, -1.4 + jit(r, 0.6)), ear(25, 1.4 + jit(r, 0.6)));
      break;
    }
    case 'horns':
      behind.push(
        tinted(`M${n(13.4)} ${n(t + 4)}Q${n(10.4)} ${n(t - 0.6)} ${n(11)} ${n(t - 4.6)}Q${n(14.6)} ${n(t - 1.4)} ${n(17.4)} ${n(t + 2)}Z`),
        tinted(`M${n(26.6)} ${n(t + 4)}Q${n(29.6)} ${n(t - 0.6)} ${n(29)} ${n(t - 4.6)}Q${n(25.4)} ${n(t - 1.4)} ${n(22.6)} ${n(t + 2)}Z`),
      );
      break;
    case 'ball':
      behind.push(tinted(ring(r, 20 + jit(r, 0.6), t - 1.4, 4.4)));
      break;
  }
  switch (pick(r, BOT_SIDES)) {
    case 'bolts':
      front.push({ d: line(r, 20 - b.half - 2.8, b.eyeY + 1, 20 - b.half + 0.2, b.eyeY + 1, 0.2) }, { d: line(r, 20 + b.half - 0.2, b.eyeY + 1, 20 + b.half + 2.8, b.eyeY + 1, 0.2) });
      break;
    case 'rings':
      behind.push(tinted(ring(r, 20 - b.half, b.eyeY + 1, 2.4)), tinted(ring(r, 20 + b.half, b.eyeY + 1, 2.4)));
      break;
    case 'arms': {
      const y = b.mouthY + 1;
      front.push({ d: smooth([[20 - b.half + 0.6, y - 1], [20 - b.half - 2.2, y + 0.6], [20 - b.half - 3, y + 3.2]], false) });
      front.push({ d: smooth([[20 + b.half - 0.6, y - 1], [20 + b.half + 2.2, y + 0.6], [20 + b.half + 3, y + 3.2]], false) });
      break;
    }
  }
}

/** Eyes like the crew's: white, inked round, both pupils glancing the same way. */
function eyes(r: Rand, b: Body, shapes: AvatarShape[]): number {
  const ey = b.eyeY;
  const look = r() * Math.PI * 2;
  const far = r() < 0.2 ? 0 : 0.4 + r() * 0.6;
  const eye = (x: number, y: number, rx: number, ry = rx * 1.1, sleepy = false) => {
    const pr = rx * 0.52;
    const reach = rx - pr - 0.35;
    const [px, py] = [x + Math.cos(look) * far * reach, y + (sleepy ? reach * 0.6 : Math.sin(look) * far * reach)];
    shapes.push({ d: smooth(loop(r, x, y, rx, ry, { count: 8, wobble: 0.03 }), true), fill: 'white', width: 1.5 });
    shapes.push(dot(px, py, pr), { ...dot(px + pr * 0.4, py - pr * 0.42, pr * 0.32), fill: 'shine' });
    // Half-shut: the lid, in the body's tint, comes down over the top of the eye.
    if (sleepy) shapes.push({ d: `M${n(x - rx - 0.2)} ${n(y + 0.3)}A${n(rx + 0.2)} ${n(ry + 0.2)} 0 0 1 ${n(x + rx + 0.2)} ${n(y + 0.3)}Z`, fill: 'tint', width: 1.5 });
  };
  const gap = Math.min(4.6 + r() * 2.2, b.half - 5.4);
  switch (pick(r, BOT_EYES)) {
    case 'pair':
      eye(20 - gap, ey, 3.3);
      eye(20 + gap, ey, 3.3);
      return gap;
    case 'big': {
      const g = Math.max(gap, 5);
      eye(20 - g, ey - 0.4, 4.1);
      eye(20 + g, ey - 0.4, 4.1);
      return g;
    }
    case 'odd': {
      const big = r() < 0.5 ? -1 : 1;
      eye(20 + big * gap, ey - 0.5, 4);
      eye(20 - big * gap, ey + 0.3, 2.7);
      return gap;
    }
    case 'cyclops':
      eye(20, ey - 0.4, 5, 5.3);
      return 4.5;
    case 'three':
      eye(20 - 6.2, ey + 0.4, 2.6);
      eye(20, ey - 1.6, 2.9);
      eye(20 + 6.2, ey + 0.4, 2.6);
      return 6;
    case 'sleepy':
      eye(20 - gap, ey, 3.4, 3.6, true);
      eye(20 + gap, ey, 3.4, 3.6, true);
      return gap;
    case 'happy': {
      const arc = (x: number) => ({ d: smooth([[x - 2.6, ey + 1], [x, ey - 1.6], [x + 2.6, ey + 1]], false) });
      shapes.push(arc(20 - gap), arc(20 + gap));
      return gap;
    }
    case 'dots':
      shapes.push(dot(20 - gap, ey, 1.9), dot(20 + gap, ey, 1.9), { ...dot(20 - gap + 0.7, ey - 0.7, 0.6), fill: 'shine' }, { ...dot(20 + gap + 0.7, ey - 0.7, 0.6), fill: 'shine' });
      return gap;
  }
}

function mouth(r: Rand, b: Body, shapes: AvatarShape[]) {
  const my = b.mouthY;
  switch (pick(r, BOT_MOUTHS)) {
    case 'smile':
      shapes.push({ d: smooth([[17.2, my - 0.6], [20, my + 1.6], [22.8, my - 0.6]], false) });
      break;
    case 'grin':
      shapes.push({ d: smooth([[15.2, my - 1], [20, my + 2.4], [24.8, my - 1]], false) });
      break;
    case 'open':
      shapes.push({ d: `M16.6 ${n(my - 0.8)}L23.4 ${n(my - 0.8)}C23.2 ${n(my + 3.8)} 16.8 ${n(my + 3.8)} 16.6 ${n(my - 0.8)}Z`, fill: 'ink' });
      shapes.push({ d: `M18.2 ${n(my + 2.1)}Q20 ${n(my + 0.7)} 21.8 ${n(my + 2.1)}`, fill: 'blush', width: 0 });
      break;
    case 'o':
      shapes.push({ d: smooth(loop(r, 20, my + 0.4, 1.4, 1.7, { count: 6, wobble: 0.05 }), true), fill: 'ink' });
      break;
    case 'cat':
      shapes.push({ d: `M17 ${n(my)}Q18.5 ${n(my + 1.6)} 20 ${n(my)}Q21.5 ${n(my + 1.6)} 23 ${n(my)}` });
      break;
    case 'flat':
      shapes.push({ d: line(r, 17, my + 0.4, 23, my + 0.4, 0.4) });
      break;
    case 'grille':
      shapes.push({ d: line(r, 15.8, my, 24.2, my, 0.2) }, { d: `M17.6 ${n(my - 1.4)}V${n(my + 1.4)}M20 ${n(my - 1.4)}V${n(my + 1.4)}M22.4 ${n(my - 1.4)}V${n(my + 1.4)}`, width: 1.4 });
      break;
    case 'fang': {
      const side = r() < 0.5 ? 17.8 : 22.2;
      shapes.push({ d: smooth([[15.8, my - 0.8], [20, my + 1.8], [24.2, my - 0.8]], false) });
      shapes.push({ d: `M${n(side - 1)} ${n(my + 0.8)}L${n(side)} ${n(my + 3)}L${n(side + 1)} ${n(my + 1.2)}`, fill: 'white', width: 1.2 });
      break;
    }
    case 'zigzag':
      shapes.push({ d: `M15.6 ${n(my)}L17.8 ${n(my - 1.3)}L20 ${n(my + 0.3)}L22.2 ${n(my - 1.3)}L24.4 ${n(my)}`, width: 1.6 });
      break;
  }
}

/**
 * Bots are little creatures, like the crew on the login page: a body (blob, box, ghost, puffball…),
 * maybe ears or an antenna, white eyes with pupils, a mouth, sometimes cheeks.
 */
function bot(r: Rand): { outline: string; fill: string; behind: AvatarShape[]; shapes: AvatarShape[] } {
  const b = body(r, pick(r, BOT_BODIES));
  const behind: AvatarShape[] = [];
  const shapes: AvatarShape[] = [];
  top(r, b, behind, shapes);
  const gap = eyes(r, b, shapes);
  mouth(r, b, shapes);
  if (r() < 0.5) {
    const x = Math.min(gap + 4, b.half - 3);
    const cheek = (cx: number): AvatarShape => ({ d: smooth(loop(r, cx, b.eyeY + 4.4, 2.3, 1.3, { count: 6, wobble: 0 }), true), fill: 'blush' });
    // Under the eyes and mouth.
    shapes.unshift(cheek(20 - x), cheek(20 + x));
  }
  return { outline: b.outline, fill: b.fill, behind, shapes };
}

const SKINS = ['#fde4d0', '#f8d5b8', '#efc29c', '#dca77c', '#bd855b', '#8f5d3d'] as const;
/** Mostly natural hair colors, now and then a dyed one. */
const HAIR_COLORS = ['#2d2421', '#2d2421', '#5b3a28', '#5b3a28', '#8b5a34', '#d8a64c', '#b8562e', '#bfb9b1', '#e48fae', '#7fa6e0', '#9b86e0'] as const;
const HUMAN_HAIR = ['short', 'short', 'part', 'bangs', 'spiky', 'long', 'long', 'bob', 'bun', 'pigtails', 'curly', 'curly', 'buzz', 'beanie'] as const;
const HUMAN_EYES = ['dots', 'dots', 'dots', 'shiny', 'shiny', 'happy', 'wink', 'lashes'] as const;
const HUMAN_MOUTHS = ['smile', 'smile', 'small', 'open', 'open', 'grin', 'cat', 'tongue', 'o'] as const;
const HUMAN_EXTRAS = ['none', 'none', 'none', 'glasses', 'glasses', 'bow', 'flower', 'freckles', 'earrings'] as const;

/** The head sits at (20, 21); the hair line runs round its top. */
const [HX, HY, HRX, HRY] = [20, 21, 13.2, 14.2];

/** Hair over the top of the head, from temple to temple; `edge` is the fringe, right to left. */
function cap(edge: string, lift = 0): string {
  return `M6.4 ${n(22 - lift)}C5.6 ${n(1.6 - lift)} 34.4 ${n(1.6 - lift)} 33.6 ${n(22 - lift)}${edge}Z`;
}

function hair(r: Rand, color: string, behind: AvatarShape[], front: AvatarShape[]) {
  const c = (d: string): AvatarShape => ({ d, color });
  const fringe = () => `Q31.6 ${n(13.6 + jit(r, 0.6))} 26 ${n(12.6 + jit(r, 0.5))}Q22 ${n(15.4 + jit(r, 0.5))} 17 ${n(13 + jit(r, 0.5))}Q10.6 ${n(13.4 + jit(r, 0.5))} 6.4 22`;
  switch (pick(r, HUMAN_HAIR)) {
    case 'short':
      front.push(c(cap(fringe())));
      break;
    case 'part': {
      // Swept to one side: the fringe dips low on one temple.
      const left = r() < 0.5;
      front.push(c(cap(left ? 'Q30 12.4 21 12.2Q13 13.4 6.4 22' : 'Q29 15 22 13.2Q12 11.6 6.4 22')));
      break;
    }
    case 'bangs':
      front.push(c(cap('Q33.2 16 31.4 15.6L8.6 15.6Q6.8 16 6.4 22')));
      break;
    case 'spiky':
      front.push(c(cap(fringe(), 0)), c('M10 9.4L9.2 3.6L14.2 6.6L16.8 1.8L20.4 5.6L24 1.6L25.8 6.4L30.8 3.8L30 9.4Z'));
      break;
    case 'long':
      behind.push(c(smooth([[6.2, 20], [5.6, 30], [6.8, 36.6], [20, 37.4], [33.2, 36.6], [34.4, 30], [33.8, 20], [20, 6]], true)));
      front.push(c(cap(r() < 0.5 ? fringe() : 'Q29 13.4 21.2 9.6Q20 9 18.8 9.6Q11 13.4 6.4 22')));
      break;
    case 'bob':
      behind.push(c(smooth([[6, 19], [5.4, 27], [7.6, 31.6], [20, 30], [32.4, 31.6], [34.6, 27], [34, 19], [20, 6]], true)));
      front.push(c(cap('Q33 16.2 31 15.8Q20 17.4 9 15.8Q7 16.2 6.4 22')));
      break;
    case 'bun':
      behind.push(c(ring(r, 20 + jit(r, 1.5), 4.4, 4.2)));
      front.push(c(cap(fringe())));
      break;
    case 'pigtails':
      behind.push(c(ring(r, 5.4, 15, 4)), c(ring(r, 34.6, 15, 4)));
      front.push(c(cap('Q31 13.6 21.6 10Q20 9.4 18.4 10Q9 13.6 6.4 22')));
      break;
    case 'curly': {
      // A cloud of curls round the top, puffing out past the head.
      const count = 14;
      const pts = Array.from({ length: count }, (_, i): Pt => {
        const a = Math.PI * (1.02 + (i / (count - 1)) * 0.96);
        const k = (i % 2 ? 0.94 : 1.04) + jit(r, 0.02);
        return [HX + 16 * k * Math.cos(a), HY - 1 + 16.6 * k * Math.sin(a)];
      });
      behind.push(c(`${smooth(pts, false)}L33 30L7 30Z`));
      front.push(c(`M6.6 19.6Q8.6 13.6 12.6 15.2Q14.8 11.2 19 13.2Q22 10.4 26 13Q30.4 12.2 33.4 19.6Q34 9 20 6.4Q6 9 6.6 19.6Z`));
      break;
    }
    case 'buzz':
      front.push({ ...c(cap('Q30 12.6 20 11.8Q10 12.6 6.4 22', -0.6)), width: 1.4 });
      break;
    case 'beanie':
      // A woolly hat in the avatar's tint, with a pompom.
      front.push(c(cap(fringe())));
      front.push(
        { d: ring(r, 20, 3.4, 2.6), fill: 'tint' },
        { d: 'M7 13.4C6.6 1.8 33.4 1.8 33 13.4Z', fill: 'tint' },
        { d: 'M6.6 12.8Q20 10.6 33.4 12.8L33.6 17Q20 14.8 6.4 17Z', fill: 'tint' },
      );
      break;
  }
}

function human(r: Rand): { outline: string; shapes: AvatarShape[]; fill: string; behind: AvatarShape[]; skin: string } {
  const skin = pick(r, SKINS);
  const hairColor = pick(r, HAIR_COLORS);
  const face = outline(loop(r, HX, HY, HRX, HRY, { power: 2.1, wobble: 0.02, count: 10, overshoot: 0.45 }), 10);
  const behind: AvatarShape[] = [];
  const shapes: AvatarShape[] = [];
  // Ears peek out at the sides.
  behind.push({ d: ring(r, 6.9, 22.6, 2.5), color: skin }, { d: ring(r, 33.1, 22.6, 2.5), color: skin });
  if (r() < 0.65) shapes.push({ d: smooth(loop(r, 11.6, 25.6, 2.3, 1.4, { count: 6, wobble: 0 }), true), fill: 'blush' }, { d: smooth(loop(r, 28.4, 25.6, 2.3, 1.4, { count: 6, wobble: 0 }), true), fill: 'blush' });
  hair(r, hairColor, behind, shapes);

  const [ey, lx, rx] = [21.4, 14.6, 25.4];
  const shiny = (x: number, rad = 1.75) => [dot(x, ey, rad), { ...dot(x + 0.6, ey - 0.6, 0.55), fill: 'shine' as const }];
  const happy = (x: number) => ({ d: smooth([[x - 2.2, ey + 0.8], [x, ey - 1.3], [x + 2.2, ey + 0.8]], false), width: 1.7 });
  const eyes = pick(r, HUMAN_EYES);
  switch (eyes) {
    case 'dots':
      shapes.push(...shiny(lx), ...shiny(rx));
      break;
    case 'shiny':
      for (const x of [lx, rx]) shapes.push({ d: smooth(loop(r, x, ey, 2.7, 3, { count: 8, wobble: 0.03 }), true), fill: 'white', width: 1.4 }, dot(x, ey + 0.3, 1.6), { ...dot(x + 0.6, ey - 0.4, 0.5), fill: 'shine' });
      break;
    case 'happy':
      shapes.push(happy(lx), happy(rx));
      break;
    case 'wink':
      shapes.push(...shiny(lx), happy(rx));
      break;
    case 'lashes':
      shapes.push(...shiny(lx), ...shiny(rx), { d: `M${n(lx - 1.6)} ${n(ey - 1.4)}L${n(lx - 2.8)} ${n(ey - 2.6)}M${n(rx + 1.6)} ${n(ey - 1.4)}L${n(rx + 2.8)} ${n(ey - 2.6)}`, width: 1.3 });
      break;
  }
  if (eyes !== 'happy' && r() < 0.35) {
    const by = ey - 3.8;
    shapes.push({ d: `${line(r, lx - 1.8, by + 0.3, lx + 1.6, by - 0.3, 0.3)}${line(r, rx - 1.6, by - 0.3, rx + 1.8, by + 0.3, 0.3)}`, width: 1.4 });
  }

  const my = 27.4;
  switch (pick(r, HUMAN_MOUTHS)) {
    case 'smile':
      shapes.push({ d: smooth([[16.4, my - 0.8], [20, my + 1.8], [23.6, my - 0.8]], false) });
      break;
    case 'small':
      shapes.push({ d: smooth([[18, my - 0.2], [20, my + 1.2], [22, my - 0.2]], false) });
      break;
    case 'open':
      shapes.push({ d: `M16.4 ${n(my - 0.8)}L23.6 ${n(my - 0.8)}C23.4 ${n(my + 4)} 16.6 ${n(my + 4)} 16.4 ${n(my - 0.8)}Z`, fill: 'ink' });
      shapes.push({ d: `M18 ${n(my + 2.2)}Q20 ${n(my + 0.8)} 22 ${n(my + 2.2)}`, fill: 'blush', width: 0 });
      break;
    case 'grin':
      shapes.push({ d: `M15.8 ${n(my - 1)}L24.2 ${n(my - 1)}C24 ${n(my + 3.8)} 16 ${n(my + 3.8)} 15.8 ${n(my - 1)}Z`, fill: 'white', width: 1.6 });
      break;
    case 'cat':
      shapes.push({ d: `M17 ${n(my)}Q18.5 ${n(my + 1.6)} 20 ${n(my)}Q21.5 ${n(my + 1.6)} 23 ${n(my)}` });
      break;
    case 'tongue':
      shapes.push({ d: `M18.6 ${n(my + 0.6)}Q18.8 ${n(my + 3.6)} 20.6 ${n(my + 3.4)}Q22 ${n(my + 3)} 21.8 ${n(my + 0.6)}`, color: '#ef8f9f', width: 1.4 });
      shapes.push({ d: smooth([[16.4, my - 0.8], [20, my + 1.2], [23.6, my - 0.8]], false) });
      break;
    case 'o':
      shapes.push({ d: smooth(loop(r, 20, my + 0.6, 1.5, 1.8, { count: 6, wobble: 0.05 }), true), fill: 'ink' });
      break;
  }

  switch (pick(r, HUMAN_EXTRAS)) {
    case 'glasses':
      shapes.push({ d: ring(r, lx, ey, 3.9), width: 1.5 }, { d: ring(r, rx, ey, 3.9), width: 1.5 }, { d: line(r, lx + 3.9, ey, rx - 3.9, ey, 0.2), width: 1.5 });
      break;
    case 'bow': {
      const [x, y] = r() < 0.5 ? [9.6, 9.4] : [30.4, 9.4];
      shapes.push({ d: `M${n(x)} ${n(y)}L${n(x - 4)} ${n(y - 2.6)}L${n(x - 4)} ${n(y + 2.6)}ZM${n(x)} ${n(y)}L${n(x + 4)} ${n(y - 2.6)}L${n(x + 4)} ${n(y + 2.6)}Z`, fill: 'tint', width: 1.5 }, dot(x, y, 1.1));
      break;
    }
    case 'flower': {
      const [x, y] = r() < 0.5 ? [9.4, 10.2] : [30.6, 10.2];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        shapes.push({ d: smooth(loop(r, x + Math.cos(a) * 2, y + Math.sin(a) * 2, 1.5, 1.5, { count: 6, wobble: 0 }), true), fill: 'tint', width: 1.2 });
      }
      shapes.push({ ...dot(x, y, 1.1), color: '#f1c84b', width: 1 });
      break;
    }
    case 'freckles':
      shapes.push(dot(11, 23.6, 0.5), dot(12.6, 24.4, 0.5), dot(11.4, 25.2, 0.5), dot(29, 23.6, 0.5), dot(27.4, 24.4, 0.5), dot(28.6, 25.2, 0.5));
      break;
    case 'earrings':
      shapes.push({ ...dot(6.6, 26.4, 1.1), color: '#f1c84b', width: 1 }, { ...dot(33.4, 26.4, 1.1), color: '#f1c84b', width: 1 });
      break;
  }
  return { outline: face.stroke, fill: face.fill, behind, shapes, skin };
}

/** A random seed (8 url-safe characters), for offering new faces to pick from. Works in the browser and on the server. */
export function randomSeed(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

/** The avatar for a seed: the same seed always draws the same face. */
export function avatarArt(seed: string, kind: AvatarKind): AvatarArt {
  const r = random(`${kind}:${seed}`);
  const tint = Math.floor(r() * TINTS);
  const drawn = kind === 'human' ? human(r) : bot(r);
  return { tint, ...drawn };
}
