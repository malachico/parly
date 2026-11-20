import { vertexAgentRanker } from './apps/appAgents.js';
import { Computers, noDriver, type ComputerDriver } from './computers/computers.js';
import { GkeDriver } from './computers/gkeDriver.js';
import { SlackBridge } from './slack/bridge.js';
import { SlackOAuth } from './slack/oauth.js';
import { SlackStore } from './slack/store.js';
import { TelegramBridge } from './telegram/bridge.js';
import { TelegramStore } from './telegram/store.js';
import { AI_MARKUP, LlmMeter } from './llm/llm.js';
import { GraphStore } from './graph/store.js';
import { llmRouter } from './llm/router.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Database } from './db/types.js';
import { Admin } from './admin/admin.js';
import { adminRouter } from './admin/routes.js';
import { buildHubCard } from './a2a/agentCard.js';
import { HubRequestHandler } from './a2a/handler.js';
import { a2aRouter } from './a2a/router.js';
import type { HubConfig } from './config.js';
import { A2AForwarder, type Forwarder } from './hub/forward.js';
import { CloudAgents, TASK_BUDGET_MICROS, TURN_BUDGET_MICROS, withCloudAgents } from './hub/cloudAgent.js';
import { makeWebSearch } from './hub/webSearch.js';
import { Composio, verifyComposioSignature } from './hub/composio.js';
import { GitHubApp, githubAppEnabled } from './hub/github.js';
import { GitHubInstalls } from './hub/githubInstalls.js';
import { GitHubInstallOAuth } from './hub/githubInstallOAuth.js';
import { verifyGitHubSignature } from './hub/triggers.js';
import { textOf } from './lib/wire.js';
import { retryingMemo } from './lib/retryingMemo.js';
import { parseKey } from './chat/chat.js';
import { callMcpTool, listMcpTools } from './mcp/inProcess.js';
import { McpEvents } from './mcp/events.js';
import { Billing, CREDIT_MICROS, verifyPaddleSignature } from './billing/billing.js';
import { payerName } from './billing/payer.js';
import { HubService } from './hub/hubService.js';
import { ClaudeRoutineWaker, type Waker } from './hub/wake.js';
import { authenticate, requireAgent, resolveClientIp, tokenResolver } from './lib/auth.js';
import { inviteMailer, noticeMailer } from './lib/mail.js';
import { RateLimiter, SharedRateLimiter } from './lib/rateLimit.js';
import { HTTP_STATUS_FOR, HubError, PlanLimitError } from './lib/errors.js';
import { mcpHandler } from './mcp/server.js';
import { createOAuth, type HubOAuth } from './oauth/index.js';
import { OAuthStore } from './oauth/store.js';
import { Registry, type CardFetcher } from './registry/registry.js';
import type { AgentRecord } from './registry/types.js';
import { googleVerifier, type GoogleVerifier } from './registry/google.js';
import { v1Router } from './rest/v1.js';
import { restRouter } from './rest/routes.js';
import { CloudTasksQueue, InlineQueue, pushRequestVerifier, type PushQueue, type PushVerifier } from './chat/queue.js';
import { Files } from './files/files.js';
import { vertexCatchupSummarizer, vertexThreadDigestFolder } from './chat/catchup.js';
import { decisionsRouter, vertexRouter } from './chat/router.js';
import { GcsFileStore, type FileStore } from './files/store.js';

interface AppDeps {
  db: Database;
  config: HubConfig;
  /** Overrides for tests. */
  forwarder?: Forwarder;
  waker?: Waker;
  fetchCard?: CardFetcher;
  verifyGoogle?: GoogleVerifier;
  fileStore?: FileStore;
  /** OAuth's tokens; made here unless given (createApp shares one with its OAuth server). */
  oauthStore?: OAuthStore;
  /** Where pushes to endpoint agents wait: Cloud Tasks when configured, else this process (InlineQueue). */
  queue?: PushQueue;
  /** Checks calls to /internal/push (tests stand in for Google's token check). */
  verifyPush?: PushVerifier;
  /** Starts and stops Parly computers (the GKE driver); none yet: hosted agents' mail waits. */
  computerDriver?: ComputerDriver;
  /** Cloud agents' calls to Vertex (tests stand in for Gemini). */
  cloudFetch?: typeof fetch;
  cloudToken?: () => Promise<string>;
  /** Composio's API (tests stand in for it). */
  composioFetch?: typeof fetch;
  /** GitHub's API for Parly's GitHub App (tests stand in for it). */
  githubFetch?: typeof fetch;
  /** Telegram Bot API (tests stand in for it). */
  telegramFetch?: typeof fetch;
  /** MCP Events callbacks (tests stand in for ChatGPT). */
  mcpEventsFetch?: typeof fetch;
}

