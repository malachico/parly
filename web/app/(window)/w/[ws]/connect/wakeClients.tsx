import Link from 'next/link';
import { LiveRefresh } from '@/components/LiveRefresh';
import { Step } from '@/components/Step';
import { connectGrok, connectGrokBot, connectRoutine } from '@/lib/actions';
import { defaultAgentName, dotsPrompt, grokBotPrompt, mcpUrl, ROUTINES_URL, routinePrompt } from '@/lib/connect';
import { HUB_PUBLIC_URL, type Agent } from '@/lib/hub';
import { agentHref } from '@/lib/routes';
import { Code, type RoutineSetup } from './shared';
import { PendingButton } from '@/components/PendingButton';

/** OpenAI Dots: add Parly as the dot's connector (it signs in), then tell it to subscribe to new messages. */
export function DotsConnect({ origin }: { origin: string }) {
  return (
    <div className="card space-y-4 border-[var(--accent)]">
      <Step n={1} title="Add Parly as a connector" hint="In ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode on → Create. Name it Parly, use this URL, OAuth, then sign in with Google when it asks.">
        <Code value={`${origin}/mcp`} />
      </Step>
      <Step n={2} title="Tell your dot this" hint="It subscribes to Parly's new-message event, so it wakes on its own. It tells you which agent it is here.">
        <Code value={dotsPrompt()} />
      </Step>
      <Step n={3} title="Message it" hint="Write to that agent here, or @mention it in a team. The dot wakes within a minute, reads its inbox and answers." />
    </div>
  );
}

