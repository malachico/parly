import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { hub, HubError, hubOrLogin, type Me } from '@/lib/hub';

const KEYS = ['code', 'state', 'installation_id', 'setup_action', 'error', 'error_description'] as const;
type Props = { searchParams: Promise<Partial<Record<(typeof KEYS)[number], string>>> };

/**
 * GitHub App install landing (the hub's /github/callback forwards here): binds the install to the signed-in
 * Parly person's session by posting the query with their bearer token to `POST /github/oauth/complete`.
 * The hub verifies `caller.id === state.ownerId` before exchanging `code`.
 */
export default async function GitHubInstalled({ searchParams }: Props) {
  const params = await searchParams;
  const body = Object.fromEntries(KEYS.filter((k) => params[k]).map((k) => [k, params[k]!]));
  const q = new URLSearchParams(body).toString();
  await hubOrLogin<Me>('/me', { next: q ? `/github/installed?${q}` : '/github/installed' });

  let out: { redirectUrl: string } | undefined;
  let problem: string | undefined;
  try {
    out = await hub<{ redirectUrl: string }>('/github/oauth/complete', { method: 'POST', body });
  } catch (err) {
    if (err instanceof HubError) problem = err.message;
    else throw err;
  }
  if (out) redirect(out.redirectUrl);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <PageHeader title="Couldn’t connect GitHub" />
      <div className="card space-y-3">
        <p>{problem}</p>
        <p className="text-sm text-[var(--muted)]">
          <Link href="/" className="text-[var(--accent)] hover:underline">
            Back to your workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
