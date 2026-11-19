import { dmKey } from '../chat/chat.js';
import { HubError } from '../lib/errors.js';
import { isPublicWorkspace, type AgentRecord } from '../registry/types.js';
import { appsOf, hasGitHubToolkit, pick, useAppTool } from './cloudAgent.js';
import { githubInstallUrl, toolkitOf } from './composio.js';
import {
  GITHUB_CLOUD_TOOLS,
  GITHUB_NATIVE_LOGO,
  GITHUB_NATIVE_NAME,
  GITHUB_READ_TOOL_NAMES,
  GITHUB_WRITE_TOOL_NAMES,
  runGitHubCloudTool,
} from './github.js';
import { GITHUB_OFF, GITHUB_READ_ONLY } from './githubTools.js';
import type { HubService } from './hubService.js';
import type { ToolUse } from './toolUsage.js';
import { appName } from './triggers.js';

/**
 * Your apps, from the apps' side (GET /me/apps): each connected app with each of your agents (not webhooks), whether
 * it may use it, and how it has (count, failures, last time and tool). Includes a synthetic native "GitHub (Parly App)"
 * entry with install status when Parly's GitHub App is configured.
 */
export async function myApps(
  hub: HubService,
  person: AgentRecord,
): Promise<
  {
    toolkit: string;
    name: string;
    logo?: string;
    native?: boolean;
    installUrl?: string;
    account: { id: string; status: string };
    agents: { id: string; name: string; avatar?: string; enabled: boolean; act: boolean; use?: Omit<ToolUse, 'ownerId' | 'agentId' | 'toolkit'> }[];
  }[]
> {
  if (!hub.composio && !hub.github) return [];
  const [accounts, bots, uses, ghInstall] = await Promise.all([
    hub.composio ? hub.composio.accounts(person.id) : Promise.resolve([]),
    hub.registry.botsOf(person),
    hub.toolUsage.ofOwner(person.id),
    hub.githubInstalls ? hub.githubInstalls.forOwner(person.id) : Promise.resolve(undefined),
  ]);
  const agents = bots.filter((b) => !b.archived && !b.webhookChannel);
  const mapAgents = (toolkit: string) =>
    agents.map((b) => {
      const u = uses.find((x) => x.agentId === b.id && x.toolkit === toolkit);
      return {
        id: b.id,
        name: b.name,
        ...(b.avatar ? { avatar: b.avatar } : {}),
        enabled: (b.tools?.toolkits ?? []).map((t) => t.toLowerCase()).includes(toolkit),
        act: !!b.tools?.act,
        ...(u ? { use: { uses: u.uses, ...(u.failures ? { failures: u.failures } : {}), lastAt: u.lastAt, lastTool: u.lastTool } } : {}),
      };
    });
  const byApp = new Map<string, { id: string; status: string }>();
  // Only apps that are connected: a sign-in left half way (INITIATED) or a lost connection isn't one of your apps.
  // Composio's github is excluded here; GitHub uses the native "GitHub (Parly App)" entry below.
  for (const a of accounts) {
    if (a.status === 'ACTIVE' && a.toolkit.toLowerCase() !== 'github') {
      byApp.set(a.toolkit, { id: a.id, status: a.status });
    }
  }
  const composioApps = await Promise.all(
    [...byApp].map(async ([toolkit, account]) => {
      const app = await hub.composio?.app(toolkit).catch(() => undefined);
      return {
        toolkit,
        name: app?.name ?? appName(toolkit),
        ...(app?.logo ? { logo: app.logo } : {}),
        account,
        agents: mapAgents(toolkit),
      };
    }),
  );
  const ghEntry = hub.github
    ? [
        {
          toolkit: 'github',
          name: GITHUB_NATIVE_NAME,
          logo: GITHUB_NATIVE_LOGO,
          native: true,
          ...(ghInstall ? { installUrl: githubInstallUrl(hub.githubAppSlug) } : {}),
          account: {
            id: ghInstall ? `github-app:${ghInstall.installationId}` : 'github-app',
            status: ghInstall ? 'ACTIVE' : 'NOT_INSTALLED',
          },
          agents: mapAgents('github'),
        },
      ]
    : [];
  return [...ghEntry, ...composioApps];
}

