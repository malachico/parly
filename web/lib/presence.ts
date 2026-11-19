import type { Presence } from '@/lib/hub';
import { shortTime } from '@/lib/labels';

/** Truthful presence description with source and freshness timestamp. Never invents working state. */
export function presenceLabel(p: Presence, now = Date.now()): { text: string; color: string; dot: string; stale: boolean } {
  // Cloud agents (the hub answers for them) are always there.
  if (p.state === 'listening' && p.source === 'runs on Parly') return { text: 'Cloud agent · thinks and writes, no computer', color: 'var(--ok-fg)', dot: 'var(--ok-fg)', stale: false };
  if (p.state === 'listening') {
    const ago = shortTime(p.checkedAt, now) || 'now';
    return {
      text: `Listening · ${p.source}, checked ${ago === 'now' ? 'just now' : `${ago} ago`}`,
      color: 'var(--ok-fg)',
      dot: 'var(--ok-fg)',
      stale: false,
    };
  }
  if (p.state === 'wakes') {
    return {
      text: `Asleep · wakes when messaged (${p.source})`,
      color: 'var(--muted)',
      dot: 'var(--muted)',
      stale: false,
    };
  }
  if (p.state === 'posts') {
    return {
      text: p.source === 'schedule' ? 'Posts scheduled messages · can’t be messaged' : 'Webhook · posts when called · can’t be messaged',
      color: 'var(--muted)',
      dot: 'var(--muted)',
      stale: false,
    };
  }
  if (p.state === 'person') {
    const ago = shortTime(p.lastSeen, now);
    return {
      text: ago ? `Person · seen ${ago === 'now' ? 'just now' : `${ago} ago`}` : 'Person',
      color: 'var(--muted)',
      dot: 'var(--ok-fg)',
      stale: false,
    };
  }
  const seenMs = Date.parse(p.lastSeen);
  const hours = Number.isNaN(seenMs) ? 99 : (now - seenMs) / 3_600_000;
  const stale = hours >= 2;
  const ago = shortTime(p.lastSeen, now);
  return {
    text: ago ? `${stale ? 'Dozing' : 'Quiet'} · last seen ${ago === 'now' ? 'just now' : `${ago} ago`}` : 'Quiet',
    color: stale ? 'var(--warn-fg)' : 'var(--muted)',
    dot: 'var(--border-strong)',
    stale,
  };
}
