import { BackToConversations } from '@/components/BackToConversations';
import { ScheduleList } from '@/components/ScheduleList';
import Link from 'next/link';
import { credits, tokens } from '@/lib/labels';
import { LocalTime } from '@/components/LocalTime';
import { notFound } from 'next/navigation';
import { Avatar } from '@/components/Avatar';
import { AuthFields } from '@/components/AuthFields';
import { Icon } from '@/components/Icon';
import { ErrorNote, KindBadge, PageHeader } from '@/components/ui';
import { agentHref, botActivityHref, dmHref, triggersHref } from '@/lib/routes';
import { hub, HubError, me, myConversations, type Agent, type AgentTrigger, type MyTools, type Schedule, type ScopedSkillView, type SkillSummaryView, type TriggerTypeGroup } from '@/lib/hub';
import { ToolsSection, TriggersSection } from '@/components/ToolsSection';
import { SkillsSection } from '@/components/SkillsSection';
import { addSiblingAgent, checkConnection, makeConnectionCode, makeConnectionToken, removeAgentTelegramBot, removeWake, setArchived, updateAgentTelegramBot, updateConnection, updateProfile, updateWake, wakeNow } from '@/lib/actions';
import { hermesConnectCommand, openclawConnectCommand, pairingPrompt } from '@/lib/connect';
import { HUB_PUBLIC_URL } from '@/lib/hub';
import { readFlash } from '@/lib/actions/helpers';
import { CopyButton } from '@/components/CopyButton';
import { PendingButton } from '@/components/PendingButton';
import { plural } from '@/lib/plural';

type Props = { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ error?: string; token?: string; code?: string; hired?: string; tq?: string; trigger?: string; only?: string }> };

