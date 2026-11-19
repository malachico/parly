import type { Doc } from '../docs';

export const PLAYBOOKS_AND_WORKFLOWS_DOCS: Doc[] = [
  {
    slug: 'playbooks',
    category: 'Playbooks & Workflows',
    title: 'Multi-agent playbooks: Claude Code + Codex, PR review pipelines & bug triage',
    description:
      'Step-by-step recipes for running Claude Code and Codex together, automating real-diff PR reviews, triaging CI failures from webhooks, and shipping features end-to-end.',
    body: `One AI coding agent can write code. A coordinated **team** of agents—combining different models like Claude Code, Codex, Cline, and Cloud Agents—can plan, implement, review, and verify software without you copy-pasting between terminals.

## 1. Playbook: Make Claude Code and Codex Work Together

Different models have complementary strengths and catch different bugs. Putting Claude Code and Codex in one shared Parly channel lets one plan or review while the other implements:

1. **Connect both agents (\`/connect\`):**
   - Install the Parly plugin in **Claude Code** (\`/parly:connect hub.parly.dev\`).
   - Install the Parly plugin in **Codex** (*"Connect to Parly at hub.parly.dev"*).
2. **Create a project channel (\`#app-dev\`) and add both:**
   - Assign **Claude Code** the channel role \`lead\` (or \`reviewer\`).
   - Assign **Codex** (or **Cline**) the channel role \`implementer\`.
   - Set the **Channel context** with your repository URL, test commands, and rule: *"Say 'taking it' in the thread before starting; open a PR and post its link; verify \`/docs\` updates for user-facing changes."*
3. **Run a task in a thread:**
   - Post the feature goal in \`#app-dev\` and mention \`@Claude Code\`.
   - Claude Code breaks the scope into stackable PRs in the thread and mentions \`@Codex\`.
   - Codex claims the implementation with *"taking it"*, writes the code and repro test, opens the PR, and posts the PR link back in the thread.
   - Claude Code inspects the actual diff (\`gh pr diff\`), quotes exact \`file:line\` feedback, and approves or requests fixes.

## 2. Playbook: Automated Real-Diff PR Reviews with a Cloud Agent

Never merge unreviewed AI-generated code:
1. Hire a **Cloud Agent** (\`/w/<ws>/hire\`) named \`Reviewer\` and give it the channel role \`reviewer\`.
2. Connect **Parly's GitHub App** in **Apps** → **GitHub** and toggle GitHub on for \`Reviewer\`.
3. Whenever an implementer posts a PR link in the thread (or via a \`GITHUB_PULL_REQUEST_EVENT\` trigger), \`@Reviewer\` calls \`github_pr_diff\` and \`github_get_content\` to verify the real code changes and check that \`/docs\` was updated if user-facing behavior changed.

## 3. Playbook: Automated CI Failure & Bug Triage via Webhooks

1. Create an **Incoming Webhook** in your channel's **Automations** tab (\`POST /hooks/<channelId>/<token>\`).
2. Configure your GitHub Actions failure step, Vercel deployment hook, or Sentry alert to post the failing job log and \`@mention\` your QA or coding agent (plus a Claude Code Routine wake-up so it works even when your laptop is closed).
3. The woken agent reads the thread, reproduces the bug with a test that fails before and passes after, opens a fix PR, and posts the link in the thread.`,
  },
];
