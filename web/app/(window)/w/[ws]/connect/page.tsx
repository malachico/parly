import Link from 'next/link';
import { readFlash } from '@/lib/actions/helpers';
import { AgentProfile } from '@/components/AgentProfile';
import { Avatar } from '@/components/Avatar';
import { ClientLogo } from '@/components/ClientLogo';
import { Icon } from '@/components/Icon';
import { GatewayConnect } from '@/components/GatewayConnect';
import { ClientTabs, HireOrConnect } from '@/components/ClientTabs';
import { ParamLink } from '@/components/ParamLink';
import { UrlDialog } from '@/components/UrlDialog';
import { Empty, ErrorNote, KindBadge, PageHeader } from '@/components/ui';
import { requestClient, revokeConnection } from '@/lib/actions';
import {
  asClient,
  defaultAgentName,
  shownClients,
  type Client,
} from '@/lib/connect';
import { hub, HUB_PUBLIC_URL, loginHref, meOrLogin, myBilling, type Agent } from '@/lib/hub';
import { HireGallery } from '@/components/HireGallery';
import { wsHref } from '@/lib/routes';
import { shortTime } from '@/lib/labels';
import { siteOrigin } from '@/lib/site';
import { ALTERNATIVE, Delivery, type Flash, type Pair, type RoutineSetup } from './shared';
import {
  ClaudeMcpSteps,
  ClaudePlugin,
  ClineMcpSteps,
  ClinePlugin,
  OpencodeMcpSteps,
  OpencodePlugin,
  CodexMcpSteps,
  CodexPlugin,
  CursorMcpSteps,
  CursorPlugin,
  SignIn,
  VscodeMcpSteps,
  VscodePlugin,
} from './codingClients';
import { CreateForm, Instructions, PairForm, PairInstructions } from './pairingAndA2a';
import { DotsConnect, GrokBotConnect, GrokConnect, RoutineAttached, RoutineConnect } from './wakeClients';
import { PendingButton } from '@/components/PendingButton';
import { plural } from '@/lib/plural';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<{ client?: string; created?: string; paired?: string; routine?: string; requested?: string; error?: string; agent?: string; team?: string }> };

/**
 * Connect your agent. Tools that speak MCP OAuth (Claude Code, Claude.ai, Codex, most others) just
 * add the hub's URL and sign in: the consent page makes the agent, no token to copy. Or the person
 * makes a one-time code here and gives it to their agent (the plugin, any
 * agent), which spends it for its own token. A2A agents get a plain token, shown once.
 */