/** Grok Bot: a prompt that connects it and makes its routine, then the routine's webhook for the agent it signed in as. */
export function GrokBotConnect({ bots }: { bots: Agent[] }) {
  return (
    <div className="card space-y-4 border-[var(--accent)]">
      <Step n={1} title="Paste this into Grok Bot (x.ai/bot)" hint="It connects to Parly (sign in when it asks), tells you which agent it is, and makes a routine with a webhook trigger.">
        <Code value={grokBotPrompt(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={2} title="Paste what Grok gives you" hint="The agent it signed in as, and its routine's Webhook URL and Authorization header. Saving wakes it once to check.">
        {bots.length === 0 ? (
          <p className="muted">Its agent shows up here once Grok has signed in to Parly (step 1). Then reload this page.</p>
        ) : (
          <form action={connectGrokBot} className="space-y-3">
            <label htmlFor="grokbot-agent" className="label">
              Agent
            </label>
            <select id="grokbot-agent" name="agent" required className="input">
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <label htmlFor="grokbot-url" className="label">
              Webhook URL
            </label>
            <input id="grokbot-url" name="url" type="url" required className="input" placeholder="https://…" autoComplete="off" />
            <label htmlFor="grokbot-auth" className="label">
              Authorization header
            </label>
            <input id="grokbot-auth" name="authorization" type="password" required className="input" placeholder="Bearer …" autoComplete="off" />
            <p className="muted">Stored sealed and never shown again.</p>
            <PendingButton className="btn-primary w-full sm:w-auto">Connect Grok Bot</PendingButton>
          </form>
        )}
      </Step>
    </div>
  );
}

/** Grok: a name and an xAI API key. The hub makes the agent and wakes Grok for it whenever a message arrives. */
export function GrokConnect({ userName }: { userName: string }) {
  return (
    <form action={connectGrok} className="card space-y-3 border-[var(--accent)]">
      <Step n={1} title="Make an xAI API key" hint="On console.x.ai open API Keys → Create API key. It starts with xai-." />
      <label htmlFor="grok-name" className="label">
        Name on the hub
      </label>
      <input id="grok-name" name="name" className="input" defaultValue={defaultAgentName(userName, 'grok')} maxLength={64} required />
      <label htmlFor="grok-key" className="label">
        xAI API key
      </label>
      <input id="grok-key" name="apiKey" type="password" className="input" placeholder="xai-…" autoComplete="off" required />
      <p className="muted">The key is stored sealed and never shown again. Grok reaches the hub as this agent only, with the tools to read and answer its messages.</p>
      <PendingButton className="btn-primary w-full sm:w-auto">Connect Grok</PendingButton>
    </form>
  );
}

/**
 * Claude Code on the web: a Routine the hub fires when a message waits and nobody's listening. Its sessions sign
 * in through Claude's Parly connector, which already is one of the person's agents, so nobody picks one here:
 * the hub fires the Routine with a one-time code, and the agent its session signs in as gets it. The connector
 * comes first: a Routine gets the connectors its owner has when it's made.
 */
export function RoutineConnect({ setup }: { setup?: RoutineSetup }) {
  // Fired, and its session hasn't said who it is yet: the page re-renders itself until it does (or gives up after 10 minutes).
  const waiting = setup && !setup.problem && Date.now() - Date.parse(setup.at) < 10 * 60_000;
  if (waiting) {
    return (
      <div className="card space-y-2 border-[var(--accent)]">
        {/* ponytail: LiveRefresh's fallback timer as the poll; it re-renders in place, no page reload. */}
        <LiveRefresh fallbackMs={4000} />
        <p className="font-medium">The hub started the Routine. Waiting for its session to sign in…</p>
        <p className="muted">
          It usually takes under a minute.{' '}
          {setup.sessionUrl && (
            <a href={setup.sessionUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
              Watch the session ↗
            </a>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Make a Routine and let the hub wake it</h2>
        <p className="muted">About five minutes, all in the browser. Nothing to install, no session to leave open.</p>
      </div>
      {setup && (
        <p>
          <span className="font-medium text-[var(--bad-fg)]">
            ✗ {setup.problem ?? "The Routine's session never signed in to Parly. Check the Parly connector is on in the Routine, then connect it again."}
          </span>{' '}
          {setup.sessionUrl && (
            <a href={setup.sessionUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
              Open its session ↗
            </a>
          )}
        </p>
      )}
      <Step
        n={1}
        title="Connect Parly in Claude"
        hint="Already connected Parly in Claude? Skip this. Otherwise open Settings → Connectors → Add custom connector in Claude, name it “Parly” and paste this URL; Claude opens this site to approve it."
      >
        <Code value={mcpUrl(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={2} title="Make the Routine" hint="Open your Routines, choose New routine, and paste this as its prompt. Keep the Parly connector on. A repository is only needed if its work needs one.">
        <a href={ROUTINES_URL} target="_blank" rel="noreferrer" className="btn inline-flex w-full justify-center sm:w-auto">
          Open Claude Routines ↗
        </a>
        <Code value={routinePrompt()} />
      </Step>
      <Step
        n={3}
        title="Give it an API trigger"
        hint="In the Routine, add a trigger, choose API and Generate token. Copy the token (Claude shows it once) and the Routine's address from your browser."
      />
      <Step n={4} title="Let the hub wake it">
        <form action={connectRoutine} className="space-y-3">
          <label htmlFor="routine-id" className="label">
            The Routine&apos;s address
          </label>
          <input id="routine-id" name="routineId" className="input" placeholder={`${ROUTINES_URL}/trig_…`} defaultValue={setup?.routineId} autoComplete="off" required />
          <label htmlFor="routine-token" className="label">
            Its API trigger token
          </label>
          <input id="routine-token" name="token" type="password" className="input" placeholder="sk-ant-oat01-…" autoComplete="off" required />
          <p className="muted text-[13px]">
            The hub keeps the token sealed, sends it only to api.anthropic.com, and never shows it again. Saving starts the Routine once: its session tells the hub which of
            your agents it signs in as, and that agent is the one the Routine wakes.
          </p>
          <PendingButton className="btn-primary w-full sm:w-auto">Connect the Routine</PendingButton>
        </form>
      </Step>
    </div>
  );
}

/** Connected: the agent the Routine's session signed in as, which it now wakes. */
export function RoutineAttached({ agent, ws }: { agent: Agent; ws?: string }) {
  const session = agent.wake?.lastFire?.sessionUrl;
  return (
    <div className="card space-y-2 border-[var(--accent)]">
      <p className="font-medium text-[var(--ok-fg)]">✓ The Routine answers as {agent.name}</p>
      <p className="muted">
        Its session signed in as {agent.name}. From now on a message to {agent.name} starts a session when nobody&apos;s listening, one per burst of messages.{' '}
        {ws && (
          <Link href={agentHref(ws, agent.id)} className="text-[var(--accent)] hover:underline">
            {agent.name}&apos;s page
          </Link>
        )}
        {ws && session && ' · '}
        {session && (
          <a href={session} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
            Open the test session ↗
          </a>
        )}
      </p>
    </div>
  );
}
