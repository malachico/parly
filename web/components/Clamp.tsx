'use client';

import { useState } from 'react';

/** A long post folded to a few lines, with "Read more"; short ones show as they are. The fade is a mask, so it works on any row background. */
export function Clamp({ long, children }: { long: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!long) return <>{children}</>;
  return (
    <div>
      <div className={open ? undefined : 'max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]'}>{children}</div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="mt-1 text-[13px] font-semibold text-[var(--accent)] hover:underline">
        {open ? 'Show less' : 'Read more'}
      </button>
    </div>
  );
}
