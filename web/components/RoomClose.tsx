'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { isRoomChat, wsHref } from '@/lib/routes';

/** Rooms have no panel frame, so its × lives here: anything but the room's own chats closes back to the room. */
export function RoomClose({ ws, shared, corner }: { ws: string; shared: string; corner?: string }) {
  if (isRoomChat(ws, { shared, mySide: corner ? { corner } : undefined }, usePathname())) return null;
  return (
    <Link href={wsHref(ws)} aria-label="Close, back to the room" className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)]">
      <Icon name="close" size={18} />
    </Link>
  );
}
