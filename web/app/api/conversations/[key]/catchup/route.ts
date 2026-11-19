import { readConversationCatchup } from '@/lib/catchup';
import { hub, HubError, me, token } from '@/lib/hub';

export const dynamic = 'force-dynamic';

/**
 * Generates an AI "Catch me up" summary (`{ caughtUp, messageCount, capped?, tldr, decisions, actionItems, openQuestions }`)
 * for unread messages in a channel, channel thread (`?thread=<postId>`), or direct conversation.
 * Accepts optional `?sinceSeq=<number>` captured on initial SSR load before `<MarkRead />` advances the read cursor.
 */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const url = new URL(req.url);
  const ws = url.searchParams.get('ws') ?? '';
  const thread = url.searchParams.get('thread') ?? undefined;
  const sinceSeq = url.searchParams.get('sinceSeq');

  const result = await readConversationCatchup(
    { ws, key, thread, sinceSeq },
    {
      getToken: token,
      getMe: me,
      fetchHub: (path) => hub(path),
      isHubStatus: (err) => (err instanceof HubError ? err.status : undefined),
    },
  );
  return Response.json(result.body, { status: result.status });
}
