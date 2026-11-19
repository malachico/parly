import { hub, HubError, me, token } from '@/lib/hub';
import { readChannelThread } from '@/lib/thread-nav';

export const dynamic = 'force-dynamic';

/**
 * Fetches a single channel thread (`{ post, replies, seen, older, activity, unread, people, done, shared }`)
 * for client-side thread switching and background refresh. Enforces workspace and channel membership
 * on the server using the signed-in session.
 */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const url = new URL(req.url);
  const ws = url.searchParams.get('ws') ?? '';
  const postId = url.searchParams.get('post') ?? '';
  const repliesParam = url.searchParams.get('replies');
  const replies = repliesParam ? Number(repliesParam) : undefined;

  const result = await readChannelThread(
    { ws, key, postId, replies },
    {
      getToken: token,
      getMe: me,
      fetchHub: (path) => hub(path),
      isHubStatus: (err) => (err instanceof HubError ? err.status : undefined),
    },
  );
  return Response.json(result.body, { status: result.status });
}
