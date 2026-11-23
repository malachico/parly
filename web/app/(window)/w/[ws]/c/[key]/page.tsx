import { readFlash } from '@/lib/actions/helpers';
import { notFound } from 'next/navigation';
import { ChannelLoader, type Opened } from '@/components/ChannelLoader';
import { openPath } from '@/lib/channelView';
import { HubError, hub, meOrLogin, parseConversationKey } from '@/lib/hub';

type Props = {
  params: Promise<{ ws: string; key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * One conversation: header, its messages, the composer. Who you're talking to lives on their Profile. There is
 * one per agent and one per channel. Its contents are one hub call here (the conversation's /open), handed to
 * ChannelLoader. ?at=<message id> scrolls to that message.
 */
export default async function ConversationPage({ params, searchParams }: Props) {
  const [{ ws, key: rawKey }, sp] = await Promise.all([params, searchParams]);
  const key = decodeURIComponent(rawKey);
  const parsed = parseConversationKey(key);
  if (!parsed) notFound();
  // Started now, so it runs alongside the reads below. Not a member: 'gone'. The hub not answering: undefined, and the browser tries.
  const opening = hub<Opened>(openPath(parsed.kind, parsed.id, ws, (k) => (typeof sp[k] === 'string' ? sp[k] : undefined))).catch((e) =>
    e instanceof HubError && [400, 403, 404].includes(e.status) ? ('gone' as const) : undefined,
  );
  // A webhook URL createWebhook just made, shown once.
  const f = parsed.kind === 'channel' ? await readFlash<{ channelId: string; url: string }>('flash_webhook') : undefined;
  const { graph } = await meOrLogin(); // cached: the layout already read it
  return <ChannelLoader ws={ws} kind={parsed.kind} id={parsed.id} initial={await opening} webhookUrl={f?.channelId === parsed.id ? f.url : undefined} graph={graph} />;
}
