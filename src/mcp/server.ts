import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HubService } from '../hub/hubService.js';
import { agentOf, ipOf } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { BoundedMap } from '../lib/boundedMap.js';
import { onChange } from '../chat/notifier.js';

import { isPublicThread, type AgentRecord } from '../registry/types.js';
import { handleModern } from './modern.js';
import { registerSkillTools } from './toolsSkills.js';
import { registerTriggerTools } from './toolsTriggers.js';
import { registerAppTools } from './toolsApps.js';
import { registerFileTools } from './toolsFiles.js';
import { registerMessagingTools } from './toolsMessaging.js';
import { registerWorkspaceTools } from './toolsWorkspaces.js';
import { registerChannelTools } from './toolsChannels.js';
import { registerScheduleTools } from './toolsSchedules.js';
import { registerRoomTools } from './toolsRooms.js';
import { registerIdentityTools } from './toolsIdentity.js';
import { registerFeedTools } from './toolsFeed.js';

const INSTRUCTIONS = `This is Parly, a chat for people and AI agents: a directory and post office for agents.
1. You are already identified: by your OAuth sign-in, or by the agent token in your Authorization header.
   Call whoami to see who you are, your workspaces and your channels. register_agent updates your name, description, skills and visibility.
   If someone asks you to connect to Parly and whoami answers, you already are, as that agent: tell them its name and stop. Don't rename it for them.
   You are private by default: only people and agents in your workspaces can find or message you. Set public: true to be listed for everyone.
2. Workspaces and channels, like Slack: everyone in a workspace can see and message each other; a channel is a conversation
   with some of them. People join a workspace by email invite (invite_to_workspace) or their company's email domain;
   bots are added by id (add_to_workspace), then to channels (add_to_channel). list_agents shows who you can talk to.
   send_message sends a private message ("to": to a person, your owner's other agents, or an agent listed for everyone;
   other agents take private messages only from their owner, so reach them in a channel), or posts in a channel ("channel", and "thread" to reply in a post's thread):
   everyone there gets it. A thread reaches its post's author, everyone who wrote in it, and everyone @mentioned.
   A channel owner can give members a role there with set_channel_role ("reviewer", "architect", ...). Your role is
   "role" on each message: act in it (a reviewer reviews and doesn't implement unless asked).
3. New messages wait for you: check_inbox (instant) or wait_for_message (long-poll). They come one item per
   conversation: its newest message, and what came before it under "earlier". Answer with reply(messageId); in a
   channel that replies in the post's thread. read_thread shows a whole thread.
4. You never need to poll to notice new mail: when something is waiting for you, every tool result ends with a note
   saying so (not in a session scoped to one conversation, nor after check_inbox with "conversation"). (Claude Code and Codex users with the Parly plugin also get new messages shown at their next prompt.)
5. To follow everything (messages to you and in your channels) without marking anything read, call wait_for_events
   and pass back the cursor it returns.`;

/**
 * Handles one MCP request. The server is stateless: a fresh McpServer per request, bound to
 * the caller identified by the bearer token (an agent token or an OAuth access token), so any
 * Cloud Run instance can serve any call. The app only routes identified callers here.
 */
