import { readFlash } from '@/lib/actions/helpers';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ChannelLoader } from '@/components/ChannelLoader';
import { PanelSkeleton } from '@/components/PanelSkeleton';
import { meOrLogin, parseConversationKey } from '@/lib/hub';

type Props = {
  params: Promise<{ ws: string; key: string }>;
};

/**
 * One conversation: header, its messages, the composer. Who you're talking to lives on their Profile. There is
 * one per agent and one per channel. Its contents are read by the browser from the hub (ChannelLoader): this page
 * makes no hub call for them. ?at=<message id> scrolls to that message.
 */
export default async function ConversationPage({ params }: Props) {
  const { ws, key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const parsed = parseConversationKey(key);
  if (!parsed) notFound();
  // A webhook URL createWebhook just made, shown once.
  const f = parsed.kind === 'channel' ? await readFlash<{ channelId: string; url: string }>('flash_webhook') : undefined;
  const { graph } = await meOrLogin(); // cached: the layout already read it
  return (
    <Suspense fallback={<PanelSkeleton />}>
      {/* A new value on every server render (an action's revalidate, a tab shown again) re-reads the conversation. */}
      <ChannelLoader ws={ws} kind={parsed.kind} id={parsed.id} renderedAt={Date.now()} webhookUrl={f?.channelId === parsed.id ? f.url : undefined} graph={graph} />
    </Suspense>
  );
}
