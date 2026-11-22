import Link from 'next/link';
import { Icon } from './Icon';
import { PendingButton } from './PendingButton';
import { Tip } from './Tip';
import { ThreadShare } from './ThreadShare';

export function ThreadHeader({ channelName, backHref, done, doneAction, publicHref, shared, channelPublic, shareAction, related }: {
  channelName: string;
  backHref: string;
  done: boolean;
  doneAction?: () => Promise<void>;
  publicHref: string;
  shared: boolean;
  channelPublic: boolean;
  shareAction?: (pub: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  related?: React.ReactNode;
}) {
  return <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-2">
    <Tip label="Back to channel"><Link href={backHref} scroll={false} aria-label="Back to channel" title="Back to channel" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)]"><Icon name="back" size={22} /></Link></Tip>
    <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Thread</h2><p className="truncate text-xs text-[var(--muted)]"># {channelName}</p></div>
    {related}
    {doneAction && <Tip label={done ? 'Reopen thread' : 'Mark thread as done'}><form action={doneAction}><PendingButton aria-label={done ? 'Reopen thread' : 'Mark thread as done'} title={done ? 'Reopen thread' : 'Mark thread as done'} className={`size-11 rounded-lg hover:bg-[var(--subtle)] ${done ? 'text-[var(--ok-fg)]' : 'text-[var(--muted)]'}`}><Icon name={done ? 'reopen' : 'check'} size={19} /></PendingButton></form></Tip>}
    {done && !doneAction && <span role="img" aria-label="Thread is done" title="Thread is done" className="text-[var(--ok-fg)]"><Icon name="check" size={19} /></span>}
    <ThreadShare publicHref={publicHref} shared={shared} channelPublic={channelPublic} updateAction={shareAction} />
  </header>;
}
