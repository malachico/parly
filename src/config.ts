import { parseSealingKey } from './lib/sealing.js';
export interface HubConfig {
  port: number;
  /** Public base URL of the hub, used in the hub's own agent card. */
  publicUrl: string;
  /** Upper bound for any long-poll (wait_for_message / wait_for_reply). Kept under typical proxy timeouts. */
  maxWaitMs: number;
  /**
   * Cloud Tasks queue for pushes to endpoint agents (CLOUD_TASKS_QUEUE: projects/<p>/locations/<l>/queues/<q>, and
   * CLOUD_TASKS_SERVICE_ACCOUNT, the account it calls /internal/push as). Unset: pushes run in this process.
   */
  cloudTasks?: { queue: string; serviceAccount: string };
  /** Timeout for a single A2A call to an endpoint agent. */
  forwardTimeoutMs: number;
  /** How long one pushed turn may run before it is cut short with an in-band close-out (under Cloud Run's 300s request ceiling). */
  turnDeadlineMs: number;
  /** Accept endpoint-agent URLs on loopback/private networks. Off on Cloud Run unless overridden. */
  allowPrivateAgentUrls: boolean;
  /** Seals endpoint-agent credentials at rest (CREDENTIALS_KEY: 32 bytes, base64). Unset: stored as given. */
  credentialsKey?: Buffer;
  /** Refuse to store endpoint-agent credentials unsealed (on by default on Cloud Run; REQUIRE_CREDENTIALS_KEY). */
  requireCredentialsKey: boolean;
  /** New registrations allowed per client IP per hour. */
  registerLimitPerHour: number;
  /** Messages (send_message / SendMessage / POST /tasks) allowed per agent per minute. */
  sendLimitPerMinute: number;
  /** Shared secret that lets a trusted server-side caller (the web app) relay its visitor's IP. */
  proxySecret?: string;
  /**
   * The Gemini model in Vertex AI that hosted agents run on (VERTEX_MODEL), with its project (VERTEX_PROJECT, default
   * this hub's) and location (VERTEX_LOCATION, default global), its prices in USD per million tokens
   * (LLM_PRICE_INPUT_PER_MTOK, LLM_PRICE_OUTPUT_PER_MTOK), and pre-first-byte timeout (VERTEX_TIMEOUT_MS, default
   * 25000). Optional Gemini API failover key (GEMINI_FALLBACK_API_KEY) and model (GEMINI_FALLBACK_MODEL, default
   * gemini-2.5-flash). What one turn of a hosted agent may spend before the hub stops it (COMPUTER_TURN_BUDGET_USD,
   * default 45; 0 = no limit). Unset model: no hosting.
   */
  vertex?: {
    model: string;
    project: string;
    location: string;
    prices: { input: number; output: number };
    timeoutMs?: number;
    fallbackApiKey?: string;
    fallbackModel?: string;
    /** Micro-dollars of model cost one hosted-agent turn may spend (raw cost, before markup). */
    turnBudgetMicros?: number;
  };
  /** A person's channel post that names no agent wakes only the ones it's for, picked by the Decisions API when a Gemini key is set, else a small Vertex model (CHANNEL_ROUTER_MODEL; CHANNEL_ROUTER=off: everyone wakes). */
  channelRouter: boolean;
  channelRouterModel: string;
  /** AI Studio key for the Decisions API router (GEMINI_API_KEY, else GEMINI_FALLBACK_API_KEY). With one, the router defaults to gemini-decision-1. */
  geminiApiKey?: string;
  /** The Vertex model that ranks candidates for agent/profile search (SEARCH_MODEL, default gemini-3.5-flash-lite — cheap; the ranker only emits a small {i,score,why} list). Falls back here rather than the hosted-agent VERTEX_MODEL so cheapening search doesn't downgrade hosted agents. */
  searchModel: string;
  /** Tell agents taking their inbox to post only the delta — what's new or what they disagree with once someone has answered — and otherwise stay silent (THREAD_DELTA_RULE=on; default off). */
  threadDeltaRule: boolean;
  /** Serve threads a rolling digest of older replies plus the verbatim tail instead of full history, folded by a small Vertex model (THREAD_DIGEST=off to disable; default on). */
  threadDigest: boolean;
  /** Build the context graph (CONTEXT_GRAPH_ENABLED=false or 0 to disable; default on). Off makes every graph helper a no-op. */
  contextGraphEnabled: boolean;
  /** What graph extraction may spend per workspace per UTC day, in USD of model cost; Parly pays, never user credits (CONTEXT_GRAPH_DAILY_CAP_USD, default 0.25; 0 = no extraction). */
  contextGraphDailyCapUsd: number;
  /** Vertex embedding model behind graph vector search; `dimensions` must match the Atlas index (changing it rebuilds that). */
  contextGraphEmbedding: { model: string; location: string; dimensions: number; pricePerMTok: number };
  /** Minutes a channel must stay quiet before its new messages are extracted into the graph (GRAPH_CHANNEL_QUIET_MINUTES, default 30). */
  graphChannelQuietMinutes: number;
  /** Minutes a thread must stay quiet before its graph re-extracts (GRAPH_THREAD_QUIET_MINUTES); 0 = only on done/reopen. */
  graphThreadQuietMinutes: number;
  /** Free's monthly credits, in USD at 1 credit = 1¢ (LLM_MONTHLY_ALLOWANCE_USD; 3 = 300 credits). */
  llmMonthlyAllowanceUsd: number;
  /**
   * What one cloud-agent turn (one message answered, auto-continues included) may spend on model calls, in
   * credits, so a loop or a bug stops there (AGENT_TURN_CREDIT_CAP, default 500 = $5; 0 = no per-turn cap).
   */
  agentTurnCreditCap?: number;
  /** Max cloud-agent turns per visitor per hour in public showcase channels (PUBLIC_TURN_LIMIT_PER_HOUR, default 20). */
  publicTurnLimitPerHour: number;
  /** Global daily spend ceiling (USD) across all public showcase cloud-agent turns (PUBLIC_DAILY_SPEND_CEILING_USD, default 25). */
  publicDailySpendCeilingUsd: number;
  /** Agent ids allowed to award showcase prize credits (SHOWCASE_JUDGE_AGENT_IDS, comma-separated). Empty = feature off. */
  showcaseJudgeAgentIds: string[];
  /** The shared showcase prize pool's id (SHOWCASE_POOL_ID, default "default"). */
  showcasePoolId: string;
  /** Total credits in the shared showcase pool, self-seeded on first award (SHOWCASE_POOL_CREDITS, default 0 = awards off). */
  showcasePoolCredits: number;
  /** Per-person lifetime showcase credit ceiling (SHOWCASE_USER_CEILING, default 0 = awards off). */
  showcaseUserCeiling: number;
  /**
   * Paddle (billing/billing.ts): PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_CLIENT_TOKEN (public, for checkout),
   * PADDLE_ENV (sandbox or production), PADDLE_PRICES (JSON: {pro, proYearly?, team?, topups: {"10": priceId, ...}}; team is the per-seat Team price).
   */
  paddle?: import('./billing/billing.js').PaddleOptions;
  /** Composio's API key (COMPOSIO_API_KEY): cloud agents get tools from their owners' connected accounts. */
  composioApiKey?: string;
  /** The secret of Composio's webhook subscription (COMPOSIO_WEBHOOK_SECRET): its trigger events are signed with it. */
  composioWebhookSecret?: string;
  /** The secret of Parly's GitHub App webhook (GITHUB_WEBHOOK_SECRET): its trigger events are signed with it (X-Hub-Signature-256). */
  githubWebhookSecret?: string;
  /** Parly's GitHub App slug (GITHUB_APP_SLUG, default "parly-dev"), used for the install URL (https://github.com/apps/<slug>/installations/new). */
  githubAppSlug: string;
  /** Parly's GitHub App ID (GITHUB_APP_ID) and PEM private key (GITHUB_APP_PRIVATE_KEY) for minting outbound installation tokens. */
  githubAppId?: string;
  githubAppPrivateKey?: string;
  /**
   * GitHub App user-to-server OAuth (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET): used by GET /github/install +
   * /github/callback to bind an installation to the Parly owner who clicked Connect. Unset: Connect is unavailable.
   */
  githubClientId?: string;
  githubClientSecret?: string;
  /** Optional zero-scope public-read PAT (GITHUB_PUBLIC_READ_TOKEN): raises the read-tool fallback limit for repos the App isn't installed on. */
  githubPublicReadToken?: string;
  /**
   * Cloud agents (agents with no computer; hub/cloudAgent.ts): the Gemini model they run on (CLOUD_AGENT_MODEL, by
   * default gemini-4-argon on a deployed hub; off locally unless set), in Vertex's project and location as above.
   * How hard they think each step (CLOUD_AGENT_THINKING: low, medium or high, default low; "default" sends none and
   * leaves it to the model) and the most a step may write, thoughts included (CLOUD_AGENT_MAX_OUTPUT_TOKENS, default 16384).
   */
  cloudAgents?: { model: string; project?: string; location: string; prices: { input: number; output: number }; thinkingLevel?: 'low' | 'medium' | 'high'; maxOutputTokens?: number };
  /**
   * GKE Agent Sandbox for hosted agents (GKE_ENDPOINT: the cluster's DNS endpoint, GKE_AGENT_IMAGE, GKE_HOMES_BUCKET,
   * GKE_IDENTITY_POOL: projects/<number>/locations/global/workloadIdentityPools/<project>.svc.id.goog): unset, hosted agents' mail waits.
   */
  gke?: { endpoint: string; namespace: string; image: string; homesBucket: string; identityPool: string };
  /**
   * The Slack bridge (PLAN-SLACK.md): the Parly Slack app's SLACK_SIGNING_SECRET (it signs every event), and
   * SLACK_CLIENT_ID / SLACK_CLIENT_SECRET for installing it. Unset: no Slack bridge.
   */
  slack?: { signingSecret: string; clientId?: string; clientSecret?: string };
  /**
   * The Telegram bridge: TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (`X-Telegram-Bot-Api-Secret-Token`).
   * Unset: no Telegram bridge.
   */
  telegram?: { botToken: string; webhookSecret: string };
  /** A Parly computer with no work for this long is stopped (COMPUTER_IDLE_MINUTES). */
  computerIdleMs: number;
  /** Shared with the scheduler job that calls POST /tick every minute; unset: no /tick. */
  tickSecret?: string;
  /** OAuth Web client ID; Google sign-in credentials must be issued for it. Unset disables Google sign-in. */
  googleClientId?: string;
  /** Accept idToken "dev:<email>" without Google. Localhost MONGODB_URI only; refused on Cloud Run. */
  googleAuthDev: boolean;
  /** Google sign-in attempts per client IP per hour. */
  googleAuthLimitPerHour: number;
  /** Self-hosted email + password sign-in (PASSWORD_LOGIN=1), with the installer's SETUP_SECRET for the first owner. */
  passwordLogin?: { setupSecret: string };
  /** Email invites per agent per hour. */
  inviteLimitPerHour: number;
  /** Gmail account + app password that send invite emails. Unset disables them. */
  gmailUser?: string;
  gmailAppPassword?: string;
  /** Public URL of the web app, linked from invite emails. OAuth sign-in needs it too (consent happens there). */
  webUrl?: string;
  /** GCS bucket for uploaded files. Unset disables file uploads. */
  filesBucket?: string;
  /** Largest file accepted, in bytes. */
  maxFileBytes: number;
  /** How long uploaded files are kept. */
  fileTtlMs: number;
  /** OAuth access tokens live this long; clients refresh them silently. */
  oauthAccessTtlMs: number;
  /** OAuth refresh tokens live this long unused (each refresh starts a new one). */
  oauthRefreshTtlMs: number;
  /** OAuth device-code requests and typed-code lookups allowed per client IP per hour. */
  deviceLimitPerHour: number;
  /** A Routine woken for messages that are still unclaimed after this long didn't start: it is woken again. */
  wakeStaleMs: number;
  /** After Claude refused to fire a Routine, wait this long before the next try. */
  wakeRetryMs: number;
  /** Timeout for one fire of a Routine. */
  wakeTimeoutMs: number;
  /** How often the hub looks for agents to wake that a send didn't (failed fires, sessions that never came). */
  wakeSweepMs: number;
}

