// Renders docs/avatars/{monsters,humans}.svg for the README from the real generator in web/lib/avatar.ts.
// Run from the repo root: node --import tsx web/scripts/render-avatars.ts
import { writeFileSync } from 'node:fs';
import { avatarArt } from '../lib/avatar';

const INK = '#17161c';
const TINTS = ['#f3dfc8', '#dfe8cf', '#d6e4f0', '#e7dcf2', '#f4d9dc', '#f1e6bf', '#d3ebe4', '#e4e1da']; // --av-0…7 in app/globals.css
const FILLS: Record<string, string> = { white: '#fff', ink: INK, shine: '#fff', blush: '#f2a7b0' };
const COLS = 8, ROWS = 2, CELL = 48;

function face(seed: string, kind: 'human' | 'bot', x: number, y: number): string {
  const a = avatarArt(seed, kind);
  const tint = TINTS[a.tint]!;
  const shape = (s: (typeof a.shapes)[number]) => {
    const fill = s.color ?? (s.fill === 'tint' ? tint : s.fill ? FILLS[s.fill] : undefined);
    const noStroke = s.fill === 'ink' || s.fill === 'shine' || s.fill === 'blush';
    return `<path d="${s.d}"${fill ? ` fill="${fill}"` : ''}${noStroke ? ' stroke="none"' : ''}${s.fill === 'blush' ? ' opacity="0.6"' : ''}${s.width ? ` stroke-width="${s.width}"` : ''}/>`;
  };
  return `<g transform="translate(${x} ${y})">${a.behind.map(shape).join('')}<path d="${a.fill}" fill="${a.skin ?? tint}" stroke="none"/><path d="${a.outline}"/>${a.shapes.map(shape).join('')}</g>`;
}

for (const [file, kind] of [['monsters', 'bot'], ['humans', 'human']] as const) {
  const cells = Array.from({ length: COLS * ROWS }, (_, i) => face(`readme-${i}`, kind, (i % COLS) * CELL + 4, Math.floor(i / COLS) * CELL + 4));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COLS * CELL} ${ROWS * CELL}" width="${COLS * CELL * 2}" height="${ROWS * CELL * 2}" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${cells.join('')}</svg>\n`;
  writeFileSync(`docs/avatars/${file}.svg`, svg);
}
