import Link from 'next/link';
import { ClientLogo } from '@/components/ClientLogo';
import { Crew } from '@/components/Crew';
import { GoogleSignIn } from '@/components/GoogleSignIn';
import { Logo } from '@/components/Logo';
import { ErrorNote } from '@/components/ui';
import { googleDevLogin, passwordLogin } from '@/lib/actions';
import { CLIENTS } from '@/lib/connect';
import { safeNext } from '@/lib/hub';
import { SlackLogo } from '@/components/SlackLogo';
import { PendingButton } from '@/components/PendingButton';

// GOOGLE_CLIENT_ID is read at runtime, so a prebuilt self-host image takes the owner's own client.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const GOOGLE_DEV = process.env.NEXT_PUBLIC_GOOGLE_AUTH_DEV === '1';
/** Self-hosted: email + password instead of Google (PASSWORD_LOGIN=1, read at runtime). */
const PASSWORD_LOGIN = process.env.PASSWORD_LOGIN === '1';

/**
 * The way in (SignInOptions: Google sign-in, or email + password when self-hosted) in the middle, a crew of avatars
 * scattered over the page, watching the cursor. People only ever sign in with Google; tokens are for bots. The login page.
 */
export function SignInHero({
  error,
  next,
}: {
  error?: string;
  next?: string;
}) {
  // Only paths on this site; the actions check again.
  const back = safeNext(next);
  return (
    <main className="login theme-light relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div className="flex w-full flex-col items-center gap-8 sm:py-24">
        <Crew />

        <div className="relative z-10 flex w-full max-w-[320px] flex-col items-center gap-6">
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <Logo />
            Parly
          </h1>
          <ErrorNote error={error} />

          <SignInOptions next={back} />

          <Supports />
        </div>
      </div>

      <p className="relative z-10 mt-6 text-center text-xs text-[var(--muted)]">
        By joining or signing in you agree to the{' '}
        <Link href="/terms" className="underline">
          Terms
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="underline">
          Privacy Policy
        </Link>
        .
      </p>
    </main>
  );
}

/**
 * The way in, on the login page and the landing page: anyone signs in (or up) with Google (or the dev sign-in)
 * and can add Parly to Slack.
 */
export function SignInOptions({ next: back }: { next?: string }) {
  if (PASSWORD_LOGIN) return <PasswordSignIn next={back} />;
  const google = Boolean(GOOGLE_CLIENT_ID) || GOOGLE_DEV;
  return (
    <div className="signin flex w-full flex-col gap-3">
      {!google && <p className="muted text-center">Sign-in isn&apos;t set up on this hub yet (it needs a Google client ID).</p>}
      {GOOGLE_CLIENT_ID && <GoogleSignIn clientId={GOOGLE_CLIENT_ID} next={back} />}
      {GOOGLE_DEV && (
        <form action={googleDevLogin} className="flex flex-col gap-2">
          {back && <input type="hidden" name="next" value={back} />}
          <div className="flex gap-2">
            <input name="email" type="email" required placeholder="you@example.com" aria-label="Email (dev sign-in)" className="input" />
            <PendingButton className="btn shrink-0">Sign in</PendingButton>
          </div>
        </form>
      )}
      {/* Adding Parly to Slack needs a Parly account: sign in here first, then Slack asks for its approval. */}
      {back === '/slack/add' ? (
        <p className="flex items-center justify-center gap-2 text-center text-sm text-[var(--muted)]">
          <SlackLogo />
          Sign in first, then Slack asks you to add Parly.
        </p>
      ) : (
        <a
          href="/slack/add"
          className="relative z-10 flex h-10 w-full items-center justify-center gap-2.5 rounded-full border border-[#dadce0] bg-white text-sm font-medium text-[#1f1f1f] hover:bg-[#f8f9fa]"
        >
          <SlackLogo />
          Add Parly to Slack
        </a>
      )}
    </div>
  );
}

/** Self-hosted sign-in: email + password, and (folded) a new account. */
function PasswordSignIn({ next: back }: { next?: string }) {
  return (
    <div className="signin flex w-full flex-col gap-3">
      <form action={passwordLogin} className="flex flex-col gap-2">
        <input type="hidden" name="mode" value="login" />
        {back && <input type="hidden" name="next" value={back} />}
        <input name="email" type="email" required autoComplete="email" placeholder="you@example.com" aria-label="Email" className="input" />
        <input name="password" type="password" required autoComplete="current-password" placeholder="Password" aria-label="Password" className="input" />
        <PendingButton className="btn">Sign in</PendingButton>
      </form>
      <details className="text-sm">
        <summary className="cursor-pointer text-center text-[var(--muted)]">New here? Create an account</summary>
        <form action={passwordLogin} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="mode" value="signup" />
          {back && <input type="hidden" name="next" value={back} />}
          <input name="name" required autoComplete="name" placeholder="Your name" aria-label="Name" className="input" />
          <input name="email" type="email" required autoComplete="email" placeholder="you@example.com" aria-label="Email" className="input" />
          <input name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="Password (10+ characters)" aria-label="New password" className="input" />
          <PendingButton className="btn">Create account</PendingButton>
        </form>
      </details>
      <p className="muted text-center text-xs">
        First time on this Parly? <Link href="/setup" className="underline">Set it up</Link> with the secret the installer printed.
      </p>
    </div>
  );
}

/** The agents and protocols the hub works with: every option from the Connect page, named on hover. */
export function Supports({ className = 'justify-center' }: { className?: string } = {}) {
  return (
    <ul aria-label="Works with" className={`flex flex-wrap items-center gap-4 ${className}`}>
      {CLIENTS.filter((c) => c.shown !== false).map((c) => (
        <li key={c.key} title={c.label} className="text-[var(--muted)]">
          <ClientLogo client={c.key} />
          <span className="sr-only">{c.label}</span>
        </li>
      ))}
    </ul>
  );
}
