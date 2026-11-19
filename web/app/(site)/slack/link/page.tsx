import Link from 'next/link';
import { ErrorNote, PageHeader } from '@/components/ui';
import { approveSlackLink } from '@/lib/actions';
import { hub, HubError, hubOrLogin, loginHref, type Me, type SlackLinkCodeView } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type Props = { searchParams: Promise<{ code?: string; done?: string; denied?: string; error?: string }> };

/**
 * One-time Slack identity approval page (/slack/link?code=…): opened from the ephemeral prompt the Parly
 * Slack app posts when an unlinked Slack user writes in a mirrored channel. Email is a hint ("this looks
 * like you"), never the authorization: the person must sign in with Google and click Approve.
 */
export default async function LinkSlackAccount({ searchParams }: Props) {
  const { code = '', done, denied, error } = await searchParams;
  const here = code ? `/slack/link?code=${encodeURIComponent(code)}` : '/slack/link';
  const user = await hubOrLogin<Me>('/me', { next: here });

  if (!user.email) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title="Connect your Slack account" />
        <p className="card">
          Sign in with your Google account to link your Slack identity.{' '}
          <Link href={loginHref(here)} className="text-[var(--accent)] hover:underline">
            Sign in with Google
          </Link>{' '}
          to continue.
        </p>
      </div>
    );
  }

  if (denied) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title="Not connected" />
        <p className="card">You cancelled the link. Nothing was connected.</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title="Slack connected" />
        <p className="card">
          Your Slack account in <span className="font-semibold">{done}</span> is now connected to <span className="font-semibold">{user.name}</span>. Go back to
          Slack and post your message again.
        </p>
      </div>
    );
  }

  let info: SlackLinkCodeView | undefined;
  let problem: string | undefined;
  if (!code) {
    problem = 'Open the one-time link the Parly app sent you in Slack.';
  } else {
    try {
      info = await hub<SlackLinkCodeView>(`/slack/link?code=${encodeURIComponent(code)}`);
    } catch (err) {
      if (err instanceof HubError) problem = err.message;
      else throw err;
    }
  }

  if (!info) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title="This link has expired" />
        <p className="card">{problem ?? 'That link has expired or was already used: write in Slack again for a new one.'}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <PageHeader title="Post from Slack as you" sub={`Connect your Slack account in ${info.teamName} to Parly.`} />
      <ErrorNote error={error} />
      <form action={approveSlackLink} className="card space-y-4">
        <input type="hidden" name="code" value={code} />
        <p className="text-sm">
          Allow messages from{' '}
          <span className="font-semibold">
            {info.slackUserName ? `${info.slackUserName} (${info.slackUserId})` : `Slack user ${info.slackUserId}`}
          </span>{' '}
          in <span className="font-semibold">{info.teamName}</span> to be posted on Parly as <span className="font-semibold">{user.name}</span> ({user.email}).
        </p>
        {info.emailMatches && (
          <p className="rounded-lg border border-[var(--accent)] bg-[var(--subtle)] px-3 py-2 text-[13px]">
            Your Slack email (<span className="font-mono">{info.slackEmail}</span>) matches your Parly email — this looks like you.
          </p>
        )}
        {!info.emailMatches && info.slackEmail && (
          <p className="text-[13px] text-[var(--muted)]">
            Slack email: <span className="font-mono">{info.slackEmail}</span> (signed in on Parly as <span className="font-mono">{user.email}</span>).
          </p>
        )}
        <p className="text-xs text-[var(--muted)]">
          Only approve this if you just wrote a message in Slack and clicked the private link from the Parly app. You can unlink your Slack account any time on{' '}
          <Link href="/account" className="text-[var(--accent)] hover:underline">
            Account
          </Link>
          .
        </p>
        <div className="flex flex-wrap gap-2">
          <PendingButton name="answer" value="approve" className="btn-primary">
            Post from Slack as you
          </PendingButton>
          <PendingButton name="answer" value="deny" className="btn-ghost" formNoValidate>
            Cancel
          </PendingButton>
        </div>
      </form>
    </div>
  );
}
