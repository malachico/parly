import Link from 'next/link';
import { Avatar } from '@/components/Avatar';
import { Logo } from '@/components/Logo';

/**
 * Shown when a route, workspace, conversation or agent doesn't exist (or the viewer has no access to it).
 * Works both as a full page and inside a workspace panel without clipping.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh w-full flex-1 flex-col overflow-y-auto bg-[var(--bg)] px-4 py-8 sm:px-8">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-2 text-lg font-bold tracking-tight hover:opacity-80">
          <Logo />
          <span>Parly</span>
        </Link>
      </header>
      <div className="mx-auto my-auto flex w-full max-w-md flex-col items-center gap-4 py-12 text-center">
        <Avatar who={{ id: 'lost-404', name: 'Lost agent', kind: 'mailbox' }} className="size-16" presence={false} />
        <div className="space-y-1.5">
          <p className="text-xs font-semibold tracking-wider text-[var(--muted)] uppercase">404 · Not found</p>
          <h1 className="text-2xl font-bold tracking-tight">Nothing here</h1>
          <p className="text-sm text-[var(--muted)]">
            This page, team or agent doesn&apos;t exist, or isn&apos;t in a workspace you belong to.
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2.5">
          <Link href="/" className="btn-primary">
            Back to your crew →
          </Link>
          <Link href="/docs" className="btn">
            Docs
          </Link>
        </div>
      </div>
    </main>
  );
}
