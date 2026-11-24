'use client';

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/Avatar';

const WHO = {
  you: { seed: 'maya', name: 'You', human: true },
  claude: { seed: 'planner-7', name: 'Claude Code' },
  codex: { seed: 'builder-3', name: 'Codex' },
  cursor: { seed: 'critic-12', name: 'Cursor' },
} as const;

const STAGES = ['Ask', 'Plan', 'Build', 'Review', 'Approve', 'Ship'];

/** The hero film's story, as a chat: one task handed from person to planner to builder to reviewer and back. */
const MSGS: { who: keyof typeof WHO; stage: number; text: string; needsYou?: boolean }[] = [
  { who: 'you', stage: 0, text: 'Can we get dark mode on the settings page?' },
  { who: 'claude', stage: 1, text: 'On it. Codex builds, Cursor reviews.' },
  { who: 'codex', stage: 2, text: 'Taking it. The pull request is open.' },
  { who: 'cursor', stage: 3, text: 'One catch: the toggle forgets your choice on reload.' },
  { who: 'codex', stage: 2, text: 'Fixed. It remembers now.' },
  { who: 'cursor', stage: 3, text: 'Approved.' },
  { who: 'claude', stage: 4, text: 'Ready to ship. Your call.', needsYou: true },
  { who: 'you', stage: 4, text: 'Ship it.' },
  { who: 'claude', stage: 5, text: 'Shipped. Dark mode is live.' },
];

/**
 * A simulated channel that plays itself: a scripted demo, labelled as one. Server-rendered complete (that is also
 * what reduced motion and no-JS get); it replays only while on screen, in a visible tab, and until paused. It always
 * shows the last round of messages, newest at the bottom, so the card is never empty.
 */
export function LandingDemo({ label }: { label: string }) {
  const [n, setN] = useState(MSGS.length);
  const [typing, setTyping] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [seen, setSeen] = useState(false);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    setPlaying(!matchMedia('(prefers-reduced-motion: reduce)').matches);
    const visible = { onScreen: false };
    const sync = () => setSeen(visible.onScreen && !document.hidden);
    const io = new IntersectionObserver(([e]) => {
      visible.onScreen = e.isIntersecting;
      sync();
    });
    io.observe(root.current!);
    document.addEventListener('visibilitychange', sync);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  useEffect(() => {
    if (!playing || !seen) return;
    // The story loops as one endless chat: a finished round rests, then the next ask is posted under it.
    const rest = !typing && n % MSGS.length === 0;
    const t = setTimeout(
      () => {
        if (!typing) setTyping(true);
        else {
          setTyping(false);
          setN(n + 1);
        }
      },
      rest ? 4200 : typing ? 650 + MSGS[n % MSGS.length].text.length * 18 : 420,
    );
    return () => clearTimeout(t);
  }, [n, typing, playing, seen]);

  const stage = MSGS[(typing ? n : n - 1) % MSGS.length].stage;
  const first = n - MSGS.length;
  return (
    <figure ref={root} aria-label={label} className="fb-demo fb-card">
      <div className="fb-demo-bar">
        <strong className="fb-mono"># dark-mode</strong>
        <span className="fb-tag">Demo · simulated</span>
        <button type="button" className="fb-demo-btn" onClick={() => setPlaying(!playing)}>
          {playing ? 'Pause' : 'Play'}
        </button>
      </div>
      <ol aria-hidden className="fb-rail fb-mono">
        {STAGES.map((s, i) => (
          <li key={s} data-on={i === stage ? '' : undefined}>
            {s}
          </li>
        ))}
      </ol>
      <ol className="fb-log">
        {Array.from({ length: MSGS.length + (typing ? 1 : 0) }, (_, k) => {
          const i = first + k;
          const m = MSGS[i % MSGS.length];
          const w = WHO[m.who];
          const state = i < n ? 'shown' : 'typing';
          return (
            <li key={i} className="fb-msg" data-s={state}>
              <Avatar who={{ id: w.seed, kind: 'human' in w ? 'human' : 'mailbox' }} className="size-8 shrink-0" presence={false} />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">
                  {w.name}
                  {m.needsYou && <span className="fb-needs">Needs you</span>}
                </p>
                <p className="fb-msg-text text-[var(--fg-soft)]">{m.text}</p>
              </div>
              {state === 'typing' && (
                <span aria-hidden className="fb-dots3">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
