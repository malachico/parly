import Link from 'next/link';
import { Avatar, AvatarStack } from '@/components/Avatar';
import { PanelTabs } from '@/components/PanelTabs';
import { CopyButton } from '@/components/CopyButton';
import { ChannelKnowledge } from '@/components/ChannelKnowledge';
import { ScheduleList } from '@/components/ScheduleList';
import { SkillsSection } from '@/components/SkillsSection';
import { Icon } from '@/components/Icon';
import { LocalTime } from '@/components/LocalTime';
import { ErrorNote } from '@/components/ui';
import { addChannelOwner, addToChannel, createWebhook, deleteWebhook, leaveChannel, linkChannelSlack, linkChannelTelegram, setChannelContext, setChannelPublic, removeFromChannel, renameChannel, setChannelArchived, setChannelOpen, setChannelRole, unlinkChannelSlack, unlinkChannelTelegram } from '@/lib/actions';
import type { Agent, Channel, Schedule, ScopedSkillView, SkillSummaryView, Webhook, Workspace, WorkspaceSlackStatus, WorkspaceTelegramStatus } from '@/lib/hub';
import { agentHref, channelHref, dmHref, triggersHref, wsHref } from '@/lib/routes';
import { PendingButton } from '@/components/PendingButton';
import { plural } from '@/lib/plural';

type Props = {
  /** A showcase guest: no DMs to the showcase's agents, so their names open profiles. */
  guest?: boolean;
  initialTab?: 'settings';
  workspaceId: string;
  channel: Channel;
  room?: Workspace['room'];
  slack?: WorkspaceSlackStatus;
  telegram?: WorkspaceTelegramStatus;
  meId: string;
  /** The hub's knowledge graph is on: show the Knowledge tab. */
  graph?: boolean;
  members: Agent[];
  /** Workspace members (people and bots) who aren't in the channel yet. */
  candidates: Agent[];
  error?: string;
  closeHref: string;
  /** An incoming webhook URL createWebhook just made, shown once. */
  webhookUrl?: string;
  /** The channel's scheduled messages. */
  schedules: Schedule[];
  webhooks: Webhook[];
  skills?: ScopedSkillView[];
  librarySkills?: SkillSummaryView[];
};

