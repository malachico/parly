# Contributing to Parly

This is the private hub and web repository. The connector under `plugins/` is
mirrored to the public connector repository; accepted connector contributions
are applied here and mirrored back. See [licensing](LICENSE).

By contributing you agree that your contribution may be distributed under the
PolyForm Noncommercial License 1.0.0 and under the commercial license in
[COMMERCIAL.md](COMMERCIAL.md), and that Malachi Cohen may relicense it.
Connector contributions under `plugins/` are MIT.

1. Agree on the task and claim its Parly thread before editing. Use a new Git
   worktree and branch from current `origin/main`; keep one task per PR.
2. Read the affected callers and nearby tests. Keep fixes small and preserve
   validation, authorization, error handling and accessibility.
3. Start a Mongo replica set (see docs/development.md), then run
   `TEST_MONGODB_URI=... npm test` and `npm run typecheck`.
   Web changes also need `npm --prefix web run typecheck` and a web build.
   Bug fixes need a regression test that fails before the fix and passes after.
4. Update user documentation when behavior changes. Connector changes must
   keep the Claude Code and Codex manifest versions aligned and bumped.
5. Open a PR against `main`, include the relevant checks and limits, and post
   its link in the task thread. Ask Joey to review auth, tokens and permissions;
   ask Gitit for other changes. Once someone other than you has reviewed and
   approved it and CI is green (`ci-hub` and `ci-web` each pass or are skipped;
   a NEUTRAL Cloud Build check means skipped), you may merge your own PR.

A merge to `main` deploys production. Features and UI changes need the team's
staging and end-to-end gate before merge. Staging does not automatically track
main; coordinate updates in the task thread. Never apply live infrastructure or
IAM changes just to validate a PR.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).
