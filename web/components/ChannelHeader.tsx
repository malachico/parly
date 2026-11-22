import Link from 'next/link';
import { Icon } from './Icon';
import type { Channel } from '../lib/hub';
import { chatHref } from '../lib/routes';

/** Channel controls share one row; the title yields space before any action does. `tabs` take the title's place: a room's two chats read as one room, not as channels. */
export function ChannelHeader({ ws, conversationKey, name, description, channel, peopleCount, botCount, thread, panel, document, tabs }: {
  ws: string;
  conversationKey: string;
  name: string;
  description: string;
  channel?: Pick<Channel, 'id' | 'public'>;
  peopleCount: number;
  botCount: number;
  thread?: string;
  panel?: string;
  document: boolean;
  tabs?: React.ReactNode;
}) {
  const control = 'inline-flex h-11 min-w-9 shrink-0 items-center justify-center gap-1 rounded-[9px] px-1.5 text-xs text-[var(--muted)] hover:bg-[var(--subtle)] hover:text-[var(--fg)] sm:h-9 sm:px-2';
  const settingsHref = chatHref(ws, conversationKey, { panel: 'channel', section: 'settings' });
  return (
    <>
      {tabs ? <div className="min-w-0 flex-1"><h1 className="sr-only">{name}</h1>{tabs}</div> : <div className="min-w-0 flex-1" title={description}>
        <h1 className="flex min-w-0 items-center gap-1 text-[15px] font-semibold">
          <Link href={chatHref(ws, conversationKey, { thread, panel: panel === 'channel' ? undefined : 'channel' })} scroll={false} aria-label={`${name}: ${panel === 'channel' ? 'close' : 'open'} channel details`} className="inline-flex h-11 min-w-0 items-center gap-1 rounded-[9px] hover:bg-[var(--subtle)] sm:h-9"><span className="font-normal text-[var(--muted)]">#</span><span className="truncate">{name}</span></Link>
          {channel?.public && <span role="img" aria-label="Public channel: anyone can read" title="Public channel: anyone can read" className="shrink-0 text-[var(--muted)]"><Icon name="globe" size={14} /></span>}
        </h1>
        <p className="hidden truncate text-xs text-[var(--muted)] sm:block">{description}</p>
      </div>}
      <nav aria-label="Channel controls" className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <span className="inline-flex shrink-0 items-center gap-1 px-1 text-xs text-[var(--muted)]" role="img" aria-label={`${peopleCount} people`} title={`${peopleCount} people`}><Icon name="person" size={16} /><span className="tabular-nums">{peopleCount}</span></span>
        <span className="inline-flex shrink-0 items-center gap-1 px-1 text-xs text-[var(--muted)]" role="img" aria-label={`${botCount} bots`} title={`${botCount} bots`}><Icon name="bot" size={16} /><span className="tabular-nums">{botCount}</span></span>
        {document && <Link href={chatHref(ws, conversationKey, { panel: 'doc' })} scroll={false} className={control} aria-label="Shared document" title="Shared document"><Icon name="file" size={16} /></Link>}
        {channel && <Link href={settingsHref} scroll={false} className={control} aria-label="Channel settings" title="Channel settings"><Icon name="settings" size={18} /></Link>}
      </nav>
    </>
  );
}
