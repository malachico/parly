import Link from 'next/link';
import { connectTool, createTrigger, deleteTrigger, disconnectTool, saveAgentTools } from '@/lib/actions';
import type { Agent, AgentTrigger, MyApp, MyTools, TriggerTypeGroup } from '@/lib/hub';
import { agentHref, dmHref } from '@/lib/routes';
import { ErrorNote } from '@/components/ui';
import { AppSearch } from '@/components/AppSearch';
import { PendingButton } from '@/components/PendingButton';

/** An app's face: its logo, or its first letter. */
function AppLogo({ app }: { app: MyApp }) {
  return app.logo ? (
    <img src={app.logo} alt="" className="size-7 shrink-0 rounded-md object-contain" loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--subtle)] text-xs font-bold uppercase">{app.name.slice(0, 1)}</span>
  );
}

/**
 * A cloud agent's tools: the apps you connected (tick the ones it may use, and whether it may act), and any of
 * Composio's apps to add: popular ones first, or a search across all of them (`?tq=`).
 */
export function ToolsSection({ ws, agent, tools, query, hired, error, only }: { ws: string; agent: Agent; tools: MyTools; query?: string; hired?: boolean; error?: string; only?: 'tools' }) {
  const add = query ? (tools.results ?? []) : tools.popular;
  const base = agentHref(ws, agent.id);
  return (
    <section id="tools" className={`card scroll-mt-6 space-y-4 ${hired ? 'border-2 border-[var(--accent)]' : ''}`}>
      {hired && (
        <div className="-mx-1 -mt-1 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--accent-soft)] px-3 py-2.5">
          <span className="text-sm font-semibold">{agent.name} is hired. Give it tools to work with, or start talking.</span>
          <Link href={dmHref(ws, agent.id)} className="text-sm font-medium text-[var(--accent)] hover:underline">
            Skip, message {agent.name} →
          </Link>
        </div>
      )}
      <div>
        <h2 className="font-medium">Tools</h2>
        <p className="muted text-[13px]">
          {agent.name} uses the apps you connect, as you. It finds the right tool for each task itself. Connected apps are yours and shared by all your agents that Parly runs.
        </p>
      </div>
      <ErrorNote error={error} />

      <form action={saveAgentTools.bind(null, ws, agent.id)} className="space-y-3">
        {only && <input type="hidden" name="only" value={only} />}
        <h3 className="label">Your apps</h3>
        {tools.connected.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-[13px] text-[var(--muted)]">No apps connected yet. Add one below.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
            {tools.connected.map((t) => {
              const live = t.account?.status === 'ACTIVE';
              const isNative = Boolean(t.native || t.slug === 'github');
              return (
                <li key={t.slug} className="flex min-h-12 items-center gap-3 px-3 py-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2.5">
                    <input type="checkbox" name="toolkit" value={t.slug} defaultChecked={agent.tools?.toolkits.includes(t.slug)} disabled={!live && !isNative} className="size-4" />
                    <AppLogo app={t} />
                    <span className="truncate font-medium">{t.name}</span>
                    {!live && !isNative && <span className="text-xs text-[var(--muted)]">{t.account ? t.account.status.toLowerCase() : ''}</span>}
                  </label>
                  {isNative ? (
                    live ? (
                      <span className="shrink-0 text-xs font-medium text-[var(--ok-fg)]">Connected</span>
                    ) : (
                      // ponytail: /me/tools only sets installUrl when ACTIVE; Connect always mints OAuth state
                      <PendingButton formAction={connectTool.bind(null, ws, agent.id, t.slug)} className="btn min-h-8 shrink-0 px-2.5 text-xs">
                        Connect
                      </PendingButton>
                    )
                  ) : (
                    t.account && (
                      <PendingButton formAction={disconnectTool.bind(null, ws, agent.id, t.account.id)} className="btn-ghost min-h-8 px-2.5 text-xs" title={`Disconnect your ${t.name} from all your agents`}>
                        Disconnect
                      </PendingButton>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" name="act" defaultChecked={agent.tools?.act} className="mt-0.5 size-4" />
          <span>
            Let {agent.name} act: send, create, change and delete. <span className="muted">Off, it can only read (search mail, list issues, check the calendar).</span>
          </span>
        </label>
        {tools.connected.length > 0 && <PendingButton className="btn-primary">Save tools</PendingButton>}
      </form>

      <div className="space-y-3 border-t border-[var(--border)] pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="label">Add apps</h3>
          {tools.searchable && <span className="text-xs text-[var(--muted)]">Composio&apos;s whole catalog: 1,000+ apps</span>}
        </div>
        {tools.searchable && (
          <AppSearch />
        )}
        {query && add.length === 0 && <p className="text-[13px] text-[var(--muted)]">No app matches &ldquo;{query}&rdquo;.</p>}
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {add.map((t) => (
            <li key={t.slug} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[var(--border)] p-2.5">
              <AppLogo app={t} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{t.name}</span>
                {t.description && <span className="truncate text-xs text-[var(--muted)]">{t.description}</span>}
              </span>
              {t.account?.status === 'ACTIVE' ? (
                <span className="shrink-0 text-xs text-[var(--muted)]">connected</span>
              ) : t.connectable ? (
                <form action={connectTool.bind(null, ws, agent.id, t.slug)} className="shrink-0">
                  {only && <input type="hidden" name="only" value={only} />}
                  <PendingButton
                    className="btn min-h-8 px-2.5 text-xs"
                    title={t.keyed ? `Opens Composio's page, where you paste your ${t.name} key. It's kept there, never in Parly.` : undefined}
                  >
                    {t.keyed ? 'Add key' : 'Connect'}
                  </PendingButton>
                </form>
              ) : (
                <span className="shrink-0 text-xs text-[var(--muted)]" title="It needs Parly's own app at that service (OAuth), which isn't set up yet">
                  needs setup
                </span>
              )}
            </li>
          ))}
        </ul>
        {query && (
          <Link href={`${base}${only ? `?only=${only}` : ''}#tools`} scroll={false} className="text-[13px] text-[var(--accent)] hover:underline">
            ← Popular apps
          </Link>
        )}
      </div>
    </section>
  );
}

/** Curated most-common triggers per app, shown first before "More {App} events…". */
const TOP_TRIGGERS: Record<string, string[]> = {
  gmail: ['GMAIL_NEW_GMAIL_MESSAGE', 'GMAIL_EMAIL_SENT_TRIGGER'],
  github: [
    'GITHUB_CHECK_SUITE',
    'GITHUB_PULL_REQUEST',
    'GITHUB_PUSH',
    'GITHUB_ISSUE_COMMENT',
  ],
  googlecalendar: [
    'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER',
    'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER',
    'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER',
    'GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER',
  ],
  googledrive: [
    'GOOGLEDRIVE_FILE_CREATED_TRIGGER',
    'GOOGLEDRIVE_FILE_UPDATED_TRIGGER',
    'GOOGLEDRIVE_COMMENT_ADDED_TRIGGER',
    'GOOGLEDRIVE_FILE_SHARED_PERMISSIONS_ADDED',
  ],
  linear: ['LINEAR_ISSUE_CREATED_TRIGGER', 'LINEAR_ISSUE_UPDATED_TRIGGER', 'LINEAR_COMMENT_EVENT_TRIGGER'],
  notion: ['NOTION_PAGE_CONTENT_UPDATED', 'NOTION_COMMENT_CREATED', 'NOTION_DATABASE_CREATED'],
  jira: ['JIRA_ISSUE_CREATED', 'JIRA_ISSUE_UPDATED', 'JIRA_COMMENT_CREATED'],
  hubspot: ['HUBSPOT_CONTACT_CREATED_TRIGGER', 'HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER'],
};

/** Cleans up noisy suffixes from Composio trigger titles ("New Gmail Message Received Trigger" → "New Gmail Message Received"). */
export const cleanTriggerLabel = (name: string) => name.replace(/\s*Trigger$/i, '').trim() || name;

/**
 * "When": the agent is told about events in your apps, as they happen (Composio triggers): any trigger of an app you
 * connected. Pick an app, pick an event (?trigger=SLUG), fill in its settings, and each event that gets through the
 * filter lands in your conversation with the agent, from the trigger, and it acts on it.
 */
export function TriggersSection({
  ws,
  agent,
  triggers,
  types,
  connected = [],
  picked,
  error,
  only,
  channels = [],
}: {
  ws: string;
  agent: Agent;
  triggers: AgentTrigger[];
  types: TriggerTypeGroup[];
  connected?: MyApp[];
  picked?: string;
  error?: string;
  only?: 'triggers';
  channels?: { id: string; name: string }[];
}) {
  const base = agentHref(ws, agent.id);
  const appFor = (toolkit: string, fallbackName?: string): MyApp =>
    connected.find((c) => c.slug === toolkit) ?? {
      slug: toolkit,
      name: fallbackName ?? toolkit,
      ...(toolkit === 'github' ? { logo: '/github-mark.svg' } : {}),
      tools: 0,
      connectable: true,
    };
  const typeGroup = picked ? types.find((g) => g.types.some((t) => t.slug === picked)) : undefined;
  const type = typeGroup?.types.find((t) => t.slug === picked);
  const activeGroup: TriggerTypeGroup | undefined =
    typeGroup ??
    (picked ? types.find((g) => g.toolkit === picked) : undefined) ??
    types[0];
  const topOrder = activeGroup ? (TOP_TRIGGERS[activeGroup.toolkit] ?? []) : [];
  const sortedGroupTypes = activeGroup
    ? [...activeGroup.types].sort((a, b) => {
        const ia = topOrder.indexOf(a.slug);
        const ib = topOrder.indexOf(b.slug);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        return a.name.localeCompare(b.name);
      })
    : [];
  const topCount = topOrder.length ? Math.max(topOrder.filter((s) => activeGroup?.types.some((t) => t.slug === s)).length, Math.min(6, sortedGroupTypes.length)) : Math.min(6, sortedGroupTypes.length);
  const topTypes = sortedGroupTypes.slice(0, topCount);
  const restTypes = sortedGroupTypes.slice(topCount);
  const isGmail = type?.slug === 'GMAIL_NEW_GMAIL_MESSAGE';
  const hasTool = typeGroup ? Boolean(agent.tools?.toolkits.includes(typeGroup.toolkit)) : true;
  return (
    <section id="when" className="card scroll-mt-6 space-y-3">
      <div>
        <h2 className="font-medium">When something happens</h2>
        <p className="muted text-[13px]">
          {agent.name} hears about it right away, from the trigger, and gets to work. Events that don&apos;t get through the filter are skipped and cost nothing.
        </p>
      </div>
      <ErrorNote error={error} />
      {triggers.length > 0 && (
        <ul className="space-y-2">
          {triggers.map((t) => {
            const group = types.find((g) => g.toolkit === t.toolkit);
            return (
              <li key={t.id} className="flex items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2.5">
                <AppLogo app={appFor(t.toolkit, group?.app)} />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{cleanTriggerLabel(t.label)}</span>
                  <span className="text-[var(--muted)]">
                    {Object.entries(t.config ?? {})
                      .filter(([k]) => k !== 'interval')
                      .map(([k, v]) => ` · ${k}: ${String(v)}`)}
                    {t.filter.from && ` · from “${t.filter.from}”`}
                    {t.filter.subject && ` · subject has “${t.filter.subject}”`}
                    {t.filter.contains && ` · mentions “${t.filter.contains}”`}
                    {` · in ${t.channelId ? `#${channels.find((c) => c.id === t.channelId)?.name ?? 'a channel'}` : 'your DM'}`}
                    {t.task && ` · → ${t.task}`}
                  </span>
                  <span className="block text-xs text-[var(--muted)]">{t.fired ? `${t.fired} so far` : 'Nothing yet'} · checked about every few minutes</span>
                </span>
                <form action={deleteTrigger.bind(null, ws, agent.id, t.id)}>
                  {only && <input type="hidden" name="only" value={only} />}
                  <PendingButton className="btn-ghost min-h-8 px-2.5 text-xs text-[var(--bad-fg)]">Turn off</PendingButton>
                </form>
              </li>
            );
          })}
        </ul>
      )}
      {types.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-3 text-[13px] text-[var(--muted)]">
          Connect an app in Tools above (Gmail, GitHub, Calendar, Slack, …), and {agent.name} can hear about what happens in it.
        </p>
      ) : (
        <div className="space-y-3 rounded-xl bg-[var(--subtle)] p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-[var(--muted)]">Tell {agent.name} when something happens in</span>
            {types.map((g) => {
              const active = activeGroup?.toolkit === g.toolkit;
              return (
                <Link
                  key={g.toolkit}
                  href={`${base}?${only ? `only=${only}&` : ''}trigger=${encodeURIComponent(g.toolkit)}#when`}
                  scroll={false}
                  className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                    active ? 'border-[var(--accent)] bg-[var(--card)] text-[var(--fg)] shadow-xs' : 'border-[var(--border)] bg-[var(--card)]/60 text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  <AppLogo app={appFor(g.toolkit, g.app)} />
                  <span>{g.app}</span>
                </Link>
              );
            })}
          </div>
          {activeGroup && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {topTypes.map((t) => {
                  const selected = type?.slug === t.slug;
                  return (
                    <Link
                      key={t.slug}
                      href={`${base}?${only ? `only=${only}&` : ''}trigger=${encodeURIComponent(t.slug)}#when`}
                      scroll={false}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                        selected ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)]'
                      }`}
                    >
                      {cleanTriggerLabel(t.name)}
                    </Link>
                  );
                })}
              </div>
              {restTypes.length > 0 && (
                <details open={restTypes.some((t) => t.slug === type?.slug)} className="text-xs">
                  <summary className="cursor-pointer font-medium text-[var(--muted)] hover:text-[var(--fg)]">
                    More {activeGroup.app} events ({restTypes.length})…
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {restTypes.map((t) => {
                      const selected = type?.slug === t.slug;
                      return (
                        <Link
                          key={t.slug}
                          href={`${base}?${only ? `only=${only}&` : ''}trigger=${encodeURIComponent(t.slug)}#when`}
                          scroll={false}
                          className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                            selected ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent)]' : 'border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)]'
                          }`}
                        >
                          {cleanTriggerLabel(t.name)}
                        </Link>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      )}
      {type && typeGroup && (
        <form action={createTrigger.bind(null, ws, agent.id, type.slug)} className="space-y-2.5 rounded-xl border border-[var(--accent)] p-3">
          {only && <input type="hidden" name="only" value={only} />}
          <div className="flex items-start gap-2.5">
            <AppLogo app={appFor(typeGroup.toolkit, typeGroup.app)} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{cleanTriggerLabel(type.name)}</p>
              {type.description && <p className="text-[13px] text-[var(--muted)]">{type.description}</p>}
            </div>
          </div>
          <TriggerFields type={type} />
          {isGmail ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <input name="from" placeholder="Only from (optional): boss@, acme.com" aria-label="Only from" className="input" />
              <input name="subject" placeholder="Subject has (optional): invoice" aria-label="Subject has" className="input" />
            </div>
          ) : (
            <input name="contains" placeholder="Only when it mentions (optional): a word, a name, a label" aria-label="Only when it mentions" className="input" />
          )}
          <input
            name="task"
            placeholder={`What should ${agent.name} do? (optional): summarize in #general, draft a reply…`}
            aria-label={`What should ${agent.name} do?`}
            className="input"
          />
          {!hasTool && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="grantTool" value={typeGroup.toolkit} className="size-4" />
              <span>
                Also let {agent.name} use {typeGroup.app}
                {agent.tools?.act ? '' : ' (read only, as its other apps)'}
              </span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[13px]">
              Post in
              <select name="channelId" defaultValue="" className="input w-auto">
                <option value="">My DM with {agent.name}</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name} (everyone there sees it)
                  </option>
                ))}
              </select>
            </label>
            <PendingButton className="btn-primary">Turn on</PendingButton>
          </div>
        </form>
      )}
    </section>
  );
}

/** A trigger type's settings as form fields (`cfg.*`): required first; Composio's polling interval keeps its default. */
export function TriggerFields({ type }: { type: TriggerTypeGroup['types'][number] }) {
  const fields = Object.entries(type.config.properties ?? {}).filter(([k]) => k !== 'interval');
  const required = new Set(type.config.required ?? []);
  fields.sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));
  if (!fields.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {fields.map(([key, p]) => {
        const label = `${p.title ?? key}${required.has(key) ? '' : ' (optional)'}`;
        const hint = p.examples?.length ? `e.g. ${String(p.examples[0])}` : (p.description ?? '').slice(0, 60);
        return p.type === 'boolean' ? (
          <label key={key} className="flex items-center gap-2 text-sm" title={p.description}>
            <input type="checkbox" name={`cfg.${key}`} defaultChecked={p.default === true} />
            {label}
          </label>
        ) : p.enum?.length ? (
          <label key={key} className="flex flex-col gap-1 text-[13px]" title={p.description}>
            {label}
            <select name={`cfg.${key}`} defaultValue={p.default === undefined ? '' : String(p.default)} required={required.has(key)} className="input">
              {!required.has(key) && <option value="">Any</option>}
              {p.enum.map((v) => (
                <option key={String(v)} value={String(v)}>
                  {String(v)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={key} className="flex flex-col gap-1 text-[13px]" title={p.description}>
            {label}
            <input
              name={`cfg.${key}`}
              type={p.type === 'number' || p.type === 'integer' ? 'number' : 'text'}
              required={required.has(key)}
              placeholder={hint}
              defaultValue={p.default === undefined || typeof p.default === 'object' ? undefined : String(p.default)}
              className="input"
            />
          </label>
        );
      })}
    </div>
  );
}
