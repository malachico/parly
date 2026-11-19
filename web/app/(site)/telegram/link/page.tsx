import Link from 'next/link';
import { ErrorNote, PageHeader } from '@/components/ui';
import { approveTelegramLink } from '@/lib/actions';
import { hub, HubError, hubOrLogin, loginHref, type Me, type TelegramLinkCodeView } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type Props = { searchParams: Promise<{ code?: string; done?: string; denied?: string; error?: string }> };

/**
 * One-time Telegram identity approval page (/telegram/link?code=…): opened from the link the Parly
 * Telegram bot sends when an unlinked Telegram user DMs `/start` or `@mentions` an agent in a linked group.
 */
export default async function LinkTelegramAccount({ searchParams }: Props) {
  const { code = '', done, denied, error } = await searchParams;
  const here = code ? `/telegram/link?code=${encodeURIComponent(code)}` : '/telegram/link';
  const user = await hubOrLogin<Me>('/me', { next: here });

  if (!user.email) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title="Connect your Telegram account" />
        <p className="card">
          Sign in with your Google account to link your Telegram identity.{' '}
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
        <PageHeader title="Telegram connected" />
        <p className="card">
          Your Telegram account (<span className="font-semibold">{done}</span>) is now connected to <span className="font-semibold">{user.name}</span>. Go back to
          Telegram and post your message.
        </p>
      </div>
    );
  }

  let info: TelegramLinkCodeView | undefined;
  let problem: string | undefined;
  if (!code) {
    problem = 'Open the one-time link the Parly bot sent you in Telegram, or generate a /start code from Account.';
  } else {
    try {
      info = await hub<TelegramLinkCodeView>(`/telegram/link?code=${encodeURIComponent(code)}`);
    } catch (err) {
      if (err instanceof HubError) problem = err.message;
      else throw err;
    }
  }

  if (!info) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title="This link has expired" />
        <p className="card">{problem ?? 'That link has expired or was already used: send /start to the Parly bot in Telegram for a new one.'}</p>
      </div>
    );
  }

  const label = info.telegramUserName
    ? `${info.telegramUserName}${info.telegramUsername ? ` (@${info.telegramUsername})` : ''} (${info.telegramUserId})`
    : info.telegramUsername
      ? `@${info.telegramUsername} (${info.telegramUserId})`
      : `Telegram user ${info.telegramUserId}`;

  return (
    <div className="mx-auto max-w-md space-y-6">
      <PageHeader title="Post from Telegram as you" sub="Connect your Telegram account to Parly." />
      <ErrorNote error={error} />
      <form action={approveTelegramLink} className="card space-y-4">
        <input type="hidden" name="code" value={code} />
        <p className="text-sm">
          Allow messages from <span className="font-semibold">{label}</span> in Telegram to be posted on Parly as{' '}
          <span className="font-semibold">{user.name}</span> ({user.email}).
        </p>
        <p className="text-xs text-[var(--muted)]">
          Only approve this if you just requested this link from the Parly Telegram bot. You can unlink your Telegram account any time on{' '}
          <Link href="/account" className="text-[var(--accent)] hover:underline">
            Account
          </Link>
          .
        </p>
        <div className="flex flex-wrap gap-2">
          <PendingButton name="answer" value="approve" className="btn-primary">
            Post from Telegram as you
          </PendingButton>
          <PendingButton name="answer" value="deny" className="btn-ghost" formNoValidate>
            Cancel
          </PendingButton>
        </div>
      </form>
    </div>
  );
}
