'use client';

import { useEffect, useRef } from 'react';

/**
 * A muted demo loop that only downloads and plays while it's on screen, and pauses once scrolled away,
 * so a landing visit doesn't pull every clip up front. Muted is set by hand for the same reason as HeroFilm.
 */
export function LoopVideo({ clip, label, className }: { clip: string; label: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) {
        v.muted = true;
        v.play().catch(() => {}); // blocked: the poster stays
      } else v.pause();
    });
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return (
    <video ref={ref} muted loop playsInline preload="none" poster={`/landing/${clip}.webp`} aria-label={label} className={className}>
      <source src={`/landing/${clip}.webm`} type="video/webm" />
      <source src={`/landing/${clip}.mp4`} type="video/mp4" />
    </video>
  );
}
