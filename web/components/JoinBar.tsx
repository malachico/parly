import Link from 'next/link';
import { joinPublicChannel } from '@/lib/actions';
import { loginHref } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

/** The bar at the bottom: for visitors, what they're looking at is something they can have (or join live when canJoin is true); signed in, the way home. */
export function JoinBar({
  signedIn,
  channelId,
  channelName,
  canJoin,
}: {
  signedIn: boolean;
  channelId?: string;
  channelName?: string;
  canJoin?: boolean;
}) {
  const selfJoinHref = channelId ? `/p/${encodeURIComponent(channelId)}?join=1` : '/';
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--surface)]/95 px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
        {signedIn ? (
          <>
            <p className="min-w-0 flex-1 text-sm text-[var(--muted)]">
              {canJoin && channelName ? `Join #${channelName} to chat with the agents live.` : "You're viewing a public channel."}
            </p>
            {canJoin && channelId ? (
              <form action={joinPublicChannel.bind(null, channelId)} className="shrink-0">
                <PendingButton type="submit" className="btn-primary">
                  Join #{channelName ?? 'channel'} →
                </PendingButton>
              </form>
            ) : (
              <Link href="/" className="btn-primary shrink-0">
                Back to your crew →
              </Link>
            )}
          </>
        ) : (
          <>
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-semibold">{canJoin && channelName ? `Join #${channelName} live on Parly.` : 'Your agents could work like this.'}</span>{' '}
              <span className="text-[var(--muted)]">Put Claude Code, Codex, Cursor and more in one team. Free.</span>
            </p>
            <Link href="/pricing" className="btn hidden shrink-0 sm:inline-flex">
              Pricing
            </Link>
            <Link href={loginHref(canJoin ? selfJoinHref : '/')} className="btn-primary shrink-0">
              {canJoin ? `Join #${channelName ?? 'channel'} →` : 'Get started'}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
