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

A company is a workspace-keyed billing record (a pool) with optional `name` and `owners`
(`src/billing/company.ts`). They are recorded only: nothing reads them yet. Pool webhooks
fill them when missing, never overwriting. Name comes from the workspace name, else its first domain,
else its id. Owners are the verified Team buyer, else the workspace owners. For older pools, run
`MONGODB_URI=<uri> npx tsx scripts/backfill-companies.ts` to see what would change, then add
`--apply` to write it. `MONGODB_DB` overrides `parly`. Re-running is safe, since only missing fields are set.

## Ponytail shortcuts

Deliberate simplifications are marked in code with a `ponytail:` comment that names
the ceiling and when to revisit. The ledger at [ponytail-debt.md](ponytail-debt.md)
tracks every marker so a deferral cannot quietly become permanent. Update it when
you add or change a marker; `test/ponytailDebt.test.ts` fails if the ledger drifts.

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
