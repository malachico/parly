import Link from 'next/link';
import { avatarArt, type AvatarShape } from '@/lib/avatar';
import type { Agent } from '@/lib/hub';

/** Who an avatar is for: the seed falls back to the id, so anyone can be drawn. Unknown kinds draw as bots. */
export type AvatarOf = {
  id: string;
  name?: string;
  avatar?: string;
  kind?: Agent['kind'] | string;
  /** Their role in this channel, if any. */
  role?: string;
  /** An incoming webhook: drawn with a badge. */
  webhookChannel?: string;
  /** A channel's Scheduled bot: a clock instead. */
  scheduler?: boolean;
  /** Parly runs it: a cloud agent (a cloud mark) or one with its own computer (a screen mark). */
  cloud?: boolean;
  hosted?: boolean;
  /** Mailbox agents: a wait is open right now, or a Routine/webhook wakes them on a message. */
  listening?: boolean;
  wakes?: boolean;
  /** Endpoint or owned bots: whether they are online right now. */
  online?: boolean;
  /** The canvas's presence: read the same as listening/wakes above. */
  presence?: { state: string };
};

/** Avatars by agent id, for a page's messages and rows; anyone missing is drawn from their id. */
export type People = Record<string, AvatarOf>;

/**
 * An agent's generated avatar, in the hand-drawn style of the logo: a round face for people, a little
 * creature like the login crew for bots. Size it with a class (`size-9`). `halo` paints a ring of
 * that color round the outline, for avatars that overlap in a stack. Every mark is part of the avatar
 * and drawn wherever it is: what it is (cloud, computer, webhook, schedule) top right, and on bots its
 * presence bottom right (green when online/listening, a "z" when it sleeps until a message wakes it, gray
 * when offline). `presence={false}` only for decorative avatars that aren't a real agent.
 */
