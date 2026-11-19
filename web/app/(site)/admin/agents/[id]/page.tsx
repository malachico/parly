import Link from 'next/link';
import { AdminNav } from '@/components/Admin';
import { Avatar } from '@/components/Avatar';
import { LocalTime } from '@/components/LocalTime';
import { Empty, ErrorNote, KindBadge, PageHeader } from '@/components/ui';
import { adminAct, adminSetPlan } from '@/lib/actions';
import { adminAgentHref, adminGet, type AdminAgent, type AdminRow } from '@/lib/admin';
import { ago } from '@/lib/labels';
import { PendingButton } from '@/components/PendingButton';
import { plural } from '@/lib/plural';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; done?: string }> };

/** One agent, for a super admin: its state, its queue, its latest tasks (no message text), and what can be done to it. */
export default async function AdminAgentPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error, done } = await searchParams;
  const a = await adminGet<AdminAgent>(adminAgentHref(id), adminAgentHref(id));
  const isBot = a.kind !== 'human';
  const facts: [string, React.ReactNode][] = [
    ['Id', <code key="id" className="font-mono text-xs break-all">{a.id}</code>],
    ...(a.email ? [['Email', a.email] as [string, React.ReactNode]] : []),
    ...(a.owner
      ? [['Owner', <Link key="owner" href={adminAgentHref(a.owner.id)} className="text-[var(--accent)] hover:underline">{a.owner.name}{a.owner.email ? ` (${a.owner.email})` : ''}</Link>] as [string, React.ReactNode]]
      : []),
    ['Kind', a.kind === 'human' ? 'person (Google sign-in)' : a.kind === 'endpoint' ? 'A2A endpoint (pushed to)' : a.followsOwner ? 'mailbox, the owner’s own coding tool' : 'mailbox (pulls its messages)'],
    ['Visibility', a.public ? 'public: anyone can find and message it' : 'private: its workspaces only'],
    ['Created', <LocalTime key="c" iso={a.createdAt} date />],
    ['Last seen', <span key="s">{ago(a.lastSeen)}{a.kind === 'mailbox' ? (a.listening ? ' · listening now' : ' · not listening') : ''}</span>],
    ...(a.url ? [['URL', <span key="u" className="break-all">{a.url}</span>] as [string, React.ReactNode]] : []),
    ...(a.kind === 'endpoint' ? [['Credential', a.credential ? `${a.credential} (never shown)` : 'none'] as [string, React.ReactNode]] : []),
    ...(a.skills.length ? [['Skills', a.skills.join(', ')] as [string, React.ReactNode]] : []),
  ];

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              <Avatar who={a} className="size-10" />
              <span className="min-w-0 break-words">{a.name}</span>
            </span>
          }
          sub={a.description || undefined}
        >
          <KindBadge kind={a.kind} />
          {a.archived && <span className="chip">archived</span>}
        </PageHeader>
        <AdminNav current="/admin/agents" />
      </div>

      <ErrorNote error={error} />
      {done && <p role="status" className="rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-sm text-[var(--ok-fg)]">{done}</p>}
      {a.authProblem && (
        <p className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
          <strong>The hub can’t sign in to it:</strong> {a.authProblem}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <dl className="card grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--muted)]">{k}</dt>
              <dd className="min-w-0">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="space-y-6">
          {a.billing && (
            <section className="card space-y-3">
              <h2 className="label">Plan</h2>
              <p className="muted text-[13px]">
                {a.billing.plan}: ${a.billing.monthlyUsd}/month of AI use, {a.billing.maxWorkspaces ?? a.billing.maxHired} workspaces and{' '}
                {a.billing.maxParticipants ?? a.billing.maxConnected} participants each
                {a.billing.extraUsd ? `, $${a.billing.extraUsd.toFixed(2)} of top-ups left` : ''}
                {a.billing.paddle ? ' · pays through Paddle' : ''}.
              </p>
              <form action={adminSetPlan.bind(null, a.id)} className="space-y-2.5">
                <select name="plan" defaultValue={a.billing.plan} className="input" aria-label="Plan">
                  <option value="free">Free</option>
                  <option value="pro">Pro</option>
                  <option value="team">Team</option>
                  <option value="enterprise">Enterprise</option>
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input name="allowanceUsd" type="number" min="0" step="1" defaultValue={a.billing.allowanceUsd} placeholder="$ / month" aria-label="Own monthly allowance in dollars" className="input" />
                  <input
                    name="maxWorkspaces"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={a.billing.customMaxWorkspaces ?? a.billing.customMaxHired}
                    placeholder="Workspaces"
                    aria-label="Own limit of owned workspaces"
                    className="input"
                  />
                  <input
                    name="maxParticipants"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={a.billing.customMaxParticipants ?? a.billing.customMaxConnected}
                    placeholder="Participants"
                    aria-label="Own limit of participants per workspace"
                    className="input"
                  />
                </div>
                <p className="text-xs text-[var(--muted)]">Leave the numbers empty to use the plan&apos;s own. Logged with your name.</p>
                <PendingButton className="btn">Save plan</PendingButton>
              </form>
            </section>
          )}
          {isBot && (
            <section className="card space-y-3">
              <h2 className="label">Actions</h2>
              <p className="muted">Each one is written to the audit log with your name.</p>
              <div className="flex flex-wrap gap-2">
                {a.kind === 'endpoint' && (
                  <form action={adminAct.bind(null, a.id, 'check')}>
                    <PendingButton className="btn">Check connection</PendingButton>
                  </form>
                )}
                <form action={adminAct.bind(null, a.id, a.archived ? 'restore' : 'archive')}>
                  <PendingButton className="btn">{a.archived ? 'Restore' : 'Archive'}</PendingButton>
                </form>
                <form action={adminAct.bind(null, a.id, 'revoke-token')}>
                  <PendingButton confirm="Yes, revoke" className="btn text-[var(--bad-fg)]">Revoke token</PendingButton>
                </form>
              </div>
              <p className="text-xs text-[var(--muted)]">
                Archive hides it everywhere and stops its messages until restored. Revoke token ends its token and OAuth sign-ins; nobody sees a new one, so the owner reconnects it from the Connect page.
              </p>
            </section>
          )}
        </div>
      </div>

      {a.workspaceList.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <ul className="flex flex-wrap gap-2">
            {a.workspaceList.map((w) => (
              <li key={w.id} className="chip" title={w.id}>
                {w.name}
                {w.archived ? ' (archived)' : ''}
              </li>
            ))}
          </ul>
          <p className="muted">In {plural(a.channels, 'channel', 'channels')}.</p>
        </section>
      )}

      {a.kind === 'human' && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Their bots ({a.bots.length})</h2>
          {a.bots.length === 0 ? <Empty>No bots.</Empty> : <BotList bots={a.bots} />}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Latest conversations</h2>
        <p className="muted">How many messages and when the last one came. Message text stays private.</p>
        {a.conversations.length === 0 ? (
          <Empty>No conversations.</Empty>
        ) : (
          <ul className="list">
            {a.conversations.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-sm" title={c.id}>
                <span className="font-medium">{c.kind === 'dm' ? 'Direct' : c.kind === 'thread' ? 'Thread' : 'Channel'}</span>
                <span className="text-[var(--muted)] tabular-nums">{c.messages} messages</span>
                <span className="ml-auto text-[var(--muted)] tabular-nums">{ago(c.lastAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BotList({ bots }: { bots: AdminRow[] }) {
  return (
    <ul className="list">
      {bots.map((b) => (
        <li key={b.id}>
          <Link href={adminAgentHref(b.id)} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--subtle)]">
            <Avatar who={b} className="size-8" />
            <span className="min-w-0 flex-1">
              <span className={`block truncate font-medium ${b.archived ? 'text-[var(--muted)] line-through' : ''}`}>{b.name}</span>
              <span className="block truncate text-xs text-[var(--muted)]">
                {b.kind === 'endpoint' ? b.url : 'mailbox'} · seen {ago(b.lastSeen)}
              </span>
            </span>
            {b.authProblem && <span className="shrink-0 text-xs text-[var(--bad-fg)]">auth problem</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
