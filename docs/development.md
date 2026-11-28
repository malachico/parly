# Development

## Testing

```bash
npm run test:pure                               # unit suites that never touch the database
export TEST_MONGODB_URI='mongodb://127.0.0.1:27019/?replicaSet=rs0&directConnection=true'
npm test                                        # pure + Mongo projects (registry, hub, MCP, plugin scripts, e2e)
npm run test:mongo                              # only the Mongo-backed suites
npm run test:coverage                           # same as npm test, with coverage + modest thresholds
npm run lint                                    # biome; warnings fail CI (`--error-on-warnings`)
npm run typecheck
```

Lint: recommended Biome rules that still fire across the tree are deferred to `off` in
`biome.json` (re-enable per rule as debt clears). Coverage floors live in `vitest.config.ts`.

Database suites each use their own Mongo database, so runs don't interfere with each other.
Start the disposable replica set below before running them; without `TEST_MONGODB_URI`,
database suites fail immediately. `npm run test:pure` needs no database.

## Mongo adapter

`MONGODB_URI` is required and selects MongoDB's `parly` database.
The adapter initializes composite/TTL indexes before its first operation and keeps
one connection pool per URI. It never logs the URI or raw driver errors.

Run the same integration suite against a throwaway Mongo replica set (standalone
Mongo does not support transactions):

```bash
docker run -d --name parly-test-mongo --ulimit nofile=65536:65536 -p 127.0.0.1:27019:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec parly-test-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
# Wait for db.hello().isWritablePrimary in mongosh, then:
TEST_MONGODB_URI='mongodb://127.0.0.1:27019/?replicaSet=rs0&directConnection=true' npm run test:mongo
```

Tests create and remove unique `test_*` databases; use a disposable local server.
CI runs the hub suite with coverage on Mongo; its disposable Mongo data files use
memory-backed storage to avoid build-disk fsync contention. `test/dbConformance.test.ts` checks
transaction guards (including missing docs and empty queries), injection, error
codes, timestamps, transforms and projections. Map keys containing dots or starting
with `$` are rejected by Mongo writes; dotted update paths remain supported.
Collection-level lock markers preserve transactional read guards and query phantoms;
they serialize writes within each collection path. Revisit this if staging shows
material contention. Lock markers expire after one day. Existing documents also receive an internal
read token so native writes and TTL deletion conflict; snapshots hide that token. BSON dates retain millisecond precision.

## Live refresh and Vertex credentials

Live events (messages, agent activity, reads) never re-render the server page: timelines are
updated on the client from the event, and on a message or read the canvas re-reads its unread
counts from the hub's conversation list (`GET /api/conversations`), once per burst of events. The page re-renders after
a server action revalidates it and once when a hidden tab is shown again, which is what picks up
changes the stream doesn't carry (new channels, waiting items, who is working).

Vertex calls reuse one GoogleAuth instance, which manages token expiry. Credential-based
project discovery is shared across calls; a failed discovery can retry on the next call.
An explicitly configured project or test token still takes precedence.

## Graph extraction quality

`test/graphQuality.test.ts` scores the decision-extraction prompt against the hand-labelled
cases in `test/fixtures/graph-quality.json`; the fixture's `_doc` says how a case passes. By
default it only checks the fixture and the prompt. To call the model, sign in with
`gcloud auth application-default login` and run
`GRAPH_QUALITY=1 VERTEX_PROJECT=<project> npx vitest run --project pure test/graphQuality.test.ts`
(`GRAPH_MODEL` overrides `gemini-3.5-flash-lite`). It fails below 80%. Run it after changing
the prompt or the model, and add a case for each extraction bug you fix.

## Companies (billing)

Billing is per person: each person has one plan (Free, Pro, or Team when a company pays), and
workspaces and rooms play no part in it. A company is a billing record with `kind: 'company'`,
`name` and `owners` (`src/billing/company.ts`). `POST /companies` makes one with a random id (one
per owner, and not while you belong to an active company); older companies are keyed by a workspace
id, and the hub stamps `kind` on those at startup (`backfillCompanyKind` in `src/db/mongo.ts`). A person (and their agents, including a room agent's opener) bills the
company only when they are linked to it (`billingAccountId`) and its plan is Team;
otherwise they pay personally. An empty or over-budget company pool pauses its members, with no
personal fallback. Signing in by domain auto-joins the workspace but never links billing, and
leaving or editing domains never unlinks it. Budget, portal and Team-webhook rights belong to
`owners`; a legacy record with no owners falls back to the workspace creator. A verified Team buyer
is added to owners, while an unverified top-up never adds one. Per-agent usage rows are keyed by
agent, month and payer, and older rows without a payer still count. Pool webhooks fill name and
owners when missing. Name comes from the workspace name, else its first domain, else its id. For
older pools, run `MONGODB_URI=<uri> npx tsx scripts/backfill-companies.ts` to see what would
change, then add `--apply` to write it. `MONGODB_DB` overrides `parly`. Re-running is safe, since
only missing fields are set.

## Ponytail shortcuts

Deliberate simplifications are marked in code with a `ponytail:` comment that names
the ceiling and when to revisit. The ledger at [ponytail-debt.md](ponytail-debt.md)
tracks every marker so a deferral cannot quietly become permanent. Update it when
you add or change a marker; `test/ponytailDebt.test.ts` fails if the ledger drifts.

## Several agents on one Claude Code

The router (`hub-events.mjs listen` with background sessions on) asks the hub for
`POST /agents/me/sibling-pairings` on start and on each `sibling_pending` event, redeems each
code and saves `<config dir>/agents/<agentId>/claude-code.json` (0600). It then starts one more
`listen` per folder with `A2A_HUB_CONFIG_DIR` set to it, so that agent's lock, cursor, sessions
and MCP cache stay apart; worktrees go under `.parly-worktrees/<agentId>/`. Test:
`test/siblingAgents.test.ts`.

## Layout

```text
src/
  app.ts, index.ts       Express app wiring and entrypoint
  a2a/                  agent card, A2A request handler and JSON-RPC router
  admin/                super-admin dashboard API
  apps/                 app keys, room APIs and app webhooks
  billing/              Paddle billing and credit balances
  chat/                 messages, conversations, cursors, routing and delivery
  cli/                  operational command-line tools
  computers/            hosted agent lifecycle and GKE driver
  db/                   database setup and collection names
  files/                file storage and signed uploads
  hub/                  send/inbox, wake, triggers, schedules and app integrations
  lib/                  shared auth, validation, networking and presentation helpers
  llm/                  LLM proxy and usage metering
  mcp/                  MCP transport, events and tools*.ts tool groups
  oauth/                OAuth clients, consent, tokens and device flow
  registry/             agents, accounts, workspaces, channels and skills
  rest/                 REST routes grouped by resource
  rooms/                shared rooms between organizations
  slack/, telegram/     messaging bridges, OAuth/linking and delivery stores
web/                    Next.js web app, docs and UI checks
examples/               echo (A2A), mailbox (MCP) and client agents
plugins/                Claude Code, Codex, Cursor, VS Code, Cline, OpenCode and Antigravity connectors
containers/             hosted agent image, runner and tools
cloudbuild/             CI, deploy and mirroring pipelines (private repo only)
scripts/                deployment, infrastructure setup and maintenance
docs/                   api, self-host, development, configuration, ponytail-debt
test/                   Vitest suites and Mongo helpers
```

Receipt logic and server-rendered chat checks: `TSX_TSCONFIG_PATH=web/tsconfig.json node --import tsx web/scripts/check-chat.ts`.
