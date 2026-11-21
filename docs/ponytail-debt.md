# Ponytail debt ledger

Deliberate shortcuts marked with a `ponytail:` comment. Each entry is one marker —
what was simplified, its ceiling, and when to revisit. Entries tagged `no-trigger`
name no upgrade path; those are the ones that silently rot.

When you add or change a `ponytail:` comment, update this file. `test/ponytailDebt.test.ts`
checks that every marker in the tree appears here (and nothing stale remains).

## `cloudbuild/mirror-connector.yaml`

- stateful copy, no subtree split (trigger checkouts can be shallow). Two near-simultaneous syncs can land out of order; add the newest-build check from deploy-hub.yaml if that ever bites.

## `containers/parly-agent/entrypoint.sh`

- one writer on a timer, so a save can't overlap another; up to PARLY_SAVE_SECONDS of work is lost if a pod dies without a TERM.

## `containers/parly-agent/parly-agent-runner.mjs`

- `no-trigger` the trace has no call id, so calls are paired in order; replies running in parallel in one step could swap.

## `plugins/parly/bin/hub-events.mjs`

- `no-trigger` no conversation seen yet means nowhere to wake; the news shows at the next SessionStart instead
- `no-trigger` one extra turn per stop, never a chain of them (each costs the person AI credits); what arrives meanwhile waits for the next stop.
- "open" means the owner's pid is alive; add an idle timeout if a forgotten open session should hand over.
- a router (workers) holds its sessions and their queue in memory, so a turn's new listener leaves a live one be
- a router that dies replays all it hadn't finished, and `shown` (the last 200) skips what it had; a router never idle replays more, so keep done ids per conversation if that ever outgrows 200

## `plugins/parly/bin/workers.mjs`

- about 80k tokens; Claude Code fires 33k under this window (its 20k output and 13k summary reserves), so recheck if those move
- busy (an older Codex run still holds the thread) retries every retryWaitMs with no ceiling; back off if that ever spins

## `plugins/parly/cline-plugin/shell.js`

- `no-trigger` POSIX shells only; Windows runs commands in PowerShell or cmd, where `export` means nothing.

## `plugins/parly/cline/install.sh`

- no Windows (Cline wants .ps1 hooks there); add one when someone asks.
- `no-trigger` VS Code's `code` command only; Cursor and others install parly.vsix by hand.

## `plugins/parly/opencode/parly.js`

- OpenCode 2.x plugin format only (export default { id, setup }); 1.x loaded named function exports.
- news is appended to the prompt text, so it stays in the saved history; move it to the "context" hook if that gets noisy

## `plugins/vscode-extension/extension.js`

- submitted even if the chat is mid-turn (VS Code queues it); blockOnResponse waits for the answer, so a burst of mail is one prompt, not one per message.
- a task Cline drops without its TaskComplete/TaskCancel hook (a crash) stays busy until this window's next start; add a timeout if that bites.

## `src/admin/admin.ts`

- reads raw docs and counts in memory; switch to count() aggregations or a rollup doc if a day holds more than this
- loads every agent like Registry.search; page the query once there are tens of thousands
- no rate limit beyond sign-in; one per person per minute if it gets spammed.

## `src/apps/appAgents.ts`

- newest SEARCH_POOL ranked by the model; embeddings + a vector index once an app has thousands.

## `src/billing/billing.ts`

- `no-trigger` derive refund cents from Paddle's adjustment totals.subtotal or items[].amount (before tax)

## `src/billing/store.ts`