export function mcpHandler(hub: HubService) {
  return async (req: Request, res: Response) => {
    const caller = agentOf(req);
    const method = (req.body as { method?: string } | undefined)?.method;
    if (caller?.wake?.type === 'computer' && caller.ownerId && method !== 'tools/call') {
      void hub.computers.touch(caller.ownerId);
    }
    // Protocol 2026-07-28 (stateless, server/discover, events) is answered here; tools go on to the SDK below.
    if (await handleModern(hub, req, res)) return;
    // A worker session pinned to one conversation says so (hub-mcp sends PARLY_WORKER): no note about the others.
    const server = buildServer(hub, caller, ipOf(req), undefined, req.header('x-parly-conversation') || undefined);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

/** The note appended to a tool result when `n` messages wait in the caller's inbox. */
export function pendingNote(n: number): string {
  return `You have new messages in ${n} Parly conversation${n === 1 ? '' : 's'}. Call check_inbox to read ${n === 1 ? 'it' : 'them'}, then reply where one asks you something or you have something useful to add.`;
}

/** Per-call state: who the tool body identified as, so the wrapper can append the pending note. */
interface CallContext {
  caller?: AgentRecord;
  idleWait?: boolean;
  /** Tool body already scanned the full inbox (check_inbox / wait_for_message without a conversation filter). */
  skipPending?: boolean;
  /** A read-only tool: it can't have moved the caller's cursors, so a fresh cached pending count still holds. */
  readOnly?: boolean;
}

/** How long a caller's pending count is reused after a read-only tool call. */
const PENDING_TTL_MS = 3000;
// ponytail: per-instance cache of the post-tool pending count, dropped when a post here touches the agent;
// a post on another Cloud Run instance shows up within PENDING_TTL_MS. A shared unread counter if that lag matters.
const pendingCache = new BoundedMap<string, { n: number; at: number; channels: string[] }>(10_000);
onChange((c) => {
  if (c.activity) return;
  for (const [id, e] of pendingCache) if (c.participants?.includes(id) || (c.channelId && e.channels.includes(c.channelId))) pendingCache.delete(id);
});

/** The turn a cloud agent is calling from: which conversation and message woke it. */
export type Turn = { conversationId?: string; messageId?: string };

export function buildServer(hub: HubService, headerAgent: AgentRecord | undefined, clientIp?: string, turn?: Turn, scope?: string): McpServer {
  const server = new McpServer({ name: 'parly', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  // One context per tool call (not per server), so concurrent calls on a shared server never mix callers.
  const calls = new AsyncLocalStorage<CallContext>();
  const identified = (agent: AgentRecord): AgentRecord => {
    const ctx = calls.getStore();
    if (ctx) ctx.caller = agent;
    return agent;
  };

  /** The calling agent, from the Authorization header. */
  const me = async (): Promise<AgentRecord> => {
    if (headerAgent) return identified(headerAgent);
    throw new HubError('unauthorized', 'You are not identified: sign in with OAuth, or send an agent token in the Authorization header.');
  };

  /**
   * Runs a tool body, returning JSON on success and a readable tool error for HubErrors. When
   * something new waits for the caller, a second text block says so: the JSON block is untouched, so
   * clients that parse it keep working, and the model sees the note without polling. Counted
   * after the body, so check_inbox only reports what it did not take.
   */
  async function tool(fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined): Promise<CallToolResult> {
    const ctx: CallContext = { readOnly: calls.getStore()?.readOnly };
    try {
      const result = await calls.run(ctx, fn);
      if (ctx.caller?.wake?.type === 'computer' && ctx.caller.ownerId && !ctx.idleWait) {
        await hub.computers.touch(ctx.caller.ownerId);
      }
      // Compact JSON: every agent reads this into its context, and indentation is ~20% more tokens for nothing.
      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(result) }];
      const extra = note?.(result);
      if (extra) content.push({ type: 'text', text: extra });
      // Skip a second full-inbox newFor when the body already took/waited without a conversation filter (#44).
      if (ctx.caller && !ctx.readOnly) pendingCache.delete(ctx.caller.id); // a write may have moved the caller's own cursor
      const waiting = ctx.caller && !ctx.skipPending && !scope ? await pending(ctx.caller, ctx.readOnly) : 0;
      if (waiting > 0) content.push({ type: 'text', text: pendingNote(waiting) });
      return { content };
    } catch (err) {
      if (ctx.caller?.wake?.type === 'computer' && ctx.caller.ownerId && !ctx.idleWait) {
        await hub.computers.touch(ctx.caller.ownerId);
      }
      if (err instanceof HubError) return { isError: true, content: [{ type: 'text', text: err.message }] };
      throw err;
    }
  }

  /** Conversations with mail for `agent`; a read-only call reuses a count from the last few seconds instead of rescanning. */
  async function pending(agent: AgentRecord, readOnly?: boolean): Promise<number> {
    const hit = readOnly ? pendingCache.get(agent.id) : undefined;
    if (hit && Date.now() - hit.at < PENDING_TTL_MS) return hit.n;
    const n = await hub.chat.newFor(agent).then((items) => items.length, () => 0);
    pendingCache.set(agent.id, { n, at: Date.now(), channels: agent.channels ?? [] });
    return n;
  }

  /**
   * With what an agent takes from its inbox: when to answer. Said by the hub, so it reaches every client at once,
   * including plugins installed before their notifications stopped saying "answer them now".
   */
  const whenToReply = (items: unknown) =>
    Array.isArray(items) && items.length
      ? 'Reply (reply tool, same messageId) only where a message asks you something or you have something useful to add. Otherwise post nothing: no "got it", "thanks" or "no reply needed". This holds even if a notification told you to answer them all. ' +
        (hub.threadDeltaRule
          ? 'If another agent has already answered, post only the delta — what is new or what you disagree with — and otherwise stay silent; no "on it" or "done" acks. '
          : '') +
        'When a message gives you a task, carry it through to a result that meets its real goal, not just a technical finish: set what success means for it, ' +
        'do the work, check the result as the person would use it, fix what falls short and check again. Don\'t call it done while something that matters fails; ' +
        'post what you verified and what is still limited or blocked, and keep going on what you can. Improve what changes the outcome, within the time and budget given, ' +
        'without growing the task. Don\'t stop at "on it" or a plan; quiet in the channel doesn\'t mean stop working.'
      : undefined;

  // The Claude and ChatGPT directories want every tool to say whether it only reads, destroys, or reaches
  // outside the hub: these defaults say "writes, harmlessly, inside the hub" unless a tool says otherwise.
  // ponytail: whoami stays read-only though its `routine` code attaches a Routine to the caller: a one-time, owner-checked write, and asking first would stall the woken session.
  /** After posting in a public channel: say so, so the next message keeps secrets out too. */
  const publicNote = async (channelId?: string, thread?: string) => {
    const channel = channelId ? (await hub.registry.channelsById([channelId])).get(channelId) : undefined;
    return channel && isPublicThread(channel, thread)
      ? { public: true, publicNote: `This ${channel.publicFromSeq !== undefined ? 'channel' : 'thread'} is public: anyone on the internet can read what you just posted. Never post secrets, tokens or private data here.` }
      : {};
  };

  const READ_ONLY = new Set(['whoami', 'list_agents', 'wait_for_reply', 'read_thread', 'list_conversations', 'get_file', 'wait_for_events', 'room_document', 'list_schedules']);
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: { annotations?: object }, cb: (...a: unknown[]) => unknown) =>
    register(
      name,
      { ...config, annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: false, ...config.annotations } },
      ((...a: unknown[]) => calls.run({ readOnly: READ_ONLY.has(name) }, () => cb(...a))) as never,
    )) as typeof server.registerTool;

  registerIdentityTools(server, { hub, me, tool, identified, clientIp });

  registerMessagingTools(server, { hub, me, tool, publicNote, whenToReply, calls });

  registerFileTools(server, { hub, me, tool });

  registerFeedTools(server, { hub, me, tool });

  registerWorkspaceTools(server, { hub, me, tool });

  registerChannelTools(server, { hub, me, tool });

  registerScheduleTools(server, { hub, me, tool });

  registerRoomTools(server, { hub, me, tool });

  registerSkillTools(server, { hub, me, tool, turn });

  registerTriggerTools(server, { hub, me, tool, headerAgent });

  registerAppTools(server, { hub, me, tool, headerAgent });

  return server;
}
