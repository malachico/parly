import { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, bearer, ipOf, requireAgent } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { githubInstallUrl, POPULAR } from '../hub/composio.js';
import { GITHUB_CLOUD_TOOLS, GITHUB_NATIVE_LOGO, GITHUB_NATIVE_NAME } from '../hub/github.js';
import { isSuperAdmin } from '../lib/admin.js';
import { agentView } from '../lib/present.js';
import { isCompanyOwner } from '../billing/company.js';
import { MAX_LIVE_BOTS } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';
import { json, myWorkspaces, str } from './helpers.js';

/** Accounts and you: sign-in, /me, plan and billing, your apps and tools. */
/** How much of the credit that pays for this person's work is used (0 to 1): their company pool's when linked, else their own. */
export async function usedByPayer(llm: Pick<HubService['llm'], 'payerOf' | 'used'>, me: AgentRecord): Promise<number> {
  return Math.min(1, await llm.used(await llm.payerOf(me)));
}

export function accountRoutes(router: Router, hub: HubService): void {

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get(
    '/agents',
    json(async (req) =>
      {
        const channel = str(req.query.channel);
        const agents = await hub.registry.search(agentOf(req), { query: str(req.query.q), skill: str(req.query.skill), workspace: str(req.query.workspace), channel });
        // Members of a channel come with their role in it.
        const roles = channel ? await hub.registry.channelRolesFor(agentOf(req), channel) : undefined;
        return agents.map((a) => ({ ...agentView(a), ...(roles?.[a.id] ? { role: roles[a.id] } : {}) }));
      },
    ),
  );

  /** Google sign-in for people: `{idToken}` from Google Identity Services. Returns a session token. */
  router.post(
    '/auth/google',
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { agent, token, created } = await hub.registry.signInWithGoogle(String(body.idToken ?? ''), ipOf(req));
      // A new person meets their first agents; signing in never waits on them, nor fails for them.
      const first = created ? await hub.starterAgents(agent).catch((err) => console.error('starter agents not made', err)) : undefined;
      return { agent: { ...agentView(agent), email: agent.email }, token, created, ...(first ? { first } : {}) };
    }),
  );

  /**
   * Self-hosted password sign-in (PASSWORD_LOGIN=1), same answer as /auth/google: `{email, password}` signs in;
   * `/setup` `{setupSecret, email, name?, password}` makes the first owner once; `/signup` adds `name?`.
   */
  const passwordAuth = (fn: (body: Record<string, unknown>, ip?: string) => Promise<{ agent: AgentRecord; token: string; created: boolean }>) =>
    json(async (req) => {
      const { agent, token, created } = await fn((req.body ?? {}) as Record<string, unknown>, ipOf(req));
      const first = created ? await hub.starterAgents(agent).catch((err) => console.error('starter agents not made', err)) : undefined;
      return { agent: { ...agentView(agent), email: agent.email }, token, created, ...(first ? { first } : {}) };
    });
  router.post('/auth/password', passwordAuth((b, ip) => hub.registry.signInWithPassword(String(b.email ?? ''), String(b.password ?? ''), ip)));
  router.post('/auth/password/setup', passwordAuth((b, ip) => hub.registry.setupOwner({ setupSecret: str(b.setupSecret), email: str(b.email), name: str(b.name), password: typeof b.password === 'string' ? b.password : undefined }, ip)));
  router.post('/auth/password/signup', passwordAuth((b, ip) => hub.registry.signUpWithPassword({ email: str(b.email), name: str(b.name), password: typeof b.password === 'string' ? b.password : undefined }, ip)));

  /** Ends a web session: revokes the session token sent as the bearer (a main token is left alone). */
  router.post(
    '/auth/logout',
    requireAgent,
    json(async (req) => {
      await hub.registry.revokeSession(agentOf(req)!, bearer(req)!);
      return { ok: true };
    }),
  );

  /** The caller's Parly computer: `{state: 'none'|'stopped'|'starting'|'ready'|'stopping', problem?}`. */
  router.get(
    '/me/computer',
    requireAgent,
    json(async (req) => {
      const c = await hub.computers.get(agentOf(req)!.id);
      return c ? { state: c.state, ...(c.problem ? { problem: c.problem } : {}) } : { state: 'none' };
    }),
  );

  /** How much of this month's allowance for hosted agents' work the caller has used (0 to 1), and when it renews. */
  router.get(
    '/me/usage',
    requireAgent,
    json(async (req) => {
      const now = new Date();
      const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
      return { used: await usedByPayer(hub.llm, agentOf(req)!), period: now.toISOString().slice(0, 7), resetsAt };
    }),
  );

  router.get(
    '/me',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      // `pending` reads every conversation of yours; `?pending=0` (the web app, on every page) skips it.
      const [workspaces, pending, hire] = await Promise.all([
        myWorkspaces(hub, me),
        req.query.pending === '0' ? undefined : hub.chat.newFor(me).then((n) => n.length),
        me.kind === 'human' ? hub.canHire(me) : false,
      ]);
      return {
        ...agentView(me, me),
        ...(me.email ? { email: me.email } : {}),
        /** My workspaces, each with the channels I am in there. */
        workspaces,
        /** Conversations with something new for you (check_inbox). */
        ...(pending !== undefined ? { pending } : {}),
        /** A super admin: the web app shows them the admin dashboard. */
        ...(isSuperAdmin(me) ? { admin: true } : {}),
        /** It can hire agents that run on Parly here (the web app shows Hire an agent). */
        ...(hire ? { hire: true } : {}),
        /** It can make cloud agents here (Connect an agent → Cloud agent). */
        ...(me.kind === 'human' && hub.cloudAgents ? { cloud: true } : {}),
        /** The knowledge graph is on (CONTEXT_GRAPH_ENABLED): the web app shows Knowledge. */
        ...(hub.graph ? { graph: true } : {}),
      };
    }),
  );

  /**
   * A signed-in (Google) person makes a bot they own: `{name, description?, url?, skills?, public?}`. The token
   * is returned once. With `follow: true` it is their own tool instead (the web's Connect page): a private
   * bot in no workspace until a member adds it: a mailbox, or an A2A endpoint with `url` (`skills` and `public` are ignored).
   */
  /** A signed-in person hires an agent that runs on Parly: `{name, workspaceId?}` (it joins that workspace). It greets them in their DM. */
  router.post(
    '/agents/hire',
    requireAgent,
    json(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const agent = await hub.hire(agentOf(req)!, str(body.name), str(body.workspaceId));
      res.status(201);
      return { agent: agentView(agent, agentOf(req)) };
    }),
  );

  /** Your plan: what it gives you, what you've used, and (when the hub takes payments) how to pay through Paddle. */
  router.get(
    '/me/billing',
    requireAgent,
    json(async (req) => {
      // Nothing here costs credits (a self-hosted hub: no cloud agents, no payments): no plan to show.
      if (!hub.cloudAgents && !hub.billing.paddle) throw new HubError('unsupported', "This hub doesn't bill");
      const me = agentOf(req)!;
      const [rec, limits, { spentMicros, capMicros }, hired] = await Promise.all([hub.billing.get(me.id), hub.llm.limits(me.id), hub.llm.balance(me.id), hub.registry.agentCount(me, true)]);
      const connected = await hub.registry.agentCount(me, false);
      const owned = await hub.registry.ownedWorkspaceUsage(me, me);
      // Whoever actually pays (payerOf): a company on Team or Enterprise shows by name; the pool's balance is its owners' to see.
      const payer = await hub.llm.payerOf(me);
      const pool = payer !== me.id ? await hub.registry.workspaceDoc(payer) : undefined;
      // A company pays: its credit is what runs out, so `used` is its ratio (never its dollars).
      const used = pool ? Math.min(1, await hub.llm.used(payer)) : capMicros > 0 ? spentMicros / capMicros : 1;
      // Why work stops, if it does: the payer's credits ran out, or its owners' monthly budget was reached (no amounts).
      const blockedBy = await hub.llm.blockedBy(payer);
      const p = hub.billing.paddle;
      return {
        plan: limits.plan,
        monthlyUsd: limits.monthlyMicros / 1e6,
        extraUsd: limits.extraMicros / 1e6,
        used: Math.min(1, used),
        leftUsd: Math.max(0, capMicros - spentMicros) / 1e6,
        workspaces: { count: owned.count, max: owned.max },
        // Legacy, for one release: bot counts against the flat per-person bot guard.
        hired,
        maxHired: MAX_LIVE_BOTS,
        connected,
        maxConnected: MAX_LIVE_BOTS,
        referrals: rec?.referrals ?? 0,
        ...(pool ? { billedTo: { workspaceId: pool.id, name: pool.name, ...(isCompanyOwner(await hub.billing.get(pool.id), pool, me.id) ? { owner: true } : {}) } } : {}),
        ...(blockedBy ? { blockedBy } : {}),
        ...(rec?.periodEnd ? { periodEnd: rec.periodEnd } : {}),
        ...(rec?.cancelAtPeriodEnd ? { cancelAtPeriodEnd: true } : {}),
        canManage: !!(p && rec?.paddleCustomerId),
        ...(p?.clientToken ? { paddle: { clientToken: p.clientToken, environment: p.environment, prices: p.prices } } : {}),
      };
    }),
  );

  router.post('/me/vouchers/redeem', requireAgent, json(async (req) => {
    const user = agentOf(req)!;
    if (user.kind !== 'human') throw new HubError('forbidden', 'Sign in as a person to redeem a voucher');
    return hub.billing.redeemVoucher(user.id, req.body?.code);
  }));

  /** Paddle's customer portal for your subscription (cards, invoices, cancelling): `{url}`. */
  router.post(
    '/me/billing/portal',
    requireAgent,
    json(async (req) => ({ url: await hub.billing.portalUrl(agentOf(req)!.id) })),
  );

  /**
   * Your tools for cloud agents: the apps you connected (`connected`) and the popular ones (`popular`), each with your
   * account for it if any. `?q=` searches all of Composio's apps instead (`results`).
   */
  router.get(
    '/me/tools',
    requireAgent,
    json(async (req) => {
      const composio = hub.composio;
      const me = agentOf(req)!;
      const ghInstall = hub.githubInstalls ? await hub.githubInstalls.forOwner(me.id) : undefined;
      const ghEntry = hub.github
        ? {
            slug: 'github',
            name: GITHUB_NATIVE_NAME,
            logo: GITHUB_NATIVE_LOGO,
            description: "Read PR diffs & files, comment, and open PRs via Parly's GitHub App.",
            tools: GITHUB_CLOUD_TOOLS.length,
            connectable: Boolean(hub.githubInstallOAuth?.configured),
            native: true,
            // Connected: link to manage on GitHub. Not connected: no installUrl — Connect goes through
            // POST /me/tools/github/connect so a single-use state is bound to this person.
            ...(ghInstall ? { installUrl: githubInstallUrl(hub.githubAppSlug) } : {}),
            account: {
              id: ghInstall ? `github-app:${ghInstall.installationId}` : 'github-app',
              status: ghInstall ? 'ACTIVE' : 'NOT_INSTALLED',
              ...(ghInstall ? { login: ghInstall.accountLogin } : {}),
            },
          }
        : undefined;
      if (!composio && !ghEntry) return { available: false, connected: [], popular: [] };
      const [accounts, catalog, popular] = composio
        ? await Promise.all([
            composio.accounts(agentOf(req)!.id),
            composio.catalog().catch(() => [] as Awaited<ReturnType<typeof composio.catalog>>),
            composio.popular(),
          ])
        : [[], [], []];
      const withAccount = <T extends { slug: string }>(t: T) => {
        const account = accounts.find((a) => a.toolkit === t.slug && a.status === 'ACTIVE') ?? accounts.find((a) => a.toolkit === t.slug);
        return { ...t, ...(account ? { account } : {}) };
      };
      const mine = await Promise.all(
        [...new Set(accounts.filter((a) => a.toolkit.toLowerCase() !== 'github').map((a) => a.toolkit))].map(
          async (slug) => (await composio?.app(slug).catch(() => undefined)) ?? { slug, name: POPULAR[slug] ?? slug, tools: 0, connectable: true },
        ),
      );
      const q = str(req.query.q);
      const composioResults = q && composio ? (await composio.searchCatalog(q)).map(withAccount) : [];
      const ghMatchesQuery =
        ghEntry && q
          ? ghEntry.name.toLowerCase().includes(q.toLowerCase()) ||
            ghEntry.slug.includes(q.toLowerCase()) ||
            ghEntry.description.toLowerCase().includes(q.toLowerCase())
          : false;
      return {
        available: true,
        triggers: hub.triggersEnabled,
        searchable: catalog.length > 0,
        connected: [...(ghEntry ? [ghEntry] : []), ...mine.map(withAccount)],
        popular: popular.filter((t) => !mine.some((m) => m.slug === t.slug)).map(withAccount),
        ...(q ? { results: [...(ghMatchesQuery && ghEntry ? [ghEntry] : []), ...composioResults] } : {}),
      };
    }),
  );

  /** Your apps, from the apps' side: each connected app, which of your agents may use it, and how they have. */
  router.get(
    '/me/apps',
    requireAgent,
    json(async (req) => hub.myApps(agentOf(req)!)),
  );
  router.get(
    '/me/apps/:toolkit/usage',
    requireAgent,
    json(async (req) => hub.appHistory(agentOf(req)!, str(req.query.agent) ?? '', String(req.params.toolkit))),
  );
  router.get(
    '/me/triggers/:id/listeners/:lid/history',
    requireAgent,
    json(async (req) => hub.listenerHistory(agentOf(req)!, String(req.params.id), String(req.params.lid))),
  );

  /** Starts connecting a toolkit: `{callbackUrl}` (where Composio sends you back); returns Composio's sign-in `url` (or the GitHub App install URL for `github`). */
  router.post(
    '/me/tools/:toolkit/connect',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      if (me.kind !== 'human') throw new HubError('forbidden', 'People connect their accounts');
      const toolkit = String(req.params.toolkit);
      if (toolkit === 'github') {
        if (!hub.githubInstallOAuth) throw new HubError('unavailable', "This hub isn't connected to GitHub");
        const { url } = await hub.githubInstallOAuth.startInstall(me);
        return { url };
      }
      if (!hub.composio) throw new HubError('unavailable', "This hub doesn't offer tools");
      return { url: await hub.composio.connectUrl(me.id, toolkit, str((req.body ?? {}).callbackUrl) ?? '') };
    }),
  );

  /** Disconnects one of your accounts: none of your agents can use it any more. */
  router.delete(
    '/me/tools/accounts/:id',
    requireAgent,
    json(async (req) => {
      if (!hub.composio) throw new HubError('unavailable', "This hub doesn't offer tools");
      await hub.composio.disconnect(agentOf(req)!.id, String(req.params.id));
      return { ok: true };
    }),
  );

  /** A cloud agent of yours: `{toolkits, act}`, which of your toolkits it may use and whether it may act or only read. */
  router.put(
    '/agents/:id/tools',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const toolkits = Array.isArray(body.toolkits) ? body.toolkits.map(String) : [];
      const agent = await hub.setAgentTools(agentOf(req)!, String(req.params.id), { toolkits, act: body.act === true });
      return { tools: agent.tools };
    }),
  );
}