export function Avatar({
  who,
  className = 'size-9',
  halo,
  label,
  presence = true,
  trigger = false,
}: {
  who: AvatarOf;
  className?: string;
  halo?: string;
  label?: string;
  presence?: boolean;
  /** Posted automatically as them (a reminder): a clock bottom right, in place of presence. */
  trigger?: boolean;
}) {
  if (trigger) label ??= 'Automated reminder';
  const art = avatarArt(who.avatar ?? who.id, who.kind === 'human' ? 'human' : 'bot');
  const tint = `var(--av-${art.tint})`;
  // What it is goes top right, presence bottom right, so neither hides the other.
  // A person never gets a bot's mark: their account's `cloud` flag is feature access, not where they run.
  const runs = who.kind === 'human' || who.webhookChannel ? undefined : who.cloud ? 'cloud' : who.hosted ? 'computer' : undefined;
  const state = who.presence?.state;
  const isOnline = Boolean(who.online || who.listening || state === 'listening');
  const isWake = !isOnline && Boolean(who.wakes || state === 'wakes');
  const showPresence = Boolean(!trigger && presence && who.kind && who.kind !== 'human' && !who.webhookChannel && (who.kind !== 'endpoint' || who.online !== undefined || state));
  return (
    <svg
      viewBox="0 0 40 40"
      className={`shrink-0 overflow-visible ${className}`}
      fill="none"
      stroke="var(--avatar-ink)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {halo && [art.fill, ...art.behind.map((s) => s.d)].map((d, i) => <path key={i} d={d} stroke={halo} strokeWidth={6} />)}
      {art.behind.map((s, i) => (
        <Shape key={i} shape={s} tint={tint} />
      ))}
      <path d={art.fill} fill={art.skin ?? tint} stroke="none" />
      <path d={art.outline} />
      {art.shapes.map((s, i) => (
        <Shape key={i} shape={s} tint={tint} />
      ))}
      <g transform="translate(0 -26)">
      {who.webhookChannel && (
        // An incoming webhook: a lightning badge, top right (a clock for scheduled messages).
        <g>
          <circle cx={33} cy={33} r={7.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
          {who.scheduler ? (
            // A clock: a scheduled message.
            <path d="M33 29.5V33l2.4 1.6" stroke="#fff" strokeWidth={1.6} fill="none" />
          ) : (
            <path d="M34.2 28 30 33.6h3.2L32 38l4.4-5.8h-3.3Z" fill="#fff" stroke="none" />
          )}
        </g>
      )}
      {runs && (
        <g>
          <title>{runs === 'cloud' ? 'Cloud agent: thinks and writes, no computer' : 'Has its own computer: runs code, browses, keeps files'}</title>
          <circle cx={33} cy={33} r={7.5} fill={runs === 'cloud' ? '#0284c7' : '#17161c'} stroke="var(--surface)" strokeWidth={2} />
          {runs === 'cloud' ? (
            // A cloud.
            <path d="M30.2 35.6h5.9a2 2 0 0 0 .3-4 2.8 2.8 0 0 0-5.4-.6 1.9 1.9 0 0 0-.8 4.6Z" fill="#fff" stroke="none" />
          ) : (
            // A screen on a stand.
            <>
              <rect x={29.3} y={29.6} width={7.4} height={5} rx={0.8} fill="#fff" stroke="none" />
              <path d="M31.4 36.6h3.2M33 34.6v2" stroke="#fff" strokeWidth={1.2} />
            </>
          )}
        </g>
      )}
      </g>
      {trigger && (
        <g>
          <title>Automated reminder</title>
          <circle cx={33} cy={33} r={6.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
          <path d="M33 30.2V33l2 1.3" stroke="#fff" strokeWidth={1.5} fill="none" />
        </g>
      )}
      {showPresence && (
        <g>
          {isWake ? (
            <>
              <title>Asleep: a message wakes it</title>
              <circle cx={33} cy={33} r={6.5} fill="var(--muted)" stroke="var(--surface)" strokeWidth={2} />
              <path d="M30.8 30.8h4.4l-4.4 4.4h4.4" stroke="#fff" strokeWidth={1.5} fill="none" />
            </>
          ) : (
            <>
              <title>{isOnline ? (who.listening ? 'Listening now' : 'Online') : 'Offline'}</title>
              <circle cx={33.5} cy={33.5} r={5.2} fill={isOnline ? 'var(--ok-fg)' : 'var(--border-strong)'} stroke="var(--surface)" strokeWidth={2.2} />
            </>
          )}
        </g>
      )}
    </svg>
  );
}

const FILLS: Record<NonNullable<AvatarShape['fill']>, { fill?: string; stroke?: string; opacity?: number }> = {
  tint: {},
  white: { fill: '#fff' },
  ink: { fill: 'var(--avatar-ink)', stroke: 'none' },
  shine: { fill: '#fff', stroke: 'none' },
  blush: { fill: '#f2a7b0', stroke: 'none', opacity: 0.6 },
};

function Shape({ shape, tint }: { shape: AvatarShape; tint: string }) {
  const look = shape.fill ? FILLS[shape.fill] : {};
  return <path d={shape.d} fill={shape.color ?? (shape.fill === 'tint' ? tint : look.fill)} stroke={look.stroke} opacity={look.opacity} strokeWidth={shape.width} />;
}

/** Overlapping avatars for a group, with "+N" past `max`. */
export function AvatarStack({
  people,
  max = 5,
  className = 'size-7',
  halo = 'var(--surface)',
  hrefOf,
  presence = true,
}: {
  people: (AvatarOf & { name?: string })[];
  max?: number;
  className?: string;
  halo?: string;
  hrefOf?: (who: AvatarOf) => string | undefined;
  presence?: boolean;
}) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className="isolate flex items-center -space-x-1.5">
      {shown.map((p, i) => {
        const href = hrefOf?.(p);
        // Earlier avatars sit in front, so the next one never covers their right-edge badges.
        const z = { zIndex: shown.length - i };
        return href ? (
          <Link key={p.id} href={href} title={p.name ? `Message ${p.name}` : undefined} aria-label={p.name ? `Message ${p.name}` : undefined} className="relative flex rounded-full" style={z}>
            <Avatar who={p} className={className} halo={halo} presence={presence} />
          </Link>
        ) : (
          <span key={p.id} title={p.name} className="relative flex" style={z}>
            <Avatar who={p} className={className} halo={halo} presence={presence} />
          </span>
        );
      })}
      {more > 0 && <span className="pl-2.5 text-xs font-medium text-[var(--muted)]">+{more}</span>}
    </span>
  );
}
