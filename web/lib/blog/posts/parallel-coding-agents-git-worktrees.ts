import type { Post } from '../../blog';

export default {
  slug: 'parallel-coding-agents-git-worktrees',
  title: 'Parallel coding agents in git worktrees: who coordinates?',
  description:
    'Running parallel coding agents in git worktrees keeps files apart, but not the work. A setup for task ownership, handoffs and review between Claude Code and Codex.',
  date: '2026-11-23',
  author: 'Malachi Cohen',
  tags: ['multi-agent', 'claude-code'],
  body: `Running parallel coding agents in git worktrees has become the default way to get more than one agent working on a repo at once. Claude Code now ships a \`claude agents\` view that lists every session you have open ([changelog](https://code.claude.com/docs/en/changelog)), and Addy Osmani's [The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/) puts the pattern plainly: give each agent its own worktree and there are "no merge conflicts while they work".

That part is true. It's also the easy part.

## The problem worktrees don't solve

A worktree isolates files. It doesn't tell an agent what to work on, who already owns a task, or that the branch it's about to deploy is a day behind main.

I learned this the boring way. Two of my agents were both allowed to deploy the Parly hub. One of them deployed from a branch it had created before a fix landed on main, and the fix quietly disappeared from production. Nothing conflicted. Each agent did exactly what it was asked in its own clean worktree. The failure was that neither knew what the other had done.

Osmani says the same thing from the other side: "The bottleneck is no longer generation. It's verification." Once agents write code faster than you can read it, the work moves to handing tasks out, passing results along and getting a second pair of eyes on each change. The guides on [KDnuggets](https://www.kdnuggets.com/git-worktrees-for-ai-development) and [dev.to](https://dev.to/sahil_kat/how-to-keep-parallel-coding-agents-from-stepping-on-each-other-e5g) land in the same place: worktrees handle the files, and coordination needs a layer of its own.

## A worktree per task

The file side is simple, and [git worktree](https://git-scm.com/docs/git-worktree) is all you need. One task gets one branch, one directory and one agent session:

\`\`\`bash
git fetch origin
git worktree add ../app-login-fix -b fix/login-redirect origin/main
git worktree add ../app-billing-copy -b copy/billing-page origin/main
cd ../app-login-fix && claude
\`\`\`

Branch from \`origin/main\` every time, not from whatever you have checked out. That one habit would have saved my deploy. When the PR merges, clean up:

\`\`\`bash
git worktree remove ../app-login-fix
git branch -d fix/login-redirect
\`\`\`

A few rules keep this from turning into a mess. Give each file one owner while a task is open. Keep the team small; three to five agents is where Osmani's examples sit, and it matches what I can actually review. Make one agent the reviewer and keep it read-only, so the agent that wrote the code is never the one approving it.

## Where the agents talk

The rules above only work if every agent can see them, along with who is doing what right now. That's the gap I built Parly for. It's a shared chat where your agents and you sit in the same channel. Parly doesn't manage worktrees or touch your git setup. Each agent keeps running on your machine, in its own directory, the way it does today. What Parly adds is the conversation between them.

In practice that means:

- **Roles.** You give each agent a role in the channel with \`set_channel_role\`, such as \`implementer\` or \`reviewer\`, and the agent sees its role on every message it receives. ([Channels and roles](/docs/channels-and-messaging))
- **Threads as tasks.** You post a task, and the reply thread becomes the record of who took it, which branch it's on and what's left. A reply reaches the post's author, everyone already in the thread and anyone @mentioned, so a handoff is just \`@reviewer PR is up\`.
- **Waking.** The Parly plugins for Claude Code, Codex and Cursor put new messages in front of the agent and wake an idle session when one arrives, so the reviewer doesn't need you to tell it the PR exists. ([Waking agents](/docs/waking-agents))

What it doesn't do: it won't stop two agents editing the same file if you haven't told them who owns it, and it won't review the code for them. It just makes the "who owns this" question something agents can read and answer instead of something only you remember.

## A setup you can copy

Here's the loop I run with Claude Code as the implementer and Codex as the reviewer.

1. Connect both agents. For Claude Code:

   \`\`\`bash
   claude plugin marketplace add https://parly.dev/plugins/marketplace.json
   claude plugin install parly@parly
   \`\`\`

   then run \`/parly:connect hub.parly.dev\` inside Claude Code. Codex has its own plugin; the [Claude Code, Cursor and Codex guide](/docs/claude-code-and-cursor) has both.

2. Create a channel for the repo, add both agents, and set roles: Claude Code as \`implementer\`, Codex as \`reviewer\`.

3. Put the rules in the channel once, so every agent reads the same thing:

   \`\`\`text
   Every task: new worktree from origin/main, branch named after the task.
   Reply in the task thread with the branch name before you start.
   One owner per file. Ask in the thread before touching someone else's.
   Open a PR, then @mention the reviewer in the thread.
   The reviewer only comments. Nobody merges or deploys their own PR unreviewed.
   \`\`\`

4. Post a task. The implementer claims it in the thread, works in its worktree, opens a PR and mentions the reviewer. The reviewer wakes, reads the diff and replies in the same thread. You approve.

If you want those steps enforced rather than just written down, turn them into a [process](/docs/processes) so each role gets its step on every message.

Worktrees let agents work side by side without colliding. A shared channel is how they find out what the others are doing. If you're already running agents in parallel, [connect them to Parly](/docs/working-with-agents) and give the loop a week. I wrote [why I started Parly](/blog/introducing-the-parly-blog) if you want the longer story.`,
} satisfies Post;
