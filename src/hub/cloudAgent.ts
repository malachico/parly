import { costMicros, type LlmMeter, type LlmPrices, type LlmUsage } from '../llm/llm.js';
import { HubError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { vertexAccessToken, vertexGenerateUrl, vertexProject } from '../lib/vertex.js';
import { newId, textOf, type WireMessage } from '../lib/wire.js';
import type { AgentRecord } from '../registry/types.js';
import { toolkitOf, type Composio } from './composio.js';
import type { GitHubInstall } from './githubInstalls.js';
import { GITHUB_CLOUD_TOOLS, GITHUB_READ_TOOL_NAMES, GITHUB_WRITE_TOOL_NAMES, runGitHubCloudTool, type GitHubApp } from './github.js';
import { GITHUB_OFF, GITHUB_READ_ONLY } from './githubTools.js';
import { AWARD_CREDITS_TOOL, FETCH_URL_TOOL, WEB_SEARCH_TOOL, isShowcaseJudge, runShowcaseCloudTool } from './showcase.js';
import type { WebSearch } from './webSearch.js';
import type { ForwardResult, Forwarder } from './forward.js';
import { compactArgs, type KnownTool } from './toolUsage.js';
import { PICKED_RESULT_MAX, appsOf, compact, hasGitHubToolkit, useAppTool, type Attachment } from './cloudTools.js';
export { appsOf, compact, hasGitHubToolkit, pick, readFiles, useAppTool } from './cloudTools.js';

// Tools safe to run again if Cloud Tasks replays the whole turn: reads and idempotent/keyed calls. Anything NOT here is
// treated as mutating, so an error AFTER one of them ran finishes the turn in-band instead of being retried (a retry
// would repeat the write). reply/send_message are mutating too but already tracked by `posted`.
// ponytail: mirrors mcp/server.ts READ_ONLY (intersected with the cloud toolset) + useTool's idempotent tools; unknown
// tools stay mutating. Keep in sync if either list grows — a stale entry only costs a lost transparent retry, never a double-write.
const RETRY_SAFE_TOOLS = new Set<string>([
  'parly_read_channel', 'web_search', 'fetch_url', 'award_credits', 'find_tools',
  'whoami', 'list_agents', 'list_conversations', 'read_thread', 'get_file', 'room_document', 'list_schedules',
  'list_skills', 'get_skill', 'find_triggers', 'watching', 'find_decisions', 'related',
  ...GITHUB_READ_TOOL_NAMES,
]);

/**
 * Cloud agents: agents with no computer. They think and write, nothing else (no files, no terminal, no code). Each is
 * an endpoint agent the hub answers for itself: the push path (Pusher) hands it a conversation's new messages, with
 * their context, as for any endpoint, and instead of calling it over A2A the hub asks Gemini in Vertex, as itself,
 * and meters the cost against the agent's owner.
 */
interface CloudAgentOptions {
  /** The Gemini model they run on (CLOUD_AGENT_MODEL). */
  model: string;
  /** Vertex's project (else the one the hub runs in) and location. */
  project?: string;
  location: string;
  prices: LlmPrices;
  /** How hard it thinks each step (thoughts bill as output, every round); unset: the model's default. */
  thinkingLevel?: 'low' | 'medium' | 'high';
  /** The most one step may write, thoughts included; unset: the model's limit. */
  maxOutputTokens?: number;
  meter: LlmMeter;
  fetchImpl?: typeof fetch;
  accessToken?: () => Promise<string>;
  /** Tools from the owner's connected accounts (hub/composio.ts), when the hub has a Composio key. */
  composio?: Composio;
  /** Parly's native GitHub App client (`github_comment`, `github_open_pr`), when `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` are configured. */
  github?: GitHubApp;
  /** Which GitHub install each owner may use (github_installs); without one, GitHub tools only read public repos. */
  githubInstalls?: { forOwner(ownerId: string): Promise<GitHubInstall | undefined> };
  /** A line in the agent's day (a tool it ran), written by the hub. */
  onActivity?: (agentId: string, text: string, conversationId: string) => void;
  /** A run of one of its owner's apps' tools (counted per agent and app). */
  onToolUse?: (ownerId: string, agentId: string, toolkit: string, tool: string, ok: boolean) => void;
  /** The tools each agent found before (find_tools), so a later turn runs them without looking again. */
  tools?: { known(agentId: string): Promise<KnownTool[]>; remember(agentId: string, tools: KnownTool[]): Promise<void> };
  /** Optional overrides for turn and per-task circuit-breaker limits. */
  maxCallsPerStep?: number;
  maxRounds?: number;
  turnBudgetMicros?: number;
  taskMaxRounds?: number;
  taskBudgetMicros?: number;
  /** Per-visitor rate limiter for cloud-agent turns in public showcase channels (default: PUBLIC_TURN_LIMIT_PER_HOUR / hr). */
  publicTurnLimiter?: RateLimiter;
  /** Global daily public-showcase spend ceiling in micro-dollars (default: PUBLIC_DAILY_CEILING_MICROS). */
  publicDailyCeilingMicros?: number;
  /** Agent ids allowed to call `award_credits` on a public-showcase turn (SHOWCASE_JUDGE_AGENT_IDS). Hub-controlled, not owner-editable. */
  showcaseJudgeAgentIds?: string[];
  /** The shared showcase prize pool's id (SHOWCASE_POOL_ID, default "default"). */
  showcasePoolId?: string;
  /** The shared pool's total credits, self-seeded on first award (SHOWCASE_POOL_CREDITS). 0/unset = awards refused. */
  showcasePoolCredits?: number;
  /** Per-person lifetime credit ceiling for the showcase (SHOWCASE_USER_CEILING). 0/unset = awards refused. */
  showcaseUserCeiling?: number;
  /** Web search for every agent (hub/webSearch.ts: a grounded Gemini call); unset = no web_search tool. */
  webSearch?: WebSearch;
}

/** What a cloud agent can see and do on Parly itself, as the agent (HubService wires it in). */
interface ParlyAccess {
  /** The conversation's latest messages before the one being answered, oldest first. */
  history(agentId: string, conversationId: string, limit: number): Promise<{ mine: boolean; from: string; text: string }[]>;
  /** A channel it's in, by name or id: its latest posts. */
  read(agentId: string, channel: string, limit: number): Promise<unknown>;
  /** Parly's MCP tools a cloud agent gets (the same ones every agent uses), and calling one as the agent. */
  mcpTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]>;
  callMcp(agentId: string, name: string, args: Record<string, unknown>, turn?: { conversationId?: string; messageId?: string }): Promise<unknown>;
  /** The person who brought the pitch in a showcase thread (its root post's human author), for turn billing and `award_credits`. */
  showcaseVisitor?(conversationId: string, messageId?: string): Promise<string | undefined>;
  humanId?(id: string): Promise<string | undefined>;
  /** A person's display name, to say whose credits ran out. */
  name?(id: string): Promise<string | undefined>;
}

