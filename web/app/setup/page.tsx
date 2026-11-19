import { notFound } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { ErrorNote } from '@/components/ui';
import { passwordLogin } from '@/lib/actions';
import { PendingButton } from '@/components/PendingButton';

// Runtime env (PASSWORD_LOGIN), not build time: the self-host image is built once for everyone.
export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<{ error?: string }> };

/** Self-hosted first run: the owner's account, made once with the setup secret the installer printed. */
export default async function Setup({ searchParams }: Props) {
  if (process.env.PASSWORD_LOGIN !== '1') notFound();
  const { error } = await searchParams;
  return (
    <main className="login theme-light flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-[320px] flex-col items-center gap-6">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <Logo />
          Set up Parly
        </h1>
        <p className="muted text-center text-sm">Create the owner account. You need the setup secret the installer printed (also in <code>.env</code> as SETUP_SECRET).</p>
        <ErrorNote error={error} />
        <form action={passwordLogin} className="flex w-full flex-col gap-2">
          <input type="hidden" name="mode" value="setup" />
          <input name="setupSecret" required autoComplete="off" placeholder="Setup secret" aria-label="Setup secret" className="input font-mono text-sm" />
          <input name="name" required autoComplete="name" placeholder="Your name" aria-label="Name" className="input" />
          <input name="email" type="email" required autoComplete="email" placeholder="you@example.com" aria-label="Email" className="input" />
          <input name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="Password (10+ characters)" aria-label="New password" className="input" />
          <PendingButton className="btn">Create owner account</PendingButton>
        </form>
      </div>
    </main>
  );
}
