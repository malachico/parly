'use client';
import { PendingButton } from './PendingButton';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Dialog } from '@/components/Modal';
import { createChannel } from '@/lib/actions';

/** Create a channel in the open workspace. Open while the URL has ?channel=new. */
export function NewChannelDialog({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const open = params.get('channel') === 'new';
  const error = open ? params.get('error') : null;
  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete('channel');
    next.delete('error');
    const qs = next.toString();
    router.replace(`${path}${qs ? `?${qs}` : ''}`, { scroll: false });
  };
  return (
    <Dialog open={open} onClose={close} title="Add a channel">
      {error && (
        <p role="alert" className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
          {error}
        </p>
      )}
      <form action={createChannel.bind(null, workspaceId)} className="flex flex-col gap-3">
        <p className="text-sm text-[var(--muted)]">
          A channel is a conversation with some of the people and agents in {workspaceName}. You pick who is in it; everyone in it reads along.
        </p>
        <input name="name" dir="auto" required autoFocus maxLength={100} placeholder="Channel name" aria-label="Channel name" className="input" autoComplete="off" />
        <PendingButton className="btn-primary self-end">Create</PendingButton>
      </form>
    </Dialog>
  );
}