/** Parly's own tools, which every cloud agent has. */
const PARLY_TOOLS = [
  {
    name: 'parly_read_channel',
    description: 'Reads the latest posts of a Parly channel (team) you are in, by its name, e.g. "Build-in-public". Use it to see what was said there.',
    parametersJsonSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, limit: { type: 'integer', description: 'How many posts, newest last (default 20, at most 50)' } },
      required: ['channel'],
    },
  },
];

/** Built-in cloud-agent tool declarations (Parly channel reader + native GitHub App outbound tools). */
export const CLOUD_TOOLS = [...PARLY_TOOLS, ...GITHUB_CLOUD_TOOLS];

/** How many earlier messages of the conversation a cloud agent sees with each turn. */
const HISTORY = 16;
/** The same for an event (a trigger's email, a webhook): it stands on its own, and earlier events are just older ones. */
const EVENT_HISTORY = 4;
/** The newest earlier messages it re-reads in full (each capped); older ones in the window shrink to one line. */
const HISTORY_FULL = 4;
const HISTORY_MSG_MAX = 1_500;
const HISTORY_GIST = 200;

/** Earlier messages as the model re-reads them: the last HISTORY_FULL capped at HISTORY_MSG_MAX, older ones as one line of HISTORY_GIST chars. */
// ponytail: plain truncation, no summary call; summarize older messages if answers lose track of a long thread's start
export function compactHistory<T extends { text: string }>(earlier: T[]): T[] {
  return earlier.map((m, i) => {
    const recent = i >= earlier.length - HISTORY_FULL;
    const text = recent ? m.text : m.text.replace(/\s+/g, ' ').trim();
    const max = recent ? HISTORY_MSG_MAX : HISTORY_GIST;
    return { ...m, text: text.length > max ? `${text.slice(0, max)}…[truncated]` : text };
  });
}

/** Most model calls in one turn segment before checking progress / auto-continuing. */
export const MAX_ROUNDS = 15;
/** Hard per-task max-rounds circuit breaker across auto-continued turn segments. */
export const TASK_MAX_ROUNDS = 60;
/** A tool's output as the model reads it: long results are cut. */
const TOOL_RESULT_MAX = 8_000;
/** Tool calls run per step; more in one step are answered "skipped". */
export const MAX_CALLS_PER_STEP = 15;
/** What one turn segment may spend (micro-dollars, $15) before auto-continuing if making progress. */
export const TURN_BUDGET_MICROS = 15_000_000;
/** Hard per-task spend circuit breaker (micro-dollars, $45); past it, the next step must answer with what it has. */
export const TASK_BUDGET_MICROS = 45_000_000;
/** Default per-visitor hourly limit on cloud-agent turns in public showcase channels. */
const PUBLIC_TURN_LIMIT_PER_HOUR = 20;
/** Default global daily public-showcase spend ceiling in micro-dollars ($25/day). */
const PUBLIC_DAILY_CEILING_MICROS = 25_000_000;
/** A tool result from an earlier step, as later steps see it again. */
const OLD_RESULT_MAX = 1_200;
/**
 * One log line per model call: where the input went. usageMetadata has no per-section split, so the sections are
 * ESTIMATES from serialized length (chars/4); promptTokenCount and cachedContentTokenCount are Vertex's real counts.
 */
// ponytail: chars/4 estimate, no countTokens calls; switch to countTokens per section if the estimate misleads
function logModelInput(agentId: string, call: 'loop' | 'synthesize', system: string, declarations: unknown[], contents: { parts: Part[] }[], u: LlmUsage): void {
  const toolResultChars = contents.reduce((n, c) => n + c.parts.reduce((m, p) => m + (p.functionResponse ? JSON.stringify(p.functionResponse).length : 0), 0), 0);
  const chars = { system: system.length, tools: declarations.length ? JSON.stringify(declarations).length : 0, history: JSON.stringify(contents).length - toolResultChars, toolResults: toolResultChars };
  const estTokens = Object.fromEntries(Object.entries(chars).map(([k, v]) => [k, Math.ceil(v / 4)]));
  console.log(JSON.stringify({ event: 'cloud_agent_input', agentId, call, chars, estTokens, promptTokenCount: u.promptTokenCount ?? 0, cachedContentTokenCount: u.cachedContentTokenCount ?? 0 }));
}

/**
 * Earlier tool results are re-sent shortened (they were already read): drop their attachments, cap the JSON.
 * Each response is shrunk at most once — the `seen` guard keeps it byte-stable across rounds. Without it the shrink
 * re-wraps an already-shrunk result into nested `{earlier:"{\"earlier\":…"}` soup every round, which corrupts the
 * text the model re-reads AND mutates the request prefix so Vertex implicit caching never kicks in. Pass the same
 * `seen` set on every round of a task.
 */
export function shrinkOldResults(turns: { parts: Part[] }[], seen: WeakSet<object>): void {
  for (const c of turns) {
    for (const p of c.parts) {
      const r = p.functionResponse as { name?: string; response: unknown; parts?: Attachment[] } | undefined;
      if (!r || seen.has(r)) continue;
      // Its PDFs and pictures were seen: not sent (and paid for) again with every later step.
      if (r.parts) delete r.parts;
      if (JSON.stringify(r.response).length > OLD_RESULT_MAX) r.response = { earlier: JSON.stringify(r.response).slice(0, OLD_RESULT_MAX) + '…' };
      seen.add(r);
    }
  }
}
/**
 * Tools on demand: instead of every tool's definition in every call (thousands, across Composio's apps), two small
 * functions: find the tools for the job, then run one. Costs the same whether the owner connected one app or fifty.
 */
