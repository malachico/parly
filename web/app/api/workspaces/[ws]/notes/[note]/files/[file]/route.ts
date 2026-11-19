import { hub, HubError, token } from '@/lib/hub';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ ws: string; note: string; file: string }> }) {
  if (!(await token())) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const { ws, note, file } = await params;
  try {
    const { url } = await hub<{ url: string }>(`/workspaces/${encodeURIComponent(ws)}/notes/${encodeURIComponent(note)}/files/${encodeURIComponent(file)}`);
    return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof HubError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
