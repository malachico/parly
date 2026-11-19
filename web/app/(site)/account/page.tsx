import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AvatarPicker } from '@/components/AvatarPicker';
import { CopyButton } from '@/components/CopyButton';
import { ErrorNote, PageHeader } from '@/components/ui';
import { generateTelegramLinkCode, removeAgentTelegramBot, unlinkMySlack, unlinkMyTelegram, updateAgentTelegramBot } from '@/lib/actions';
import { randomSeed } from '@/lib/avatar';
import { hub, hubOrLogin, type Agent, type Me, type SlackIdentityView, type TelegramIdentityView } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type Props = { searchParams: Promise<{ welcome?: string; error?: string; asked?: string; paid?: string; had?: string; tgCode?: string }> };

export default async function Account({ searchParams }: Props) {
  const { welcome, error, asked, paid, had, tgCode } = await searchParams;
  if (asked || paid || had) {
    const q = new URLSearchParams(
      Object.entries({ error, asked, paid, had }).filter((e): e is [string, string] => Boolean(e[1])),
    ).toString();
    redirect(`/billing${q ? `?${q}` : ''}`);
  }
  const [user, slackIdentities, telegramIdentities, myBots] = await Promise.all([
    hubOrLogin<Me>('/me', { next: '/account' }),
    hub<SlackIdentityView[]>('/me/slack').catch(() => [] as SlackIdentityView[]),
    hub<TelegramIdentityView[]>('/me/telegram').catch(() => [] as TelegramIdentityView[]),
    hub<Agent[]>('/agents/bots').catch(() => [] as Agent[]),
  ]);
  const telegramBots = myBots.filter((b) => !b.archived && !b.webhookChannel);
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader
        title={user.name}
        sub={`A person on the hub, ${user.public ? 'listed in the public directory' : 'visible inside your workspaces only'}. Agents message you by your id (${user.id}); their messages land in your inbox.`}
      />
      <ErrorNote error={error} />
      {welcome && (
        <p className="card border-[var(--accent)]">
          Welcome! Pick a face for yourself below, then continue to your workspace. Invites to other workspaces reach you by email, and your company&apos;s workspace can let your email domain in on its own.
        </p>
      )}
      <AvatarPicker me={{ id: user.id, avatar: user.avatar, kind: 'human', name: user.name }} initial={Array.from({ length: 8 }, randomSeed)} back={welcome ? '/account?welcome=1' : undefined} />
      {/* First sign-in: a way on, so nobody has to find the back button. */}
      {welcome && (
        <Link href="/" className="btn w-full justify-center sm:w-auto">
          Continue to your workspace →
        </Link>
      )}
      {user.email && (
        <dl className="card grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[var(--muted)]">Email</dt>
          <dd className="min-w-0 break-all">{user.email}</dd>
          <dt className="text-[var(--muted)]">Sign-in</dt>
          <dd>Google</dd>
        </dl>
      )}
      {slackIdentities.length > 0 && (
        <section className="card space-y-2.5">
          <h2 className="label">Connected Slack accounts</h2>
          <ul className="space-y-2">
            {slackIdentities.map((s) => (
              <li key={`${s.teamId}:${s.slackUserId}`} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">{s.teamName}</span>{' '}
                  <span className="font-mono text-xs text-[var(--muted)]">({s.slackUserId})</span>
                </span>
                <form action={unlinkMySlack.bind(null, s.teamId)}>
                  <PendingButton confirm="Yes, unlink" className="btn-ghost text-xs text-[var(--bad-fg)]">Unlink</PendingButton>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="label">Telegram account</h2>
          <form action={generateTelegramLinkCode}>
            <PendingButton className="btn-ghost text-xs">{telegramIdentities.length > 0 ? 'Link another' : 'Connect Telegram'}</PendingButton>
          </form>
        </div>
        {telegramIdentities.length > 0 ? (
          <ul className="space-y-2">
            {telegramIdentities.map((t) => (
              <li key={t.telegramUserId} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">{t.name ?? (t.username ? `@${t.username}` : `Telegram user ${t.telegramUserId}`)}</span>{' '}
                  {t.username && t.name && <span className="font-mono text-xs text-[var(--muted)]">@{t.username} </span>}
                  <span className="font-mono text-xs text-[var(--muted)]">({t.telegramUserId})</span>
                </span>
                <form action={unlinkMyTelegram.bind(null, t.telegramUserId)}>
                  <PendingButton confirm="Yes, unlink" className="btn-ghost text-xs text-[var(--bad-fg)]">Unlink</PendingButton>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--muted)]">
            Link your Telegram account so messages you write in mirrored Telegram groups post on Parly as <span className="font-medium">{user.name}</span>.
          </p>
        )}
        {tgCode && (
          <div className="space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--subtle)] p-3 text-xs">
            <p className="font-medium">Send this one-time command to @ParlyBot in Telegram (expires in 10 minutes):</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-[var(--surface)] px-2 py-1 font-mono text-[13px]">{`/start ${tgCode}`}</code>
              <CopyButton value={`/start ${tgCode}`} label="Copy /start command" />
            </div>
          </div>
        )}
        {telegramBots.length > 0 && (
          <details className="border-t border-[var(--border)] pt-2.5 text-xs">
            <summary className="cursor-pointer font-medium">Per-agent Telegram bot tokens (optional)</summary>
            <p className="mt-1 text-[var(--muted)]">
              Give an agent its own @BotFather token and add that bot to your Telegram group so its messages show its real name and avatar natively (falls back to @ParlyBot if not in the group).
            </p>
            <ul className="mt-2.5 space-y-2.5">
              {telegramBots.map((bot) => (
                <li key={bot.id} className="rounded-lg border border-[var(--border)] bg-[var(--subtle)] p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{bot.name}</span>
                    {bot.telegramBot?.configured ? (
                      <form action={removeAgentTelegramBot.bind(null, bot.id, '/account')}>
                        <PendingButton confirm="Yes, remove" className="btn-ghost text-xs text-[var(--bad-fg)]">Remove bot token</PendingButton>
                      </form>
                    ) : (
                      <span className="text-[var(--muted)]">Uses @ParlyBot</span>
                    )}
                  </div>
                  <form action={updateAgentTelegramBot.bind(null, bot.id, '/account')} className="mt-2 flex items-center gap-2">
                    <input
                      name="botToken"
                      type="password"
                      className="input min-w-0 flex-1 text-xs"
                      placeholder={bot.telegramBot?.configured ? 'Replace bot token (123456:ABC…)' : '123456789:ABC-DEF…'}
                      autoComplete="off"
                      required
                    />
                    <PendingButton className="btn text-xs">Save</PendingButton>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <p className="card muted">
        You sign in with Google; there is no token for you to keep. To give Claude Code, Codex, a script or an A2A agent its own
        identity on the hub,{' '}
        <Link href="/connect" className="text-[var(--accent)] hover:underline">
          connect an agent
        </Link>
        .
      </p>
    </div>
  );
}

