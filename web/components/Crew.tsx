'use client';

import { useEffect, useRef } from 'react';

type Pt = [number, number];

/** One character in a 64×64 box: a tinted body, two eyes that follow the cursor, a mouth. */
type Member = {
  tint: number;
  /** Body paths, filled with the tint (or a person's skin) and stroked in ink. */
  body: string[];
  /** A person's skin, in place of the tint. */
  skin?: string;
  /** A person's hair, filled with its color; `behind` goes under the head (long hair, a bun). */
  hair?: { d: string; color: string; behind?: boolean }[];
  /** Ink-only strokes on top of the body (antennas, hair). */
  lines?: string[];
  dots?: Pt[];
  eyes: [Pt, Pt];
  mouth: string;
  cheeks?: [Pt, Pt];
  /** Placement: a row on phones, scattered over the page from sm up. */
  className: string;
};

const FACES: Member[] = [
  {
    tint: 0,
    body: ['M32 12C45 11.5 54.5 21 54 34C53.6 46.5 44.5 55.5 32 55.5C19.2 55.6 10 46 10.3 33.5C10.6 21 19.6 12.3 32.6 12'],
    lines: ['M25 13.5Q27 6 33 9.5Q36 4.5 40 11'],
    eyes: [
      [25, 32],
      [39, 32],
    ],
    mouth: 'M28.5 42Q32 46 35.5 42',
    cheeks: [
      [19.5, 40],
      [44.5, 40],
    ],
    className: 'sm:absolute sm:left-[9%] sm:top-[13%] size-16 sm:size-[88px] -rotate-6 [--d:-0.4s] [--b:0.6s]',
  },
  {
    tint: 2,
    body: ['M15 16.5L49 15.6Q53.6 15.6 53.7 20L54.2 49.5Q54.2 54 49.7 54.1L15.4 54.6Q10.9 54.6 10.9 50.1L10.6 21Q10.6 16.6 15 16.5'],
    lines: ['M32 15.8Q31.3 11 32.2 7.4', 'M25.5 45.5H38.5', 'M28.5 43.5V47.5M32 43.5V47.5M35.5 43.5V47.5'],
    dots: [[32.3, 5.2]],
    eyes: [
      [24, 31],
      [40, 31],
    ],
    mouth: '',
    className: 'sm:absolute sm:right-[13%] sm:top-[6%] size-16 sm:size-[104px] rotate-6 [--d:-1.6s] [--b:2.1s]',
  },
  {
    tint: 3,
    body: ['M13.5 54V30Q13.8 10.6 32 10.4Q50.2 10.6 50.5 30V54Q46.8 50.4 43 54Q39.4 50.4 35.6 54Q32 50.4 28.4 54Q24.7 50.4 21 54Q17.3 50.4 13.5 54'],
    eyes: [
      [25.5, 29],
      [38.5, 29],
    ],
    mouth: 'M30.2 39.5a1.9 2.2 0 1 0 3.8 0a1.9 2.2 0 1 0 -3.8 0',
    cheeks: [
      [19.5, 36],
      [44.5, 36],
    ],
    className: 'hidden sm:block sm:absolute sm:left-[3%] sm:top-[60%] sm:size-16 sm:size-[76px] rotate-[10deg] [--d:-2.2s] [--b:3.4s]',
  },
  {
    tint: 4,
    body: [
      'M32 5.4C36 5.3 39 8.2 38.9 12C38.8 15.8 35.8 18.4 32 18.3C28.2 18.2 25.3 15.5 25.4 11.8C25.5 8 28.3 5.5 32.4 5.4',
      'M32 15.5C44 15.2 52.6 24 52.3 36C52 47.6 43.6 56 32 55.8C20.3 55.7 11.8 47 12 35.5C12.3 24 20.6 15.7 32.5 15.5',
    ],
    eyes: [
      [25, 34],
      [39, 34],
    ],
    mouth: 'M29 44Q32 47 35 44',
    cheeks: [
      [19.5, 42],
      [44.5, 42],
    ],
    className: 'hidden sm:block sm:absolute sm:right-[5%] sm:top-[43%] sm:size-16 sm:size-[92px] -rotate-6 [--d:-0.9s] [--b:1.3s]',
  },
  {
    tint: 1,
    body: ['M14 20.5L50 20Q56 20 56 26L56.3 45.5Q56.3 51.6 50.2 51.6L14.2 52Q8 52 8 46L7.8 26.6Q7.8 20.6 14 20.5'],
    lines: ['M22 20.4Q20 15 17 11.5', 'M42 20.2Q44.2 15 47.2 11.6'],
    dots: [
      [16.4, 10.6],
      [47.8, 10.6],
    ],
    eyes: [
      [22, 34],
      [42, 34],
    ],
    mouth: 'M26 43Q32 48.5 38 43',
    className: 'hidden sm:block sm:absolute sm:left-[23%] sm:bottom-[7%] sm:size-[72px] rotate-3 [--d:-3s] [--b:4.2s]',
  },
  {
    tint: 6,
    body: ['M14.5 26L13 9.5L25.5 17.5Q32 15.6 38.5 17.5L51 9.5L49.5 26Q53.6 31.5 53.2 38C52.6 48.8 43.6 55.6 32 55.5C20.4 55.4 11.4 48.6 10.9 38Q10.6 31.5 14.5 26'],
    eyes: [
      [25, 34],
      [39, 34],
    ],
    mouth: 'M28.2 43.3Q30.1 45.6 32 43.3Q33.9 45.6 35.8 43.3',
    cheeks: [
      [18.5, 41],
      [45.5, 41],
    ],
    className: 'hidden sm:block sm:absolute sm:right-[25%] sm:bottom-[15%] sm:size-[84px] -rotate-[10deg] [--d:-1.2s] [--b:2.8s]',
  },
];