/** CLOUD_AGENT_THINKING: low (default), medium or high; "default" leaves the model's own default. */
function thinkingOf(raw: string | undefined): { thinkingLevel?: 'low' | 'medium' | 'high' } {
  const v = (raw ?? '').trim().toLowerCase() || 'low';
  if (v === 'default') return {};
  if (v === 'low' || v === 'medium' || v === 'high') return { thinkingLevel: v };
  throw new Error(`CLOUD_AGENT_THINKING must be low, medium, high or default, got ${JSON.stringify(raw)}`);
}

function num(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number, got "${raw}"`);
  return n;
}

function paddlePrices(): import('./billing/billing.js').PaddleOptions['prices'] {
  const raw = process.env.PADDLE_PRICES || '{}';
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`PADDLE_PRICES must be valid JSON, got ${JSON.stringify(raw)}: ${(err as Error).message}`);
  }
}

export function loadConfig(): HubConfig {
  const port = num('PORT', 8080);
  const llmPrices = { input: num('LLM_PRICE_INPUT_PER_MTOK', 2), output: num('LLM_PRICE_OUTPUT_PER_MTOK', 12) };
  const vertexProject = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const vertexLocation = process.env.VERTEX_LOCATION || 'global';
  const geminiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GEMINI_FALLBACK_API_KEY?.trim();
  return {
    port,
    publicUrl: (process.env.HUB_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    ...(process.env.CLOUD_TASKS_QUEUE && process.env.CLOUD_TASKS_SERVICE_ACCOUNT
      ? { cloudTasks: { queue: process.env.CLOUD_TASKS_QUEUE, serviceAccount: process.env.CLOUD_TASKS_SERVICE_ACCOUNT } }
      : {}),
    maxWaitMs: num('MAX_WAIT_MS', 25_000),
    forwardTimeoutMs: num('FORWARD_TIMEOUT_MS', 60_000),
    turnDeadlineMs: num('TURN_DEADLINE_MS', 270_000),
    // K_SERVICE is set by Cloud Run.
    allowPrivateAgentUrls: process.env.ALLOW_PRIVATE_AGENT_URLS
      ? process.env.ALLOW_PRIVATE_AGENT_URLS === 'true'
      : !process.env.K_SERVICE,
    credentialsKey: parseSealingKey(process.env.CREDENTIALS_KEY),
    requireCredentialsKey: process.env.REQUIRE_CREDENTIALS_KEY ? process.env.REQUIRE_CREDENTIALS_KEY === 'true' : !!process.env.K_SERVICE,
    registerLimitPerHour: num('REGISTER_LIMIT_PER_HOUR', 20),
    sendLimitPerMinute: num('SEND_LIMIT_PER_MINUTE', 60),
    proxySecret: process.env.HUB_PROXY_SECRET || undefined,
    tickSecret: process.env.TICK_SECRET || undefined,
    vertex: process.env.VERTEX_MODEL
      ? {
          model: process.env.VERTEX_MODEL,
          project: vertexProject || '',
          location: vertexLocation,
          prices: llmPrices,
          timeoutMs: num('VERTEX_TIMEOUT_MS', 25_000),
          turnBudgetMicros: Math.round(num('COMPUTER_TURN_BUDGET_USD', 45, true) * 1_000_000),
          ...(process.env.GEMINI_FALLBACK_API_KEY?.trim() ? { fallbackApiKey: process.env.GEMINI_FALLBACK_API_KEY.trim() } : {}),
          ...(process.env.GEMINI_FALLBACK_MODEL?.trim() ? { fallbackModel: process.env.GEMINI_FALLBACK_MODEL.trim() } : {}),
        }
      : undefined,
    channelRouter: process.env.CHANNEL_ROUTER !== 'off',
    channelRouterModel: process.env.CHANNEL_ROUTER_MODEL || (geminiKey ? 'gemini-decision-1' : 'gemini-3.5-flash-lite'),
    ...(geminiKey ? { geminiApiKey: geminiKey } : {}),
    searchModel: process.env.SEARCH_MODEL || 'gemini-3.5-flash-lite',
    threadDeltaRule: process.env.THREAD_DELTA_RULE === 'on',
    threadDigest: process.env.THREAD_DIGEST !== 'off',
    contextGraphEnabled: !['off', 'false', '0', 'no'].includes((process.env.CONTEXT_GRAPH_ENABLED ?? '').trim().toLowerCase()),
    contextGraphDailyCapUsd: num('CONTEXT_GRAPH_DAILY_CAP_USD', 0.25, true),
    contextGraphEmbedding: {
      model: process.env.CONTEXT_GRAPH_EMBEDDING_MODEL || 'gemini-embedding-001',
      location: process.env.CONTEXT_GRAPH_EMBEDDING_LOCATION || 'us-central1',
      dimensions: Math.round(num('CONTEXT_GRAPH_EMBEDDING_DIMENSIONS', 768)),
      pricePerMTok: num('CONTEXT_GRAPH_EMBEDDING_PRICE_PER_MTOK', 0.15, true),
    },
    graphChannelQuietMinutes: num('GRAPH_CHANNEL_QUIET_MINUTES', 30),
    graphThreadQuietMinutes: num('GRAPH_THREAD_QUIET_MINUTES', 5),
    llmMonthlyAllowanceUsd: num('LLM_MONTHLY_ALLOWANCE_USD', 3),
    agentTurnCreditCap: num('AGENT_TURN_CREDIT_CAP', 500, true),
    publicTurnLimitPerHour: num('PUBLIC_TURN_LIMIT_PER_HOUR', 20),
    publicDailySpendCeilingUsd: num('PUBLIC_DAILY_SPEND_CEILING_USD', 25),
    showcaseJudgeAgentIds: (process.env.SHOWCASE_JUDGE_AGENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    showcasePoolId: process.env.SHOWCASE_POOL_ID?.trim() || 'default',
    showcasePoolCredits: num('SHOWCASE_POOL_CREDITS', 0, true),
    showcaseUserCeiling: num('SHOWCASE_USER_CEILING', 0, true),
    composioApiKey: process.env.COMPOSIO_API_KEY || undefined,
    composioWebhookSecret: process.env.COMPOSIO_WEBHOOK_SECRET || undefined,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || undefined,
    githubAppSlug: process.env.GITHUB_APP_SLUG || 'parly-dev',
    githubAppId: process.env.GITHUB_APP_ID?.trim() || undefined,
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim() || undefined,
    githubClientId: process.env.GITHUB_CLIENT_ID?.trim() || undefined,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() || undefined,
    githubPublicReadToken: process.env.GITHUB_PUBLIC_READ_TOKEN?.trim() || undefined,
    paddle:
      process.env.PADDLE_API_KEY && process.env.PADDLE_WEBHOOK_SECRET
        ? {
            apiKey: process.env.PADDLE_API_KEY,
            webhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
            clientToken: process.env.PADDLE_CLIENT_TOKEN || undefined,
            environment: process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox',
            prices: paddlePrices(),
          }
        : undefined,
    cloudAgents:
      process.env.CLOUD_AGENT_MODEL || process.env.K_SERVICE
        ? {
            model: process.env.CLOUD_AGENT_MODEL || 'gemini-4-argon',
            project: vertexProject || undefined,
            location: vertexLocation,
            prices: llmPrices,
            ...thinkingOf(process.env.CLOUD_AGENT_THINKING),
            maxOutputTokens: num('CLOUD_AGENT_MAX_OUTPUT_TOKENS', 16_384),
          }
        : undefined,
    slack: process.env.SLACK_SIGNING_SECRET
      ? { signingSecret: process.env.SLACK_SIGNING_SECRET, clientId: process.env.SLACK_CLIENT_ID || undefined, clientSecret: process.env.SLACK_CLIENT_SECRET || undefined }
      : undefined,
    telegram:
      process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
        ? { botToken: process.env.TELEGRAM_BOT_TOKEN.trim(), webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET.trim() }
        : undefined,
    gke: process.env.GKE_ENDPOINT
      ? {
          endpoint: process.env.GKE_ENDPOINT,
          namespace: process.env.GKE_NAMESPACE || 'parly',
          image: process.env.GKE_AGENT_IMAGE || '',
          homesBucket: process.env.GKE_HOMES_BUCKET || '',
          identityPool: process.env.GKE_IDENTITY_POOL || '',
        }
      : undefined,
    computerIdleMs: num('COMPUTER_IDLE_MINUTES', 30) * 60_000,
    googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
    googleAuthDev: devAuth(),
    googleAuthLimitPerHour: num('GOOGLE_AUTH_LIMIT_PER_HOUR', 60),
    passwordLogin: passwordLogin(),
            inviteLimitPerHour: num('INVITE_LIMIT_PER_HOUR', 50),
    gmailUser: process.env.GMAIL_USER || undefined,
    // Google shows app passwords in groups of four; strip the spaces.
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '') || undefined,
    webUrl: process.env.WEB_URL?.replace(/\/+$/, '') || undefined,
    filesBucket: process.env.FILES_BUCKET || undefined,
    maxFileBytes: num('MAX_FILE_MB', 25) * 1024 * 1024,
    fileTtlMs: num('FILE_TTL_DAYS', 90) * 24 * 60 * 60 * 1000,
    oauthAccessTtlMs: num('OAUTH_ACCESS_TTL_S', 60 * 60) * 1000,
    oauthRefreshTtlMs: num('OAUTH_REFRESH_TTL_DAYS', 90) * 24 * 60 * 60 * 1000,
    deviceLimitPerHour: num('DEVICE_LIMIT_PER_HOUR', 60),
    wakeStaleMs: num('WAKE_STALE_MS', 5 * 60_000),
    wakeRetryMs: num('WAKE_RETRY_MS', 10 * 60_000),
    wakeTimeoutMs: num('WAKE_TIMEOUT_MS', 10_000),
    wakeSweepMs: num('WAKE_SWEEP_MS', 60_000),
  };
}

function passwordLogin(): { setupSecret: string } | undefined {
  if (process.env.PASSWORD_LOGIN !== '1') return undefined;
  const setupSecret = process.env.SETUP_SECRET?.trim() ?? '';
  if (setupSecret.length < 24) throw new Error('PASSWORD_LOGIN=1 needs SETUP_SECRET (24+ characters; the installer generates one)');
  return { setupSecret };
}

/** The Google dev bypass only ever runs against a localhost Mongo, never on Cloud Run. */
function devAuth(): boolean {
  if (process.env.GOOGLE_AUTH_DEV !== '1') return false;
  if (process.env.K_SERVICE || !localMongo(process.env.MONGODB_URI)) {
    throw new Error('GOOGLE_AUTH_DEV=1 is only allowed locally with MONGODB_URI on localhost, never on Cloud Run');
  }
  return true;
}

/** True only for a plain mongodb:// URI whose host is this machine (the same hosts mongo.ts lets skip TLS). */
function localMongo(uri: string | undefined): boolean {
  try {
    const url = new URL(uri ?? '');
    return url.protocol === 'mongodb:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
