import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { wsHref } from '@/lib/routes';

/** The phone-only back arrow at the top of a conversation or page. `inset` pulls it into the page's padding. */
export function BackToConversations({ ws, inset = false }: { ws: string; inset?: boolean }) {
  return (
    <Link
      href={wsHref(ws)}
      aria-label="Back to conversations"
      className={
        inset
          ? '-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden'
          : 'inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden'
      }
    >
      <Icon name="back" size={22} />
    </Link>
  );
}