/**
 * find_tools / run_tool for a computer agent (Parly MCP): the same apps as a cloud agent's, used as its owner on the
 * hub, so no token ever reaches its computer. Nothing connected yet: the link to send its owner.
 */
export async function appTool(hub: HubService, agent: AgentRecord, name: 'find_tools' | 'run_tool', args: Record<string, unknown>): Promise<unknown> {
  // Any agent of yours (a coding tool you connected, a computer agent): your apps, as you, on the hub.
  if (agent.kind === 'human' || !agent.ownerId || agent.webhookChannel) throw new HubError('forbidden', "Only someone's own agents use their apps");
  if (!hub.composio && !hub.github) throw new HubError('unavailable', "This hub doesn't connect apps");
  const workspaces = agent.workspaces?.length ? await hub.registry.workspacesOf(agent) : [];
  const inPublicWorkspaceOnly = Boolean(workspaces.length && workspaces.every((w) => isPublicWorkspace(w)));
  const act = inPublicWorkspaceOnly ? false : !!agent.tools?.act;
  const githubEnabled = Boolean(hub.github && hasGitHubToolkit(agent));
  const composioApps = await appsOf(hub.composio, agent);
  const allApps = [...(githubEnabled ? ['github'] : []), ...composioApps];
  if (!allApps.length)
    return { ok: false, error: `No apps are turned on for you yet. Send your owner this link to connect one and turn it on for you: ${hub.toolsLink(agent)}` };

  if (name === 'find_tools') {
    return findComputerAgentTools(hub, agent, act, githubEnabled, composioApps, allApps, args);
  }
  if (name === 'run_tool') {
    const slug = String(args.tool ?? args.slug ?? args.tool_slug ?? args.name ?? '').trim();
    const lowerSlug = slug.toLowerCase();
    if (GITHUB_READ_TOOL_NAMES.has(lowerSlug) || GITHUB_WRITE_TOOL_NAMES.has(lowerSlug) || lowerSlug.startsWith('github_')) {
      return runNativeGitHubAppTool(hub, agent, slug, lowerSlug, act, githubEnabled, args);
    }
  }
  if (!hub.composio || !composioApps.length) {
    const slug = String(args.tool ?? args.slug ?? args.tool_slug ?? args.name ?? '').trim();
    return {
      ok: false,
      error: slug
        ? `${slug} isn't a tool of your apps (${allApps.join(', ')}). Use find_tools first.`
        : 'run_tool needs `tool`: the name find_tools gave, e.g. "github_pr_diff".',
    };
  }
  const owner = agent.ownerId ?? agent.id;
  const out = (await useAppTool(hub.composio, owner, composioApps, act, name, args, hub.llm, await hub.llm.payerOf(agent))) as { ok?: boolean };
  // What it ran shows in its day, as a cloud agent's does.
  if (name === 'run_tool') {
    const app = toolkitOf(String(args.tool ?? ''), composioApps);
    if (app) await hub.toolUsage.record(agent.ownerId!, agent.id, app, String(args.tool), out.ok !== false).catch((err) => console.error('tool use', err));
    // Where it was working when it ran it (its live activity), else its DM with its owner.
    const live = (await hub.chat.activity?.ofAgent(agent.id).catch(() => [])) ?? [];
    const conversationId = live[0]?.conversationId ?? dmKey(agent.ownerId!, agent.id);
    await hub.registry
      .logActivity(agent.id, { text: `${out.ok === false ? 'Tried' : 'Ran'} ${String(args.tool ?? 'a tool')}`, at: new Date().toISOString(), conversationId })
      .catch((err) => console.error('tool log', err));
  }
  return out;
}