/** A person's head and ears, and their head alone (for long hair, which hides the ears). */
const HEAD = 'M32 14C45 13.6 51.4 23 51 35C50.6 47 42.5 54.6 32 54.5C21 54.6 13 46.5 13.2 34.5C13.4 22.6 20.4 14.2 32.6 14';
const EARS = ['M9 36a4 4.4 0 1 0 8 0a4 4.4 0 1 0 -8 0', 'M47 36a4 4.4 0 1 0 8 0a4 4.4 0 1 0 -8 0'];
const PERSON = {
  eyes: [
    [25, 35],
    [39, 35],
  ] as [Pt, Pt],
  cheeks: [
    [19.5, 43],
    [44.5, 43],
  ] as [Pt, Pt],
};

/** People, drawn like the crew's creatures, so the login page shows both who uses a hub. */
const PEOPLE: Member[] = [
  {
    tint: 0,
    skin: '#f8d5b8',
    body: [...EARS, HEAD],
    hair: [{ d: 'M12.6 34C11 2.5 53 2.5 51.4 34Q49.6 24.4 42 21.4Q34.6 25.4 27 21.6Q17.4 22.6 12.6 34Z', color: '#2d2421' }],
    ...PERSON,
    mouth: 'M28 45Q32 49.5 36 45',
    className: 'sm:absolute sm:left-[27%] sm:top-[23%] size-16 sm:size-[80px] rotate-[5deg] [--d:-1.1s] [--b:2.4s]',
  },
  {
    tint: 4,
    skin: '#a86f4c',
    body: [HEAD],
    hair: [
      // Two locks with wavy ends and nothing under the chin: one shell around the face read as a headscarf.
      {
        d: 'M32 11C50.5 11 55.4 24 54.8 38C54.4 46 56 52 55 57Q52.6 60.6 50.4 57Q48.4 60.6 46 56.6L47 46H17L18 56.6Q15.6 60.6 13.6 57Q11.4 60.6 9 57C8 52 9.6 46 9.2 38C8.6 24 13.5 11 32 11Z',
        color: '#a04a26',
        behind: true,
      },
      { d: 'M12.6 34C11 2.5 53 2.5 51.4 34Q48.4 21.6 33 16.4Q32 16 31 16.4Q15.6 21.6 12.6 34Z', color: '#a04a26' },
    ],
    ...PERSON,
    mouth: 'M29.4 44.6Q32 47.6 34.6 44.6',
    className: 'sm:absolute sm:left-[8%] sm:bottom-[5%] size-16 sm:size-[84px] -rotate-[7deg] [--d:-2.9s] [--b:0.9s]',
  },
  {
    tint: 0,
    skin: '#8f5d3d',
    body: [...EARS, HEAD],
    hair: [
      { d: 'M25 9a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', color: '#2d2421', behind: true },
      { d: 'M12.6 34C11 2.5 53 2.5 51.4 34Q47.4 22 37.4 20Q31 24.6 24 21Q16 23 12.6 34Z', color: '#2d2421' },
    ],
    ...PERSON,
    mouth: 'M27.6 44.4H36.4C36.2 50 27.8 50 27.6 44.4Z',
    className: 'hidden sm:block sm:absolute sm:right-[3%] sm:top-[21%] sm:size-[78px] rotate-[8deg] [--d:-0.2s] [--b:3.1s]',
  },
  {
    tint: 0,
    skin: '#dca77c',
    body: [...EARS, HEAD],
    hair: [
      {
        d: 'M12 40Q6 33 9.6 26Q7.6 17 15.6 13.4Q19.4 5.6 27.6 7.6Q33.4 2.6 39.6 7Q47.6 6.4 49.6 13.6Q57 17.4 54.4 25.6Q58 32.6 52 40Z',
        color: '#5b3a28',
        behind: true,
      },
      { d: 'M13 33Q13.4 23.4 19.6 23Q22 17.6 28 19.4Q32 15.4 36.6 19.4Q42.8 17.4 44.8 23Q50.8 23.6 51 33Q52.6 13 32 13Q11.4 13 13 33Z', color: '#5b3a28' },
    ],
    ...PERSON,
    mouth: 'M28.6 44.6Q30.3 46.8 32 44.6Q33.7 46.8 35.4 44.6',
    className: 'hidden lg:block lg:absolute lg:right-[11%] lg:top-[66%] lg:size-[70px] -rotate-[9deg] [--d:-3.7s] [--b:1.5s]',
  },
];

