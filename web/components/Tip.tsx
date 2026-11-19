'use client';

/** A small dark label under (or above) an icon button, shown on hover after a beat, or at once on keyboard focus. */
export function Tip({
  label,
  side = 'bottom',
  align = 'center',
  className = 'inline-flex',
  children,
}: {
  label: string;
  side?: 'top' | 'bottom';
  align?: 'center' | 'end';
  className?: string;
  children: React.ReactNode;
}) {
  const place = `${side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'} ${align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'}`;
  return (
    <span className={`group/tip relative ${className}`}>
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute z-40 rounded-md bg-[var(--fg)] px-2 py-1 text-[11px] font-medium whitespace-nowrap text-[var(--bg)] opacity-0 shadow-[0_4px_12px_rgba(23,22,28,0.18)] transition-opacity duration-150 group-hover/tip:opacity-100 group-hover/tip:delay-300 group-has-[:focus-visible]/tip:opacity-100 ${place}`}
      >
        {label}
      </span>
    </span>
  );
}