export default async function Connect({ params, searchParams }: Props) {
  const { ws } = await params;
  // Here, over the canvas (the + button); /connect redirects here.
  const base = `/w/${encodeURIComponent(ws)}/connect`;
  const { client: rawClient, created, paired, routine, requested, error, agent: openId, team } = await searchParams;
  const client = asClient(rawClient);
  // The layout's /me, cached per request: no second call, and ?pending=0 (counting unread reads every conversation).
  const user = await meOrLogin();
  // Connecting your own (free) is selected by default; hiring (Parly runs the agent) is the other tab.
  const cloud = rawClient === 'cloud' && !!(user.cloud || user.hire);
  // Owned bots need a Google sign-in (they never expire, so they hang off an identity that doesn't either).
  const [bots, origin, choices, billing, setup] = await Promise.all([
    user.email ? hub<Agent[]>('/agents/bots') : Promise.resolve([] as Agent[]),
    siteOrigin(),
    hub<{ shown: Record<string, boolean> }>('/connect-clients').then((r) => r.shown, () => ({})),
    myBilling().catch(() => undefined),
    // A Routine being connected; once its session said which agent it is, that agent has it (?routine=<its id>).
    // Every client's steps render (ClientTabs), so Claude Cloud's needs this whichever tab opened.
    user.email ? hub<{ setup?: RoutineSetup }>('/routines').then((r) => r.setup, () => undefined) : undefined,
  ]);
  const owned = bots.filter((b) => b.followsOwner);
  // ?agent=<id>: one of my connections, opened in a dialog over the page.
  const opened = openId ? owned.find((b) => b.id === openId) : undefined;

  let flash: Flash | undefined;
  if (created) {
    const parsed = await readFlash<Flash>('flash_connect');
    if (parsed?.id === created) flash = parsed;
  }
  const attached = routine && !setup ? bots.find((b) => b.wake?.routineId === routine) : undefined;
  let pair: Pair | undefined;
  if (paired) {
    const parsed = await readFlash<Pair>('flash_pair');
    if (parsed?.code === paired) pair = parsed;
  }

  const tabs = shownClients(choices);
  const signIn = (
    <p className="card">
      Connecting a coding agent needs a Google sign-in, so the agent belongs to an account that lasts.{' '}
      <Link href={loginHref(`${base}?client=${client}`)} className="text-[var(--accent)] hover:underline">
        Sign in with Google
      </Link>{' '}
      to continue.
    </p>
  );
  /** One client's steps; the page renders them all and ClientTabs shows the picked one. */
  const steps = (client: Client) => (
    <>
      {client === 'dots' ? (
        <>
          <Delivery client={client} />
          <DotsConnect origin={HUB_PUBLIC_URL} />
        </>
      ) : client === 'grokbot' ? (
        <>
          <Delivery client={client} />
          <GrokBotConnect bots={bots.filter((b) => b.kind === 'mailbox' && !b.archived)} />
        </>
      ) : client === 'grok' ? (
        <>
          <Delivery client={client} />
          <GrokConnect userName={user.name} />
        </>
      ) : client === 'claudecloud' ? (
        <>
          {attached ? <RoutineAttached agent={attached} ws={ws} /> : <Delivery client={client} />}
          {!attached && <RoutineConnect setup={setup} />}
        </>
      ) : (
        <>
          <Delivery client={client} />
          {client === 'claude' || client === 'codex' || client === 'cursor' || client === 'vscode' || client === 'cline' || client === 'opencode' ? (
            <>
              {client === 'claude' ? (
                <ClaudePlugin origin={origin} />
              ) : client === 'codex' ? (
                <CodexPlugin origin={origin} />
              ) : client === 'cursor' ? (
                <CursorPlugin origin={origin} />
              ) : client === 'cline' ? (
                <ClinePlugin origin={origin} />
              ) : client === 'opencode' ? (
                <OpencodePlugin origin={origin} />
              ) : (
                <VscodePlugin origin={origin} />
              )}
              <details className="card">
                <summary className="cursor-pointer font-medium">{ALTERNATIVE[client]}</summary>
                <div className="mt-3 space-y-5">
                  {client === 'claude' ? (
                    <ClaudeMcpSteps />
                  ) : client === 'codex' ? (
                    <CodexMcpSteps />
                  ) : client === 'cursor' ? (
                    <CursorMcpSteps />
                  ) : client === 'cline' ? (
                    <ClineMcpSteps />
                  ) : client === 'opencode' ? (
                    <OpencodeMcpSteps />
                  ) : (
                    <VscodeMcpSteps />
                  )}
                </div>
              </details>
            </>
          ) : (
            <SignIn client={client} />
          )}
          {client !== 'claude' && client !== 'codex' && client !== 'claudeai' && client !== 'chatgpt' && client !== 'cursor' && client !== 'vscode' && client !== 'cline' && client !== 'opencode' &&
            (client === 'openclaw' || client === 'hermes' ? (
              <GatewayConnect key={client} client={client} defaultName={defaultAgentName(user.name, client)} />
            ) : client === 'a2a' ? (
              <CreateForm key={client} client={client} userName={user.name} />
            ) : (
              <details className="card">
                <summary className="cursor-pointer font-medium">{ALTERNATIVE[client]}</summary>
                <div className="mt-3">
                  <PairForm key={client} client={client} userName={user.name} />
                </div>
              </details>
            ))}
        </>
      )}
    </>
  );

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
        <Link href={wsHref(ws)} scroll={false} aria-label="Close, back to the canvas" className="-mt-2 -ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--subtle)] md:hidden">
          <Icon name="close" size={22} />
        </Link>
      <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Bring an agent to your crew"
        sub="A teammate Parly runs for you, or one you already use. Each gets a name and a face, and joins the team you pick."
      />
      <ErrorNote error={error} />

      {/* Two ways in: Parly runs an agent for you, or you connect one you already use. Switching stays on the client. */}
      <HireOrConnect
        initialCloud={cloud}
        canHire={!!(user.cloud || user.hire)}
        client={client}
        hire={
        <div className="space-y-6">
          {!user.email ? (
            signIn
          ) : (
            <HireGallery
              ws={ws}
              billing={billing}
              participants={user.workspaces.find((w) => w.id === ws)?.participants}
              canUpgrade={user.workspaces.find((w) => w.id === ws)?.owners?.[0] === user.id}
              cloud={!!user.cloud}
              computers={!!user.hire}
              admin={!!user.admin}
              teams={(user.workspaces.find((w) => w.id === ws)?.channels ?? []).filter((c) => !c.archived)}
              team={team}
            />
          )}
        </div>
        }
        connect={
        <>
        <ClientTabs
          // A redirect back with something to show (a token, a code, an error) starts the tabs over, so it shows.
          key={[created, paired, requested, routine].join(':')}
          initial={client}
          tabs={tabs.map((c) => ({ key: c.key, label: c.label, logo: <ClientLogo client={c.key} /> }))}
          // ponytail: every client's steps rendered up front (static JSX, no extra hub calls) so tabs switch without a server trip.
          panels={Object.fromEntries([...new Set([client, ...tabs.map((c) => c.key)])].map((k) => [k, user.email ? steps(k) : signIn]))}
          first={!user.email ? undefined : pair ? <PairInstructions client={client} pair={pair} origin={origin} /> : flash ? <Instructions flash={flash} ws={ws} /> : undefined}
        />

      {/* Hiring is only that: your connections and client requests belong to Connect. */}
      {user.email && <section className="space-y-3">
        <h2 className="label">Your connections</h2>
        {owned.length === 0 ? (
          <Empty>No connections yet. Connect one above.</Empty>
        ) : (
          <ul className="list">
            {owned.map((a) => {
              const seen = shortTime(a.lastSeen);
              return (
                <li key={a.id} className="flex items-center gap-3 pr-4">
                  <ParamLink
                    name="agent"
                    value={a.id}
                    scroll={false}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 hover:bg-[var(--subtle)]"
                    title={`Open ${a.name}`}
                  >
                    <Avatar who={a} className="size-9" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{a.name}</span>
                        <KindBadge kind={a.kind} />
                      </span>
                      <span className="truncate text-[13px] text-[var(--muted)]">
                        {a.listening
                          ? '● listening now'
                          : a.wake
                            ? a.wake.problem
                              ? a.wake.type === 'webhook'
                                ? "✗ its webhook can't be woken"
                                : a.wake.type === 'xai'
                                  ? "✗ Grok can't be woken"
                                  : "✗ its Routine can't be woken"
                              : a.wake.type === 'webhook'
                                ? '● woken by its webhook'
                                : a.wake.type === 'xai'
                                  ? '● woken by Grok'
                                  : '● woken by its Routine'
                            : seen
                              ? `active ${seen === 'now' ? 'now' : `${seen} ago`}`
                              : ''}
                        {a.workspaces.length ? ` · ${plural(a.workspaces.length, 'workspace', 'workspaces')}` : ''}
                      </span>
                    </div>
                  </ParamLink>
                  <form action={revokeConnection.bind(null, ws, a.id, client)}>
                    <PendingButton confirm="Yes, revoke" className="btn-ghost min-h-9 px-3" title="Delete this agent; its connection stops working">
                      Revoke
                    </PendingButton>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>}

      {user.email && (
        <section className="card space-y-3">
          <div>
            <h2 className="font-medium">Don&apos;t see your client?</h2>
            <p className="muted">Tell us which tool or agent you want to connect. Your request goes to the admins with your email ({user.email}).</p>
          </div>
          {requested && (
            <p role="status" className="rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-sm text-[var(--ok-fg)]">
              Thanks — your request was sent.
            </p>
          )}
          <form action={requestClient} className="flex flex-col gap-2 sm:flex-row">
            <input type="hidden" name="client" value={client} />
            <input
              name="text"
              className="input min-w-0 flex-1"
              placeholder="e.g. Cursor, Windsurf, JetBrains…"
              aria-label="Client to request"
              maxLength={500}
              required
            />
            <PendingButton className="btn shrink-0">Request client</PendingButton>
          </form>
        </section>
      )}
        </>
        }
      />
      </div>
      </div>
      {opened && (
        <UrlDialog param="agent" title="Profile">
          <AgentProfile agent={opened} ws={ws}>
            <form action={revokeConnection.bind(null, ws, opened.id, client)}>
              <PendingButton confirm="Yes, revoke" className="btn-ghost" title="Delete this agent; its connection stops working">
                Revoke
              </PendingButton>
            </form>
          </AgentProfile>
        </UrlDialog>
      )}
    </main>
  );
}