/** A person's id, if they're still active; undefined for bots and archived accounts. */
function activeHumanId(person: AgentRecord | undefined): string | undefined {
  return person?.kind === 'human' && !person.archived ? person.id : undefined;
}

function oauthStoreFor(db: Database, config: HubConfig): OAuthStore {
  return new OAuthStore(db, { accessTtlMs: config.oauthAccessTtlMs, refreshTtlMs: config.oauthRefreshTtlMs });
}

export function createHub({ db, config, forwarder, waker, fetchCard, verifyGoogle, fileStore, oauthStore, queue, computerDriver, cloudFetch, cloudToken, composioFetch, githubFetch, telegramFetch, mcpEventsFetch }: AppDeps): HubService {
  const oauthTokens = oauthStore ?? oauthStoreFor(db, config);
  const webUrl = config.webUrl ?? config.publicUrl;
  const meter = new LlmMeter(db, Math.round(config.llmMonthlyAllowanceUsd * 1_000_000));
  const graph = new GraphStore(db, meter, { enabled: config.contextGraphEnabled, dailyCapMicros: Math.round(config.contextGraphDailyCapUsd * 1_000_000) });
  const registry = new Registry(db, {
    plans: Boolean(config.cloudAgents || config.paddle),
    fetchCard,
    allowPrivateUrls: config.allowPrivateAgentUrls,
    sealingKey: config.credentialsKey,
    requireSealing: config.requireCredentialsKey,
    registerLimiter: new SharedRateLimiter(db, 'register', config.registerLimitPerHour, 60 * 60 * 1000, 'registrations from your address'),
    verifyGoogle: verifyGoogle ?? googleVerifier(config.googleClientId, config.googleAuthDev),
    googleLimiter: new SharedRateLimiter(db, 'sign-in', config.googleAuthLimitPerHour, 60 * 60 * 1000, 'sign-in attempts from your address'),
    inviteLimiter: new RateLimiter(config.inviteLimitPerHour, 60 * 60 * 1000, 'invites'),
    mailInvite: inviteMailer(config.gmailUser, config.gmailAppPassword, config.webUrl),
    passwordLogin: config.passwordLogin,
    // Deleting a bot or rotating its token also ends its OAuth sign-ins.
    revokeTokens: (ids) => oauthTokens.revokeAgents(ids),
    // Archiving a workspace or channel drops its context graph (the registry logs a failed purge, never fails the archive).
    purgeGraph: (scope) => graph.purgeGraphFor(scope),
  });
  // A cloud agent's per-message breaker is in model cost (before AI_MARKUP): the turn cap in credits, converted.
  const turnCapMicros = config.agentTurnCreditCap ? Math.round((config.agentTurnCreditCap * CREDIT_MICROS) / AI_MARKUP) : TASK_BUDGET_MICROS;
  // Cloud agents (no computer) are answered by the hub itself; every other endpoint agent is called over A2A.
  const composio = config.composioApiKey ? new Composio(config.composioApiKey, composioFetch, config.githubAppSlug) : undefined;
  const github = githubAppEnabled(config) ? new GitHubApp({ appId: config.githubAppId!, privateKey: config.githubAppPrivateKey!, fetchImpl: githubFetch, publicReadToken: config.githubPublicReadToken }) : undefined;
  // Web search for every agent (cloud agents' tool + the web_search MCP tool), on the cloud agents' Vertex model.
  const webSearch = config.cloudAgents ? makeWebSearch({ ...config.cloudAgents, meter, accessToken: cloudToken, fetchImpl: cloudFetch }) : undefined;
  const cloud = config.cloudAgents
    ? new CloudAgents({
        ...config.cloudAgents,
        meter,
        taskBudgetMicros: turnCapMicros,
        turnBudgetMicros: Math.min(TURN_BUDGET_MICROS, turnCapMicros),
        webSearch,
        fetchImpl: cloudFetch,
        accessToken: cloudToken,
        composio,
        github,
        githubInstalls: { forOwner: async (ownerId) => hub.githubInstalls?.forOwner(ownerId) },
        publicTurnLimiter: new RateLimiter(config.publicTurnLimitPerHour, 60 * 60 * 1000, 'public showcase turns'),
        publicDailyCeilingMicros: Math.round(config.publicDailySpendCeilingUsd * 1_000_000),
        showcaseJudgeAgentIds: config.showcaseJudgeAgentIds,
        showcasePoolId: config.showcasePoolId,
        showcasePoolCredits: config.showcasePoolCredits,
        showcaseUserCeiling: config.showcaseUserCeiling,
        onActivity: (agentId, text, conversationId) =>
          void registry.logActivity(agentId, { text, at: new Date().toISOString(), conversationId }).catch((err) => console.error('tool log', err)),
        onToolUse: (ownerId, agentId, toolkit, tool, ok) => void hub.toolUsage.record(ownerId, agentId, toolkit, tool, ok).catch((err) => console.error('tool use', err)),
        tools: { known: (agentId) => hub.toolUsage.known(agentId), remember: (agentId, tools) => hub.toolUsage.remember(agentId, tools) },
      })
    : undefined;
  const forward = withCloudAgents(
    forwarder ??
      new A2AForwarder(config.forwardTimeoutMs, {
        allowPrivate: config.allowPrivateAgentUrls,
        sealingKey: config.credentialsKey,
        onAuthProblem: (agent, problem) => void registry.setAuthProblem(agent.id, problem).catch((err) => console.error('auth problem not recorded', err)),
      }),
    cloud,
  );
  const sendLimiter = new RateLimiter(config.sendLimitPerMinute, 60 * 1000, 'messages');
  const store = fileStore ?? (config.filesBucket ? new GcsFileStore(config.filesBucket) : undefined);
  const files = new Files(db, store, config.maxFileBytes, config.fileTtlMs, config.publicUrl);
  const routines = waker ?? new ClaudeRoutineWaker(config.wakeTimeoutMs, config.credentialsKey, undefined, config.allowPrivateAgentUrls, config.publicUrl);
  const driver = computerDriver ?? (config.gke ? new GkeDriver(config.gke) : noDriver);
  const computers = new Computers(db, registry, driver, {
    hubUrl: config.publicUrl,
    sealingKey: config.credentialsKey,
    idleMs: config.computerIdleMs,
    bootTimeoutMs: 3 * 60_000,
  });
  if (driver instanceof GkeDriver) driver.report = (id, state) => computers.onState(id, state);
  // Hosted agents wake on their owner's Parly computer; every other kind through its Routine or webhook.
  const wake: Waker = { fire: (agent, text, conversation) => (agent.wake?.type === 'computer' ? computers.wake(agent).then(() => ({})) : routines.fire(agent, text, conversation)) };
  const pushes = queue ?? (config.cloudTasks ? new CloudTasksQueue({ ...config.cloudTasks, url: pushUrl(config) }) : new InlineQueue());
  const billing = new Billing(db, config.paddle);
  const githubInstalls = github ? new GitHubInstalls(db) : undefined;
  const githubInstallOAuth = githubInstalls
    ? new GitHubInstallOAuth(db, githubInstalls, {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        appSlug: config.githubAppSlug,
        publicUrl: config.publicUrl,
        webUrl,
        fetchImpl: githubFetch,
      })
    : undefined;
  // MCP Events secrets are sealed like other credentials.
  const mcpEvents = new McpEvents(db, { sealingKey: config.credentialsKey, ...(mcpEventsFetch ? { fetchImpl: mcpEventsFetch } : {}) });
  const hub = new HubService(
    db,
    registry,
    forward,
    pushes,
    config.maxWaitMs,
    sendLimiter,
    files,
    {
      computers,
      llm: meter,
      billing,
      cloudAgents: Boolean(cloud),
      threadDeltaRule: config.threadDeltaRule,
      composio: cloud ? composio : undefined,
      webUrl,
      hosting: config.vertex ? { sealingKey: config.credentialsKey, requireSealing: config.requireCredentialsKey } : undefined,
      webSearch,
      github,
      githubInstalls,
      githubInstallOAuth,
      githubAppSlug: config.githubAppSlug,
      mcpEvents,
      turnDeadlineMs: config.turnDeadlineMs,
    },
    wake,
    { staleMs: config.wakeStaleMs, retryMs: config.wakeRetryMs },
  );
  if (pushes instanceof InlineQueue) pushes.setHandler((job) => hub.push.run(job));
  if (config.slack) {
    const slackStore = new SlackStore(db, config.credentialsKey);
    const slack = new SlackBridge(slackStore, hub, { signingSecret: config.slack.signingSecret, webUrl });
    hub.slack = slack;
    hub.slackOAuth = new SlackOAuth(db, slackStore, hub, {
      clientId: config.slack.clientId,
      clientSecret: config.slack.clientSecret,
      publicUrl: config.publicUrl,
      webUrl,
    });
  }
  if (config.telegram) {
    const telegramStore = new TelegramStore(db);
    hub.telegram = new TelegramBridge(telegramStore, hub, {
      botToken: config.telegram.botToken,
      webhookSecret: config.telegram.webhookSecret,
      webUrl,
      fetchImpl: telegramFetch,
    });
  }
  if (hub.slack || hub.telegram) {
    const slack = hub.slack;
    const telegram = hub.telegram;
    hub.chat.onPosted = (message) => {
      if (slack) void slack.onPosted(message).catch((err) => console.error(`Slack mirror of ${message.id}`, err));
      if (telegram) void telegram.onPosted(message).catch((err) => console.error(`Telegram mirror of ${message.id}`, err));
    };
  }
  // Local dev and tests post webhooks to private addresses; a deployed hub only to public https ones.
  if (config.allowPrivateAgentUrls) hub.appEvents.fetchImpl = fetch;
  hub.chat.logPosted = (m) => void hub.logPosted(m).catch((err) => console.error(`log of ${m.id}`, err));
  hub.chat.catchupLimiter = new RateLimiter(30, 60 * 60 * 1000, 'catch-up summaries');
  if (config.vertex?.project) {
    const flashLite = { ...config.vertex, model: 'gemini-3.5-flash-lite', location: 'global', accessToken: cloudToken, fetchImpl: cloudFetch };
    hub.chat.catchup = vertexCatchupSummarizer(flashLite);
    // THREAD_DIGEST: fold older thread replies into a rolling digest so wakes carry a recap, not the whole history.
    if (config.threadDigest) hub.chat.fold = vertexThreadDigestFolder(flashLite);
    hub.agentRanker = vertexAgentRanker({ ...config.vertex, model: config.searchModel, accessToken: cloudToken, fetchImpl: cloudFetch });
    hub.vertexPrices = config.vertex.prices;
    if (config.channelRouter && !config.channelRouterModel.startsWith('gemini-decision')) hub.chat.route = vertexRouter({ ...config.vertex, model: config.channelRouterModel, accessToken: cloudToken });
  }
  // CHANNEL_ROUTER_MODEL=gemini-decision-1 routes on the Decisions API instead (AI Studio key, not Vertex).
  if (config.channelRouter && config.channelRouterModel.startsWith('gemini-decision') && config.geminiApiKey) hub.chat.route = decisionsRouter({ apiKey: config.geminiApiKey, model: config.channelRouterModel });
  // Cloud agents remember the conversation and can read and post in their channels, as themselves.
  if (cloud) {
    // A failed first load must not stick for the instance's life, so don't cache the rejection.
    const mcpTools = retryingMemo(() => listMcpTools(hub));
    const me = async (id: string) => {
      const a = await registry.get(id);
      if (!a) throw new Error('No such agent');
      return a;
    };
    cloud.parly = {
      history: async (agentId, conversationId, limit) => {
        const agent = await me(agentId);
        if (!(await hub.chat.canRead(agent, conversationId))) return [];
        // What it had already heard (up to its cursor): what's new comes with the message being answered.
        const seen = (await hub.chat.store.seenIn(conversationId, [agentId]))[agentId];
        const messages =
          seen === undefined ? (await hub.chat.store.page(conversationId, limit + 1)).slice(0, -1) : await hub.chat.store.page(conversationId, limit, seen + 1);
        // A thread starts with its post, which lives in the channel.
        const key = parseKey(conversationId);
        const post = key.kind === 'thread' && (messages[0]?.seq ?? 1) <= 1 ? await hub.chat.store.message(key.post) : undefined;
        return [...(post ? [post] : []), ...messages].map((m) => ({ mine: m.fromId === agentId, from: m.from, text: textOf({ parts: m.parts }).slice(0, 4000) }));
      },
      read: async (agentId, channel, limit) => {
        const agent = await me(agentId);
        const ch = await registry.resolveMemberChannel(agent, channel.replace(/^#/, ''));
        const page = await hub.chat.page(agent, `channel:${ch.id}`, limit);
        return page.messages.map((m) => ({ id: m.id, from: m.from, at: m.at, text: textOf({ parts: m.parts }).slice(0, 6000) }));
      },
      mcpTools,
      callMcp: async (agentId, name, args, turn) => callMcpTool(hub, await me(agentId), name, args, turn),
      // The person who brought the pitch: the human author of the thread's root post (or the channel post itself on a root turn; never a relaying crew bot).
      humanId: async (id) => activeHumanId(await registry.get(id)),
      name: (id) => payerName(id, { agent: (a) => registry.get(a), workspace: (w) => registry.workspaceDoc(w) }),
      showcaseVisitor: async (conversationId, messageId) => {
        const key = parseKey(conversationId);
        if (key.kind === 'dm') return undefined;
        const rootId = key.kind === 'thread' ? key.post : messageId;
        if (!rootId) return undefined;
        const root = await hub.chat.store.message(rootId);
        if (!root?.fromId || root.conversationId !== `channel:${key.channelId}`) return undefined;
        return activeHumanId(await registry.get(root.fromId));
      },
    };
  }
  return hub;
}

/** Where Cloud Tasks delivers push jobs. */
function pushUrl(config: HubConfig): string {
  return `${config.publicUrl}/internal/push`;
}

/** A webhook's body as express.raw left it, untouched: signatures are checked over these exact bytes. */
function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

/** The signed body parsed as JSON, or undefined once a 400 has been sent. */
function rawJson<T>(raw: Buffer, res: Response): T | undefined {
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    res.status(400).json({ error: 'invalid json' });
    return undefined;
  }
}

export function createApp(deps: AppDeps): { app: express.Express; hub: HubService; oauth?: HubOAuth } {
  const oauthStore = deps.oauthStore ?? oauthStoreFor(deps.db, deps.config);
  const hub = createHub({ ...deps, oauthStore });
  const oauth = createOAuth(deps.config, oauthStore, hub.registry);
  const app = express();
  app.disable('x-powered-by');
  // Cloud Run's front end is the one proxy hop, so req.ip is the real client.
  app.set('trust proxy', 1);
  // MCP gets room for upload_file's base64 (5MB of bytes is ~6.7MB of base64); everything else stays small.
  // Before the JSON parser: the LLM proxy passes bodies through as they are, and they're large.
  app.use('/llm', llmRouter(hub.llm, deps.config.vertex, (id) => hub.registry.get(id), (ownerId) => void hub.computers.touch(ownerId)));
  // Paddle signs the raw body too: its webhook sets plans and adds top-ups (billing/billing.ts).
  if (deps.config.paddle) {
    const secret = deps.config.paddle.webhookSecret;
    app.post('/billing/paddle', express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
      const raw = rawBody(req);
      if (!verifyPaddleSignature(raw, req.header('paddle-signature'), secret)) return void res.status(401).json({ error: 'bad signature' });
      const event = rawJson<Parameters<typeof hub.billing.handle>[0]>(raw, res);
      if (event === undefined) return;
      hub.billing
        .handle(event)
        .then((outcome) => res.json({ ok: true, outcome }), next);
    });
  }
  // Composio signs its trigger events (a new email, …) over the raw body: they reach agents (HubService.onComposioEvent).
  if (deps.config.composioWebhookSecret) {
    const secret = deps.config.composioWebhookSecret;
    hub.triggersEnabled = true;
    app.post('/composio/events', express.raw({ type: '*/*', limit: '2mb' }), (req, res, next) => {
      const raw = rawBody(req);
      const ok = verifyComposioSignature(raw, { id: req.header('webhook-id'), timestamp: req.header('webhook-timestamp'), signature: req.header('webhook-signature') }, secret);
      if (!ok) return void res.status(401).json({ error: 'bad signature' });
      const event = rawJson<Record<string, unknown>>(raw, res);
      if (event === undefined) return;
      hub.triggerService.onComposioEvent(event).then((outcome) => res.json({ ok: true, outcome }), next);
    });
  }
  // GitHub App webhook: signed over the raw body with X-Hub-Signature-256 (GITHUB_WEBHOOK_SECRET).
  // Fail-closed: missing/empty secret or bad/absent signature returns 401 with no side effects.
  if (deps.config.githubWebhookSecret && hub.githubInstalls) {
    hub.triggersEnabled = true;
    hub.githubTriggersEnabled = true;
  }
  app.post('/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), (req, res, next) => {
    const secret = deps.config.githubWebhookSecret ?? '';
    const raw = rawBody(req);
    if (!verifyGitHubSignature(raw, req.header('x-hub-signature-256'), secret)) return void res.status(401).json({ error: 'bad signature' });
    const payload = rawJson<Record<string, unknown>>(raw, res);
    if (payload === undefined) return;
    hub.triggerService
      .onGitHubEvent({ event: req.header('x-github-event'), deliveryId: req.header('x-github-delivery'), payload })
      .then((outcome) => res.json({ ok: true, outcome }), next);
  });
  // Slack signs the raw body: it's checked before anything parses it.
  if (hub.slack) {
    const slack = hub.slack;
    // Slash commands and interactions are signed the same way, over the raw form body.
    for (const [path, handle] of [['/slack/commands', slack.command], ['/slack/interactions', slack.interaction]] as const) {
      app.post(path, express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
        handle
          .call(slack, rawBody(req), req.header('x-slack-request-timestamp'), req.header('x-slack-signature'))
          .then(({ status, body }) => (body === '' ? res.status(status).end() : res.status(status).json(body)), next);
      });
    }
    app.post('/slack/events', express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
      slack
        .receive(rawBody(req), req.header('x-slack-request-timestamp'), req.header('x-slack-signature'))
        .then(({ status, body }) => res.status(status).json(body), next);
    });
  }
  if (hub.telegram) {
    const telegram = hub.telegram;
    app.post('/telegram/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
      telegram
        .receive(rawBody(req), req.header('x-telegram-bot-api-secret-token'))
        .then(({ status, body }) => res.status(status).json(body), next);
    });
  }
  app.use('/mcp', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(resolveClientIp(deps.config.proxySecret));
  // Cloud Tasks delivers push jobs here, before agent sign-in: its bearer is a Google OIDC token, not an agent's.
  // A job that fails (a non-2xx answer) is retried by the queue.
  if (deps.config.cloudTasks) {
    const verify = deps.verifyPush ?? pushRequestVerifier({ serviceAccount: deps.config.cloudTasks.serviceAccount, url: pushUrl(deps.config) });
    app.post('/internal/push', (req, res, next) => {
      verify(req.header('authorization'), req.body)
        .then((job) => {
        const started = Date.now();
        return hub.push.run(job).catch((err) => {
          console.error(`push failed: agent ${job.agentId}, conversation ${job.conversationId}, after ${Date.now() - started}ms`, err);
          throw err;
        });
      })
        .then(() => res.status(204).end(), next);
    });
  }
  // Apps' API: app keys only, so it sits before agent sign-in (a pk_live_ key is never an agent token).
  app.use('/v1', v1Router(hub));
  app.use(authenticate(tokenResolver(hub.registry, oauth?.agentFor)));
  // 401s name this, so MCP clients know where to sign in.
  if (oauth) app.locals.resourceMetadataUrl = oauth.resourceMetadataUrl;
  app.locals.tickSecret = deps.config.tickSecret;

  app.get('/', (_req, res) => {
    res.json({
      name: 'Parly',
      agentCard: `${deps.config.publicUrl}/.well-known/agent-card.json`,
      a2a: `${deps.config.publicUrl}/a2a`,
      mcp: `${deps.config.publicUrl}/mcp`,
      agents: `${deps.config.publicUrl}/agents`,
      ...(oauth ? { oauth: `${deps.config.publicUrl}/.well-known/oauth-authorization-server` } : {}),
    });
  });
  // Before the A2A router: OAuth's routes are under /.well-known/oauth-* and its own paths, no overlap.
  if (oauth) app.use(oauth.router);
  app.use(a2aRouter(new HubRequestHandler(hub, buildHubCard(deps.config.publicUrl))));
  // Unidentified callers get a 401 that tells an OAuth-capable client where to sign in.
  app.post('/mcp', requireAgent, mcpHandler(hub));
  app.all('/mcp', (_req, res) => {
    // Stateless server: no SSE stream (GET) or session teardown (DELETE).
    res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
  });
  app.use(adminRouter(new Admin(deps.db, hub, noticeMailer(deps.config.gmailUser, deps.config.gmailAppPassword)), hub.billing));
  app.use(restRouter(hub, { sealingKey: deps.config.credentialsKey, publicUrl: deps.config.publicUrl, webUrl: deps.config.webUrl }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HubError) {
      res.status(HTTP_STATUS_FOR[err.code]).json({ error: err.message, ...(err instanceof PlanLimitError ? err.info : {}) });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return { app, hub, oauth };
}
