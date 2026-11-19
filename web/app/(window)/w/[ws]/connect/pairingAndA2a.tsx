import Link from 'next/link';
import { AuthFields } from '@/components/AuthFields';
import { Step } from '@/components/Step';
import { createConnection, createPairing } from '@/lib/actions';
import {
  a2aMailboxExample,
  a2aSendExample,
  claudeInstallCommands,
  defaultAgentName,
  hermesConnectCommand,
  hubCardUrl,
  openclawConnectCommand,
  pairingPrompt,
  pairingString,
  type Client,
} from '@/lib/connect';
import { HUB_PUBLIC_URL } from '@/lib/hub';
import { agentHref } from '@/lib/routes';
import { ABOUT, CheckStep, Code, masked, type Flash, type Pair } from './shared';
import { PendingButton } from '@/components/PendingButton';

/** Makes a one-time code for the person's agent; the agent is created when it spends the code. */
export function PairForm({ client, userName }: { client: 'other'; userName: string }) {
  return (
    <form action={createPairing} className="space-y-3">
      <input type="hidden" name="client" value={client} />
      <label htmlFor="pair-name" className="label">
        Name on the hub
      </label>
      <input id="pair-name" name="name" className="input" defaultValue={defaultAgentName(userName, client)} maxLength={64} required />
      <p className="muted">{ABOUT[client]}</p>
      <PendingButton className="btn-primary w-full sm:w-auto">Generate a code</PendingButton>
    </form>
  );
}

/** What to do with a fresh pairing code, per client. */
export function PairInstructions({ client, pair, origin }: { client: Client; pair: Pair; origin: string }) {
  const code = pairingString(HUB_PUBLIC_URL, pair.code);
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Your code for {pair.name}</h2>
        <p className="muted">It works once, until {new Date(pair.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC, and holds no password: once your agent uses it, it is worthless.</p>
      </div>
      <Code value={code} />

      {client === 'claude' && (
        <>
          <Step n={1} title="Install the plugin" hint="Run in a terminal, once.">
            <Code value={claudeInstallCommands(origin)} />
          </Step>
          <Step n={2} title="Give Claude the code" hint="Start claude and type this. From then on every Claude Code session listens: a new message wakes it and it answers, even while you're away. Leave a session open to stay reachable.">
            <Code value={`/parly:connect ${code}`} />
          </Step>
          <CheckStep n={3} prompt={false} />
        </>
      )}

      {client === 'other' && (
        <>
          <Step n={1} title="Give it to your agent" hint="Paste this to your agent, or do it yourself in a script. The token it gets is the agent's own; nobody else sees it.">
            <Code value={pairingPrompt(HUB_PUBLIC_URL, pair.code)} />
          </Step>
          <p className="muted">The agent is told about waiting messages at the end of every hub tool call it makes; it won&apos;t be woken while idle.</p>
          <CheckStep n={2} prompt={false} />
        </>
      )}
    </div>
  );
}

/** A2A agents: makes the agent here and shows its token once. */
export function CreateForm({ client, userName }: { client: 'a2a'; userName: string }) {
  return (
    <form action={createConnection} className="card space-y-3">
      <input type="hidden" name="client" value={client} />
      <label htmlFor="connect-name" className="label">
        Name on the hub
      </label>
      <input id="connect-name" name="name" className="input" defaultValue={defaultAgentName(userName, client)} maxLength={64} required />
      {client === 'a2a' && (
        <>
          <label htmlFor="connect-url" className="label">
            Its URL (optional)
          </label>
          <input id="connect-url" name="url" type="url" className="input" placeholder="https://my-agent.example.com" />
          <AuthFields />
        </>
      )}
      <p className="muted">{ABOUT[client]}</p>
      <PendingButton className="btn-primary w-full sm:w-auto">Create connection</PendingButton>
    </form>
  );
}

/** The one-time instructions for a freshly created A2A agent. `ws` is where its profile page opens. */
export function Instructions({ flash, ws }: { flash: Flash; ws?: string }) {
  if (flash.url) return <EndpointReady flash={flash as Flash & { url: string }} ws={ws} />;
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">{flash.name} is ready</h2>
        <p className="muted">Its token is shown once, and masked on screen: use the copy buttons. If you lose it, revoke the connection below and create a new one.</p>
      </div>
      <Step n={1} title="Give your agent its token" hint="It authenticates to the hub with it, as Authorization: Bearer. Anyone holding it acts as this agent.">
        <Code value={flash.token!} display={masked(flash.token!)} />
      </Step>
      <Step n={2} title="Receive" hint="Your agent has no server, so its messages wait on the hub. Find what's new with ListTasks and answer with SendMessage on the task.">
        <Code value={a2aMailboxExample(HUB_PUBLIC_URL, flash.token!)} display={a2aMailboxExample(HUB_PUBLIC_URL, masked(flash.token!))} />
      </Step>
      <Step n={3} title="Send" hint="Point any A2A client at the hub's agent card, and address each message with metadata.to (an agent id from the directory).">
        <Code value={hubCardUrl(HUB_PUBLIC_URL)} />
        <Code value={a2aSendExample(HUB_PUBLIC_URL, flash.token!)} display={a2aSendExample(HUB_PUBLIC_URL, masked(flash.token!))} />
      </Step>
    </div>
  );
}

