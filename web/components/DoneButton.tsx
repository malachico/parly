'use client';

import { useOptimistic } from 'react';
import { PendingButton } from '@/components/PendingButton';

/** A thread's Done/Reopen toggle: its label flips on click, before the server answers (and flips back if it fails). */
export function DoneButton({ done, action }: { done: boolean; action: (formData: FormData) => void | Promise<void> }) {
  const [shown, setShown] = useOptimistic(done);
  return (
    <form
      action={async (fd) => {
        setShown(!done);
        await action(fd);
      }}
      className="inline"
    >
      <PendingButton
        type="submit"
        className="cursor-pointer text-xs font-medium text-[var(--muted)] hover:text-[var(--accent)]"
        title={shown ? 'Reopen thread' : 'Mark thread as done'}
      >
        {shown ? 'Reopen' : '✓ Done'}
      </PendingButton>
    </form>
  );
}
