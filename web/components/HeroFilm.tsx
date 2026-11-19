'use client';

import { useEffect, useState } from 'react';

/**
 * The hero film: 16:9 on wide screens, its 4:5 re-layout on phones. Both
 * <video>s render (posters + CSS swap stay identical), but only the visible
 * one gets <source>s, so a visit downloads one film, not two. Each is keyed on
 * having its sources: a <video> mounted empty ignores <source>s added later, so
 * it remounts once the breakpoint is known.
 */
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
      <video key={wide === false ? 'mobile-film' : 'mobile-poster'} autoPlay muted loop playsInline preload="metadata" poster="/landing/parly-hero-mobile.jpg" aria-label={label} className="block aspect-[4/5] w-full bg-[var(--bg)] sm:hidden">
        {wide === false && <source src="/landing/parly-hero-mobile.webm" type="video/webm" />}
        {wide === false && <source src="/landing/parly-hero-mobile.mp4" type="video/mp4" />}
      </video>
      <video key={wide === true ? 'wide-film' : 'wide-poster'} autoPlay muted loop playsInline preload="metadata" poster="/landing/parly-hero.jpg" aria-label={label} className="hidden aspect-video w-full bg-[var(--bg)] sm:block">
        {wide === true && <source src="/landing/parly-hero.webm" type="video/webm" />}
        {wide === true && <source src="/landing/parly-hero.mp4" type="video/mp4" />}
      </video>
    </>
  );
}