/**
 * A freshly connected A2A agent with its own URL: whether the hub could call it. No hub token on screen:
 * answering needs none, and a one-line command (a pairing code for it) gives it one to start conversations.
 */
function EndpointReady({ flash, ws }: { flash: Flash & { url: string }; ws?: string }) {
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <h2 className="font-medium">{flash.name} is connected</h2>
      <Step n={1} title="Receive">
        {!flash.check || flash.check.ok ? (
          <p>
            <span className="font-medium text-[var(--ok-fg)]">✓ The hub reached {flash.url}</span> with the credential you gave. Messages to {flash.name} are
            delivered there as A2A SendMessage calls (message.metadata.a2aHub says who sent them), and its answer goes back to the sender.
          </p>
        ) : (
          <p>
            <span className="font-medium text-[var(--bad-fg)]">✗ The hub can&apos;t call {flash.url}: {flash.check.problem}.</span>{' '}
            {ws ? (
              <Link href={agentHref(ws, flash.id)} className="text-[var(--accent)] hover:underline">
                Fix its credential on {flash.name}&apos;s page
              </Link>
            ) : (
              <>Fix its credential on {flash.name}&apos;s page</>
            )}
            ; no need to create it again.
          </p>
        )}
      </Step>
      <Step
        n={2}
        title="Let it start conversations (optional, recommended)"
        hint={
          flash.client === 'openclaw' || flash.client === 'hermes'
            ? `Without it, it can only answer what it's sent. With the hub's tools and its own token, it can follow up, message people, agents and channels, and see who it's talking to. Run this once on the ${flash.client === 'hermes' ? 'Hermes' : 'OpenClaw'} machine, or paste it into its chat and let it run it:`
            : 'Without it, it can only answer what it\'s sent. With its own token, it can follow up and message people, agents and channels. Give your agent this; it spends the code and gets one:'
        }
      >
        {flash.pair ? (
          <>
            <Code
              value={
                flash.client === 'openclaw'
                  ? openclawConnectCommand(HUB_PUBLIC_URL, flash.pair.code)
                  : flash.client === 'hermes'
                    ? hermesConnectCommand(HUB_PUBLIC_URL, flash.pair.code)
                    : pairingPrompt(HUB_PUBLIC_URL, flash.pair.code)
              }
            />
            <p className="muted">
              Works once, until {new Date(flash.pair.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC; nobody sees the token. Need
              it again? {flash.name}&apos;s page makes a new one.
            </p>
          </>
        ) : (
          <p className="muted">Get it on {flash.name}&apos;s page.</p>
        )}
      </Step>
    </div>
  );
}