/** A team's details beside its conversation: who's in it (and adding them), its skills & processes, its automations (schedules and webhooks), and its settings (name, context, visibility, Slack, Telegram, archive/leave). */
export function ChannelPanel({ guest = false, initialTab, workspaceId, channel, room, slack, telegram, meId, graph, members, candidates, error, closeHref, webhookUrl, schedules, webhooks, skills = [], librarySkills = [] }: Props) {
  const id = channel.id;
  const isOwner = (agentId: string) => channel.owners?.includes(agentId) ?? false;
  const people = members.filter((m) => m.kind === 'human').length;
  const agents = members.length - people;
  const card = 'flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4';

  const membersTab = (
    <>
      <ErrorNote error={error} />
      {candidates.length > 0 && (
        <form action={addToChannel.bind(null, workspaceId, id)} className={card}>
          <h3 className="font-semibold">Add to the team</h3>
          <div className="flex gap-2">
            <label htmlFor="add-member" className="sr-only">
              Who
            </label>
            <select id="add-member" name="agent" required className="input min-w-0 flex-1" defaultValue="">
              <option value="" disabled>
                Pick a person or an agent
              </option>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.kind === 'human' ? ' (person)' : a.ownerId === meId ? ' (your agent)' : a.description ? ` · ${a.description.slice(0, 40)}` : ''}
                </option>
              ))}
            </select>
            <PendingButton className="btn-primary shrink-0">Add</PendingButton>
          </div>
          {channel.owner && (
            <input
              name="role"
              dir="auto"
              maxLength={40}
              list="role-suggestions"
              placeholder="Its role here (optional): reviewer, QA, researcher…"
              aria-label="Role in this team (optional)"
              className="input py-1.5 text-[13px]"
            />
          )}
          <p className="text-xs text-[var(--muted)]">
            Someone new?{' '}
            <Link href={wsHref(workspaceId, { panel: 'workspace' })} className="text-[var(--accent)] hover:underline">
              Invite them to the workspace
            </Link>{' '}
            first.
          </p>
        </form>
      )}

      <section className="flex flex-col gap-1">
        <h3 className="label mb-1">
          {plural(members.length, 'member', 'members')}
        </h3>
        <ul className="flex flex-col gap-1">
          {members.map((m) => {
            const canManage = channel.owner && m.id !== meId;
            const memberHref = m.id === meId || (guest && m.kind !== 'human') ? agentHref(workspaceId, m.id) : dmHref(workspaceId, m.id);
            const row = (
              <>
                <Link href={memberHref} title={m.id === meId ? 'Your profile' : `Message ${m.name}`} className="shrink-0 rounded-full">
                  <Avatar who={m} className="size-9 shrink-0" presence={!m.archived} />
                </Link>
                <span className="flex min-w-0 flex-1 flex-col">
                  <Link href={memberHref} className="truncate text-sm font-medium hover:underline">
                    {m.name}
                    {m.id === meId && <span className="font-normal text-[var(--muted)]"> (you)</span>}
                  </Link>
                  <span className="truncate text-xs text-[var(--muted)]">
                    {[channel.roles?.[m.id], isOwner(m.id) && 'owner', m.kind === 'human' ? 'person' : 'agent', m.archived && 'archived'].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </>
            );
            if (!channel.owner) {
              return (
                <li key={m.id} className="flex min-h-12 items-center gap-3 rounded-xl px-2">
                  {row}
                </li>
              );
            }
            // Actions open under the member; `name` keeps one open at a time.
            return (
              <li key={m.id}>
                <details name="manage-member" className="group rounded-xl open:bg-[var(--bg)]">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-xl px-2 hover:bg-[var(--subtle)] [&::-webkit-details-marker]:hidden" aria-label={`Manage ${m.name}`}>
                    {row}
                    <Icon name="more" size={16} className="shrink-0 text-[var(--muted)]" />
                  </summary>
                  <div className="flex flex-col gap-2 px-2 pt-1 pb-3 pl-14">
                    <form action={setChannelRole.bind(null, workspaceId, id, m.id)} className="flex gap-1.5">
                      <label htmlFor={`role-${m.id}`} className="sr-only">
                        Role of {m.name}
                      </label>
                      <input id={`role-${m.id}`} name="role" dir="auto" maxLength={40} list="role-suggestions" defaultValue={channel.roles?.[m.id] ?? ''} placeholder="Role, e.g. reviewer" className="input py-1.5 text-[13px]" />
                      <PendingButton className="btn shrink-0 text-[13px]">Set role</PendingButton>
                    </form>
                    <div className="flex flex-wrap gap-1.5">
                      {canManage && !isOwner(m.id) && (
                        <form action={addChannelOwner.bind(null, workspaceId, id, m.id)}>
                          <PendingButton className="btn-ghost text-[13px]">Make owner</PendingButton>
                        </form>
                      )}
                      {canManage && m.id !== channel.owners?.[0] && (
                        <form action={removeFromChannel.bind(null, workspaceId, id, m.id)}>
                          <PendingButton confirm="Yes, remove" className="btn-ghost text-[13px] text-[var(--bad-fg)]" aria-label={`Remove ${m.name}`}>
                            Remove from the team
                          </PendingButton>
                        </form>
                      )}
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
        {channel.owner && (
          <datalist id="role-suggestions">
            {['reviewer', 'architect', 'implementer', 'QA', 'PM', 'researcher', 'EA', 'ops watch'].map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        )}
        {agents > 0 && <p className="mt-2 text-xs text-[var(--muted)]">An agent&apos;s owner can see what it reads and writes here.</p>}
      </section>
    </>
  );

  const skillsTab = (
    <SkillsSection
      ws={workspaceId}
      scope="channel"
      targetId={id}
      targetName={`#${channel.name}`}
      canManage={Boolean(channel.owner) && !channel.archived}
      effectiveSkills={skills}
      librarySkills={librarySkills}
      backHref={channelHref(workspaceId, id, { panel: 'channel' })}
    />
  );

  const automationsTab = (
    <>
      {channel.archived ? (
        <p className="text-sm text-[var(--muted)]">This team is archived: restore it in Settings to schedule messages or add webhooks.</p>
      ) : (
        <>
          <section className={card}>
            <div>
              <h3 className="font-semibold">Scheduled messages</h3>
              <p className="text-xs text-[var(--muted)]">Recurring or one-time messages posted here with ⏰; @name in one wakes an agent.</p>
            </div>
            <ScheduleList
              schedules={schedules}
              back={channelHref(workspaceId, id, { panel: 'channel' })}
              canChange={(s) => s.ownerId === meId || channel.owner}
              byName={(s) => `by ${members.find((m) => m.id === s.ownerId)?.name ?? 'someone no longer here'}`}
            />
            {/* New ones are made in Triggers (On a schedule), with everything else that wakes agents. */}
            <Link href={`${triggersHref(workspaceId)}/new?type=schedule`} className="text-sm text-[var(--accent)] hover:underline">
              + Schedule one in Triggers
            </Link>
          </section>
          <section className={card}>
            <div>
              <h3 className="font-semibold">Incoming webhooks</h3>
              <p className="text-xs text-[var(--muted)]">Let a service (CI, GitHub, alerts) post here. Its posts come from you, marked 🪝 and its name; @name in one wakes an agent.</p>
            </div>
            {webhooks.length > 0 && (
              <ul className="flex flex-col gap-2">
                {webhooks.map((w) => (
                  <li key={w.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="truncate text-sm">
                        🪝 {w.name}
                      </p>
                      <p className="text-[13px] text-[var(--muted)]">
                        by {members.find((m) => m.id === w.ownerId)?.name ?? 'someone no longer here'}
                        {w.lastUsedAt ? (
                          <>
                            {' · last post '}
                            <LocalTime iso={w.lastUsedAt} date />
                          </>
                        ) : (
                          ' · not used yet'
                        )}
                      </p>
                    </div>
                    {(w.ownerId === meId || channel.owner) && (
                      <form action={deleteWebhook.bind(null, workspaceId, id, w.id)}>
                        <PendingButton confirm="Yes, delete" className="btn-ghost text-[13px] text-[var(--bad-fg)]">Delete</PendingButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {webhookUrl ? (
              <>
                <p className="text-[13px] font-medium">Copy it now; it isn&apos;t shown again.</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-[var(--bg)] px-2 py-1.5 text-[13px]" title={webhookUrl}>
                    {webhookUrl}
                  </code>
                  <CopyButton value={webhookUrl} label="Copy webhook URL" />
                </div>
                <p className="text-xs text-[var(--muted)]">
                  POST <code>{'{"text": "…"}'}</code> to it, or paste it anywhere that takes a Slack webhook. GitHub works too (Settings → Webhooks). Add <code>?thread=&lt;post id&gt;</code> to post in a thread. To revoke it, delete it here.
                </p>
              </>
            ) : (
              <form action={createWebhook.bind(null, workspaceId, id)} className="flex gap-2">
                <label htmlFor="webhook-name" className="sr-only">
                  Its name
                </label>
                <input id="webhook-name" name="name" dir="auto" maxLength={64} placeholder="Its name, e.g. GitHub" className="input min-w-0 flex-1" />
                <PendingButton className="btn shrink-0">Create URL</PendingButton>
              </form>
            )}
          </section>
        </>
      )}
    </>
  );

  const settingsTab = (
    <>
      {channel.owner ? (
        <>
          <form action={renameChannel.bind(null, workspaceId, id)} className={card}>
            <label htmlFor="rename-channel" className="font-semibold">
              Name
            </label>
            <div className="flex gap-2">
              <input id="rename-channel" dir="auto" name="name" required maxLength={100} defaultValue={channel.name} className="input min-w-0 flex-1" />
              <PendingButton className="btn shrink-0">Rename</PendingButton>
            </div>
          </form>
          <form action={setChannelContext.bind(null, workspaceId, id)} className={card}>
            <label htmlFor="channel-context" className="font-semibold">
              Context
            </label>
            <p className="text-[13px] text-[var(--muted)]">What this channel is for: its purpose, links (repo, site) and standing rules. Every agent here gets it with each message.</p>
            <textarea id="channel-context" dir="auto" name="context" maxLength={1000} rows={4} defaultValue={channel.context ?? ''} placeholder="e.g. We build Lemonade Stand, a juice delivery app. Code: github.com/acme/lemonade. Every PR gets a review before it merges. Ask Dana about anything that costs money." className="input min-h-24 w-full" />
            <PendingButton className="btn w-fit">Save</PendingButton>
          </form>
          <section className={card}>
            <h3 className="font-semibold">Who can see it</h3>
            <form action={setChannelOpen.bind(null, workspaceId, id, !channel.open)} className="flex items-start justify-between gap-3">
              <span className="text-[13px]">
                <span className="block font-medium">{channel.open ? 'Open to the workspace' : 'Closed'}</span>
                <span className="text-[var(--muted)]">{channel.open ? 'Anyone in the workspace can find and join it.' : 'Only people and agents added by a member are in it.'}</span>
              </span>
              <PendingButton className="btn shrink-0 text-[13px]">{channel.open ? 'Close it' : 'Open it'}</PendingButton>
            </form>
            <form action={setChannelPublic.bind(null, workspaceId, id, !channel.public)} className="flex items-start justify-between gap-3 border-t border-[var(--border)] pt-3">
              <span className="text-[13px]">
                <span className="block font-medium">{channel.public ? '🌐 Public: anyone with the link can read it' : 'Private to its members'}</span>
                <span className="text-[var(--muted)]">
                  {channel.public ? (
                    <>
                      Read-only, from when it went public.{' '}
                      <Link href={`/p/${id}`} className="text-[var(--accent)] hover:underline">
                        Open the public page
                      </Link>
                    </>
                  ) : (
                    'Make it public to build in the open: messages from then on are readable by anyone with the link; its agents are told so.'
                  )}
                </span>
              </span>
              <PendingButton className="btn shrink-0 text-[13px]">{channel.public ? 'Make private' : 'Make public'}</PendingButton>
            </form>
          </section>
        </>
      ) : (
        <>
          {channel.context && (
            <section className={card}>
              <h3 className="font-semibold">Context</h3>
              <p dir="auto" className="whitespace-pre-wrap text-[13px]">{channel.context}</p>
            </section>
          )}
          <p className="text-sm text-[var(--muted)]">Only the team&apos;s owners change its name, context and who can see it.</p>
        </>
      )}
      <SlackChannelSection workspaceId={workspaceId} channel={channel} room={room} slack={slack} card={card} />
      <TelegramChannelSection workspaceId={workspaceId} channel={channel} telegram={telegram} card={card} />
      <section className="flex flex-col gap-3 rounded-2xl border border-[color-mix(in_srgb,var(--bad-fg)_30%,transparent)] p-4">
        <h3 className="font-semibold text-[var(--bad-fg)]">Danger zone</h3>
        {channel.owner && (
          <form action={setChannelArchived.bind(null, workspaceId, id, !channel.archived)} className="flex flex-col gap-2">
            {!channel.archived && Boolean(channel.slack?.length) && (
              <>
                <p className="text-[13px] text-[var(--muted)]">It&apos;s linked to Slack: while archived, messages written there won&apos;t reach Parly. Restoring it brings the link back.</p>
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" name="unlinkSlack" />
                  Also unlink it from Slack
                </label>
              </>
            )}
            {!channel.archived && Boolean(channel.telegram?.length) && (
              <>
                <p className="text-[13px] text-[var(--muted)]">It&apos;s linked to Telegram: while archived, messages written there won&apos;t reach Parly. Restoring it brings the link back.</p>
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" name="unlinkTelegram" />
                  Also unlink it from Telegram
                </label>
              </>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-[var(--muted)]">{channel.archived ? 'Archived: nobody can post until it is restored.' : 'Archiving keeps the history and members; nobody can post.'}</span>
              <PendingButton className="btn shrink-0 text-[13px]">{channel.archived ? 'Restore' : 'Archive'}</PendingButton>
            </div>
          </form>
        )}
        {meId !== channel.owners?.[0] && (
          <form action={leaveChannel.bind(null, workspaceId, id)} className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-[var(--muted)]">You stop getting its messages.</span>
            <PendingButton confirm="Yes, leave" className="btn shrink-0 text-[13px] text-[var(--bad-fg)]">Leave the team</PendingButton>
          </form>
        )}
      </section>
    </>
  );

  const customActiveSkills = skills.filter((s) => s.enabled && !s.skill.id.startsWith('builtin:')).length;
  const automations = schedules.length + webhooks.length;
  return (
    <aside aria-label="Channel details" className="flex h-full w-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg)] lg:w-[420px] lg:shrink-0">
      <header className="flex items-start gap-3 bg-[var(--surface)] px-4 pt-4 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h2 className="truncate text-xl font-bold"># {channel.name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <AvatarStack
              people={members}
              max={6}
              className="size-7"
              hrefOf={(p) => (p.webhookChannel ? undefined : p.id === meId || (guest && p.kind !== 'human') ? agentHref(workspaceId, p.id) : dmHref(workspaceId, p.id))}
            />
            <span className="text-xs text-[var(--muted)]">
              {plural(people, 'person', 'people')} · {plural(agents, 'agent', 'agents')}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[11px] font-medium">
            <span className="rounded-full bg-[var(--subtle)] px-2 py-0.5">{channel.open ? 'Open' : 'Closed'}</span>
            {channel.public && <Link href={`/p/${channel.id}`} className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[var(--accent)] hover:underline">🌐 Public link</Link>}
            {Boolean(channel.slack?.length) && <span className="rounded-full bg-[var(--subtle)] px-2 py-0.5">Slack linked</span>}
            {Boolean(channel.telegram?.length) && <span className="rounded-full bg-[var(--subtle)] px-2 py-0.5">Telegram linked</span>}
            {channel.archived && <span className="rounded-full bg-[var(--bad-bg)] px-2 py-0.5 text-[var(--bad-fg)]">Archived</span>}
          </div>
        </div>
        <Link href={closeHref} aria-label="Close details" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)]">
          <Icon name="close" size={20} />
        </Link>
      </header>
      <nav aria-label="Thread filter" className="flex gap-3 px-4 pb-3 text-xs">
        <Link href={channelHref(workspaceId, id)} className="text-[var(--accent)] hover:underline">Open threads</Link>
        <Link href={channelHref(workspaceId, id, { filter: 'done' })} className="text-[var(--accent)] hover:underline">Completed threads</Link>
      </nav>
      <PanelTabs
        key={initialTab ?? 'remembered'}
        storageKey={`parly.team-details.${id}`}
        initial={webhookUrl ? 'automations' : initialTab}
        tabs={[
          { id: 'members', label: 'Members', badge: members.length, content: membersTab },
          { id: 'skills', label: 'Skills', badge: customActiveSkills, content: skillsTab },
          { id: 'automations', label: 'Automations', badge: automations, content: automationsTab },
          // ponytail: PanelTabs mounts every tab, so this fetches when the panel opens even if hidden; fetch on tab show if it costs.
          ...(graph ? [{ id: 'knowledge', label: 'Knowledge', content: <ChannelKnowledge key={id} ws={workspaceId} channelId={id} /> }] : []),
          { id: 'settings', label: 'Settings', content: settingsTab },
        ]}
      />
    </aside>
  );
}

function SlackChannelSection({
  workspaceId,
  channel,
  room,
  slack,
  card,
}: {
  workspaceId: string;
  channel: Channel;
  room?: Workspace['room'];
  slack?: WorkspaceSlackStatus;
  card: string;
}) {
  const id = channel.id;
  if (!(room ? slack?.canManage : channel.owner) || !(slack?.configured || slack?.install || channel.slack?.length)) return null;
  const options = slack?.channels ?? [];
  return (
    <section className={card}>
      <h3 className="font-semibold">Slack</h3>
      {!slack?.install ? (
        <p className="text-[13px] text-[var(--muted)]">
          <Link href={wsHref(workspaceId, { panel: 'workspace' })} className="text-[var(--accent)] hover:underline">
            Connect Slack in workspace settings
          </Link>{' '}
          first, then link this channel.
        </p>
      ) : slack.install.problem ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] text-[var(--bad-fg)]">{slack.install.problem}</p>
          <Link href={wsHref(workspaceId, { panel: 'workspace' })} className="text-[13px] text-[var(--accent)] hover:underline">
            Reconnect Slack in workspace settings
          </Link>
        </div>
      ) : room ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-[13px] text-[var(--muted)]">
            Link <span className="font-medium">{room.mySide?.name ?? 'your side'}</span> (<span className="font-medium">{slack.install.teamName}</span>) to two Slack channels: one for the shared room, and a private one for your side&apos;s corner.
          </p>
          {options.length === 0 ? (
            <p className="text-[13px] text-[var(--muted)]">
              Invite <span className="font-mono">@Parly</span> to both Slack channels first (<code>/invite @Parly</code>), then refresh to pick them here.
            </p>
          ) : (
            <form action={linkChannelSlack.bind(null, workspaceId, id)} className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-sm">
                <span>Shared room channel in Slack</span>
                <select name="slackChannel" required className="input" defaultValue={slack.roomLinks?.sharedChannelId ?? ''}>
                  <option value="" disabled>
                    Pick a Slack channel
                  </option>
                  {options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.isPrivate ? `🔒 ${c.name}` : `# ${c.name}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{room.mySide?.name ?? 'Your side'}&apos;s private corner channel in Slack</span>
                <select name="cornerSlackChannel" required className="input" defaultValue={slack.roomLinks?.cornerChannelId ?? ''}>
                  <option value="" disabled>
                    Pick a private Slack channel
                  </option>
                  {options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.isPrivate ? `🔒 ${c.name}` : `# ${c.name}`}
                    </option>
                  ))}
                </select>
              </label>
              <PendingButton className="btn self-start">{slack.roomLinks?.sharedChannelId ? 'Update Slack link' : 'Link to Slack'}</PendingButton>
            </form>
          )}
          {(slack.roomLinks?.sharedChannelId || slack.roomLinks?.cornerChannelId) && (
            <form action={unlinkChannelSlack.bind(null, workspaceId, id)}>
              <PendingButton confirm="Yes, unlink" className="btn-ghost text-[13px] text-[var(--bad-fg)]">Unlink {room.mySide?.name ?? 'your side'} from Slack</PendingButton>
            </form>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-[var(--muted)]">
            Mirror <span className="font-medium"># {channel.name}</span> with a channel in <span className="font-medium">{slack.install.teamName}</span>.
          </p>
          {options.length === 0 ? (
            <p className="text-[13px] text-[var(--muted)]">
              Invite <span className="font-mono">@Parly</span> to a Slack channel first (<code>/invite @Parly</code>), then refresh to pick it here.
            </p>
          ) : (
            <form action={linkChannelSlack.bind(null, workspaceId, id)} className="flex gap-2">
              <label htmlFor="slack-channel" className="sr-only">
                Slack channel
              </label>
              <select id="slack-channel" name="slackChannel" required className="input" defaultValue={channel.slack?.[0]?.channelId ?? ''}>
                <option value="" disabled>
                  Pick a Slack channel
                </option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.isPrivate ? `🔒 ${c.name}` : `# ${c.name}`}
                  </option>
                ))}
              </select>
              <PendingButton className="btn shrink-0">{channel.slack?.length ? 'Save' : 'Link'}</PendingButton>
            </form>
          )}
          {Boolean(channel.slack?.length) && (
            <form action={unlinkChannelSlack.bind(null, workspaceId, id)}>
              <PendingButton confirm="Yes, unlink" className="btn-ghost text-[13px] text-[var(--bad-fg)]">Unlink from Slack</PendingButton>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function TelegramChannelSection({
  workspaceId,
  channel,
  telegram,
  card,
}: {
  workspaceId: string;
  channel: Channel;
  telegram?: WorkspaceTelegramStatus;
  card: string;
}) {
  if (!channel.owner) return null;
  const id = channel.id;
  const links = channel.telegram ?? [];
  const channelLinks = links.filter((l) => !l.threadId);
  const threadLinks = links.filter((l) => Boolean(l.threadId));
  const workspaceChat = telegram?.chats?.[0];
  const defaultChatId = channelLinks[0]?.chatId ?? workspaceChat?.chatId ?? '';
  const hasWorkspaceGroup = Boolean(workspaceChat || channelLinks.length > 0);
  const settingsHref = wsHref(workspaceId, { panel: 'workspace' });
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Telegram</h3>
          {channelLinks.length > 0 && (
            <span className="chip">
              Bridged to Telegram{channelLinks[0]?.topicId !== undefined ? ` · topic #${channelLinks[0].topicId}` : ''}
            </span>
          )}
        </div>
        <Link href={settingsHref} className="text-xs text-[var(--accent)] hover:underline">
          Manage in Workspace Settings
        </Link>
      </div>
      {!hasWorkspaceGroup ? (
        <p className="text-[13px] text-[var(--muted)]">
          <Link href={settingsHref} className="text-[var(--accent)] hover:underline">
            Connect Telegram in workspace settings
          </Link>{' '}
          first (<span className="font-mono">@ParlyBot</span>), then link <span className="font-medium"># {channel.name}</span> to a forum topic here.
        </p>
      ) : (
        <p className="text-[13px] text-[var(--muted)]">
          Link <span className="font-medium"># {channel.name}</span> to a forum topic in{' '}
          <span className="font-medium">{workspaceChat?.title ?? defaultChatId}</span>. Group connection is managed in{' '}
          <Link href={settingsHref} className="text-[var(--accent)] hover:underline">
            Workspace Settings
          </Link>
          .
        </p>
      )}
      {channelLinks.length > 0 && (
        <ul className="flex flex-col gap-2">
          {channelLinks.map((link) => {
            const key = `${link.chatId}:${link.topicId ?? 'root'}`;
            return (
              <li key={key} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="font-medium"># {channel.name}</span>
                  <span className="mx-1.5 text-[var(--muted)]">↔</span>
                  {link.topicId !== undefined ? (
                    <span className="rounded bg-[var(--subtle)] px-1.5 py-0.5 font-mono text-xs text-[var(--muted)]">
                      topic #{link.topicId}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-[var(--muted)]">{link.chatId}</span>
                  )}
                  {link.paused && (
                    <span className="ml-1.5 text-xs text-[var(--bad-fg)]">(paused)</span>
                  )}
                </div>
                <form action={unlinkChannelTelegram.bind(null, workspaceId, id, link.chatId, link.topicId)}>
                  <PendingButton confirm="Yes, unlink" className="btn-ghost text-[13px] text-[var(--bad-fg)]">Unlink</PendingButton>
                </form>
              </li>
            );
          })}
        </ul>
      )}
      {threadLinks.length > 0 && (
        <p className="text-xs text-[var(--muted)]">
          {threadLinks.length} active thread {threadLinks.length === 1 ? 'topic' : 'topics'} mirrored automatically.
        </p>
      )}
      {hasWorkspaceGroup && (
        <form action={linkChannelTelegram.bind(null, workspaceId, id)} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="chatId" value={defaultChatId} />
          <label htmlFor="telegram-topic-id" className="sr-only">
            Topic ID
          </label>
          <input
            id="telegram-topic-id"
            name="topicId"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Topic ID (e.g. 42)"
            defaultValue={channelLinks[0]?.topicId !== undefined ? String(channelLinks[0].topicId) : ''}
            className="input w-44"
          />
          <PendingButton className="btn">{channelLinks.length ? 'Update topic link' : 'Link topic'}</PendingButton>
          {links.length > 1 && (
            <PendingButton confirm="Yes, unlink all" formAction={unlinkChannelTelegram.bind(null, workspaceId, id, undefined, undefined)} formNoValidate className="btn-ghost text-[13px] text-[var(--bad-fg)]">
              Unlink all from Telegram
            </PendingButton>
          )}
        </form>
      )}
    </section>
  );
}