/** The six faces and the people, plus a few repeats in other tints and sizes so wide screens get a looser scatter. */
const CREW: Member[] = [
  // On phones the row shows, in this order, a creature, a person, a creature, a person.
  FACES[0]!,
  PEOPLE[0]!,
  FACES[1]!,
  PEOPLE[1]!,
  ...FACES.slice(2),
  ...PEOPLE.slice(2),
  { ...FACES[1]!, tint: 5, className: 'hidden lg:block lg:absolute lg:left-[31%] lg:top-[5%] lg:size-[58px] -rotate-12 [--d:-2.6s] [--b:1.9s]' },
  { ...FACES[2]!, tint: 1, className: 'hidden lg:block lg:absolute lg:right-[2%] lg:bottom-[4%] lg:size-[64px] rotate-[8deg] [--d:-0.7s] [--b:3.9s]' },
  { ...FACES[0]!, tint: 3, className: 'hidden lg:block lg:absolute lg:left-[15%] lg:top-[37%] lg:size-[54px] rotate-12 [--d:-1.9s] [--b:0.3s]' },
  { ...FACES[5]!, tint: 0, className: 'hidden lg:block lg:absolute lg:right-[30%] lg:top-[22%] lg:size-[48px] rotate-[14deg] [--d:-3.4s] [--b:2.5s]' },
];

/** How far a pupil can travel from the middle of its eye, in viewBox units. */
const REACH = 2.6;
const FACE_REACH = 1.6;

/**
 * The login crew: little creatures and people, in the avatar style, that watch the cursor. With no pointer
 * around (phones, or a still mouse) they glance about on their own; they hop when the sign-in is hovered.
 */
