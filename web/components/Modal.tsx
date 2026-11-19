'use client';

import { useEffect, useRef } from 'react';
import { Icon } from '@/components/Icon';

type DialogProps = {
  open: boolean;
  /** Called when the person closes it: Esc, the backdrop, or ✕. */
  onClose: () => void;
  title: string;
  /** Wider dialogs (Find) go full screen on phones. */
  wide?: boolean;
  children: React.ReactNode;
};

/** A native modal dialog driven by `open`. Esc, a backdrop click and ✕ call onClose. */
export function Dialog({ open, onClose, title, wide, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const size = wide
    ? 'm-0 h-dvh max-h-none w-full max-w-none sm:m-auto sm:h-[min(640px,88dvh)] sm:w-[min(600px,calc(100vw-32px))] sm:rounded-2xl'
    : 'm-auto w-[min(440px,calc(100vw-32px))] rounded-2xl';
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={() => isOpen.current && onClose()}
      onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation(); }}
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      className={`${size} border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--fg)] backdrop:bg-black/40 backdrop:backdrop-blur`}
    >
      <div className={`flex flex-col gap-4 p-5 sm:p-6 ${wide ? 'h-full min-h-0' : ''}`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="btn-ghost min-h-9 px-2.5">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
