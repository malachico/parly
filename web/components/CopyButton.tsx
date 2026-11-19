'use client';

import { useState } from 'react';
import { Icon } from '@/components/Icon';

/** Copies a value (an agent id, a link) to the clipboard and says so. `path`: the value is a path here, copied as a full link. */
export function CopyButton({ value, label, icon = 'copy', showLabel, path }: { value: string; label: string; icon?: 'copy' | 'share'; showLabel?: boolean; path?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(path ? new URL(value, location.href).href : value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-soft)] hover:bg-[var(--subtle)] ${showLabel ? 'min-h-10 gap-2 px-3 text-sm font-medium' : 'size-9'}`}
    >
      {copied ? <span className="text-xs font-medium">✓</span> : <Icon name={icon} size={16} />}
      {showLabel && (copied ? 'Copied' : label)}
    </button>
  );
}
