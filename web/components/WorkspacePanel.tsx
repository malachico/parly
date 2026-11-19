import Link from 'next/link';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { ErrorNote } from '@/components/ui';
import {
  addToWorkspace,
  addWorkspaceOwner,
  connectSlack,
  connectWorkspaceTelegram,
  disconnectWorkspaceTelegram,
  inviteByEmail,
  leaveWorkspace,
  linkWorkspaceChannelTelegram,
  removeFromWorkspace,
  renameWorkspace,
  revokeInvite,
  setDomains,
  setWorkspaceArchived,
  setWorkspacePublic,
  unlinkWorkspaceChannelTelegram,
} from '@/lib/actions';
import type { Agent, Invite, Workspace, WorkspaceSlackStatus, WorkspaceTelegramStatus } from '@/lib/hub';
import { plural } from '@/lib/plural';
import { atPlanCap, isBillingOwner, planCapMessage, type PlanUsage } from '@/lib/plan-limits';
import { agentHref, dmHref } from '@/lib/routes';
import { PendingButton } from '@/components/PendingButton';

type Props = {
  workspace: Workspace;
  meId: string;
  members: Agent[];
  invites: Invite[];
  /** Bots I can see that aren't in the workspace: mine, public ones, ones from workspaces I share. */
  candidates: Agent[];
  /** Whether the viewer belongs to at least one other active (non-archived) workspace, allowing this one to be archived. */
  hasOtherWorkspace?: boolean;
  /** Flash cookie: the address just invited. */
  invited?: string;
  slack?: WorkspaceSlackStatus;
  slackInstalled?: boolean;
  telegram?: WorkspaceTelegramStatus;
  error?: string;
  closeHref: string;
};

/**
 * Workspace details, filling the panel over the canvas (its close button is the panel's own): who's in it and adding
 * more at the top, then settings (email domains) and integrations (Slack, Telegram), then archiving and leaving.
 */