const META_TOOLS = [
  {
    name: 'find_tools',
    description: "Searches your tools that aren't listed: your owner's connected apps, and Parly's less-used ones (manage skills, schedule messages, triggers). Returns matching tools with what they do and their arguments. Call it before run_tool.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, e.g. "list open issues" or "send an email"' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Several things at once instead of query, e.g. ["get a pull request", "list its files", "merge a pull request"]' },
        app: { type: 'string', description: 'Optional: one app to search, e.g. "github"' },
      },
    },
  },
  {
    name: 'run_tool',
    description: "Runs one tool that find_tools returned, with its arguments: an app's as your owner, a Parly one as you.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The tool\'s slug, e.g. GITHUB_LIST_ISSUES' },
        arguments: { type: 'object', description: 'Its arguments, as find_tools described them' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these fields of the result, found at any depth (e.g. ["message", "sha", "date"] for commits). Use it whenever you need only part of a result, especially lists.',
        },
      },
      required: ['tool'],
    },
  },
];

/**
 * Parly tools a turn rarely needs: left out of every request's declarations (re-sent each round) and reached through
 * find_tools/run_tool instead. Private turns only, like every Parly tool.
 */
const ON_DEMAND_PARLY_TOOLS = new Set([
  'create_skill', 'update_skill', 'delete_skill', 'attach_skill', 'detach_skill',
  'schedule_message', 'list_schedules', 'update_schedule',
  'find_triggers', 'watch', 'watching', 'stop_watching',
]);

type McpTool = { name: string; description?: string; inputSchema: unknown };

/** The on-demand Parly tools a find_tools call matches: any 4+ letter word of its query in a tool's name or description. */
// ponytail: word match over a dozen tools, no ranking; rank (or embed) if the on-demand list grows past a few dozen.
function findParlyTools(tools: McpTool[], args: Record<string, unknown>): { tool: string; app: 'parly'; does?: string; arguments: unknown; writes?: true }[] {
  if (typeof args.app === 'string' && args.app.toLowerCase() !== 'parly') return [];
  const text = [args.query, ...(Array.isArray(args.queries) ? args.queries : [])].filter((q) => typeof q === 'string').join(' ');
  const words = text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  return tools
    .filter((t) => !words.length || words.some((w) => `${t.name.replace(/_/g, ' ')} ${t.description ?? ''}`.toLowerCase().includes(w)))
    .map((t) => ({ tool: t.name, app: 'parly' as const, does: t.description, arguments: t.inputSchema, ...(RETRY_SAFE_TOOLS.has(t.name) ? {} : { writes: true as const }) }));
}

type Part = { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: unknown };

