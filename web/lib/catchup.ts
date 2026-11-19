import type { MessageView } from './hub';
import { agentKey, channelKey } from './routes';
import { sessionWorkspace, type SessionReadDeps } from './thread-nav';

export const ALL_CAUGHT_UP_TLDR = "You're all caught up ✨";

export type CatchupResponse = {
  caughtUp: boolean;
  messageCount: number;
  capped?: boolean;
  tldr: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
};

type ReadConversationCatchupResult =
  | { status: 200; body: CatchupResponse }
  | { status: 400 | 401 | 403 | 404 | 429 | 500; body: { error: string } };

/**
 * Server-side session-gated reader for `GET /api/conversations/[key]/catchup`.
 * Reuses the session, workspace, channel, thread, and DM membership checks from `readChannelThread` (#302)
 * before delegating unread collection and Vertex AI summarization to the Hub (`GET /conversations/:key/catchup`).
 */
export async function readConversationCatchup(
  input: {
    ws: string;
    key: string;
    thread?: string;
    sinceSeq?: number | string | null;
  },
  deps: SessionReadDeps,
): Promise<ReadConversationCatchupResult> {
  const ws = input.ws.trim();
  const key = input.key.trim();
  const threadId = input.thread?.trim() || undefined;

  if (!ws || !key) {
    return { status: 400, body: { error: 'Invalid catch-up request' } };
  }

  let parsedSinceSeq: number | undefined;
  if (input.sinceSeq !== undefined && input.sinceSeq !== null && String(input.sinceSeq).trim() !== '') {
    const n = Number(input.sinceSeq);
    if (!Number.isInteger(n) || n < 0) {
      return { status: 400, body: { error: 'Invalid sinceSeq parameter' } };
    }
    parsedSinceSeq = n;
  }

  const isChannel = key.startsWith('channel:') && key.length > 8;
  const isDm = key.startsWith('dm:') && key.length > 3;
  const isAgent = key.startsWith('agent:') && key.length > 6;
  const isThreadKey = key.startsWith('thread:') && key.split(':').length === 3;

  if (!isChannel && !isDm && !isAgent && !isThreadKey) {
    return { status: 400, body: { error: 'Invalid conversation key' } };
  }
  if ((isDm || isAgent) && threadId) {
    return { status: 400, body: { error: 'Direct conversations do not have threads' } };
  }

  const session = await sessionWorkspace(ws, deps);
  if ('status' in session) return session;
  const { user, workspace } = session;

  let targetKey = key;
  let verifyChannelId: string | undefined;
  let verifyThreadPostId: string | undefined;

  if (isChannel) {
    const channelId = key.slice(8);
    const channel = workspace.channels?.find((c) => c.id === channelId);
    if (!channel) {
      return { status: 403, body: { error: 'Not a member of this channel' } };
    }
    if (threadId) {
      verifyChannelId = channelId;
      verifyThreadPostId = threadId;
      targetKey = `thread:${channelId}:${threadId}`;
    }
  } else if (isThreadKey) {
    const [, channelId, postId] = key.split(':');
    if (!channelId || !postId) {
      return { status: 400, body: { error: 'Invalid conversation key' } };
    }
    const channel = workspace.channels?.find((c) => c.id === channelId);
    if (!channel) {
      return { status: 403, body: { error: 'Not a member of this channel' } };
    }
    verifyChannelId = channelId;
    verifyThreadPostId = postId;
    targetKey = `thread:${channelId}:${postId}`;
  } else if (isDm) {
    const ids = key.slice(3).split('_').filter(Boolean);
    if (ids.length !== 2 || ids[0] === ids[1]) {
      return { status: 400, body: { error: 'Invalid conversation key' } };
    }
    if (!ids.includes(user.id)) {
      return { status: 403, body: { error: 'Not a participant in this conversation' } };
    }
  } else if (isAgent) {
    const otherId = key.slice(6).trim();
    if (!otherId || otherId === user.id) {
      return { status: 400, body: { error: 'Invalid conversation key' } };
    }
    targetKey = agentKey(otherId);
  }

  try {
    if (verifyChannelId && verifyThreadPostId) {
      const threadPost = await deps.fetchHub<{ message: MessageView }>(
        `/messages/${encodeURIComponent(verifyThreadPostId)}`,
      );
      if (threadPost.message.conversation !== channelKey(verifyChannelId)) {
        return { status: 404, body: { error: 'Thread does not belong to this channel' } };
      }
    }

    const qs = parsedSinceSeq !== undefined ? `?sinceSeq=${encodeURIComponent(String(parsedSinceSeq))}` : '';
    const catchup = await deps.fetchHub<CatchupResponse>(
      `/conversations/${encodeURIComponent(targetKey)}/catchup${qs}`,
    );

    return {
      status: 200,
      body: {
        caughtUp: Boolean(catchup.caughtUp),
        messageCount: Number(catchup.messageCount) || 0,
        ...(catchup.capped ? { capped: true } : {}),
        tldr: typeof catchup.tldr === 'string' && catchup.tldr.trim() ? catchup.tldr : ALL_CAUGHT_UP_TLDR,
        decisions: Array.isArray(catchup.decisions) ? catchup.decisions : [],
        actionItems: Array.isArray(catchup.actionItems) ? catchup.actionItems : [],
        openQuestions: Array.isArray(catchup.openQuestions) ? catchup.openQuestions : [],
      },
    };
  } catch (err) {
    const status = deps.isHubStatus?.(err);
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 429) {
      return {
        status,
        body: { error: err instanceof Error ? err.message : 'Unable to generate catch-up summary' },
      };
    }
    return {
      status: 500,
      body: { error: 'Unable to generate catch-up summary' },
    };
  }
}
