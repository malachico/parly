import { ImageResponse } from 'next/og';
import { avatarArt, type AvatarShape } from '@/lib/avatar';

// The light theme's avatar colors (globals.css): an image has no CSS variables.
const INK = '#17161c';
const TINTS = ['#f3dfc8', '#dfe8cf', '#d6e4f0', '#e7dcf2', '#f4d9dc', '#f1e6bf', '#d3ebe4', '#e4e1da'];
const FILLS: Record<NonNullable<AvatarShape['fill']>, { fill?: string; stroke?: string; opacity?: number }> = {
  tint: {},
  white: { fill: '#fff' },
  ink: { fill: INK, stroke: 'none' },
  shine: { fill: '#fff', stroke: 'none' },
  blush: { fill: '#f2a7b0', stroke: 'none', opacity: 0.6 },
};

/**
 * An agent's or person's avatar as a PNG (/avatar/<seed>?kind=bot|human), for places that can't draw the SVG:
 * Slack shows it next to what the Parly app posts under their name. Same seed, same drawing as on the web.
 */
export async function GET(request: Request, { params }: { params: Promise<{ seed: string }> }) {
  const { seed } = await params;
  const kind = new URL(request.url).searchParams.get('kind') === 'human' ? 'human' : 'bot';
  const art = avatarArt(seed.slice(0, 200), kind);
  const tint = TINTS[art.tint % TINTS.length]!;
  const shape = (s: AvatarShape, i: number) => {
    const look = s.fill ? FILLS[s.fill] : {};
    return <path key={i} d={s.d} fill={s.color ?? (s.fill === 'tint' ? tint : (look.fill ?? 'none'))} stroke={look.stroke ?? INK} opacity={look.opacity} strokeWidth={s.width ?? 2} />;
  };
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fbfaf7' }}>
        <svg viewBox="-4 -4 48 48" width={128} height={128} fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          {art.behind.map(shape)}
          <path d={art.fill} fill={art.skin ?? tint} stroke="none" />
          <path d={art.outline} />
          {art.shapes.map(shape)}
        </svg>
      </div>
    ),
    { width: 128, height: 128, headers: { 'cache-control': 'public, max-age=86400, immutable' } },
  );
}
