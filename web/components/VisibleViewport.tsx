'use client';

import { useEffect } from 'react';

/**
 * Keeps the chat window exactly the visible part of the screen. When a phone's keyboard opens, iOS
 * Safari scrolls the whole page to bring the input into view, which pushes even a sticky header off
 * the top. This sets --app-h to the visual viewport's height (the shell uses it) and scrolls the page
 * back, so the header stays at the top and the composer sits just above the keyboard. Pinch zoom (desktop trackpads,
 * phones) is not the keyboard: the shell keeps the screen's height.
 */
export function VisibleViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fitViewport = () => {
      // Pinch-zoomed (scale > 1), the visual viewport is the zoomed-in part: its height times the scale is still the
      // screen, so zooming never shrinks the shell. Only the keyboard (at scale 1) makes it shorter.
      document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height * vv.scale)}px`);
      // Panning a zoomed page is the person's own scroll: leave it.
      if (vv.scale <= 1.01 && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    fitViewport();
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
    return () => {
      vv.removeEventListener('resize', fitViewport);
      vv.removeEventListener('scroll', fitViewport);
    };
  }, []);
  return null;
}
