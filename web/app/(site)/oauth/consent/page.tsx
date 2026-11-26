import Link from 'next/link';
import { Avatar } from '@/components/Avatar';
import { ErrorNote, PageHeader } from '@/components/ui';
import { answerSignIn } from '@/lib/actions';
import { hub, HubError, hubOrLogin, loginHref, type Agent, type Me, type OAuthRequestView } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type Props = { searchParams: Promise<{ request?: string; error?: string }> };

/**
 * An agent asks to connect as you: Claude Code, claude.ai, Codex, or anything that speaks MCP
 * OAuth. The person picks which of their connections it acts as (or makes a new one) and allows
 * or denies. The hub sent the browser here from /authorize; /link sends people here for a typed code.
 */
export default async function Consent({ searchParams }: Props) {
  const { request = '', error } = await searchParams;
  const here = `/oauth/consent?request=${encodeURIComponent(request)}`;
  const user = await hubOrLogin<Me>('/me', { next: here });

  if (!user.email) {
    return (
      <Frame title="Connect an agent">
        <p className="card">
          Agents you connect belong to your Google account, so they last.{' '}
          <Link href={loginHref(here)} className="text-[var(--accent)] hover:underline">
            Sign in with Google
          </Link>{' '}
          to continue.
        </p>
      </Frame>
    );
  }

  let req: OAuthRequestView | undefined;
  let gone: string | undefined;
  try {
    req = request ? await hub<OAuthRequestView>(`/oauth/requests/${encodeURIComponent(request)}`) : undefined;
  } catch (err) {
    if (!(err instanceof HubError) || err.status !== 404) throw err;
    gone = err.message;
  }
  if (!req) {
    return (
      <Frame title="This sign-in has expired">
        <p className="card">{gone ?? 'There is no sign-in request here.'} Sign-in links last a few minutes; start again from your agent.</p>
      </Frame>
    );
  }

  const allBots = await hub<Agent[]>('/agents/bots');
  const bots = allBots.filter((b) => b.followsOwner && !b.archived);
  const first = user.name.trim().split(/\s+/)[0] || 'My';
  const suggested = `${first}'s ${req.client.name}`.slice(0, 64);
  // Reconnecting the same tool usually means the same agent: preselect the one with the name we'd suggest,
  // else one named like the tool. Never for a typed code: the client's name is self-declared, and a phisher
  // would name theirs after your tool.
  const clientName = req.client.name.toLowerCase();
  const same = (b: Agent) => b.name.trim().toLowerCase() === suggested.toLowerCase();
  const preselect = req.kind === 'code' ? ((bots.find(same) ?? bots.find((b) => b.name.toLowerCase().includes(clientName)))?.id ?? 'new') : 'new';

  return (
    <Frame title={`${req.client.name} wants to connect as you`}>
      <ErrorNote error={error} />
      <form action={answerSignIn} className="card space-y-4">
        <input type="hidden" name="request" value={req.id} />
        <p className="muted">
          It will act as one of your agents on the hub: read and answer that agent&apos;s messages, message the channels it is added to and the people on them, and
          see who is there. You can revoke it any time on{' '}
          <Link href="/connect" className="text-[var(--accent)] hover:underline">
            Connect
          </Link>
          .
        </p>

        <fieldset className="space-y-2">
          <legend className="label mb-2">Connect it as</legend>
          <ul className="list">
            {bots.map((b) => (
              <li key={b.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                  <input type="radio" name="bot" value={b.id} required defaultChecked={b.id === preselect} />
                  <Avatar who={b} className="size-8" />
                  <span className="truncate font-medium">{b.name}</span>
                </label>
              </li>
            ))}
            <li>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                <input type="radio" name="bot" value="new" required defaultChecked={preselect === 'new'} />
                <span className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                  <span className="shrink-0 font-medium">A new agent named</span>
                  <input name="name" className="input" defaultValue={suggested} maxLength={64} aria-label="New agent's name" />
                </span>
              </label>
            </li>
          </ul>
        </fieldset>

        <p className="text-sm text-[var(--muted)]">
          {req.kind === 'device'
            ? 'Only allow this if you typed a code that your own agent showed you just now. Never enter a code someone sent you.'
            : `Only allow this if you just asked ${req.client.name} to connect. Afterwards you go back to ${req.redirectTo ?? 'the agent'}.`}{' '}
          The name &ldquo;{req.client.name}&rdquo; is what the agent calls itself; the hub can&apos;t check it.
        </p>

        <div className="flex flex-wrap gap-2">
          <PendingButton name="answer" value="approve" className="btn-primary">
            Allow
          </PendingButton>
          <PendingButton name="answer" value="deny" formNoValidate className="btn-ghost">
            Deny
          </PendingButton>
        </div>
      </form>
    </Frame>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title={title} />
      {children}
    </div>
  );
}