- first Team subscription wins a pool; another one (e.g. a $75 checkout by someone who knows the owner's id) is ignored until the first ends or lapses. A legit replacement needs the first cancelled.
- a Team pool keeps the buyer's paddleCustomerId (its portal needs it), so ownerOfCustomer's limit(1) may pick the pool or the buyer's own doc for a customer-only event; only adjustments without custom_data hit that fallback.
- one doc per workspace per day that never expires; add a TTL index or a cleanup sweep if they pile up.

## `src/chat/activity.ts`

- reads up to 500 activity changes since the cursor (oldest first, so the cursor resumes past them) and filters in memory; an index on (channelId, atMs) when it's busy

## `src/chat/chatService.ts`

- an agent's thread reply the router can't place wakes the thread's agents only while fewer than this many agents' messages in a row precede it, so a router outage can't bounce two agents off each other; tune if real threads need longer guessed chains.
- the newest 50 mentions, and 50 messages after each; a per-person "waiting" doc if that falls short.
- `no-trigger` take() must not drain a thread/DM the agent never joined — channel membership (canRead) isn't enough; missing participants fails closed.
- `no-trigger` the newest 50 channel messages after it; a reply buried under more than that is missed
- scans the latest messages of the 30 most recent conversations; a search index if people need more

## `src/chat/push.ts`

- `no-trigger` up to 3 answers in a row per job; anything still waiting goes with the next message's job
- a send that never reached the agent, then an unrelated post from it, counts as answered; the channel check has the same ceiling
- if the post lands but the see() below throws, the retry re-asks and the agent mints a fresh messageId, so the a2a_<messageId> dedupe misses and the asker gets the answer twice. A duplicate reply beats a dropped one; gate the re-ask on a since()-answered-already check (as the forwarder.send catch above does) if dupes ever bite.

## `src/chat/router.ts`

- Flash until Jev (TypeSafe's decision model) has access; same `Route`, swap the call.
- a flat threshold; tune it (or wake everyone when every answer is near 0.5) once prod logs show the spread.
- `no-trigger` the last few messages, each cut short; enough to see who asked what was answered.
- one log line per pick, to read the real latency and choices in prod; drop once it's settled.

## `src/chat/store.ts`

- `no-trigger` the list lives in one doc, kept small by expiry; thousands of distinct loads in 30 minutes would hit the 1 MB limit.
- read outside the transaction (a query in it would lock a busy channel); a message landing in between is missed, as before
- still runs synchronously in the viewer's first page request, so a legacy channel costs N/400 round trips spread across that viewer's retries; move to a one-shot migration or a per-request page budget once a channel is big enough to feel it.
- `no-trigger` the file's first 500 messages (usually one), conversation ids only; a file re-sent more than that may hide a reader

## `src/computers/computers.ts`

- reads every running computer each minute; a query on (state, lastActivityAt) when there are many

## `src/db/mongo.ts`

- telegram_events sets expiresAt too but is left off deliberately to keep its history; add it here when that cleanup is worth more than the audit trail
- non-unique sign-in lookups; a unique index on email/googleSub wants a dedup + backfill first (see docs/ponytail-debt.md)

## `src/graph/search.ts`

- channel scope over-fetches 5x workspace-wide then filters, so a busy workspace can starve a quiet channel; store channelId on embeddings and pre-filter it when that bites.
- scans the 500 most recent substring candidates in the workspace; add a text index when graphs outgrow that.

## `src/graph/sources.ts`

- unscoped and agent-scoped skills have no workspace to live in, so they get no node; add one when the graph reads skills across workspaces.

## `src/graph/extract.ts`

- a burst over the cap keeps only its newest MAX_CATCHUP_MESSAGES; page from the watermark if big bursts lose facts.

## `src/graph/store.ts`

- soft cap (check, then record after the call), so concurrent extractions can overshoot by one call each; reserve-then-settle if that matters.
- lexical only; compare entity embeddings with a cosine threshold once entity nodes are embedded.
- matches against the 500 most recently updated entries of the kind, read then written, so two concurrent extractions can split one entity into two groups; a unique index on (workspaceId, kind, key) groups if that bites.

## `src/hub/canvasService.ts`

- reads at most 300 lines per page; if all 300 are about conversations the viewer can't read, the page comes back empty

## `src/hub/cloudAgent.ts`

- `no-trigger` in memory, per instance; a repeat after a restart is fine
- `no-trigger` in memory, per instance; after a restart the notice may come once more (errs toward telling, never toward charging unannounced)
- in-memory flag — a dropped request (SIGKILL/crash) after a write but before any post still replays.
- chars/4 estimate, no countTokens calls; switch to countTokens per section if the estimate misleads
- mirrors mcp/server.ts READ_ONLY (intersected with the cloud toolset) + useTool's idempotent tools; unknown tools stay mutating. Keep in sync if either list grows — a stale entry only costs a lost transparent retry, never a double-write.
- word match over a dozen tools, no ranking; rank (or embed) if the on-demand list grows past a few dozen.
- plain truncation, no summary call; summarize older messages if answers lose track of a long thread's start

## `src/hub/composio.ts`

- a slug search capped at 20; an app outranked by 20 others that mention its slug reads as unknown. Use GET /toolkits/{slug} if that shows up.

## `src/hub/githubInstalls.ts`

- newest install wins (sorted in memory, no index); pick by account when one owner needs several at once.

## `src/hub/hubService.ts`

- refused while its maker is out of the channel (rejoining turns it back on); delete it on leave if that surprises people.
- one settings read per call (each /me); cache it if /me gets hot

## `src/hub/schedules.ts`

- `no-trigger` three failures in a row pause it; the owner sees why in the channel panel

## `src/hub/triggers.ts`

- `no-trigger` depth 3, 25 lines, 300 characters a value; enough to know what happened, the agent can look up the rest.

## `src/hub/triggerService.ts`

- `no-trigger` a quiet cap of 100 listeners against scripts or a runaway agent
- a retried event counts twice here (the message itself is stored once).

## `src/hub/wake.ts`

- one model for every Grok agent; per-agent choice when someone asks for it

## `src/hub/wakeService.ts`

- `no-trigger` header injection is stopped by fetch itself (it rejects CR/LF in header values).

## `src/index.ts`

- runs only while an instance has CPU (Cloud Run throttles idle ones); a scheduler job if that ever bites

## `src/lib/bridge.ts`

- exponential backoff from 30s, at most an hour between tries

## `src/lib/rateLimit.ts`

- `no-trigger` in-memory per instance for per-agent/session limits; sign-in, registration and pairing redeem use SharedRateLimiter

## `src/llm/llm.ts`

- the 200 costliest agents of the month (index period, micros desc); page it if the admin needs the long tail

## `src/llm/router.ts`

- `no-trigger` one hedge; a cancelled call may still be billed for its input, which the meter doesn't count.
- calls already under way can overshoot the allowance by their own cost; a reservation per call if that matters
- checked before each call, so a turn overshoots by its last call; a runner that changes its turn id isn't stopped.
- only error.message, the rest of a 400 can echo the prompt; delete once the signature resend is proven live.

## `src/mcp/modern.ts`

- dual-era by hand until the SDK speaks 2026-07-28.

## `src/mcp/server.ts`

- per-instance cache of the post-tool pending count, dropped when a post here touches the agent; a post on another Cloud Run instance shows up within PENDING_TTL_MS. A shared unread counter if that lag matters.
- `no-trigger` whoami stays read-only though its `routine` code attaches a Routine to the caller: a one-time, owner-checked write, and asking first would stall the woken session.

## `src/mcp/toolsMessaging.ts`

- per-instance memory of which conversations an agent was already shown the channel context, skills and processes in (by check_inbox, wait_for_message or read_thread); another Cloud Run instance, an eviction or SEEN_TTL_MS just sends them again, a skills change alone does not within SEEN_TTL_MS, and any fresh session of the agent (a restarted worker, a memoryless `claude -p` loop) goes up to SEEN_TTL_MS without them. A per-session key if that matters (the MCP transport is stateless, so there is no session id yet).
- the boilerplate counts as shown even if `fields` dropped it; the agent asked for less.

## `src/registry/auth.ts`

- 10k entries, then the oldest goes; a hit still costs 1 doc read (caching the record would make it 0 but serve stale workspaces/channels).
- two first-time sign-ins racing for one email could create two agents; add a unique `emails` doc if that ever matters
- `no-trigger` one owner read per matching workspace; few workspaces share a domain.
- first matching workspace wins when several share the domain; let the person pick if that happens.
- room is read outside the accept, so two concurrent sign-ins could overshoot by one; transact if that matters.

## `src/registry/channels.ts`

- the creator can't leave, so a channel always has an owner; co-owners can. Add transfer/delete when needed

## `src/registry/registry.ts`

- count then create, so two at once can land one over; harmless, the next one is refused.
- `no-trigger` the name hint reads the viewer's whole directory, like search(); only on a miss
- the whole directory reads every public agent plus the viewer's workspaces, channels and owned agents, unpaged; page it when public agents number thousands

## `src/registry/workspaces.ts`

- the newest 100 (Mongo index: room.appId + createdAt); add a cursor when an app needs more.
- the creator can't leave, so a workspace always has an owner; co-owners can. Add transfer/delete when needed

## `src/rest/conversations.ts`

- each stream polls the store like /events does; a pub/sub fan-out when many tabs are open at once

## `src/rest/helpers.ts`

- one member+invite read per workspace; denormalize a seat count if GET /me gets slow.
- raw JSON for services without Slack's shape; add an adapter when one is common enough to want prettier.

## `src/rest/v1Rooms.ts`

- at most 100, newest first; add a cursor when an app needs more.

## `src/rest/workspaces.ts`

- model spend (agentUsage) only, metered tools aren't per agent; agentUsage keeps the latest payer, so someone linked mid-month shows their whole month.

## `src/rooms/rooms.ts`

- one decision at a time, so a later go-prompt isn't in the room's status until it's answered in its corner.
- reads already-reminded ones again on every tick; add a remindAt field if that grows.

## `src/slack/bridge.ts`

- `no-trigger` per instance and in memory; a few repeats across instances or restarts are fine

## `src/slack/store.ts`

- scans the not-done events; an index on (done, at) when there are many
- reads up to 100 due posts a sweep; more often, or a bigger page, if Slack gets busy

## `test/e2e.test.ts`

- `no-trigger` this describe block injects a verifier that splits idToken on '|', so pass email|sub (default dev: token has no '|')
- `no-trigger` the hub reply carries id/seq/conversation too; assert only the example's contract

## `vitest.config.ts`

- modest coverage floors in CI (55/50/40/55); raise as suite coverage grows

## `web/app/(site)/layout.tsx`

- signed-in state is learned client-side (session cookie is httpOnly, no PPR here) so docs/legal stay static.

## `web/app/(site)/p/[id]/page.tsx`

- noindex for every public channel; a per-channel "let search engines index it" switch when someone wants one.

## `web/app/(window)/w/[ws]/apps/[toolkit]/page.tsx`

- matches by name in the page; a hub-side search when people have thousands of agents.
- installUrl only when ACTIVE; bare GitHub URL skips CSRF-bound Connect

## `web/app/(window)/w/[ws]/apps/page.tsx`

- installUrl is only set when ACTIVE (Manage on GitHub); Connect mints OAuth state

## `web/components/ChannelLoader.tsx`

- everyone in the workspace, in one <select>; a search box when workspaces get long

## `web/app/(window)/w/[ws]/connect/page.tsx`

- every client's steps rendered up front (static JSX, no extra hub calls) so tabs switch without a server trip.

## `web/app/(window)/w/[ws]/page.tsx`

- every bot I can see, in one <select>; a search box when the public directory gets long

## `web/app/(window)/w/[ws]/triggers/[id]/page.tsx`

- matches by name in the page; a hub-side search when people have thousands of agents.

## `web/app/(window)/w/[ws]/triggers/new/page.tsx`

- `no-trigger` matches in the page; every connected app's events are already here

## `web/app/api/session/route.ts`

- cookie presence, not a hub-validated session; a stale token shows "Back" until the next page that checks

## `web/components/AccountMenu.tsx`

- `no-trigger` a deleted app's rooms (appId, no app) show nowhere in the menu; they stay reachable by link.

## `web/components/BillingCard.tsx`

- no Team price configured yet; the ask lands in Admin → Leads as an Enterprise lead.

## `web/components/Composer.tsx`

- `no-trigger` prefix-then-substring match over the member list; fine for channels of tens.

## `web/components/InlineMarkdown.tsx`

- `no-trigger` bold, italics, code, strikethrough and links in one line; full markdown lives in the message itself (Thread.tsx)

## `web/components/RoomDocument.tsx`

- `no-trigger` O(n·m) table; a 50k-character document is a few hundred lines, so this is instant

## `web/components/RoomForm.tsx`

- `no-trigger` one agent per side at setup; required radios stop an accidental room with nobody talking, without JS.

## `web/components/ScrollToBottom.tsx`

- 2s of re-placing after open; longer only if slow images still land late

## `web/components/Thread.tsx`

- `no-trigger` letter count, not a bidi algorithm; per-block auto still handles English messages

## `web/components/ToolsSection.tsx`

- /me/tools only sets installUrl when ACTIVE; Connect always mints OAuth state

## `web/components/Tour.tsx`

- three stops for a new user (add, team, ⌘K); apps, workspaces and billing are one menu away, details in /docs.

## `web/lib/clientIp.ts`

- single trusted proxy — take the last X-Forwarded-For entry (the one the proxy appended); earlier entries are client-spoofable.

## `web/lib/hub.ts`

- slow hub calls in the runtime logs; a real trace (OpenTelemetry) if this stops being enough

## `web/lib/live.ts`

- re-merges on every render; fine for a page of messages

## `web/lib/roomStatus.check.ts`

- one runnable check for the readyToApprove gate (seq-1768 bug). Run: node --import tsx lib/roomStatus.check.ts

## `web/proxy.ts`

- short timeout — middleware must not hang the request if the hub is down (#18)

## `web/scripts/build-plugins.mjs`

- local install until the plugin is in Cursor's marketplace (which wants an open-source repo).

---

**134 markers, 33 with no trigger.**
