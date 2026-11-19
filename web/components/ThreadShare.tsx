'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { CopyButton } from './CopyButton';
import { Dialog } from './Modal';
import { Icon } from './Icon';
import { Tip } from './Tip';

export function ThreadShare({ publicHref, shared, channelPublic, updateAction }: {
  publicHref: string;
  shared: boolean;
  channelPublic: boolean;
  updateAction?: (pub: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [isPublic, setPublic] = useState(channelPublic || shared);
  const [url, setUrl] = useState(publicHref);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const explanation = useId();
  useEffect(() => setPublic(channelPublic || shared), [channelPublic, shared]);
  return (
    <>
      <Tip label="Share thread" align="end"><button type="button" aria-label="Share thread" title="Share thread" onClick={() => { setUrl(new URL(publicHref, window.location.origin).href); setOpen(true); }} className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)]"><Icon name="share" size={19} /></button></Tip>
      <Dialog open={open} onClose={() => setOpen(false)} title="Share thread">
        <label className="flex min-h-11 items-center justify-between gap-4 font-medium">
          Public
          <span className="relative inline-flex h-6 w-10 shrink-0"><input type="checkbox" role="switch" className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" aria-describedby={explanation} checked={channelPublic || isPublic} disabled={pending || channelPublic || !updateAction} onChange={(e) => {
            const next = e.currentTarget.checked;
            setError('');
            startTransition(async () => {
              try {
                const result = await updateAction!(next);
                if (result.ok) setPublic(next);
                else setError(result.error);
              } catch {
                setError('Sharing could not be saved. Try again.');
              }
            });
          }} /><span aria-hidden="true" className="pointer-events-none h-6 w-10 rounded-full bg-[var(--border)] after:absolute after:top-1 after:left-1 after:size-4 after:rounded-full after:bg-[var(--surface)] after:transition-transform peer-checked:bg-[var(--accent)] peer-checked:after:translate-x-4 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)] peer-disabled:opacity-50" /></span>
        </label>
        <p id={explanation} className="text-sm text-[var(--muted)]">Anyone with the link can read this thread and its files without signing in. The rest of a private channel stays private.</p>
        {channelPublic ? <p className="text-sm text-[var(--muted)]">This channel is public. Change its visibility in channel settings.</p> : !updateAction && <p className="text-sm text-[var(--muted)]">Only a channel owner can change sharing.</p>}
        {pending && <p role="status" className="text-sm text-[var(--muted)]">Saving sharing…</p>}
        {error && <p role="alert" className="text-sm text-[var(--bad-fg)]">{error}</p>}
        {(channelPublic || isPublic) && !pending && <div className="flex min-w-0 items-center gap-2"><input readOnly aria-label="Public thread link" value={url} className="min-w-0 flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm" /><CopyButton value={url} label="Copy link" /></div>}
      </Dialog>
    </>
  );
}
