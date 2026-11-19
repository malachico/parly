'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * A submit button that shows a spinner while its form's action runs. Only the button you clicked spins, when a form
 * has several (Save, and each Disconnect). `confirm`: a destructive one asks first; the first click arms it and shows
 * this text, a second click submits, and leaving it (blur, Esc) disarms.
 */
export function PendingButton({ children, className, confirm, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { confirm?: string }) {
  const { pending } = useFormStatus();
  const [clicked, setClicked] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!pending) setClicked(false);
  }, [pending]);
  // Disarm on a press anywhere else or Esc. Not blur alone: Safari doesn't focus a clicked button, and touch has no Esc.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!armed) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setArmed(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setArmed(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [armed]);
  const busy = pending && clicked;
  return (
    <button
      {...props}
      ref={ref}
      onClick={(e) => {
        if (confirm && !armed) {
          e.preventDefault();
          setArmed(true);
          return;
        }
        setArmed(false);
        setClicked(true);
        props.onClick?.(e);
      }}
      onBlur={(e) => (setArmed(false), props.onBlur?.(e))}
      disabled={props.disabled || pending}
      aria-busy={busy}
      className={`inline-flex items-center justify-center gap-1.5 ${armed ? 'font-semibold' : ''} ${className ?? ''}`}
    >
      {busy && <span role="status" aria-label="Working" className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {armed ? confirm : children}
      {armed && <span className="sr-only" role="status">Click again to confirm</span>}
    </button>
  );
}
