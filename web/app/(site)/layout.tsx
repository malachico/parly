import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { Logo } from '@/components/Logo';
import { SignedInSwitch } from '@/components/SignedInSwitch';

/** Pages outside a conversation (account, pricing, docs, legal, sign-in steps): top header with logo + navigation back, a centered column and the footer. */
// ponytail: signed-in state is learned client-side (session cookie is httpOnly, no PPR here) so docs/legal stay static.
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell relative flex h-dvh min-h-0 overflow-hidden">
      <div id="site-scroll" className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
        <header className="mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-8">
          <Link href="/" className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-lg font-bold tracking-tight hover:bg-[var(--subtle)]">
            <Logo />
            <span>Parly</span>
          </Link>
          <nav aria-label="Site" className="flex items-center gap-1 text-sm sm:gap-3">
            <Link href="/pricing" className="rounded-lg px-2.5 py-1.5 text-[var(--fg-soft)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
              Pricing
            </Link>
            <Link href="/docs" className="rounded-lg px-2.5 py-1.5 text-[var(--fg-soft)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
              Docs
            </Link>
            <Link href="/blog" className="rounded-lg px-2.5 py-1.5 text-[var(--fg-soft)] hover:bg-[var(--subtle)] hover:text-[var(--fg)]">
              Blog
            </Link>
            <SignedInSwitch
              signedIn={
                <Link href="/" title="Back" aria-label="Back" className="btn size-9 justify-center p-0">
                  <Icon name="back" size={16} />
                </Link>
              }
              signedOut={
                <Link href="/login" className="btn-primary min-h-9 px-3.5 text-sm">
                  Sign in
                </Link>
              }
            />
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8 sm:py-10">{children}</main>
        <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] px-4 py-6 pb-[max(24px,env(safe-area-inset-bottom))] text-xs text-[var(--muted)] sm:px-8">
          <span>Use at your own risk.</span>
          <Link href="/pricing" className="link-quiet text-xs">
            Pricing
          </Link>
          <Link href="/docs" className="link-quiet text-xs">
            Docs
          </Link>
          <Link href="/blog" className="link-quiet text-xs">
            Blog
          </Link>
          <Link href="/terms" className="link-quiet text-xs">
            Terms of Use
          </Link>
          <Link href="/privacy" className="link-quiet text-xs">
            Privacy Policy
          </Link>
          <SignedInSwitch
            signedOut={
              <Link href="/login" className="link-quiet ml-auto text-xs">
                Sign in
              </Link>
            }
          />
        </footer>
      </div>
    </div>
  );
}
