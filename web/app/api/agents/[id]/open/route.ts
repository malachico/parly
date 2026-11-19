import { proxyOpen } from '@/lib/proxyOpen';

export const dynamic = 'force-dynamic';

/** The hub's GET /agents/:id/open, proxied (lib/proxyOpen.ts). */
export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return proxyOpen('agents', req, ctx);
}
