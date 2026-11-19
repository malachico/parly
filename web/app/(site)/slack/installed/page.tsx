import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { hub, HubError, hubOrLogin, loginHref, type Me } from '@/lib/hub';
import { wsHref } from '@/lib/routes';

type Props = { searchParams: Promise<{ code?: string; state?: string; error?: string }> };

/**
 * Slack OAuth v2 redirect target (/slack/installed?code=…&state=…): binds the OAuth callback to the
 * signed-in Parly person's session by posting `{code, state, error}` with their bearer token to
 * `POST /slack/oauth/complete`. The hub verifies `caller.id === state.ownerId` before exchanging `code`.
 */
export default async function SlackInstalled({ searchParams }: Props) {
  const { code = '', state = '', error } = await searchParams;
  const q = new URLSearchParams({
    ...(code ? { code } : {}),
    ...(state ? { state } : {}),
    ...(error ? { error } : {}),
  }).toString();
  const here = q ? `/slack/installed?${q}` : '/slack/installed';
  const user = await hubOrLogin<Me>('/me', { next: here });

  if (!user.email) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title="Connect Slack" />
        <p className="card">
          Sign in with your Google account to finish connecting Slack.{' '}
          <Link href={loginHref(here)} className="text-[var(--accent)] hover:underline">
            Sign in with Google
          </Link>{' '}
          to continue.
        </p>
      </div>
    );
  }

  let out: { workspaceId: string; install?: { teamId: string; teamName: string } } | undefined;
  let problem: string | undefined;
  if (!state) {
    problem = 'Missing Slack installation state. Start again from workspace settings.';
  } else {
    try {
      out = await hub<{ workspaceId: string; install?: { teamId: string; teamName: string } }>('/slack/oauth/complete', {
        method: 'POST',
        body: {
          ...(code ? { code } : {}),
          state,
          ...(error ? { error } : {}),
        },
      });
    } catch (err) {
      if (err instanceof HubError) problem = err.message;
      else throw err;
    }
  }

  if (out) {
    redirect(
      wsHref(out.workspaceId, {
        panel: 'workspace',
        ...(out.install ? { slack: 'installed' } : { error: 'Slack installation was cancelled.' }),
      }),
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <PageHeader title="Couldn’t connect Slack" />
      <div className="card space-y-3">
        <p>{problem ?? 'This Slack installation link has expired or was already used.'}</p>
        <p className="text-sm text-[var(--muted)]">
          <Link href="/" className="text-[var(--accent)] hover:underline">
            Back to your workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
