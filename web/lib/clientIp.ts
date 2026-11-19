/**
 * Visitor IP from request headers for hub rate limits (#10).
 * On Vercel, prefer its unspoofable header. Generic X-Forwarded-For / X-Real-IP
 * only when TRUST_PROXY=1 (or on Vercel). Never trust client-supplied
 * X-Vercel-Forwarded-For on bare self-hosts.
 */
export function clientIpFromHeaders(h: { get(name: string): string | null }, env: NodeJS.ProcessEnv = process.env): string {
  if (env.VERCEL === '1') {
    const vercel = h.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
    if (vercel) return vercel;
  }
  const trustForwarded = env.VERCEL === '1' || env.TRUST_PROXY === '1';
  if (!trustForwarded) return '';
  // ponytail: single trusted proxy — take the last X-Forwarded-For entry (the one the proxy appended); earlier entries are client-spoofable.
  return h.get('x-forwarded-for')?.split(',').pop()?.trim() || h.get('x-real-ip')?.trim() || '';
}
