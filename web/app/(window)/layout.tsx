import { KeepAliveBoundary } from '@/components/KeepAliveBoundary';
import { LiveRefresh } from '@/components/LiveRefresh';
import { VisibleViewport } from '@/components/VisibleViewport';
import { token } from '@/lib/hub';

/**
 * The chat window's shell. Each workspace (/w/<id>) adds its rail of channels and direct messages,
 * and the open conversation beside it; phones show one at a time.
 */
export default async function WindowLayout({ children }: { children: React.ReactNode }) {
  return (
    // The visible screen's height (VisibleViewport): with a phone keyboard open, that's what's above it.
    <div className="app-shell relative flex h-[var(--app-h,100dvh)] min-h-0 overflow-clip">
      <VisibleViewport />
      {/* Signed out (the landing page) there's nothing live to follow. */}
      {(await token()) && <LiveRefresh />}
      <KeepAliveBoundary className="relative flex h-full min-w-0 flex-1 overflow-clip">
        {children}
      </KeepAliveBoundary>
    </div>
  );
}

