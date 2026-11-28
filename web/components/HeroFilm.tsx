'use client';

import { useEffect, useState } from 'react';

/**
 * The hero film: 16:9 on wide screens, its 4:5 re-layout on phones. Both
 * <video>s render (posters + CSS swap stay identical), but only the visible
 * one gets <source>s, so a visit downloads one film, not two. Each is keyed on
 * having its sources: a <video> mounted empty ignores <source>s added later, so
 * it remounts once the breakpoint is known.
 *
 * `autoPlay` alone isn't enough: React sets `muted` as a property, never the
 * attribute, so on a remounted <video> browsers can judge it unmuted and block
 * autoplay, leaving a click-to-play poster. `start` mutes and plays it by hand.
 *
 * The poster is the hero's first paint (LCP), so each one is preloaded at high priority for its own
 * breakpoint only; React hoists these <link>s into <head>.
 */
const start = (v: HTMLVideoElement | null) => {
  if (!v || !v.querySelector('source')) return;
  v.muted = true;
  v.play().catch(() => {}); // still blocked (e.g. iOS Low Power Mode): the poster stays
};

export function HeroFilm({ label }: { label: string }) {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)'); // Tailwind `sm`
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return (
    <>
      <link rel="preload" as="image" href="/landing/parly-hero-mobile.webp" type="image/webp" media="(max-width: 639.98px)" fetchPriority="high" />
      <link rel="preload" as="image" href="/landing/parly-hero.webp" type="image/webp" media="(min-width: 640px)" fetchPriority="high" />
      <video ref={wide === false ? start : undefined} key={wide === false ? 'mobile-film' : 'mobile-poster'} autoPlay muted loop playsInline preload="metadata" poster="/landing/parly-hero-mobile.webp" aria-label={label} className="block aspect-[4/5] w-full bg-[var(--bg)] sm:hidden">
        {wide === false && <source src="/landing/parly-hero-mobile.webm" type="video/webm" />}
        {wide === false && <source src="/landing/parly-hero-mobile.mp4" type="video/mp4" />}
      </video>
      <video ref={wide === true ? start : undefined} key={wide === true ? 'wide-film' : 'wide-poster'} autoPlay muted loop playsInline preload="metadata" poster="/landing/parly-hero.webp" aria-label={label} className="hidden aspect-video w-full bg-[var(--bg)] sm:block">
        {wide === true && <source src="/landing/parly-hero.webm" type="video/webm" />}
        {wide === true && <source src="/landing/parly-hero.mp4" type="video/mp4" />}
      </video>
    </>
  );
}
