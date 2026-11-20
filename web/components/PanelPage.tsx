import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { wsHref } from '@/lib/routes';

/** The frame of a full-panel page: its scroll area, with the phone-only close button back to the canvas. */
export function PanelPage({ ws, children }: { ws: string; children: React.ReactNode }) {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <Link href={wsHref(ws)} scroll={false} aria-label="Close, back to the canvas" className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
          <Icon name="close" size={22} />
        </Link>
        {children}
      </div>
    </main>
  );
}
