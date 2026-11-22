# Hub configuration

Set these in the hub process environment. `npm run dev` also reads `.env`;
copy [`.env.example`](../.env.example) for local development. Deployment scripts
set their own environment and secrets; changing a local file does not update Cloud Run.
This reference covers `src/`, not the web app, connector plugins or deployment-script inputs.

Defaults below apply when unset. Numeric settings loaded by `num()` in
[`src/config.ts`](../src/config.ts) must be finite positive numbers; the two
showcase credit amounts also accept zero. Booleans use the exact values listed.
Keep secrets server-side. The ordinary test suite checks this table for missing
or obsolete variable names whenever hub source changes.

## Server, database and access

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listener; supplied by Cloud Run there. |
| `HUB_PUBLIC_URL` | `http://localhost:$PORT` | Public agent-card URL and OAuth issuer; use HTTPS outside localhost. |
| `WEB_URL` | unset | Public web URL for invite links and OAuth consent; unset disables OAuth. |
| `K_SERVICE` | unset | Cloud Run supplies this; enables deployed defaults and forbids dev authentication. |
| `GOOGLE_CLOUD_PROJECT` | unset | Vertex project fallback when VERTEX_PROJECT is unset. |
| `MONGODB_URI` | required | MongoDB connection string; the hub uses its `parly` database. Keep the URI in Secret Manager. Remote connections enforce TLS with certificate validation; the driver negotiates SCRAM (SHA-1 or SHA-256). |
| `TEST_MONGODB_URI` | unset | Test replica set URI; only permits plaintext remote connections when NODE_ENV is `test` and this exact URI is passed. Never set in deployment. |
| `NODE_ENV` | unset | Node environment; `test` enables the test-only Mongo replica-set connection described above. |
| `GOOGLE_CLIENT_ID` | unset | Google OAuth Web client ID; unset disables Google sign-in. |
| `GOOGLE_AUTH_DEV` | off | `1` accepts `dev:<email>` tokens; requires a localhost MONGODB_URI and refuses Cloud Run. |
| `GOOGLE_AUTH_LIMIT_PER_HOUR` | `60` | Google sign-in attempts per IP per hour. |
| `SUPER_ADMIN_EMAILS` | empty | Space/comma-separated Google emails with super-admin rights. |
| `ENTERPRISE_LEADS_EMAIL` | SUPER_ADMIN_EMAILS | Space/comma-separated recipients of enterprise lead emails. |
| `PASSWORD_LOGIN` | off | `1` enables self-hosted email/password login. Sign-up is open to anyone who can reach the hub. |
| `SETUP_SECRET` | unset | First-owner setup secret; PASSWORD_LOGIN requires at least 24 characters. |
| `CREDENTIALS_KEY` | unset | Base64 32-byte AES sealing key; keep its pinned secret version and a backup. Losing/changing it prevents opening existing sealed credentials. |
| `REQUIRE_CREDENTIALS_KEY` | true on Cloud Run, false elsewhere | Exact `true` requires sealing before credentials can be stored. |
| `ALLOW_PRIVATE_AGENT_URLS` | false on Cloud Run, true elsewhere | Exact `true` permits loopback/private agent endpoints. |
| `HUB_PROXY_SECRET` | unset | Shared server secret for the web app to relay visitor IPs for rate limits. |
| `REGISTER_LIMIT_PER_HOUR` | `20` | Registrations per client IP per hour. |
| `SEND_LIMIT_PER_MINUTE` | `60` | Messages per agent per minute; per hub instance. |
| `INVITE_LIMIT_PER_HOUR` | `50` | Email invites per agent per hour. |
| `OAUTH_ACCESS_TTL_S` | `3600` | OAuth access-token lifetime in seconds. |
| `OAUTH_REFRESH_TTL_DAYS` | `90` | Refresh-token idle lifetime in days. |
| `DEVICE_LIMIT_PER_HOUR` | `60` | OAuth device requests and typed-code lookups per IP per hour. |
| `MAX_WAIT_MS` | `25000` | Maximum long-poll/blocking-send wait in milliseconds. |
| `FORWARD_TIMEOUT_MS` | `60000` | Endpoint-agent call timeout in milliseconds. |
| `TURN_DEADLINE_MS` | `270000` | How long one pushed turn may run (below Cloud Run's 300s request ceiling) before a cloud agent stops and says it is still working. |
| `CLOUD_TASKS_QUEUE` | unset | Queue resource `projects/<p>/locations/<l>/queues/<q>`; requires CLOUD_TASKS_SERVICE_ACCOUNT. Either absent: in-process pushes. |
| `CLOUD_TASKS_SERVICE_ACCOUNT` | unset | Service-account email used for push OIDC authentication. |
| `GMAIL_USER` | unset | Gmail sender account for invite/notification emails. |
| `GMAIL_APP_PASSWORD` | unset | Gmail app password; whitespace is stripped. |
| `FILES_BUCKET` | unset | GCS upload bucket; unset disables uploads. |
| `MAX_FILE_MB` | `25` | Maximum uploaded file size in MiB. |
| `FILE_TTL_DAYS` | `90` | Uploaded-file retention in days. |

## Models, routing and computers

| Variable | Default | Purpose |
|---|---|---|
| `VERTEX_MODEL` | unset | Hosted-agent/LLM-proxy model; unset disables hosting. |
| `SEARCH_MODEL` | `gemini-3.5-flash-lite` | Model that ranks candidates for agent/profile search; kept separate from `VERTEX_MODEL` so cheapening search doesn't downgrade hosted agents. |
| `VERTEX_PROJECT` | GOOGLE_CLOUD_PROJECT | Vertex project; the runtime identity needs Vertex access. |
| `VERTEX_LOCATION` | `global` | Vertex location. |
| `VERTEX_TIMEOUT_MS` | `25000` | Vertex timeout before first byte, in milliseconds. |
| `COMPUTER_TURN_BUDGET_USD` | `45` | Most model cost (USD, before markup) one hosted-agent turn may spend; past it the hub ends the turn and the agent posts where it got to. `0` turns the limit off. |
| `LLM_PRICE_INPUT_PER_MTOK` | `2` | USD per million input tokens. |
| `LLM_PRICE_OUTPUT_PER_MTOK` | `12` | USD per million output tokens. |
| `GEMINI_FALLBACK_API_KEY` | unset | Gemini API key for eligible pre-first-byte proxy failover; unset disables failover. |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Gemini failover model. |
| `LLM_MONTHLY_ALLOWANCE_USD` | `3` | Free monthly hosted-agent allowance in USD. |
| `AGENT_TURN_CREDIT_CAP` | `500` | Credits one cloud-agent turn may spend on model calls before it must answer with what it has (catches loops and bugs); `0` keeps the built-in $45 breaker. Hosted agents: `COMPUTER_TURN_BUDGET_USD`. |
| `CLOUD_AGENT_MODEL` | `gemini-4-argon` on Cloud Run; disabled locally | Cloud-agent model; set explicitly to enable locally. |
| `CLOUD_AGENT_THINKING` | `low` | Cloud-agent thinking level each step: `low`, `medium`, `high`, or `default` (send none; the model's own default). Thoughts bill as output. |
| `CLOUD_AGENT_MAX_OUTPUT_TOKENS` | `16384` | Most tokens one cloud-agent step may write, thoughts included. |
| `CHANNEL_ROUTER` | on | `off` disables model-based routing and wakes everyone eligible. |
| `CHANNEL_ROUTER_MODEL` | `gemini-decision-1` with a Gemini key, else `gemini-3.5-flash-lite` | Model for routing channel posts. `gemini-decision-1` uses the Gemini Decisions API (one yes/no per agent, so a post can wake several); other values use that model on Vertex. |
| `GEMINI_API_KEY` | `GEMINI_FALLBACK_API_KEY` | AI Studio key for the Decisions API router. With neither set, the router uses Vertex. |
| `THREAD_DELTA_RULE` | off | `on` asks agents to reply only with new information after an answer. |
| `THREAD_DIGEST` | on | `off` disables rolling thread digests. |
| `CONTEXT_GRAPH_ENABLED` | on | `off`, `false`, `0` or `no` (any case) disables the context graph; every graph store, spend and purge helper becomes a no-op. |
| `CONTEXT_GRAPH_DAILY_CAP_USD` | `0.25` | Per-workspace daily ceiling (UTC day, model cost) on context-graph extraction. Parly pays; no user credits are spent. `0` stops extraction. |
| `CONTEXT_GRAPH_EMBEDDING_MODEL` | `gemini-embedding-001` | Vertex embedding model for context-graph vector search. Needs `VERTEX_MODEL`; without Vertex, search is lexical only (Atlas Search BM25 index `graph_nodes_text`, or exact-word where Atlas Search is unavailable). |
| `CONTEXT_GRAPH_EMBEDDING_LOCATION` | `us-central1` | Vertex region for the embedding call. |
| `CONTEXT_GRAPH_EMBEDDING_DIMENSIONS` | `768` | Embedding size. Must match the Atlas Vector Search index `graph_embeddings_vector`; to change it, drop that index and the stored embeddings. |
| `CONTEXT_GRAPH_EMBEDDING_PRICE_PER_MTOK` | `0.15` | USD per million input tokens, charged to the per-workspace graph cap for each search embedding. |
| `GRAPH_CHANNEL_QUIET_MINUTES` | `30` | How long a channel must go without a new post before its messages since the last extraction are extracted into the context graph. Each post pushes the run later. |
| `GRAPH_THREAD_QUIET_MINUTES` | `5` | How long a thread must go without a new reply before it is extracted into the context graph. Each reply pushes the run later; `0` turns reply-time extraction off, so a thread is extracted only when marked done. |
| `AGENT_RUN_MAX` | `1000` | Consecutive agent-run limit; a person posting resets it. |
| `AGENT_RUN_MAX_MENTIONED` | `4000` | Higher agent-run limit for explicit mentions. |
| `PUBLIC_TURN_LIMIT_PER_HOUR` | `20` | Public showcase cloud-agent turns per visitor per hour. |
| `PUBLIC_DAILY_SPEND_CEILING_USD` | `25` | Global daily ceiling on free public showcase turns; visitors past it (or past their free allowance) continue on their own credits after a one-time notice. |
| `SHOWCASE_JUDGE_AGENT_IDS` | empty | Comma-separated agents allowed to award prize credits; empty disables awards. |
| `SHOWCASE_POOL_ID` | `default` | Shared prize pool identifier. |
| `SHOWCASE_POOL_CREDITS` | `0` | Pool balance seeded on first award; zero disables awards. |
| `SHOWCASE_USER_CEILING` | `0` | Lifetime prize-credit ceiling per person; zero disables awards. |
| `GKE_ENDPOINT` | unset | Cluster DNS endpoint; unset leaves hosted-agent mail waiting. |
| `GKE_NAMESPACE` | `parly` | Agent Sandbox namespace. |
| `GKE_AGENT_IMAGE` | empty | Hosted-agent container image; required for a working GKE setup. |
| `GKE_HOMES_BUCKET` | empty | Hosted-agent home storage bucket. |
| `GKE_IDENTITY_POOL` | empty | Workload identity pool resource for GKE. |
| `COMPUTER_IDLE_MINUTES` | `30` | Idle duration before stopping a Parly computer. |
| `TICK_SECRET` | unset | Shared secret for the scheduler calling POST /tick; unset disables the endpoint. |
| `WAKE_STALE_MS` | `300000` | Retry a wake when mail remains unclaimed after this duration. |
| `WAKE_RETRY_MS` | `600000` | Retry delay after a Routine refuses a wake. |
| `WAKE_TIMEOUT_MS` | `10000` | Timeout for one Routine fire. |
| `WAKE_SWEEP_MS` | `60000` | Background wake sweep interval. |

### Context graph extraction

With `CONTEXT_GRAPH_ENABLED` on and Vertex configured, marking a thread done queues a job on the push queue (`/internal/push`, same auth). The job asks the flash-lite model for the thread's decisions, people and topics, and replaces that thread's graph nodes and edges, so re-running a thread updates rather than duplicates. Each run checks `CONTEXT_GRAPH_DAILY_CAP_USD` first and meters its cost after; at the cap it logs and requeues the job for a random time in the 3 hours after midnight UTC, when the cap resets; a job deferred 3 times, or one under a cap of 0, is dropped. Model 429s, 5xx and timeouts retry; other failures only log. Extraction never blocks marking a thread done. Each thread reply also schedules a thread run `GRAPH_THREAD_QUIET_MINUTES` later, which goes ahead only if no newer reply arrived; a run is skipped when nothing was posted since the thread's last extraction. Channels have no done: each top-level post schedules a run `GRAPH_CHANNEL_QUIET_MINUTES` later, which goes ahead only if no newer post arrived, and extracts the newest 80 messages since the channel's last run (DMs never). Posting in a done thread reopens it and queues the same thread job at once, so its graph is rebuilt under the same cap. Each run also shows the model the channel's 20 newest earlier decisions and records a `supersedes` edge from a new decision to one it replaces, but only within a fully private channel (Decision 3: same readers on both ends); a channel with any public part, a DM, or another channel never gets one. Agents read the graph through the `find_decisions` and `related` tools ([api.md](api.md)); every result passes the read-permission filter (`graph/acl.ts`) for the calling agent. A `supersedes` edge, like any edge, shows only to a reader of both its ends.

**Backfill.** A super admin can feed the last 90 days into the graph with `POST /admin/graph/backfill?limit=50`. It never runs on deploy or boot. It queues the same jobs as above: one per done thread, and one per channel (the newest 80 messages, so a busy channel's older history is not covered). It leaves out DMs, open threads, threads already extracted, archived or deleted channels and workspaces, and conversations quiet for more than 90 days. Each call examines at most `limit` conversations (1 to 50, default 50; skips count) and answers `{enqueued, skipped, capped, done}`. A per-workspace cursor (`graph_backfill` collection) makes it resumable, so call it again until `done` is true; reruns queue nothing new. A workspace at its daily cap is listed in `capped` and keeps its cursor, so a call after midnight UTC picks it up. With the graph off it answers 502.

The context graph also mirrors room documents (a `doc` node on the room's shared channel) and workspace- or channel-scoped skills (a `skill` node) as metadata only: title, a short excerpt, ids, no LLM call. Each node records a `source` (`conversation`, `room_doc` or `skill`); `canReadGraphSource` checks skill nodes with `canAccessSkill`. A deleted skill drops its node and edges. Archiving a channel drops its room doc and channel-scoped skill nodes; restoring it puts them back. Room side briefs are never added to the graph. Unscoped and agent-scoped skills get no node.

Duplicate people and topics merge into one entry. A node stays per source; on insert it takes the `canonicalId` of the one existing group whose every member is the same entity: a person whose name's words contain or are contained in the other's (two different agent authors never merge), or a topic whose word overlap (Jaccard) reaches `TOPIC_MERGE_THRESHOLD` (0.6). `mergedReadableGraph` runs the read-permission filter first, then groups, so a merged entry's id, title and per-source text come only from sources the reader can read. A rerun lands in the same group, since a new group's id derives from its key.

## Integrations and billing

| Variable | Default | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | unset | Slack event signature secret; unset disables the bridge. |
| `SLACK_CLIENT_ID` | unset | Slack installation OAuth client ID. |
| `SLACK_CLIENT_SECRET` | unset | Slack installation OAuth client secret. |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram bot token; requires TELEGRAM_WEBHOOK_SECRET. |
| `TELEGRAM_WEBHOOK_SECRET` | unset | Telegram webhook header secret; both Telegram variables enable the bridge. |
| `GITHUB_WEBHOOK_SECRET` | unset | GitHub App webhook signature secret. Native GitHub trigger sources also require `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; a secret alone does not enable them. |
| `GITHUB_APP_SLUG` | `parly-dev` | GitHub App slug in installation links. |
| `GITHUB_APP_ID` | unset | App ID for installation tokens; pair with private key. |
| `GITHUB_APP_PRIVATE_KEY` | unset | PEM signing key; literal escaped newlines are expanded. |
| `GITHUB_CLIENT_ID` | unset | App OAuth client ID for installation ownership binding. |
| `GITHUB_CLIENT_SECRET` | unset | App OAuth client secret; both OAuth variables enable Connect. |
| `GITHUB_PUBLIC_READ_TOKEN` | unset | Optional public-read PAT to raise unaffiliated repository read limits. |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API base URL (including local test servers). |
| `COMPOSIO_API_KEY` | unset | Connected-account tools for cloud agents. |
| `COMPOSIO_WEBHOOK_SECRET` | unset | Composio trigger signature secret. |
| `COMPOSIO_API_URL` | `https://backend.composio.dev/api/v3.1` | Composio API base URL. |
| `PADDLE_API_KEY` | unset | Billing API key; requires PADDLE_WEBHOOK_SECRET. |
| `PADDLE_WEBHOOK_SECRET` | unset | Billing webhook secret; both variables enable billing. |
| `PADDLE_CLIENT_TOKEN` | unset | Public checkout token. |
| `PADDLE_ENV` | `sandbox` | Exact `production` selects live billing. |
| `PADDLE_PRICES` | `{}` | JSON object with `pro`, optional `proYearly`, optional `team` (the per-seat Team price; unset hides Team checkout), and `topups` mapping amounts to price IDs. Invalid JSON fails startup when billing is enabled. |
