import { hub, HubError, token } from '@/lib/hub';

export const dynamic = 'force-dynamic';

/**
 * Opens an attached file for the signed-in person: the hub checks they were in a conversation
 * that carries it, then this redirects to a short-lived signed link. Pages point <img> and
 * download links here, so they never hold a link that has expired. The redirect is kept 2 minutes
 * (the link lasts 5), so an image already seen in the channel opens at once in its thread.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await token())) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;
  const download = new URL(req.url).searchParams.get('download') ? '&download=1' : '';
  try {
    const { url } = await hub<{ url: string }>(`/files/${encodeURIComponent(id)}?link=1${download}`);
    return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'private, max-age=120' } });
  } catch (err) {
    if (err instanceof HubError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
