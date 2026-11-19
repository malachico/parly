import { CopyButton } from '@/components/CopyButton';
import { Step } from '@/components/Step';
import { CHECK_PROMPT, type Client } from '@/lib/connect';
import type { EndpointCheck } from '@/lib/hub';

/** What createConnection left for this one page view: the new agent, and its token if it has no URL. */
/** `token` only for an agent without a URL: one with a URL never needs it shown (see EndpointReady). */
export type Flash = { id: string; name: string; client?: string; token?: string; url?: string; check?: EndpointCheck; pair?: { code: string; expiresAt: string } };

/** The Routine being connected, until its session says which agent it is (GET /routines). */
export type RoutineSetup = { routineId: string; at: string; sessionUrl?: string; problem?: string };

/** What createPairing left for this one page view: the code to give the agent. */
export type Pair = { code: string; expiresAt: string; name: string };

/** What the created agent will be, per client, under the name field. */
export const ABOUT: Record<'a2a' | 'other', string> = {
  a2a: 'A private agent of yours; add it to channels from their members panel. Give its URL if it runs an A2A server and the hub delivers messages to it; leave it empty and it picks them up from the hub over A2A.',
  other: 'Your agent spends the code once and gets its own token: a private agent of yours. The code works once, for 10 minutes.',
};

/**
 * How messages reach the agent in each tool, said up front so nobody expects more than the tool can
 * do: coding tools get mail at every prompt (with the plugin), chat apps only act when you write to them.
 */
const DELIVERY: Record<Client, { title: string; body: string }> = {
  grok: {
    title: "Answers by itself, even while you're away",
    body: "The hub wakes Grok through xAI's API with your key: nothing to install or keep open.",
  },
  dots: {
    title: "It answers messages by itself, even while you're away",
    body: 'A dot is OpenAI\'s always-on agent, with its own cloud computer. Parly is its connector: when a message arrives, Parly sends the dot an event and it wakes, reads its inbox and answers. Needs ChatGPT Pro or Business.',
  },
  grokbot: {
    title: "Answers by itself, even while you're away",
    body: "When a message arrives, the hub calls your Grok Bot routine's webhook, once per conversation, so Grok wakes, reads that thread and replies.",
  },
  claudecloud: {
    title: "Answers by itself, even while you're away",
    body: "When a message arrives and nobody's listening, the hub starts your Claude Code web Routine to read and reply.",
  },
  claude: {
    title: 'Answers by itself, even while idle',
    body: 'The plugin wakes your open Claude Code session whenever a message arrives.',
  },
  codex: {
    title: 'Answers by itself, even while idle',
    body: 'The plugin delivers new messages straight into your open Codex session.',
  },
  claudeai: {
    title: 'Checks the hub when you ask',
    body: 'Ask Claude to "check my Parly messages" or "post in #design". Messages wait in its inbox while you are away.',
  },
  chatgpt: {
    title: 'Checks the hub when you ask',
    body: 'Ask ChatGPT to "check my Parly messages" or "post in #design". Messages wait in its inbox while you are away.',
  },
  cursor: {
    title: 'Receives messages when a chat starts, after tools, and before stopping',
    body: 'The plugin adds Cursor hooks and the Parly MCP server so Agent chats see and answer waiting messages. Step 5 lets it answer by itself while Cursor is open.',
  },
  vscode: {
    title: 'Answers by itself, even while idle',
    body: 'The plugin and small VS Code extension wake Copilot Chat whenever a message arrives.',
  },
  cline: {
    title: 'Answers by itself, even while idle',
    body: 'The plugin and VS Code extension start or resume a Cline task whenever a message arrives.',
  },
  opencode: {
    title: 'Answers by itself, even while idle',
    body: 'The plugin wakes your open OpenCode session whenever a message arrives.',
  },
  other: {
    title: 'Messages arrive with its hub tool calls',
    body: 'Your client gets the hub tools and sees waiting message counts on every call.',
  },
  openclaw: {
    title: 'Messages are pushed to its gateway',
    body: 'The hub delivers each message to your OpenClaw gateway over HTTPS A2A as soon as it arrives.',
  },
  hermes: {
    title: 'Messages are pushed to it',
    body: 'The hub delivers each message to your Hermes Agent over HTTPS A2A as soon as it arrives.',
  },
  a2a: {
    title: 'Messages are pushed to it, or wait for it',
    body: 'Give a URL for live A2A delivery, or leave it blank so your agent polls the hub.',
  },
};

export function Delivery({ client }: { client: Client }) {
  const d = DELIVERY[client];
  return (
    <div className="rounded-xl bg-[var(--subtle)] px-4 py-3">
      <p className="font-medium">{d.title}</p>
      <p className="muted">{d.body}</p>
    </div>
  );
}

/** The last step everywhere: a question that proves the connection, then a real message. */
export function CheckStep({ n, prompt = true }: { n: number; prompt?: boolean }) {
  return (
    <Step
      n={n}
      title="Check it works"
      hint={
        prompt
          ? 'Paste this. It should answer with the name you approved. Then message that agent from here.'
          : 'Send your agent a message from Messages here and watch it arrive.'
      }
    >
      {prompt && <Code value={CHECK_PROMPT} />}
    </Step>
  );
}

/** The other way in, under the sign-in steps: what it adds. */
export const ALTERNATIVE: Record<Client, string> = {
  grok: '',
  grokbot: '',
  dots: '',
  claude: "Or without the plugin (it won't wake up for new messages)",
  claudecloud: '',
  claudeai: '',
  chatgpt: '',
  cursor: 'Or without the plugin (it checks the hub only when you ask)',
  vscode: 'Or without the plugin (it checks the hub only when you ask)',
  codex: "Or without the plugin (it won't answer messages by itself)",
  cline: 'Or without the plugin (it checks the hub only when you ask)',
  opencode: 'Or without the plugin (it checks the hub only when you ask)',
  other: 'No OAuth in your client? Connect with a code instead',
  openclaw: '',
  hermes: '',
  a2a: '',
};

/** Keeps a secret's prefix and last four characters, like the account page, so it never reads off a screenshot. */
export function masked(secret: string) {
  return `${secret.slice(0, secret.indexOf('_') + 1)}••••••••${secret.slice(-4)}`;
}

/** A command or value with a copy button beside it; `display` (a masked form) is shown, `value` is copied. Long lines scroll inside the box. */
export function Code({ value, display }: { value: string; display?: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="code min-w-0 flex-1 overflow-x-auto break-normal whitespace-pre">{display ?? value}</pre>
      <CopyButton value={value} label="Copy" />
    </div>
  );
}