export function Crew() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const members = [...el.querySelectorAll<HTMLElement>('[data-member]')].map((node) => ({
      node,
      face: node.querySelector<SVGGElement>('[data-face]')!,
      pupils: [...node.querySelectorAll<SVGGElement>('[data-pupil]')],
      cur: { x: 0, y: 0 },
      idle: { x: 0, y: 0 },
      nextGlance: 0,
    }));
    let pointer: { x: number; y: number } | null = null;
    let lastMove = 0;
    let frame = 0;

    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      lastMove = performance.now();
    };
    const onLeave = () => (pointer = null);

    const tick = (now: number) => {
      const watching = pointer && now - lastMove < 4000;
      for (const m of members) {
        let target = m.idle;
        if (watching && pointer) {
          const box = m.node.getBoundingClientRect();
          const dx = pointer.x - (box.left + box.width / 2);
          const dy = pointer.y - (box.top + box.height * 0.55);
          const dist = Math.hypot(dx, dy) || 1;
          const pull = Math.min(1, dist / 220);
          target = { x: (dx / dist) * pull, y: (dy / dist) * pull };
        } else if (now > m.nextGlance) {
          // Glance somewhere new, or back to the middle now and then.
          const a = Math.random() * Math.PI * 2;
          const k = Math.random() < 0.25 ? 0 : 0.5 + Math.random() * 0.5;
          m.idle = { x: Math.cos(a) * k, y: Math.sin(a) * k * 0.8 };
          m.nextGlance = now + 900 + Math.random() * 2200;
        }
        const ease = watching ? 0.25 : 0.08;
        m.cur.x += (target.x - m.cur.x) * ease;
        m.cur.y += (target.y - m.cur.y) * ease;
        const { x, y } = m.cur;
        for (const p of m.pupils) p.setAttribute('transform', `translate(${(x * REACH).toFixed(2)} ${(y * REACH).toFixed(2)})`);
        m.face.setAttribute('transform', `translate(${(x * FACE_REACH).toFixed(2)} ${(y * FACE_REACH).toFixed(2)})`);
      }
      frame = requestAnimationFrame(tick);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div ref={root} aria-hidden className="pointer-events-none flex items-end justify-center gap-2 sm:absolute sm:inset-0 sm:block">
      {CREW.map((m, i) => (
        <div key={i} data-member className={`crew-member ${m.className}`}>
          <svg viewBox="0 0 64 64" className="size-full overflow-visible" fill="none" stroke="var(--avatar-ink)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            {m.hair?.filter((h) => h.behind).map((h, j) => <path key={j} d={h.d} fill={h.color} />)}
            {m.body.map((d, j) => (
              <path key={j} d={d} fill={m.skin ?? `var(--av-${m.tint})`} />
            ))}
            {m.hair?.filter((h) => !h.behind).map((h, j) => <path key={j} d={h.d} fill={h.color} />)}
            {m.lines?.map((d, j) => <path key={j} d={d} />)}
            {m.dots?.map(([x, y], j) => <circle key={j} cx={x} cy={y} r={2.3} fill={`var(--av-${m.tint})`} />)}
            <g data-face>
              {m.cheeks?.map(([x, y], j) => <ellipse key={j} cx={x} cy={y} rx={3.2} ry={2} fill="#f2a7b0" opacity={0.55} stroke="none" />)}
              {m.eyes.map(([x, y], j) => (
                <g key={j} className="crew-eye">
                  <ellipse cx={x} cy={y} rx={5.2} ry={5.8} fill="#fff" />
                  <g data-pupil>
                    <circle cx={x} cy={y} r={2.7} fill="var(--avatar-ink)" stroke="none" />
                    <circle cx={x + 1} cy={y - 1.1} r={0.9} fill="#fff" stroke="none" />
                  </g>
                </g>
              ))}
              {m.mouth && <path d={m.mouth} />}
            </g>
          </svg>
        </div>
      ))}
    </div>
  );
}