/** A profile, beside the rail. */
export default async function AgentPage({ params, searchParams }: Props) {
  const { ws, id } = await params;
  const { error, token: tokenShown, code: codeShown, hired, tq, trigger: triggerPicked, only } = await searchParams;
  const toolQuery = tq?.trim() || undefined;
  // A one-time code makeConnectionCode just made, shown once as a command.
  let newCode: { code: string; expiresAt: string } | undefined;
  if (codeShown) {
    const f = await readFlash<{ id: string; code: string; expiresAt: string }>('flash_agent_code');
    if (f?.id === id) newCode = f;
  }
  // A token makeConnectionToken just made, shown once.
  let newToken: string | undefined;
  if (tokenShown) {
    const f = await readFlash<{ id: string; token: string }>('flash_agent_token');
    if (f?.id === id) newToken = f.token;
  }
  const [found, user] = await Promise.all([
    hub<Agent>(`/agents/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof HubError && err.status === 404) return undefined;
      throw err;
    }),
    me(),
  ]);
  // Archived bots are hidden from everyone, but their owner still has the full profile, to restore it.
  const agent = found ?? (await hub<Agent[]>('/agents/bots').catch(() => [] as Agent[])).find((b) => b.id === id);
  if (!agent) return <GoneProfile ws={ws} id={id} />;
  // The owner of an A2A connection can check it and change its URL or credential here.
  const mine = !!agent.url && agent.kind !== 'human' && !!user && agent.ownerId === user.id;
  // The owner of a mailbox bot can have a webhook wake it.
  const myMailbox = agent.kind === 'mailbox' && !!user && agent.ownerId === user.id && !agent.archived && !agent.webhookChannel;
  // An incoming webhook: the channel it posts into, by name when I'm in it.
  const webhookChannelName = agent.webhookChannel
    ? (user?.workspaces.flatMap((w) => w.channels ?? []).find((c) => c.id === agent.webhookChannel)?.name ?? 'its channel')
    : undefined;
  const aid = encodeURIComponent(agent.id);
  const ownsBot = agent.kind !== 'human' && !agent.webhookChannel && agent.ownerId === user?.id;
  // Scheduled direct messages from me to this agent (sent as me, so its answers land in our conversation).
  const canSchedule = !!user && user.kind === 'human' && agent.id !== user.id && agent.kind !== 'human' && !agent.archived && !agent.webhookChannel;
  // Skills & processes attached to or inherited by this agent.
  const canManageSkills = Boolean(user && agent.kind !== 'human' && !agent.webhookChannel && (agent.ownerId === user.id || agent.id === user.id || user.admin));
  const showSkills = agent.kind !== 'human' && !agent.webhookChannel && !!user;
  // Everything below is independent, so it's asked for at once.
  const [usage, triggers, tools, schedules, effectiveSkills, librarySkills, cardResult, allTriggerTypes] = await Promise.all([
    // The owner of an agent Parly runs (cloud or hosted) sees what it used this month.
    (agent.cloud || agent.hosted) && agent.ownerId === user?.id
      ? hub<{ calls: number; input: number; output: number; micros: number }>(`/agents/${aid}/usage`).catch(() => undefined)
      : undefined,
    // The owner of an agent Parly runs (cloud or computer) picks its tools and triggers from their connected accounts.
    ownsBot ? hub<AgentTrigger[]>(`/agents/${aid}/triggers`).catch(() => undefined) : undefined,
    // Any agent of yours can use your connected apps (cloud ones built in, the rest through Parly's MCP).
    ownsBot ? hub<MyTools>(`/me/tools${toolQuery ? `?q=${encodeURIComponent(toolQuery)}` : ''}`).catch(() => undefined) : undefined,
    canSchedule ? hub<Schedule[]>(`/agents/${aid}/schedules`).catch(() => [] as Schedule[]) : ([] as Schedule[]),
    showSkills ? hub<ScopedSkillView[]>(`/agents/${aid}/skills?workspaceId=${encodeURIComponent(ws)}`).catch(() => [] as ScopedSkillView[]) : ([] as ScopedSkillView[]),
    showSkills && canManageSkills ? hub<SkillSummaryView[]>('/me/skills').catch(() => [] as SkillSummaryView[]) : ([] as SkillSummaryView[]),
    // A cloud agent runs on Parly: no A2A server, so no card.
    agent.kind === 'endpoint' && !agent.cloud
      ? hub(`/agents/${aid}/card`).then(
          (card): { card?: unknown; cardError?: string } => ({ card }),
          (err) => {
            if (!(err instanceof HubError)) throw err;
            return { cardError: err.message };
          },
        )
      : {},
    // What the owner's connected apps can tell this agent about (the "When something happens" picker); used below only with triggers.
    ownsBot ? hub<TriggerTypeGroup[]>('/me/trigger-types').catch(() => [] as TriggerTypeGroup[]) : ([] as TriggerTypeGroup[]),
  ]);
  const { card, cardError } = cardResult as { card?: unknown; cardError?: string };
  const triggerTypes = triggers && tools?.triggers ? allTriggerTypes : [];
  // Its tools and its triggers: on the profile, or each on its own (?only=tools|triggers, from the canvas card).
  const toolsCard = tools?.available && <ToolsSection ws={ws} agent={agent} tools={tools} query={toolQuery} hired={!!hired} error={only === 'tools' || !(tools.triggers && triggers) ? error : undefined} only={only === 'tools' ? 'tools' : undefined} />;
  const triggersCard = tools?.triggers && triggers && (
    <TriggersSection
      ws={ws}
      agent={agent}
      triggers={triggers}
      types={triggerTypes}
      connected={tools.connected}
      picked={triggerPicked}
      error={error}
      only={only === 'triggers' ? 'triggers' : undefined}
      // Where events can go besides the DM: channels the agent is in (the hub checks you are too).
      channels={(user?.workspaces.flatMap((w) => w.channels ?? []) ?? []).filter((c) => agent.channels.includes(c.id) && !c.archived)}
    />
  );
  const skillsCard = agent.kind !== 'human' && !agent.webhookChannel && user && (
    <SkillsSection
      ws={ws}
      scope="agent"
      targetId={agent.id}
      targetName={agent.name}
      canManage={canManageSkills}
      effectiveSkills={effectiveSkills}
      librarySkills={librarySkills}
      backHref={only === 'skills' ? `${agentHref(ws, agent.id)}?only=skills` : `${agentHref(ws, agent.id)}#skills`}
      error={only === 'skills' ? error : undefined}
    />
  );
  if ((only === 'tools' && toolsCard) || (only === 'triggers' && triggersCard) || (only === 'skills' && skillsCard))
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
          <div className="mx-auto max-w-3xl space-y-4">
            <div className="flex items-center gap-3">
              <Avatar who={agent} className="size-10 shrink-0" />
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
                {agent.name}: {only === 'tools' ? 'Tools' : only === 'triggers' ? 'When something happens' : 'Skills & Processes'}
              </h1>
              <Link href={agentHref(ws, agent.id)} className="btn-ghost min-h-9 text-sm">
                Full profile
              </Link>
            </div>
            {only === 'tools' ? toolsCard : only === 'triggers' ? triggersCard : skillsCard}
          </div>
        </div>
      </main>
    );
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <BackToConversations ws={ws} inset />
        <div className="mx-auto max-w-3xl space-y-6">
          <section className="card space-y-5 p-5 sm:p-6">
            <div className="flex flex-wrap items-start gap-4">
              <Avatar who={agent} className="size-16 shrink-0" />
              <div className="min-w-0 flex-1">
                <h1 className="page-title break-words">{agent.name}</h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
                  <KindBadge kind={agent.kind} />
                  {agent.hosted && <span className="chip shrink-0">hosted on Parly</span>}
                  {agent.owner ? (
                    <span>
                      owned by{' '}
                      <Link href={agentHref(ws, agent.owner.id)} className="text-[var(--accent)] hover:underline">
                        {agent.owner.name || 'a person'}
                      </Link>
                      {user?.id === agent.owner.id ? ' (you)' : ''}
                    </span>
                  ) : agent.public ? (
                    'public'
                  ) : (
                    'workspace only'
                  )}
                </div>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                {user && user.id !== agent.id && !agent.archived && !agent.webhookChannel && (
                  <Link href={dmHref(ws, agent.id)} className="btn-primary">
                    Message
                  </Link>
                )}
                {agent.kind !== 'human' && agent.ownerId === user?.id && (
                  <Link href={botActivityHref(ws, agent.id)} className="btn-ghost">
                    Conversations
                  </Link>
                )}
                {myMailbox && !agent.cloud && (
                  <form action={addSiblingAgent.bind(null, agent.id, ws)}>
                    <PendingButton className="btn-ghost">Add agent on this client</PendingButton>
                  </form>
                )}
                {agent.kind !== 'human' && agent.ownerId === user?.id && !agent.archived && (
                  <form action={setArchived.bind(null, agentHref(ws, agent.id), agent.id, true)}>
                    <PendingButton confirm={agent.webhookChannel ? 'Yes, revoke' : 'Yes, archive'} className="btn-ghost text-[var(--bad-fg)]">{agent.webhookChannel ? 'Revoke' : 'Archive'}</PendingButton>
                  </form>
                )}
              </div>
            </div>
            {agent.archived && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--subtle)] px-4 py-3 text-sm">
                <span className="text-[var(--muted)]">Archived: hidden from everyone, gets no messages and can&apos;t sign in. Its history is kept.</span>
                <form action={setArchived.bind(null, agentHref(ws, agent.id), agent.id, false)} className="ml-auto">
                  <PendingButton className="btn">Restore</PendingButton>
                </form>
              </div>
            )}
            <ErrorNote error={error} />
            <p className="max-w-prose">{agent.description || <span className="muted">No description</span>}</p>
            {agent.kind !== 'human' && agent.ownerId === user?.id && !agent.archived && (
              <details>
                <summary className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-[var(--muted)]" title="Edit description">
                  <Icon name="settings" size={16} />
                  <span className="sr-only">Edit description</span>
                </summary>
                <form action={updateProfile.bind(null, agent.id, ws)} className="mt-3 space-y-3">
                  <label htmlFor="profile-description" className="label">
                    Description
                  </label>
                  <textarea id="profile-description" name="description" rows={3} defaultValue={agent.description ?? ''} className="input" />
                  <PendingButton className="btn-primary" title="Save">
                    <Icon name="check" size={18} />
                    <span className="sr-only">Save</span>
                  </PendingButton>
                </form>
              </details>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-[var(--border)] pt-4 text-sm [&_dt]:text-[var(--muted)]">
              {!agent.webhookChannel && (
                <>
                  <dt>Status</dt>
                  <dd>
                    {agent.cloud ? (
                      <span className="font-medium text-[var(--ok-fg)]">● Cloud agent: answers whenever it’s messaged</span>
                    ) : agent.listening ? (
                      <span className="font-medium text-[var(--ok-fg)]">● Listening now</span>
                    ) : agent.wakes ? (
                      <span className="font-medium text-[var(--ok-fg)]">
                        {agent.wake?.type === 'webhook'
                          ? '● Wakes on message, via its webhook'
                          : agent.wake?.type === 'claude-routine'
                            ? '● Wakes on message, via its Routine'
                            : agent.wake?.type === 'xai'
                              ? '● Wakes on message: Grok (xAI) answers for it'
                              : agent.wake?.type === 'computer' || agent.hosted
                                ? '● Wakes its Parly computer on message'
                                : '● Wakes on message'}
                      </span>
                    ) : agent.kind === 'mailbox' ? (
                      'Not listening right now: messages wait in its inbox until its session is open again, or until a wake (below) starts it'
                    ) : (
                      'Not listening'
                    )}
                  </dd>
                </>
              )}
              <dt>Last seen</dt>
              <dd><LocalTime iso={agent.lastSeen} date /></dd>
              {agent.url && (
                <>
                  <dt>URL</dt>
                  <dd className="break-all">{agent.url}</dd>
                  <dt>Signs in with</dt>
                  <dd>{agent.credential ? { bearer: 'Bearer token', basic: 'Username + password', apiKey: 'API key header', oauth2: 'OAuth2 client credentials' }[agent.credential.type] : 'Nothing'}</dd>
                </>
              )}
              {agent.authProblem && (
                <>
                  <dt>Problem</dt>
                  <dd className="text-[var(--bad-fg)]">The hub can&apos;t sign in to it: {agent.authProblem}</dd>
                </>
              )}
              {webhookChannelName && (
                <>
                  <dt>Webhook</dt>
                  <dd>Posts what services send to its URL into #{webhookChannelName}. It can&apos;t read messages. Revoke it to stop the URL working.</dd>
                </>
              )}
            </dl>
            {mine && (
              <form action={checkConnection.bind(null, agent.id, ws)}>
                <PendingButton className="btn-ghost">Check the connection</PendingButton>
              </form>
            )}
            {agent.kind !== 'human' && agent.owner && agent.ownerId !== user?.id && (
              <p className="muted text-[13px]">Owned by {agent.owner.name}, who can see its conversations.</p>
            )}
          </section>
          {mine && (
            <details className="card" open={!!agent.authProblem || !!error}>
              <summary className="cursor-pointer font-medium">Change its URL or credential</summary>
              <form action={updateConnection.bind(null, agent.id, ws)} className="mt-3 space-y-3">
                <ErrorNote error={agent.archived ? undefined : error} />
                <label htmlFor="agent-url" className="label">
                  Its URL
                </label>
                <input id="agent-url" name="url" type="url" className="input" defaultValue={agent.url} required />
                <AuthFields keep />
                <p className="muted">Same agent afterwards; the hub calls it once to check.</p>
                <PendingButton className="btn-primary w-full sm:w-auto">Save</PendingButton>
              </form>
            </details>
          )}
          {myMailbox && !agent.hosted && <WakeCard agent={agent} ws={ws} error={error} />}
          {agent.kind !== 'human' && !agent.webhookChannel && !agent.archived && agent.ownerId === user?.id && (
            <TelegramBotCard agent={agent} ws={ws} error={error} />
          )}
          {agent.hosted && agent.ownerId === user?.id && !agent.archived && (
            <section className="card">
              <h2 className="font-medium">Its computer on Parly</h2>
              <p className="muted text-[13px]">
                {agent.wake?.problem
                  ? `Problem waking its computer: ${agent.wake.problem}`
                  : `${agent.name} runs on its own computer managed by Parly. It wakes when a message arrives and sleeps when idle.`}
              </p>
            </section>
          )}
          {toolsCard}
          {triggersCard}
          {skillsCard}
          {usage && (
            <section className="card">
              <h2 className="font-medium">This month</h2>
              <p className="muted text-[13px]">
                {usage.calls
                  ? `${tokens(usage.input)} tokens in, ${tokens(usage.output)} out, over ${plural(usage.calls, 'call', 'calls')}: about ${credits(usage.micros / 1e6)} credits.`
                  : 'No model use yet this month.'}
              </p>
            </section>
          )}
          {canSchedule && (
            <details className="card" open={schedules.length > 0}>
              <summary className="cursor-pointer font-medium">Scheduled messages to {agent.name}</summary>
              <div className="mt-3 space-y-3">
                <p className="muted text-[13px]">Sent as you with ⏰ in front, so {agent.name}&apos;s answers land in your conversation with it. Or ask any agent: “every weekday at 9, ask {agent.name} for …”.</p>
                <ScheduleList schedules={schedules} back={agentHref(ws, agent.id)} canChange={() => true} />
                <Link href={`${triggersHref(ws)}/new?type=schedule`} className="text-sm text-[var(--accent)] hover:underline">
                  + Schedule one in Triggers
                </Link>
              </div>
            </details>
          )}
          {mine && (
            <details className="card" open={!!newToken || !!newCode}>
              <summary className="cursor-pointer font-medium">Let it start conversations</summary>
              <div className="mt-3 space-y-3">
                <p className="muted">
                  Answering needs nothing. To message others on the hub, it needs the hub&apos;s tools and its own token. A one-time code gets both: one command for OpenClaw or Hermes
                  (on its machine or in its chat), or instructions any other agent can follow.
                </p>
                {newCode ? (
                  <div className="space-y-1">
                    <div className="flex items-start gap-2">
                      <pre className="code min-w-0 flex-1 overflow-x-auto whitespace-pre">{openclawConnectCommand(HUB_PUBLIC_URL, newCode.code)}</pre>
                      <CopyButton value={openclawConnectCommand(HUB_PUBLIC_URL, newCode.code)} label="Copy" />
                    </div>
                    <details>
                      <summary className="cursor-pointer text-sm">Hermes Agent? Run this on its machine instead</summary>
                      <div className="mt-2 flex items-start gap-2">
                        <pre className="code min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap">{hermesConnectCommand(HUB_PUBLIC_URL, newCode.code)}</pre>
                        <CopyButton value={hermesConnectCommand(HUB_PUBLIC_URL, newCode.code)} label="Copy" />
                      </div>
                    </details>
                    <details>
                      <summary className="cursor-pointer text-sm">Another agent? Give it this instead</summary>
                      <div className="mt-2 flex items-start gap-2">
                        <pre className="code min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap">{pairingPrompt(HUB_PUBLIC_URL, newCode.code)}</pre>
                        <CopyButton value={pairingPrompt(HUB_PUBLIC_URL, newCode.code)} label="Copy" />
                      </div>
                    </details>
                    <p className="muted text-[13px]">
                      Works once, until {new Date(newCode.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.
                    </p>
                  </div>
                ) : (
                  <form action={makeConnectionCode.bind(null, agent.id, ws)}>
                    <PendingButton className="btn">Get the command</PendingButton>
                  </form>
                )}
                {newToken ? (
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Its token, shown once:</p>
                    <div className="flex items-start gap-2">
                      <pre className="code min-w-0 flex-1 overflow-x-auto whitespace-pre">{`${newToken.slice(0, newToken.indexOf('_') + 1)}••••••••${newToken.slice(-4)}`}</pre>
                      <CopyButton value={newToken} label="Copy" />
                    </div>
                  </div>
                ) : (
                  <form action={makeConnectionToken.bind(null, agent.id, ws)}>
                    <PendingButton className="btn">Make a token instead</PendingButton>
                    <p className="muted mt-1 text-[13px]">For another client: shown once, as Authorization: Bearer. Either way, any token it had stops working.</p>
                  </form>
                )}
              </div>
            </details>
          )}
          <section>
            <h2 className="label mb-3">Skills</h2>
            {agent.skills.length === 0 ? (
              <p className="muted">None advertised.</p>
            ) : (
              <ul className="list">
                {agent.skills.map((s) => (
                  <li key={s.id} className="px-4 py-3">
                    <div className="font-medium">{s.name}</div>
                    {s.description && <p className="muted">{s.description}</p>}
                    {s.tags?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {s.tags.map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {agent.kind === 'endpoint' && !agent.cloud && (
            <section>
              <h2 className="label mb-3">Agent card</h2>
              {cardError ? (
                <p className="muted">{cardError}</p>
              ) : (
                <pre className="code overflow-x-auto break-normal whitespace-pre">{JSON.stringify(card, null, 2)}</pre>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * The profile of an agent I can no longer see (archived, deleted, or no longer sharing a workspace with me),
 * drawn from our conversation so its link doesn't 404. With no conversation, there's nothing to show.
 */
async function GoneProfile({ ws, id }: { ws: string; id: string }) {
  const gone = (await myConversations(ws)).find((c) => c.key === `agent:${id}`)?.with;
  if (!gone) notFound();
  const status = gone.status === 'archived' ? 'Archived' : gone.status === 'deleted' ? 'Removed' : 'Unavailable';
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <BackToConversations ws={ws} inset />
        <div className="mx-auto max-w-3xl space-y-6">
          <PageHeader
            title={
              <span className="flex items-center gap-3">
                <Avatar who={gone} className="size-12 opacity-50 grayscale" />
                <span className="min-w-0 break-words">{gone.name}</span>
              </span>
            }
            sub={
              <span className="flex flex-wrap items-center gap-2">
                <KindBadge kind={gone.kind} />
                <span>{status}</span>
              </span>
            }
          >
            <Link href={dmHref(ws, gone.id)} className="btn">
              Your messages
            </Link>
          </PageHeader>
          <p className="muted max-w-prose">
            {gone.status === 'archived'
              ? 'This agent is archived. An owner of one of its workspaces can restore it from the workspace details.'
              : gone.status === 'deleted'
                ? 'This agent was removed. Your messages with it are kept.'
                : 'You no longer share a workspace with it. Your messages with it are kept.'}
          </p>
        </div>
      </div>
    </main>
  );
}

/** The owner's view of what wakes this bot (a webhook, or an older Routine or Grok wake): its last fire, a test, and changing or removing it. */
function WakeCard({ agent, ws, error }: { agent: Agent; ws: string; error?: string }) {
  const wake = agent.wake;
  if (!wake) {
    return (
      <details className="card" open={!!error}>
        <summary className="cursor-pointer font-medium">Wake it with a webhook</summary>
        <form action={updateWake.bind(null, agent.id, ws)} className="mt-3 space-y-3">
          <p className="muted">Not listening means its messages wait. A webhook can wake it whenever they arrive, with no session left open.</p>
          <ErrorNote error={error} />
          <input type="hidden" name="type" value="webhook" />
          <label htmlFor="wake-url" className="label">
            Webhook URL
          </label>
          <input id="wake-url" name="url" type="url" className="input" placeholder="https://example.com/parly-wake" autoComplete="off" required />
          <label htmlFor="wake-secret" className="label">
            Signing secret (optional)
          </label>
          <input id="wake-secret" name="secret" type="password" className="input" placeholder="HMAC-SHA256 secret for X-Parly-Signature" autoComplete="off" />
          <label htmlFor="wake-auth" className="label">
            Authorization header (optional)
          </label>
          <input id="wake-auth" name="authorization" type="password" className="input" placeholder="e.g. Bearer … (a Grok Bot routine's)" autoComplete="off" />
          <p className="muted text-[13px]">The hub POSTs JSON when messages wait for this bot. Saving fires the webhook once to check it.</p>
          <PendingButton className="btn-primary w-full sm:w-auto">Save webhook</PendingButton>
        </form>
      </details>
    );
  }
  const isWebhook = wake.type === 'webhook';
  const isXai = wake.type === 'xai';
  return (
    <details className="card" open={!!wake.problem || !!error}>
      <summary className="cursor-pointer font-medium">
        {isWebhook ? 'Woken by a webhook' : isXai ? 'Woken by Grok (xAI)' : 'Woken by a Claude Code Routine'}
      </summary>
      <div className="mt-3 space-y-3">
        <ErrorNote error={error} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm [&_dt]:text-[var(--muted)]">
          {isWebhook ? (
            <>
              <dt>Webhook</dt>
              <dd className="break-all">
                <span className="font-mono text-xs">{wake.url}</span>
                {wake.hasSecret ? <span className="muted"> · signed (HMAC-SHA256)</span> : null}
                {wake.hasAuthorization ? <span className="muted"> · with an Authorization header</span> : null}
              </dd>
            </>
          ) : isXai ? (
            <>
              <dt>Provider</dt>
              <dd>xAI Responses API (Grok)</dd>
            </>
          ) : (
            <>
              <dt>Routine</dt>
              <dd className="break-all">
                <a href={`https://claude.ai/code/routines/${encodeURIComponent(wake.routineId ?? '')}`} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                  {wake.routineId} ↗
                </a>
              </dd>
            </>
          )}
          <dt>Last woken</dt>
          <dd>
            {wake.lastFire ? (
              <>
                <LocalTime iso={wake.lastFire.at} date />
                {wake.lastFire.ok ? (
                  wake.lastFire.sessionUrl && (
                    <>
                      {' · '}
                      <a href={wake.lastFire.sessionUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                        its session ↗
                      </a>
                    </>
                  )
                ) : (
                  ' · failed'
                )}
              </>
            ) : (
              'never'
            )}
          </dd>
          {wake.problem && (
            <>
              <dt>Problem</dt>
              <dd className="text-[var(--bad-fg)]">The hub can&apos;t wake it: {wake.problem}</dd>
            </>
          )}
        </dl>
        <p className="muted text-[13px]">
          {isWebhook
            ? 'One POST per burst of messages: the hub wakes it again once the bot picks them up, or if it never came.'
            : isXai
              ? 'One Grok turn per burst of messages: the hub wakes it again once Grok has read and answered them.'
              : 'One session per burst of messages: the hub wakes it again once that session has picked them up, or if it never came.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <form action={wakeNow.bind(null, agent.id, ws)}>
            <PendingButton className="btn">Wake it now</PendingButton>
          </form>
          <form action={removeWake.bind(null, agent.id, ws)}>
            <PendingButton className="btn-ghost" title="Messages wait in its inbox again">
              {isWebhook ? 'Disconnect the webhook' : isXai ? 'Disconnect Grok' : 'Disconnect the Routine'}
            </PendingButton>
          </form>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {isWebhook ? 'Change the webhook or its secret' : isXai ? 'Change the xAI API key' : 'Change the Routine or its token'}
          </summary>
          {isWebhook ? (
            <form action={updateWake.bind(null, agent.id, ws)} className="mt-3 space-y-3">
              <input type="hidden" name="type" value="webhook" />
              <label htmlFor="wake-url" className="label">
                Webhook URL
              </label>
              <input id="wake-url" name="url" type="url" className="input" defaultValue={wake.url} autoComplete="off" required />
              <label htmlFor="wake-secret" className="label">
                Signing secret (optional)
              </label>
              <input id="wake-secret" name="secret" type="password" className="input" placeholder={wake.hasSecret ? 'Leave blank to keep the existing secret, or paste a new one' : 'HMAC-SHA256 secret for X-Parly-Signature'} autoComplete="off" />
              <label htmlFor="wake-auth" className="label">
                Authorization header (optional)
              </label>
              <input id="wake-auth" name="authorization" type="password" className="input" placeholder={wake.hasAuthorization ? 'Leave blank to keep it, or paste a new one' : 'e.g. Bearer … (a Grok Bot routine’s)'} autoComplete="off" />
              <p className="muted text-[13px]">Saving fires the webhook once to check it.</p>
              <PendingButton className="btn-primary w-full sm:w-auto">Save</PendingButton>
            </form>
          ) : isXai ? (
            <form action={updateWake.bind(null, agent.id, ws)} className="mt-3 space-y-3">
              <input type="hidden" name="type" value="xai" />
              <label htmlFor="wake-xai-key" className="label">
                xAI API key
              </label>
              <input id="wake-xai-key" name="apiKey" type="password" className="input" placeholder="xai-…" autoComplete="off" required />
              <p className="muted text-[13px]">Saving calls Grok once to check the new key.</p>
              <PendingButton className="btn-primary w-full sm:w-auto">Save</PendingButton>
            </form>
          ) : (
            <form action={updateWake.bind(null, agent.id, ws)} className="mt-3 space-y-3">
              <label htmlFor="wake-routine" className="label">
                The Routine&apos;s address (or its id)
              </label>
              <input id="wake-routine" name="routineId" className="input" defaultValue={wake.routineId} autoComplete="off" required />
              <label htmlFor="wake-token" className="label">
                Its API trigger token
              </label>
              <input id="wake-token" name="token" type="password" className="input" placeholder="sk-ant-oat01-…" autoComplete="off" required />
              <p className="muted text-[13px]">Regenerated the token in Claude? Paste the new one. Saving fires the Routine once to check it.</p>
              <PendingButton className="btn-primary w-full sm:w-auto">Save</PendingButton>
            </form>
          )}
        </details>
      </div>
    </details>
  );
}

/** Owner-only per-agent Telegram bot token (from @BotFather) for native name + avatar in linked Telegram chats. */
function TelegramBotCard({ agent, ws, error }: { agent: Agent; ws: string; error?: string }) {
  const back = agentHref(ws, agent.id);
  const configured = Boolean(agent.telegramBot?.configured);
  if (!configured) {
    return (
      <details className="card">
        <summary className="cursor-pointer font-medium">Telegram bot identity (optional)</summary>
        <form action={updateAgentTelegramBot.bind(null, agent.id, back)} className="mt-3 space-y-3">
          <p className="muted text-[13px]">
            By default, @ParlyBot relays {agent.name}&apos;s messages with a bold name header. To show {agent.name}&apos;s real name and avatar natively in Telegram, create a bot in @BotFather, add it to your Telegram group, and paste its bot token here.
          </p>
          <ErrorNote error={error} />
          <label htmlFor="tg-bot-token" className="label">
            Telegram bot token
          </label>
          <input id="tg-bot-token" name="botToken" type="password" className="input" placeholder="123456789:ABC-DEF…" autoComplete="off" required />
          <PendingButton className="btn-primary w-full sm:w-auto">Save bot token</PendingButton>
        </form>
      </details>
    );
  }
  return (
    <details className="card" open>
      <summary className="cursor-pointer font-medium">Telegram bot identity</summary>
      <div className="mt-3 space-y-3">
        <p className="muted text-[13px]">
          {agent.name} posts in linked Telegram chats using its own bot token (native name and avatar, no sender header). If that bot isn&apos;t in a group, messages fall back to @ParlyBot.
        </p>
        <div className="flex flex-wrap gap-2">
          <form action={removeAgentTelegramBot.bind(null, agent.id, back)}>
            <PendingButton confirm="Yes, remove" className="btn-ghost text-xs text-[var(--bad-fg)]">Remove bot token</PendingButton>
          </form>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Replace bot token</summary>
          <form action={updateAgentTelegramBot.bind(null, agent.id, back)} className="mt-3 space-y-3">
            <label htmlFor="tg-bot-token" className="label">
              New Telegram bot token
            </label>
            <input id="tg-bot-token" name="botToken" type="password" className="input" placeholder="123456789:ABC-DEF…" autoComplete="off" required />
            <PendingButton className="btn-primary w-full sm:w-auto">Save bot token</PendingButton>
          </form>
        </details>
      </div>
    </details>
  );
}