/** What every cloud agent is told, before its owner's description of it. */
function cloudInstructions(agent: Pick<AgentRecord, 'name' | 'description' | 'tools'>): string {
  const hasTools = Boolean(agent.tools?.toolkits.length);
  return [
    `You are ${agent.name}, an AI agent on Parly, a place where people and AI agents work together in teams.`,
    agent.description ? `What you do: ${agent.description}` : '',
    hasTools
      ? 'You are a cloud agent: you have no computer, local files or terminal, so never claim to have run commands or edited local files. When something needs a terminal or code changes, say which kind of coding agent should do it (for example Claude Code, Codex or Cline, connected from "Connect an agent").'
      : 'You are a cloud agent: you think and write. You have no computer, files, terminal or internet access, so never claim to have run, opened or checked anything. When something needs code or a real tool, say which kind of agent should do it (for example Claude Code, Codex or Cline, connected from "Connect an agent").',
    'Write like a helpful teammate in a chat: short, warm, concrete. Use plain text with a little Markdown at most.',
    'To address someone, write @ and their name exactly as it appears. Ask a person a question only when you need their decision, and then stop.',
    'You have Parly\'s own tools, the same as every agent on Parly: read a channel you are in (parly_read_channel) or a thread (read_thread), post or message (send_message, reply), see who is around (list_agents), schedule messages, load or manage reusable skills and team processes (get_skill, list_skills, create_skill, update_skill, attach_skill, detach_skill), and more. To create, update, delete, attach or detach a skill, or to schedule messages, find the tool with find_tools and run it with run_tool. Before you use a skill or follow a process, load it with get_skill(id): a summary in [Skills] or [Processes] is not its instructions. When [Processes] are shown, follow the step matching your role (and its expected output and transition gate) as a workflow template, loading the skill a step names before that step. Post only when asked, and say what you posted. If you are not in a channel you need, say so and ask to be added to it.',
    'When you are asked for something, either do it or say plainly why you can\'t. Never leave a request unanswered.',
    'When your owner asks you to keep an eye on something ("tell me about mails from X", "post new PRs of acme/web in #dev"), set it up yourself: find_triggers, then watch, and say what you turned on. watching lists them, stop_watching turns one off. All four are run with run_tool (find_tools shows their arguments).',
    'Work economically: plan first, then make the fewest tool calls that get the job done. Prefer one call with filters (dates, limits, a search) over many pages or one call per item, and pass run_tool the fields you need (e.g. ["message", "date"]) so only those come back. Call tools that do not depend on each other together in one step, not one per step. If you have enough to answer, answer; once you have answered or posted your answer, stop: no more tool calls to check or confirm it.',
    hasTools
      ? `You have tools from your owner's connected accounts (${agent.tools!.toolkits.join(', ')}). Use them when they help, and say what you did with them.${agent.tools!.act ? '' : ' You may only read with them: if something needs sending, creating or changing, write it out and ask your owner to do it or to let you act in your Tools settings.'}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A turn's answer, or why there is none, from Gemini's generateContent response. */
function answerText(parts: Part[]): string {
  return parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

export class CloudAgents {
  private readonly fetchImpl: typeof fetch;
  private readonly token: () => Promise<string>;
  private readonly publicTurnLimiter: RateLimiter;
  private readonly publicDailyCeilingMicros: number;
  /** Owners already told this month that the allowance ran out (one notice, not one per message). */
  // ponytail: in memory, per instance; a repeat after a restart is fine
  private readonly toldOut = new Set<string>();
  private readonly toldPublicPaused = new Set<string>();
  private readonly toldVisitorRateLimited = new Set<string>();
  /** Visitors already told their public turns now use their own credits (per month, or per day when only the ceiling is hit). */
  private readonly toldPaid = new Set<string>();
  /** Set by the hub once it exists: history and Parly's own tools. */
  parly?: ParlyAccess;

  constructor(private readonly opts: CloudAgentOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.token = vertexAccessToken(opts.accessToken);
    this.publicTurnLimiter = opts.publicTurnLimiter ?? new RateLimiter(PUBLIC_TURN_LIMIT_PER_HOUR, 60 * 60_000, 'public showcase turns');
    this.publicDailyCeilingMicros = opts.publicDailyCeilingMicros ?? PUBLIC_DAILY_CEILING_MICROS;
  }

  /** One turn: what the hub pushed it (its new messages and their context), answered as the agent. */
  async answer(agent: AgentRecord, message: WireMessage, signal?: AbortSignal): Promise<ForwardResult> {
    const reply = (text: string): ForwardResult => ({ kind: 'message', message: { messageId: newId(), role: 'ROLE_AGENT', parts: [{ text }] } });
    // Tools / connected accounts use the agent's owner; metering uses payerOf (the owner, or a room agent's payerId).
    const owner = agent.ownerId ?? agent.id;
    const payer = await this.opts.meter.payerOf(agent);
    const { conversationId, event, fromId, publicShowcase, messageId } = (message.metadata?.a2aHub ?? {}) as {
      conversationId?: string;
      event?: boolean;
      fromId?: string;
      public?: boolean;
      publicShowcase?: boolean;
      messageId?: string;
    };
    const isPublicTurn = Boolean(publicShowcase);
    const rootHuman = isPublicTurn && conversationId ? await this.parly?.showcaseVisitor?.(conversationId, messageId) : undefined;
    const triggeringHuman = isPublicTurn && fromId ? await this.parly?.humanId?.(fromId) : undefined;
    const visitorId = triggeringHuman ?? rootHuman;
    const period = new Date().toISOString().slice(0, 7);
    // A visitor's public turn is billed to the visitor; the payer testing their own crew pays from their plan.
    const visitorTurn = Boolean(isPublicTurn && visitorId && visitorId !== payer);
    // Where it may stay quiet (a channel post not for it), an empty answer passes; elsewhere it always answers.
    const mayPass = textOf(message).includes('[You may pass]');
    const day = new Date().toISOString().slice(0, 10);
    if (visitorTurn) {
      try {
        this.publicTurnLimiter.hit(visitorId!);
      } catch (err) {
        if (err instanceof HubError && err.code === 'rate_limited') {
          const hourBucket = new Date().toISOString().slice(0, 13);
          if (mayPass || this.toldVisitorRateLimited.has(`${visitorId}:${hourBucket}`)) return reply('PASS');
          this.toldVisitorRateLimited.add(`${visitorId}:${hourBucket}`);
          return reply("You've reached the hourly limit for public showcase turns. Please wait a bit before asking again.");
        }
        throw err;
      }
    }
    // A visitor spends the hub's free public allowance first (capped hub-wide per day), then their own credits after one notice.
    const freeLeft = visitorTurn && (await this.opts.meter.used(visitorId!, period, { freeOnly: true })) < 1;
    const freeTurn = freeLeft && !(await this.opts.meter.publicShowcaseOverCeiling(this.publicDailyCeilingMicros, day));
    if (visitorTurn && !freeTurn) {
      if ((await this.opts.meter.used(visitorId!)) >= 1) {
        if (freeLeft) {
          if (mayPass || this.toldPublicPaused.has(`${agent.id}:${day}`)) return reply('PASS');
          this.toldPublicPaused.add(`${agent.id}:${day}`);
          return reply("Today's public showcase budget is used up, so public turns are paused until tomorrow (UTC). To keep going now, top up in Account → Billing.");
        }
        if (mayPass || this.toldOut.has(`pub:${visitorId}:${period}`)) return reply('PASS');
        this.toldOut.add(`pub:${visitorId}:${period}`);
        return reply("Your free public turns and your own Parly credits for this month are used up. To keep going now, upgrade or top up in Account → Billing.");
      }
      // ponytail: in memory, per instance; after a restart the notice may come once more (errs toward telling, never toward charging unannounced)
      const noticeKey = `${visitorId}:${freeLeft ? day : period}`;
      if (!this.toldPaid.has(noticeKey)) {
        if (mayPass) return reply('PASS');
        this.toldPaid.add(noticeKey);
        return reply(
          freeLeft
            ? "Today's free public showcase budget is used up. From your next message, your turns here use your own Parly credits."
            : "Your free public turns for this month are used up. From your next message, your turns here use your own Parly credits.",
        );
      }
    } else if (!visitorTurn && (await this.opts.meter.used(payer)) >= 1) {
      if (mayPass || this.toldOut.has(`${payer}:${period}`)) return reply('PASS');
      this.toldOut.add(`${payer}:${period}`);
      if (fromId === payer) return reply("Your Parly credits for this month are used up, so I'll be quiet until they renew next month. To keep going now, upgrade or top up in Account → Billing.");
      const name = (await this.parly?.name?.(payer).catch(() => undefined)) ?? "this agent's payer";
      return reply(`This agent's Parly credits are paid by ${name}, and they're used up for this month, so I'll be quiet until they renew. ${name} can upgrade or top up in Account → Billing.`);
    }
    const project = await vertexProject(this.opts.project);
    const url = vertexGenerateUrl({ project, location: this.opts.location, model: this.opts.model });
    // Its apps: the ones its owner turned on for it and has a working account for; never exposed on public turns.
    const apps = isPublicTurn ? [] : await this.appsFor(agent);
    // Tools it found in earlier turns (in apps it may still use): it runs them directly instead of looking again.
    const known = apps.length && this.opts.tools ? (await this.opts.tools.known(agent.id).catch(() => [])).filter((t) => apps.includes(t.app)) : [];
    // Read once per turn: remember() after find_tools only changes the next turn. Sent with the newest message, not the
    // system prompt, so the cached prefix (systemInstruction + tools) stays byte-identical from call to call.
    const knownNote = known.length ? `Tools you found before. Run them with run_tool directly; use find_tools only for something new:\n${known.map((t) => JSON.stringify(t)).join('\n')}` : '';
    const system = cloudInstructions(isPublicTurn ? { ...agent, tools: undefined } : agent);
    const act = isPublicTurn ? false : !!agent.tools?.act;
    const generationConfig = {
      ...(this.opts.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel } } : {}),
      ...(this.opts.maxOutputTokens ? { maxOutputTokens: this.opts.maxOutputTokens } : {}),
    };
    const withConfig = Object.keys(generationConfig).length ? { generationConfig } : {};
    const turnPayer = visitorTurn ? visitorId! : payer;
    const meterOpts: { freeOnly?: boolean; publicShowcase?: boolean; personId?: string } = freeTurn
      ? { freeOnly: true, publicShowcase: true }
      : isPublicTurn
        ? { publicShowcase: true }
        : { personId: agent.ownerId ?? agent.payerId ?? agent.id }; // the referral goes to the person, even when a pool pays
    // Recheck between paid calls: a tool round may have spent the last credits.
    // Reused by run_tool within the round so a round checks the meter once before any new spend.
    let roundHasCredits: Promise<boolean> | undefined;
    const canCallModel = async () => {
      const ok =
        (!freeTurn || !(await this.opts.meter.publicShowcaseOverCeiling(this.publicDailyCeilingMicros))) &&
        (await this.opts.meter.used(turnPayer, undefined, meterOpts)) < 1;
      roundHasCredits = Promise.resolve(ok);
      return ok;
    };
    const roundCredits: Pick<LlmMeter, 'hasCredits' | 'charge'> = {
      hasCredits: (ownerId) => (roundHasCredits ??= this.opts.meter.hasCredits(ownerId)),
      charge: async (ownerId, credits) => {
        roundHasCredits = undefined;
        await this.opts.meter.charge(ownerId, credits);
      },
    };
    // What it tried this turn, so an answer that doesn't come says why.
    const steps: string[] = [];
    // It posted with its own reply/send_message tool: in a channel that post is its answer, not a second message.
    let posted = false;
    // A mutating tool (anything not in RETRY_SAFE_TOOLS) ran this turn: if we then error, don't let Cloud Tasks replay
    // the whole turn — the write would repeat. posted implies mutated (reply/send_message mutate), tracked separately
    // only because a channel post IS the answer and gets the "what I posted above" wording.
    let mutated = false;
    let lastFinish = '';
    const finish = async (text: string) => {
      const empty = (t: string) => !t || /^(PASS|NO_REPLY)$/.test(t.trim());
      // In a channel or thread, an agent that says PASS on purpose (mentioned only in passing) stays quiet: an apology
      // would be noise. Only a DM always gets an answer.
      if (/^(PASS|NO_REPLY)$/.test(text.trim()) && !steps.length && conversationId && !conversationId.startsWith('dm:')) return reply('PASS');
      if (posted && conversationId && !conversationId.startsWith('dm:')) return reply('PASS');
      // It worked but didn't answer: one more step, tools off, to say what it found and what's left.
      if (!mayPass && empty(text) && steps.length) text = await synthesize().catch(() => '');
      // Passing (or an empty answer) only where it's allowed; a DM or a mention always gets an answer.
      if (!mayPass && empty(text)) {
        console.error(`cloud agent ${agent.id}: no answer (finish ${lastFinish || '?'}; steps: ${steps.join(' | ') || 'none'})`);
        text = steps.length
          ? `I couldn't finish that. Here's what I tried:\n${[...new Set(steps)].map((s) => `- ${s}${steps.filter((x) => x === s).length > 1 ? ` (×${steps.filter((x) => x === s).length})` : ''}`).join('\n')}\n\nTell me how you'd like me to go on, or give me a smaller first step.`
          : "Sorry, I couldn't put together an answer to that one. Could you say it again, maybe in smaller steps?";
      }
      return reply(text || 'PASS');
    };
    // What was said before, so it remembers: its own messages as its turns, everyone else's as theirs.
    const earlier = conversationId && this.parly ? await this.parly.history(agent.id, conversationId, event ? EVENT_HISTORY : HISTORY).catch(() => []) : [];
    const contents: { role: string; parts: Part[] }[] = [];
    // Shrunk only where read_thread can fetch it back: a private turn in a channel thread. A DM or a public turn keeps it whole.
    const rereadable = !isPublicTurn && conversationId?.startsWith('thread:');
    for (const m of rereadable ? compactHistory(earlier) : earlier) {
      const role = m.mine ? 'model' : 'user';
      const text = m.mine ? m.text : `${m.from}: ${m.text}`;
      const last = contents.at(-1);
      if (last?.role === role) last.parts.push({ text });
      else contents.push({ role, parts: [{ text }] });
    }
    if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(earlier in this conversation)' }] });
    // Today's date and time with the newest message (not in the system prompt, whose cached prefix it would break).
    const at = new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
    const now = { role: 'user', parts: [{ text: `(Now: ${at})` }, ...(knownNote ? [{ text: knownNote }] : []), { text: textOf(message) }] as Part[] };
    if (contents.at(-1)?.role === 'user') contents.at(-1)!.parts.push(...now.parts);
    else contents.push(now);
    // A public turn (anyone can be talking) gets no Parly tools: they run as the agent, so even reads (whoami, read_thread,
    // get_file, parly_read_channel) would reach its private channels. The prompt already carries this conversation.
    const mcp = this.parly && !isPublicTurn ? await this.parly.mcpTools().catch(() => []) : [];
    const mcpNames = new Set(mcp.map((t) => t.name));
    const onDemand = mcp.filter((t) => ON_DEMAND_PARLY_TOOLS.has(t.name));
    const githubEnabled = isPublicTurn ? false : Boolean(this.opts.github && hasGitHubToolkit(agent));
    // Only configured judges on public turns can award credits. Read-only fetch_url remains available to judges privately too.
    const awardEnabled = isPublicTurn && isShowcaseJudge(agent, this.opts.showcaseJudgeAgentIds);
    const fetchUrlEnabled = isPublicTurn || isShowcaseJudge(agent, this.opts.showcaseJudgeAgentIds);
    // The person to pay = the human who brought the pitch (thread's root author), resolved by the hub, never the model.
    const showcaseRecipientId = awardEnabled ? rootHuman : undefined;
    let declarations = [
      ...(this.parly && !isPublicTurn ? PARLY_TOOLS : []),
      ...(githubEnabled ? GITHUB_CLOUD_TOOLS.filter((t) => act || !GITHUB_WRITE_TOOL_NAMES.has(t.name)) : []),
      ...(awardEnabled ? [AWARD_CREDITS_TOOL] : []),
      ...(fetchUrlEnabled ? [FETCH_URL_TOOL] : []),
      ...(this.opts.webSearch ? [WEB_SEARCH_TOOL] : []),
      ...mcp.filter((t) => !ON_DEMAND_PARLY_TOOLS.has(t.name)).map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 1000), parametersJsonSchema: t.inputSchema })),
      // Also with no apps: the on-demand Parly tools are reached only through them.
      ...(apps.length || onDemand.length ? META_TOOLS : []),
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // stable order: part of the cached prefix
    // The model, asked once more with tools off: a summary of what this turn found, so work isn't thrown away.
    const synthesize = async (): Promise<string> => {
      if (!(await canCallModel())) return '';
      const note = { text: "(Tools are off now. Answer the request with what you've found so far: give the results you have, and say plainly what's still missing and why.)" };
      const synthContents =
        contents.at(-1)?.role === 'user'
          ? [...contents.slice(0, -1), { role: 'user', parts: [...contents.at(-1)!.parts, note] }]
          : [...contents, { role: 'user', parts: [note] }];
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: synthContents,
          ...withConfig,
          ...(declarations.length ? { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
        }),
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
      });
      if (!res.ok) return '';
      const body = (await res.json()) as { candidates?: { content?: { parts?: Part[] } }[]; usageMetadata?: LlmUsage };
      if (body.usageMetadata) {
        logModelInput(agent.id, 'synthesize', system, declarations, synthContents, body.usageMetadata);
        await this.opts.meter.add(turnPayer, costMicros(this.opts.prices, body.usageMetadata), { id: agent.id, usage: body.usageMetadata }, undefined, meterOpts);
      }
      return answerText(body.candidates?.[0]?.content?.parts ?? []);
    };
    const maxCallsPerStep = this.opts.maxCallsPerStep ?? MAX_CALLS_PER_STEP;
    const maxRounds = this.opts.maxRounds ?? MAX_ROUNDS;
    const turnBudgetMicros = this.opts.turnBudgetMicros ?? TURN_BUDGET_MICROS;
    const taskMaxRounds = this.opts.taskMaxRounds ?? TASK_MAX_ROUNDS;
    const taskBudgetMicros = this.opts.taskBudgetMicros ?? TASK_BUDGET_MICROS;
    // The same call twice in a turn gets the first result's reminder, not a second run (loops burn steps and money).
    const tried = new Map<string, number>();
    // Each earlier result is shrunk once and only once across the whole task (see shrinkOldResults).
    const shrunkResults = new WeakSet<object>();
    let totalSpent = 0;
    let turnSpent = 0;
    let turnRounds = 0;
    let turnProgress = 0;
    let totalProgress = 0;
    let stalledRounds = 0;
    let nudgedContinue = false;
    // It posted part of its answer with its own tool, then failed: the push queue counts a turn it posted in as answered,
    // so a rethrow would leave the fragment standing as the whole answer. Say so instead. Nothing posted: rethrow and retry.
    try {
      for (let totalRounds = 0; totalRounds < taskMaxRounds; totalRounds++, turnRounds++) {
        signal?.throwIfAborted();
        const hitTaskBreaker = totalRounds >= taskMaxRounds - 1 || totalSpent >= taskBudgetMicros;
        const hitTurnLimit = turnRounds >= maxRounds - 1 || turnSpent >= turnBudgetMicros;
        const hasActiveProgress = turnProgress > 0 && stalledRounds < 2;
        // Auto-continue: when hitting the per-turn round or spend limit mid-task with active progress, continue into
        // the next turn window automatically unless the per-task circuit breaker is reached.
        if (!hitTaskBreaker && hitTurnLimit && hasActiveProgress) {
          turnRounds = 0;
          turnSpent = 0;
          turnProgress = 0;
        }
        // The final step (circuit breaker tripped, or turn limit reached with no active progress): answer now with what it has.
        const lastRound = hitTaskBreaker || ((turnRounds >= maxRounds - 1 || turnSpent >= turnBudgetMicros) && !hasActiveProgress);
        // Results from earlier steps are sent again shortened: they were read already. Once each, so the request
        // prefix stays byte-stable for caching instead of re-wrapping into nested soup every round.
        shrinkOldResults(contents.slice(0, -1), shrunkResults);
        if (totalRounds > 0 && !(await canCallModel()))
          return finish('Parly credits or the public showcase budget are used up, so I stopped before another model call.');
        if (totalRounds === 0) roundHasCredits = Promise.resolve(true);
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            ...withConfig,
            // Keep tools declared when history has functionCall/functionResponse parts; on the last round, mode NONE forces a text answer.
            ...(declarations.length
              ? {
                  tools: [{ functionDeclarations: declarations }],
                  ...(lastRound ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
                }
              : {}),
          }),
          signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
        });
        if (!res.ok) {
          const why = `Gemini answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
          // A passing failure (rate limit, server error) throws: the push queue tries again later, from the same point.
          if (res.status === 429 || res.status >= 500) throw new Error(why);
          // One that retrying won't fix (no such model, no access) is said in the chat, not retried in silence.
          console.error(`cloud agent ${agent.id}: ${why}`);
          // One it won't take with PDFs or pictures attached: tried again without them (the result still says they were there).
          const attached = contents.at(-1)!.parts.map((p) => p.functionResponse as { parts?: Attachment[] } | undefined).filter((r) => r?.parts);
          if (res.status === 400 && attached.length) {
            for (const r of attached) delete r!.parts;
            totalRounds--;
            turnRounds--;
            continue;
          }
          // A request the model won't take with Parly's MCP tools (a schema it rejects) is tried once without them.
          if (res.status === 400 && mcpNames.size && declarations.some((d) => mcpNames.has(d.name))) {
            declarations = declarations.filter((d) => !mcpNames.has(d.name));
            totalRounds--;
            turnRounds--;
            continue;
          }
          return reply(`I can't answer right now: the model I run on (${this.opts.model}) refused the call (HTTP ${res.status}). The Parly team has the details.`);
        }
        const body = (await res.json()) as { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]; usageMetadata?: LlmUsage };
        if (body.usageMetadata) {
          logModelInput(agent.id, 'loop', system, declarations, contents, body.usageMetadata);
          const cost = costMicros(this.opts.prices, body.usageMetadata);
          totalSpent += cost;
          turnSpent += cost;
          roundHasCredits = undefined;
          await this.opts.meter.add(turnPayer, cost, { id: agent.id, usage: body.usageMetadata }, undefined, meterOpts);
        }
        const parts = body.candidates?.[0]?.content?.parts ?? [];
        lastFinish = body.candidates?.[0]?.finishReason ?? '';
        const calls = parts.filter((p) => p.functionCall);
        // A broken tool call (MALFORMED_FUNCTION_CALL and the like) comes back empty: it gets one more try, told so.
        if (!calls.length && !answerText(parts) && lastFinish && lastFinish !== 'STOP' && !lastRound) {
          console.warn(`cloud agent ${agent.id}: empty turn (${lastFinish}), retrying`);
          steps.push(`a step that came back empty (${lastFinish})`);
          stalledRounds++;
          const note = { text: `(Your last step came back empty: ${lastFinish}. Call a tool with valid arguments, or answer in text.)` };
          if (contents.at(-1)?.role === 'user') contents.at(-1)!.parts.push(note);
          else contents.push({ role: 'user', parts: [note] });
          continue;
        }
        // Auto-continue if the model paused with empty output mid-task after making real tool progress.
        if (!calls.length && !answerText(parts) && !lastRound && totalProgress > 0 && stalledRounds < 2 && !nudgedContinue) {
          nudgedContinue = true;
          stalledRounds++;
          const note = { text: '(Continue from the tool results above: make any remaining tool calls you need, or write your final answer.)' };
          if (contents.at(-1)?.role === 'user') contents.at(-1)!.parts.push(note);
          else contents.push({ role: 'user', parts: [note] });
          continue;
        }
        if (lastRound || !calls.length) return finish(answerText(parts));
        contents.push({ role: 'model', parts });
        const results: Part[] = [];
        let stepSucceeded = false;
        for (const [i, { functionCall: call }] of calls.entries()) {
          if (i >= maxCallsPerStep) {
            results.push({ functionResponse: { name: call!.name, response: { ok: false, error: `Skipped: at most ${maxCallsPerStep} tool calls per step. Use what you have, or call it in the next step if you still need it.` } } });
            continue;
          }
          const key = `${call!.name}:${JSON.stringify(call!.args ?? {})}`;
          const times = (tried.get(key) ?? 0) + 1;
          tried.set(key, times);
          if (times > 1) {
            results.push({ functionResponse: { name: call!.name, response: { ok: false, error: 'You already made this exact call this turn: use its result. If it failed, change the arguments or explain the problem instead of repeating it.' } } });
            steps.push(`${call!.name === 'run_tool' ? String(call!.args?.tool ?? 'a tool') : call!.name}: repeated, skipped`);
            continue;
          }
          if (!RETRY_SAFE_TOOLS.has(call!.name)) mutated = true;
          const args = call!.args ?? {};
          const slug = call!.name === 'run_tool' ? String(args.tool ?? '') : '';
          const use = () => this.useTool(agent.id, owner, apps, act, githubEnabled, call!.name, args, { award: awardEnabled, fetch: fetchUrlEnabled, recipientId: showcaseRecipientId, key: messageId }, { payer: turnPayer, agentId: agent.id, meterOpts }, roundCredits);
          const run = isPublicTurn && (call!.name === 'parly_read_channel' || ON_DEMAND_PARLY_TOOLS.has(slug))
            ? Promise.resolve({ ok: false, error: 'Not available in a public conversation.' })
            : mcpNames.has(call!.name)
            ? this.parly!.callMcp(agent.id, call!.name, args, { conversationId, messageId })
            : onDemand.some((t) => t.name === slug)
            ? this.parly!.callMcp(agent.id, slug, (args.arguments as Record<string, unknown> | undefined) ?? {}, { conversationId, messageId })
            : call!.name === 'find_tools' && onDemand.length
            ? (async () => {
                const parly = findParlyTools(onDemand, args);
                const fromApps = apps.length && String(args.app ?? '').toLowerCase() !== 'parly' ? ((await use()) as { ok?: boolean; tools?: unknown[] }) : undefined;
                if (fromApps?.ok === false && !parly.length) return fromApps;
                return { ok: true, tools: [...(fromApps?.tools ?? []), ...parly] };
              })()
            : use();
          const out = (await run.catch((err: Error) => ({ ok: false, error: err.message }))) as { ok?: boolean };
          const what = call!.name === 'run_tool' ? String(call!.args?.tool ?? 'a tool') : call!.name;
          const error = (out as { error?: unknown }).error;
          steps.push(`${what}${out.ok === false ? `: failed (${String(error ?? 'no reason').slice(0, 160)})` : ''}`);
          if (out.ok !== false) {
            if (call!.name === 'reply' || call!.name === 'send_message') posted = true;
            stepSucceeded = true;
            turnProgress++;
            totalProgress++;
          }
          if (conversationId && call!.name !== 'find_tools') this.opts.onActivity?.(agent.id, `${out.ok === false ? 'Tried' : 'Ran'} ${what}`, conversationId);
          const app = call!.name === 'run_tool' ? toolkitOf(String(call!.args?.tool ?? ''), apps) : call!.name.startsWith('github_') ? 'github' : undefined;
          if (app) this.opts.onToolUse?.(owner, agent.id, app, what, out.ok !== false);
          const { whole, files, ...shown } = out as { whole?: boolean; files?: Attachment[]; ok?: boolean };
          const picked = whole === true || (call!.name === 'run_tool' && Array.isArray(call!.args?.fields) && (call!.args.fields as unknown[]).length > 0);
          const json = JSON.stringify(compact(shown, 0, picked));
          const cap = picked ? PICKED_RESULT_MAX : TOOL_RESULT_MAX;
          const response = JSON.parse(json.length > cap ? JSON.stringify({ ok: out.ok, truncated: json.slice(0, cap) }) : json);
          // PDFs and pictures go with the result as its parts (Gemini's multimodal function responses).
          results.push({ functionResponse: { name: call!.name, response, ...(files?.length ? { parts: files } : {}) } });
        }
        stalledRounds = stepSucceeded ? 0 : stalledRounds + 1;
        contents.push({ role: 'user', parts: results });
      }
      return finish('');
    } catch (err) {
      // Only the turn's OWN deadline aborts `signal` with a TimeoutError reason. A 429/5xx, an inner per-model-call
      // timeout (its 120s timeout composes a separate signal — the outer one stays un-aborted, reason undefined), or the
      // hub shutting down (AbortError) all land here with reason !== TimeoutError.
      const timedOut = signal?.reason?.name === 'TimeoutError';
      // Nothing landed and it wasn't our own deadline: let Cloud Tasks retry the whole turn transparently.
      if (!posted && !mutated && !timedOut) throw err;
      // ponytail: in-memory flag — a dropped request (SIGKILL/crash) after a write but before any post still replays.
      // Upgrade: persist "acted" on the sending cursor and extend push.ts's `retried` guard to cover it.
      const incomplete = posted ? ', so what I posted above is incomplete' : '';
      // Said in-band so the turn isn't redone from scratch (deadline, shutdown, or a post-mutation error).
      if (timedOut) return reply(`I'm still working on this but ran out of time for this turn${incomplete}. Say 'continue' and I'll pick it up from there.`);
      console.error(`cloud agent ${agent.id}: failed partway through the turn`, err);
      return reply(`I hit an error partway through${incomplete}. Say 'continue' and I'll pick it up from there.`);
    }
  }

  private appsFor(agent: AgentRecord): Promise<string[]> {
    return appsOf(this.opts.composio, agent);
  }

  private async useTool(agentId: string, owner: string, apps: string[], act: boolean, githubEnabled: boolean, name: string, args: Record<string, unknown>, showcase?: { award: boolean; fetch: boolean; recipientId?: string; key?: string }, billing?: { payer: string; agentId: string; meterOpts?: { freeOnly?: boolean; publicShowcase?: boolean; personId?: string } }, credits: Pick<LlmMeter, 'hasCredits' | 'charge'> = this.opts.meter): Promise<unknown> {
    if (name === 'parly_read_channel') return { ok: true, posts: await this.parly!.read(agentId, String(args.channel ?? ''), Math.min(50, Number(args.limit) || 20)) };
    if (name === 'web_search') {
      if (!this.opts.webSearch) return { ok: false, error: 'Web search is not configured on this hub.' };
      return this.opts.webSearch(String(args.query ?? ''), billing ?? { payer: owner, agentId });
    }
    if (name === 'fetch_url' || name === 'award_credits') {
      // fetch_url: any showcase crew agent on a public turn. award_credits: judge-only (it moves real credit).
      if (name === 'fetch_url' && !showcase?.fetch) return { ok: false, error: 'fetch_url is only available to showcase crew on a public turn.' };
      if (name === 'award_credits' && !showcase?.award) return { ok: false, error: 'Only a showcase judge can award credits.' };
      return runShowcaseCloudTool(
        this.opts.meter,
        {
          poolId: this.opts.showcasePoolId ?? 'default',
          poolCredits: this.opts.showcasePoolCredits ?? 0,
          ceiling: this.opts.showcaseUserCeiling ?? 0,
          judgeId: agentId,
          judgeOwnerId: owner,
          recipientId: showcase?.recipientId,
          key: showcase?.key,
        },
        name,
        args,
        // fetch_url must use the SSRF-safe publicFetch (showcase.ts default), never opts.fetchImpl (the Vertex fetch).
      );
    }
    if (GITHUB_READ_TOOL_NAMES.has(name) || GITHUB_WRITE_TOOL_NAMES.has(name)) {
      if (!this.opts.github || !githubEnabled) {
        return { ok: false, error: GITHUB_OFF };
      }
      if (GITHUB_WRITE_TOOL_NAMES.has(name) && !act) {
        return { ok: false, error: GITHUB_READ_ONLY };
      }
      return runGitHubCloudTool(this.opts.github, await this.opts.githubInstalls?.forOwner(owner), name, args);
    }
    const out = await useAppTool(this.opts.composio, owner, apps, act, name, args, credits, billing?.payer ?? owner);
    // What it found, it keeps: next turn it runs these without finding them again.
    const found = name === 'find_tools' ? (out as { tools?: { tool: string; app: string; does?: string; arguments?: unknown; writes?: boolean }[] }).tools : undefined;
    if (found?.length && this.opts.tools)
      await this.opts.tools
        .remember(agentId, found.slice(0, 10).map((t) => ({ tool: t.tool, app: t.app, ...(t.does ? { does: t.does.slice(0, 160) } : {}), arguments: compactArgs(t.arguments), ...(t.writes ? { writes: true } : {}) })))
        .catch((err) => console.error('tool memory', err));
    return out;
  }
}

/** The hub's forwarder: cloud agents are answered here; every other endpoint agent is called over A2A as before. */
export function withCloudAgents(a2a: Forwarder, cloud: CloudAgents | undefined): Forwarder {
  if (!cloud) return a2a;
  return {
    send: (agent, message, signal) => (agent.cloud ? cloud.answer(agent, message, signal) : a2a.send(agent, message, signal)),
    getTask: (agent, taskId) => a2a.getTask(agent, taskId),
    cancel: (agent, taskId) => a2a.cancel(agent, taskId),
    check: async (agent) => (agent.cloud ? { ok: true } : (a2a.check?.(agent) ?? { ok: true })),
  };
}