export function WorkspacePanel({ workspace, meId, members, invites, candidates, hasOtherWorkspace, invited, slack, slackInstalled, telegram, error, closeHref }: Props) {
  const id = workspace.id;
  const isOwner = (agentId: string) => workspace.owners?.includes(agentId) ?? false;
  const people = members.filter((m) => m.kind === 'human');
  const agents = members.filter((m) => m.kind !== 'human');
  const showSlack = Boolean(slack?.canManage && (slack.configured || slack.install));
  const showTelegram = Boolean(workspace.owner || (telegram?.canManage && (telegram.configured || telegram.chats.length > 0)));
  const telegramChats = telegram?.chats ?? [];
  const telegramLinks = telegram?.links ?? [];
  const activeChannels = (workspace.channels ?? []).filter((c) => !c.archived);
  const isPublicWorkspace = Boolean(workspace.public || workspace.publicShowcase);
  const canAddMembers = workspace.owner || !isPublicWorkspace;
  const canArchive = workspace.owner && (Boolean(workspace.archived) || Boolean(hasOtherWorkspace));
  const canLeave = meId !== workspace.owners?.[0];
  // Hub may omit participants until PR A; fall back to live members + pending invites.
  const participants: PlanUsage = workspace.participants ?? {
    count: members.filter((m) => !m.archived).length + invites.length,
    max: null,
  };
  const atCap = atPlanCap(participants);
  const canUpgrade = isBillingOwner(workspace.owners, meId);

  const memberRow = (m: Agent) => {
    const memberHref = m.id === meId ? agentHref(id, m.id) : dmHref(id, m.id);
    const row = (
      <>
        <Link href={memberHref} title={m.id === meId ? 'Your profile' : `Message ${m.name}`} className="shrink-0 rounded-full">
          <Avatar who={m} className="size-8" presence={!m.archived} />
        </Link>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Link href={memberHref} className="truncate font-medium hover:underline">
            {m.name}
          </Link>
          {m.id === meId && <span className="shrink-0 text-[13px] text-[var(--muted)]">you</span>}
        </span>
        {isOwner(m.id) && <span className="chip shrink-0">owner</span>}
        {m.archived && <span className="chip shrink-0">archived</span>}
      </>
    );
    const canMakeOwner = !isOwner(m.id);
    const canRemove = m.id !== workspace.owners?.[0];
    if (!workspace.owner || m.id === meId || (!canMakeOwner && !canRemove)) {
      return (
        <li key={m.id} className="flex min-h-14 items-center gap-3 px-4">
          {row}
        </li>
      );
    }
    return (
      <li key={m.id}>
        <details name="manage-member" className="group open:bg-[var(--bg)]">
          <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4" aria-label={`Manage ${m.name}`}>
            {row}
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)] group-open:bg-[var(--subtle)] group-open:text-[var(--fg)]">
              <Icon name="more" size={18} />
            </span>
          </summary>
          <div className="flex flex-wrap gap-2 px-4 pb-3 pl-[60px]">
            {canMakeOwner && (
              <form action={addWorkspaceOwner.bind(null, id, m.id)}>
                <PendingButton className="btn-ghost min-h-9 text-[13px]">Make owner</PendingButton>
              </form>
            )}
            {canRemove && (
              <form action={removeFromWorkspace.bind(null, id, m.id)}>
                <PendingButton confirm="Yes, remove" className="btn-ghost min-h-9 text-[13px] text-[var(--bad-fg)]" aria-label={`Remove ${m.name}`}>
                  Remove from workspace
                </PendingButton>
              </form>
            )}
          </div>
        </details>
      </li>
    );
  };

  return (
    <main aria-label="Workspace details" className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 pb-[max(24px,env(safe-area-inset-bottom))] sm:px-7">
        <Link
          href={closeHref}
          aria-label="Back to the canvas"
          className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden"
        >
          <Icon name="back" size={22} />
        </Link>
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          <header className="flex items-center gap-4">
            <span className="avatar avatar-accent size-14 text-2xl" aria-hidden>
              {workspace.name.trim().charAt(0).toUpperCase() || '#'}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="page-title truncate">{workspace.name}</h1>
                {isPublicWorkspace && <span className="chip">🌐 Public</span>}
              </div>
              <span className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
                {plural(people.length, 'person', 'people')} · {plural(agents.length, 'agent', 'agents')}
                {participants.max != null && (
                  <span>
                    · {participants.count}/{participants.max} participants
                  </span>
                )}
                {workspace.archived && <span className="chip">archived</span>}
              </span>
            </div>
          </header>

          <ErrorNote error={error} />

          {canAddMembers && (
            <section className="flex flex-col gap-3">
              <h2 className="label">Add to this workspace</h2>
              {atCap && participants.max != null ? (
                <div role="status" className="card flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">
                      {planCapMessage('participants', { count: participants.count, max: participants.max })}
                      {canUpgrade ? ', upgrade to add more' : ''}
                    </p>
                    <p className="text-[13px] text-[var(--muted)]">
                      {canUpgrade
                        ? 'Remove someone or archive an agent, or upgrade your plan.'
                        : 'Remove someone or archive an agent, or ask the workspace owner to upgrade.'}
                    </p>
                  </div>
                  {canUpgrade && (
                    <Link href="/billing" className="btn-primary shrink-0 justify-center">
                      Upgrade
                    </Link>
                  )}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <form action={inviteByEmail.bind(null, id)} className="card flex flex-col gap-3">
                    <span className="flex items-center gap-2 font-medium">
                      <Icon name="person" size={18} /> Invite a person
                    </span>
                    <label htmlFor="invite-email" className="sr-only">
                      Email
                    </label>
                    <input id="invite-email" name="email" type="email" required placeholder="name@example.com" className="input" autoComplete="off" />
                    <PendingButton className="btn mt-auto">Send invite</PendingButton>
                  </form>
                  <div className="card flex flex-col gap-3">
                    <span className="flex items-center gap-2 font-medium">
                      <Icon name="plug" size={18} /> Add an agent
                    </span>
                    {candidates.length > 0 ? (
                      <form action={addToWorkspace.bind(null, id)} className="flex flex-1 flex-col gap-3">
                        <label htmlFor="add-bot" className="sr-only">
                          Agent
                        </label>
                        <select id="add-bot" name="agent" required className="input" defaultValue="">
                          <option value="" disabled>
                            Pick an agent you can see
                          </option>
                          {candidates.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                              {a.ownerId === meId ? ' (your agent)' : a.public ? ' (public)' : a.description ? ` · ${a.description.slice(0, 40)}` : ''}
                            </option>
                          ))}
                        </select>
                        <PendingButton className="btn mt-auto">Add agent</PendingButton>
                      </form>
                    ) : (
                      <p className="text-[13px] text-[var(--muted)]">
                        No agents to add yet.{' '}
                        <Link href="/connect" className="text-[var(--accent)] hover:underline">
                          Connect one
                        </Link>{' '}
                        and it shows up here.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {invited && (
                <p className="rounded-lg bg-[var(--subtle)] px-3 py-2 text-[13px]">
                  Invited <span className="font-medium">{invited}</span>. They join as soon as they sign in with Google.
                </p>
              )}
            </section>
          )}

          <section className="flex flex-col gap-3">
            <h2 className="label">People · {people.length + invites.length}</h2>
            <ul className="list">
              {people.map(memberRow)}
              {invites.map((inv) => (
                <li key={inv.email} className="flex min-h-14 items-center gap-3 px-4">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl border border-dashed border-[var(--border-strong)] text-[var(--muted)]">
                    <Icon name="person" size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{inv.email}</span>
                    <span className="block truncate text-xs text-[var(--muted)]">Invited by {inv.invitedBy} · hasn&apos;t signed in yet</span>
                  </span>
                  <form action={revokeInvite.bind(null, id, inv.email)}>
                    <PendingButton className="link-quiet min-h-10 px-1" aria-label={`Cancel invite for ${inv.email}`}>
                      Cancel
                    </PendingButton>
                  </form>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="label">Agents · {agents.length}</h2>
            {agents.length > 0 ? (
              <ul className="list">{agents.map(memberRow)}</ul>
            ) : (
              <p className="card text-[13px] text-[var(--muted)]">No agents in this workspace yet. Add one above.</p>
            )}
          </section>

          {workspace.owner && (
            <section className="flex flex-col gap-3">
              <h2 className="label">Settings</h2>
              <div className="list">
                <form action={renameWorkspace.bind(null, id)} className="flex flex-col gap-3 p-4">
                  <label htmlFor="workspace-name" className="font-medium">
                    Workspace name
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="workspace-name"
                      name="name"
                      required
                      maxLength={64}
                      defaultValue={workspace.name}
                      className="input min-w-0 flex-1"
                      autoComplete="off"
                    />
                    <PendingButton className="btn-ghost shrink-0">Save name</PendingButton>
                  </div>
                </form>
                <form action={setDomains.bind(null, id)} className="flex flex-col gap-3 p-4">
                  <div>
                    <label htmlFor="domains" className="font-medium">
                      Join by email domain
                    </label>
                    <p className="text-[13px] text-[var(--muted)]">
                      Anyone who signs in with one of these domains joins on their own. One per line; each must be a workspace owner&apos;s own Google sign-in domain, and public mail providers (gmail.com…) aren&apos;t allowed.
                    </p>
                  </div>
                  <textarea
                    id="domains"
                    name="domains"
                    rows={2}
                    placeholder="acme.com"
                    defaultValue={(workspace.domains ?? []).join('\n')}
                    className="input font-mono text-sm"
                    autoComplete="off"
                  />
                  <PendingButton className="btn-ghost self-start">Save domains</PendingButton>
                </form>
                <div className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-medium">Public workspace</span>
                      <p className="text-[13px] text-[var(--muted)]">
                        {isPublicWorkspace
                          ? 'Anyone with a public channel link can click Join to enter that channel as a participate-only guest. Private channels and non-joined members stay hidden.'
                          : 'Let anyone with a public channel link join as a participate-only guest. Existing internal channels are never opened automatically.'}
                      </p>
                    </div>
                    {isPublicWorkspace && (
                      <form action={setWorkspacePublic.bind(null, id, false, undefined)}>
                        <PendingButton className="btn-ghost shrink-0">Make workspace private</PendingButton>
                      </form>
                    )}
                  </div>
                  {!isPublicWorkspace && (
                    <details className="rounded-xl border border-[var(--border)] bg-[var(--subtle)] p-3">
                      <summary className="cursor-pointer text-sm font-medium">Choose channels &amp; make public…</summary>
                      <form action={setWorkspacePublic.bind(null, id, true)} className="mt-3 flex flex-col gap-3">
                        <p className="text-xs text-[var(--muted)]">
                          Select which channels visitors can view and join publicly. Any unchecked channel stays private to your core team.
                        </p>
                        {activeChannels.length > 0 ? (
                          <div className="flex flex-col gap-1.5">
                            {activeChannels.map((c) => (
                              <label key={c.id} className="flex items-center gap-2 text-sm">
                                <input type="checkbox" name="publicChannels" value={c.id} defaultChecked={Boolean(c.public)} />
                                <span className="font-medium"># {c.name}</span>
                                <span className="text-xs text-[var(--muted)]">{c.public ? '(already public)' : '(internal — unchecked stays private)'}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-[var(--muted)]">No active channels yet.</p>
                        )}
                        <PendingButton className="btn-primary self-start text-sm">Confirm &amp; make workspace public</PendingButton>
                      </form>
                    </details>
                  )}
                </div>
              </div>
            </section>
          )}

          {(showSlack || showTelegram) && (
            <section className="flex flex-col gap-3">
              <h2 className="label">Integrations</h2>
              <div className="list">
                {showSlack && slack && (
                  <div className="flex flex-col gap-3 p-4">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">Slack</span>
                      {slack.install && !slack.install.problem && <span className="chip">connected</span>}
                    </div>
                    {slackInstalled && (
                      <p className="rounded-lg border border-[var(--accent)] bg-[var(--subtle)] px-3 py-2 text-[13px]">
                        {workspace.room
                          ? <>Slack connected! Invite <span className="font-mono">@Parly</span> to your two Slack channels, then link them from the room&apos;s shared channel.</>
                          : <>Slack connected! Type <span className="font-mono">/invite @Parly</span> in a Slack channel: it gets its Parly channel, linked.</>}
                      </p>
                    )}
                    {slack.install ? (
                      <>
                        <p className="text-sm">
                          Connected to <span className="font-semibold">{slack.install.teamName}</span>
                          {workspace.room?.mySide ? ` (${workspace.room.mySide.name})` : ''}.
                        </p>
                        {slack.install.problem ? (
                          <p className="text-[13px] text-[var(--bad-fg)]">{slack.install.problem}</p>
                        ) : (
                          <p className="text-[13px] text-[var(--muted)]">
                            {workspace.room ? (
                              <>
                                Invite <span className="font-mono">@Parly</span> to a Slack channel, then open a channel&apos;s details panel and choose{' '}
                                <span className="font-medium">Link to Slack</span>.
                              </>
                            ) : (
                              <>
                                Type <span className="font-mono">/invite @Parly</span> in a Slack channel and it&apos;s linked to the Parly channel of the same name (made
                                if there&apos;s none).
                              </>
                            )}{' '}
                            In Slack, every agent posts through the Parly app under its own name.
                          </p>
                        )}
                        {slack.configured && (
                          <form action={connectSlack.bind(null, id)}>
                            <PendingButton className={slack.install.problem ? 'btn' : 'btn-ghost'}>Reconnect Slack</PendingButton>
                          </form>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-[13px] text-[var(--muted)]">
                          {workspace.room?.mySide
                            ? `Connect ${workspace.room.mySide.name}'s Slack workspace to mirror the room's shared channel and your side's private corner. In Slack, every agent posts through the Parly app under its own name.`
                            : 'Connect your Slack workspace so you can mirror linked channels both ways. In Slack, every agent posts through the Parly app under its own name.'}
                        </p>
                        <form action={connectSlack.bind(null, id)}>
                          <PendingButton className="btn">Connect Slack</PendingButton>
                        </form>
                      </>
                    )}
                  </div>
                )}
                {showTelegram && (
                  <WorkspaceTelegramSection
                    workspaceId={id}
                    workspaceName={workspace.name}
                    chats={telegramChats}
                    links={telegramLinks}
                    channels={activeChannels}
                  />
                )}
              </div>
            </section>
          )}

          {(canArchive || canLeave) && (
            <section className="flex flex-col gap-3">
              <h2 className="label">Danger zone</h2>
              <div className="list">
                {canArchive && (
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1 basis-60">
                      <p className="font-medium">{workspace.archived ? 'Restore workspace' : 'Archive workspace'}</p>
                      <p className="text-[13px] text-[var(--muted)]">
                        {workspace.archived
                          ? 'Archived: its history and members stay, and nobody can post in its channels until it is restored.'
                          : 'Keeps the history and members; nobody can post in its channels until it is restored.'}
                      </p>
                    </div>
                    <form action={setWorkspaceArchived.bind(null, id, !workspace.archived)}>
                      <PendingButton className="btn-ghost">{workspace.archived ? 'Restore' : 'Archive'}</PendingButton>
                    </form>
                  </div>
                )}
                {canLeave && (
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1 basis-60">
                      <p className="font-medium">Leave {workspace.name}</p>
                      <p className="text-[13px] text-[var(--muted)]">You lose access to its channels and conversations.</p>
                    </div>
                    <form action={leaveWorkspace.bind(null, id)}>
                      <PendingButton confirm="Yes, leave" className="btn-ghost text-[var(--bad-fg)]">Leave</PendingButton>
                    </form>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function WorkspaceTelegramSection({
  workspaceId,
  workspaceName,
  chats,
  links,
  channels,
}: {
  workspaceId: string;
  workspaceName: string;
  chats: WorkspaceTelegramStatus['chats'];
  links: WorkspaceTelegramStatus['links'];
  channels: NonNullable<Workspace['channels']>;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="font-medium">Telegram</span>
        {chats.length > 0 && <span className="chip">connected</span>}
      </div>
      <p className="text-[13px] text-[var(--muted)]">
        Add <span className="font-mono">@ParlyBot</span> to your Telegram supergroup with <span className="font-medium">Topics</span> enabled, then connect the supergroup here once for <span className="font-medium">{workspaceName}</span>. Individual forum topics map to channels.
      </p>
      {chats.length > 0 && (
        <ul className="flex flex-col gap-2">
          {chats.map((chat) => (
            <li key={chat.chatId} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                {chat.title ? (
                  <>
                    <span className="font-medium">{chat.title}</span>{' '}
                    <span className="font-mono text-xs text-[var(--muted)]">({chat.chatId})</span>
                  </>
                ) : (
                  <span className="font-mono text-[13px]">{chat.chatId}</span>
                )}
              </div>
              <form action={disconnectWorkspaceTelegram.bind(null, workspaceId, chat.chatId)}>
                <PendingButton confirm="Yes, disconnect" className="btn-ghost text-[13px] text-[var(--bad-fg)]">Disconnect</PendingButton>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={connectWorkspaceTelegram.bind(null, workspaceId)} className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="workspace-telegram-chat-id" className="sr-only">
            Telegram supergroup chat ID or link
          </label>
          <input
            id="workspace-telegram-chat-id"
            name="chatId"
            required
            dir="auto"
            placeholder="Supergroup Chat ID (-100…) or t.me/c/… link"
            defaultValue={chats[0]?.chatId ?? ''}
            className="input min-w-0 flex-1"
          />
          <label htmlFor="workspace-telegram-title" className="sr-only">
            Group name (optional)
          </label>
          <input
            id="workspace-telegram-title"
            name="title"
            dir="auto"
            placeholder="Group name (optional)"
            defaultValue={chats[0]?.title ?? ''}
            className="input sm:w-44"
          />
        </div>
        <PendingButton className="btn self-start">{chats.length > 0 ? 'Update Telegram group' : 'Connect Telegram group'}</PendingButton>
      </form>
      {(chats.length > 0 || links.length > 0) && (
        <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
          <span className="text-xs font-semibold tracking-wider text-[var(--muted)] uppercase">Channel ↔ Topic mappings</span>
          {links.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {links.map((link) => (
                <li key={`${link.channelId}:${link.chatId}:${link.topicId ?? 'root'}`} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--subtle)] px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium"># {link.channelName}</span>
                    <span className="mx-1.5 text-[var(--muted)]">↔</span>
                    <span className="font-mono text-xs text-[var(--muted)]">
                      {link.topicId !== undefined ? `topic #${link.topicId}` : link.chatId}
                    </span>
                    {link.paused && <span className="ml-1.5 text-xs text-[var(--bad-fg)]">(paused)</span>}
                  </span>
                  <form action={unlinkWorkspaceChannelTelegram.bind(null, workspaceId, link.channelId, link.chatId, link.topicId)}>
                    <PendingButton confirm="Yes, unlink" className="btn-ghost text-xs text-[var(--bad-fg)]">Unlink</PendingButton>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[var(--muted)]">No channels mapped to topics yet. Map one below or from any channel&apos;s Settings tab.</p>
          )}
          {channels.length > 0 && chats[0] && (
            <form action={linkWorkspaceChannelTelegram.bind(null, workspaceId)} className="flex flex-wrap items-center gap-2 pt-1">
              <input type="hidden" name="chatId" value={chats[0].chatId} />
              <label htmlFor="workspace-tg-channel" className="sr-only">
                Channel
              </label>
              <select id="workspace-tg-channel" name="channelId" required className="input min-w-0 flex-1 text-sm" defaultValue={channels[0]?.id ?? ''}>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    # {c.name}
                  </option>
                ))}
              </select>
              <label htmlFor="workspace-tg-topic" className="sr-only">
                Topic ID
              </label>
              <input
                id="workspace-tg-topic"
                name="topicId"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Topic ID (e.g. 42)"
                className="input w-36 text-sm"
              />
              <PendingButton className="btn-ghost text-sm">Map topic</PendingButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
