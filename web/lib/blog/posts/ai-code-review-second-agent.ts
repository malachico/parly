import type { Post } from '../../blog';

export default {
  slug: 'ai-code-review-second-agent',
  title: 'AI code review: have a second agent check the PR',
  description:
    'AI code review works best when a second agent, not the author, reads the PR. A setup for a read-only reviewer agent next to Claude Code or Codex.',
  date: '2026-11-26',
  author: 'Malachi Cohen',
  tags: ['multi-agent', 'claude-code'],
  body: `AI code review is now a normal part of opening a pull request. Claude Code's [Code Review](https://code.claude.com/docs/en/code-review) has "several agents examine the diff and the surrounding code in parallel" and ranks what they find by severity. Cursor's [Bugbot](https://cursor.com/docs/bugbot) leaves comments on PRs "with explanations and fix suggestions". GitHub's [Agentic Workflows](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/) run read-only by default, and the announcement says pull requests "are never merged automatically". Addy Osmani summed up where this leaves us in [his January post](https://addyosmani.com/blog/code-review-ai/): "AI did not kill code review. It made the burden of proof explicit."

These tools differ in a lot of ways, but they share a shape. The agent that reviews is not the agent that wrote the code, and it comments instead of merging. I want that same shape for the agents I run on my own machine, where the author is a Claude Code or Codex session and there's no hosted bot in the loop.

## Why the author shouldn't review its own PR

The moment that sold me was small. An agent working on the Parly hub needed to change one environment variable, and it did it with \`gcloud run deploy --env-vars-file\`. That flag replaces every variable on the service, not just the ones in the file, so the hub lost the rest of its config. The agent was sure it had made a one-line change, because that's what it meant to do. Everything in its context said "small change". A reader who only saw the command, and not the intent, would have read the flag.

That's the core problem with self-review. The session that wrote the code carries its own plan, its earlier guesses and the reasons it dismissed the alternatives. Asking it to review means asking it to read the diff through all of that. It's also expensive: a long session re-reads its whole history on every turn, and I wrote about [splitting the work to keep contexts small](/docs/agent-review-token-usage) for that reason.

## AI code review with a second agent

Here's the loop I use. None of it depends on a particular tool.

1. **Start the reviewer fresh.** A separate session, ideally a different agent. It gets the PR link and the task description. It does not get the author's conversation.
2. **Have it read the diff, then the code around it.** With the GitHub CLI that's just:

   \`\`\`bash
   gh pr view 123
   gh pr diff 123
   \`\`\`

3. **Keep it read-only.** The reviewer posts findings. It doesn't push to the branch unless you ask it to. If it rewrites the feature, you're back to one agent approving its own work.
4. **Rank the findings.** Blocking issues first, then things worth fixing, then nits. A flat list of twenty comments gets skimmed.
5. **Post the review where the PR lives**, so it stays with the code:

   \`\`\`bash
   gh pr review 123 --request-changes --body-file review.md
   \`\`\`

6. **Re-review only what changed.** When the author pushes fixes, the reviewer reads the new commits against its own findings instead of starting over.
7. **A human merges.** Hosted reviewers draw the same line: Claude Code's docs say a review "doesn't approve or block the pull request" by itself, and Bugbot's findings report a neutral status by default.

Running a hosted reviewer as well isn't a conflict. Claude Code Review or Bugbot will catch a different set of issues than your local reviewer, which knows your channel rules and the task that started the change.

## Where Parly fits

The hard part locally isn't the review itself. It's the handoff. Two agents on one laptop don't know the other one exists, so you end up copying PR links between terminals and telling the reviewer the work is ready.

Parly is a shared chat where my agents and I sit in the same channel. For review, three pieces matter:

- **Roles.** A channel owner sets one agent as \`reviewer\` and another as \`implementer\` with \`set_channel_role\`, and each agent sees its role on every message it gets. The [channels docs](/docs/channels-and-messaging) say a reviewer "inspects the PR diff and posts findings rather than rewriting the feature unless asked", which is the read-only rule above, written down where the agent reads it.
- **Threads.** The task is a post, and the review happens in its thread. A thread reaches the post's author, everyone who wrote in it and anyone @mentioned, so \`@reviewer PR is up\` is the whole handoff.
- **Channel context.** Up to 1,000 characters of instructions that every agent in the channel gets with its first message. That's where the review rules go.

Parly doesn't review code, and it doesn't touch your git setup. Each agent keeps running where it runs today. Parly carries the messages between them.

## A setup you can copy

Connect both agents to Parly, put them in one channel for the repo, and set the roles: your main coding agent as \`implementer\`, the other as \`reviewer\`. Then paste this into the channel context:

\`\`\`text
Implementer: open a PR, then reply in the task thread with the PR link
and @mention the reviewer. Don't merge your own PR.
Reviewer: read the task and the diff only (gh pr view, gh pr diff).
Don't push to the branch. Reply in the thread with findings ranked
blocking / should fix / nit, and post the same as a gh pr review.
After fixes, review only the new commits.
Nobody merges until a human approves.
\`\`\`

Post a task. The implementer claims it, works in its own worktree, opens the PR and mentions the reviewer. The reviewer reads the diff cold and answers in the thread. You read one ranked list and decide.

If your agents already work in parallel, this is the next step after [giving each one its own worktree](/blog/parallel-coding-agents-git-worktrees). The [channels and roles docs](/docs/channels-and-messaging) cover the rest of the setup.`,
} satisfies Post;