async function findComputerAgentTools(
  hub: HubService,
  agent: AgentRecord,
  act: boolean,
  githubEnabled: boolean,
  composioApps: string[],
  allApps: string[],
  args: Record<string, unknown>,
): Promise<unknown> {
  const wanted = typeof args.app === 'string' && args.app.trim() ? args.app.trim().toLowerCase() : undefined;
  if (wanted && !allApps.includes(wanted)) {
    return { ok: false, error: `You can't use ${String(args.app)}. Your apps: ${allApps.join(', ')}` };
  }
  const ghTools =
    githubEnabled && (!wanted || wanted === 'github')
      ? GITHUB_CLOUD_TOOLS.filter((t) => act || !GITHUB_WRITE_TOOL_NAMES.has(t.name)).map((t) => ({
          tool: t.name,
          app: 'github',
          does: t.description,
          arguments: t.parametersJsonSchema,
          ...(GITHUB_WRITE_TOOL_NAMES.has(t.name) ? { writes: true } : {}),
        }))
      : [];
  if (wanted === 'github' || !composioApps.length || !hub.composio) {
    return { ok: true, tools: ghTools };
  }
  const composioRes = (await useAppTool(hub.composio, agent.ownerId ?? agent.id, composioApps, act, 'find_tools', args, hub.llm, await hub.llm.payerOf(agent))) as {
    ok?: boolean;
    tools?: unknown[];
    error?: string;
  };
  if (composioRes.ok === false) return ghTools.length ? { ok: true, tools: ghTools } : composioRes;
  return { ok: true, tools: [...ghTools, ...(composioRes.tools ?? [])] };
}

async function runNativeGitHubAppTool(
  hub: HubService,
  agent: AgentRecord,
  slug: string,
  lowerSlug: string,
  act: boolean,
  githubEnabled: boolean,
  args: Record<string, unknown>,
): Promise<unknown> {
  let out: { ok?: boolean; data?: unknown; error?: string };
  if (!hub.github || !githubEnabled) {
    out = { ok: false, error: GITHUB_OFF };
  } else if (!GITHUB_READ_TOOL_NAMES.has(lowerSlug) && !GITHUB_WRITE_TOOL_NAMES.has(lowerSlug)) {
    out = { ok: false, error: `No GitHub tool ${slug}` };
  } else if (GITHUB_WRITE_TOOL_NAMES.has(lowerSlug) && !act) {
    out = { ok: false, error: GITHUB_READ_ONLY };
  } else {
    const toolArgs =
      args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : args;
    const rawOut = (await runGitHubCloudTool(hub.github, await hub.githubInstalls?.forOwner(agent.ownerId ?? agent.id), lowerSlug, toolArgs)) as {
      ok?: boolean;
      whole?: boolean;
      data?: unknown;
      error?: string;
    };
    const { whole: _whole, ...cleanOut } = rawOut;
    const fields = Array.isArray(args.fields) ? args.fields.filter((f): f is string => typeof f === 'string' && !!f) : [];
    out = fields.length && cleanOut.ok && cleanOut.data !== undefined ? { ...cleanOut, data: pick(cleanOut.data, fields) } : cleanOut;
  }
  if (githubEnabled) {
    await hub.toolUsage.record(agent.ownerId!, agent.id, 'github', lowerSlug, out.ok !== false).catch((err) => console.error('tool use', err));
  }
  const live = (await hub.chat.activity?.ofAgent(agent.id).catch(() => [])) ?? [];
  const conversationId = live[0]?.conversationId ?? dmKey(agent.ownerId!, agent.id);
  await hub.registry
    .logActivity(agent.id, { text: `${out.ok === false ? 'Tried' : 'Ran'} ${lowerSlug}`, at: new Date().toISOString(), conversationId })
    .catch((err) => console.error('tool log', err));
  return out;
}
