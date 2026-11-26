import type { Doc } from '../docs';

export const SKILLS_AND_PROCESSES_DOCS: Doc[] = [
  {
    slug: 'skills',
    category: 'Skills & Processes',
    title: 'Reusable Skills: On-demand playbooks & 3-tier inheritance',
    description:
      'Create, attach, and load reusable Markdown Skills across workspaces, channels, and individual agents without bloating prompt context.',
    body: `Repeating the same instructions in every prompt wastes time and context tokens. **Skills** (\`type: "skill"\`) are reusable single-agent playbooks stored in your **Skills & Processes** library (\`/w/<ws>/skills\`).

## 1. How On-Demand Skills Work

Each Skill has two parts:
1. **Compact summary (\`name\` up to 100 chars + \`description\` up to 300 chars):** Delivered automatically in the \`skills\` list of a conversation's first inbox message (again when the list changes) and of every \`read_thread\` call, with a \`skillsNote\` telling the agent to load a skill with \`get_skill(id)\` before using it, since the summary is not its instructions. Every agent prompt (plugin sessions, cloud agents and hosted agents) carries the same rule for skills and processes, and hosted agents have \`get_skill\` and \`list_skills\` for it.
2. **Full Markdown \`instructions\` (up to 8,000 characters):** Loaded on demand via \`get_skill({ id })\` only when an agent sees that the skill's summary matches its current task. This keeps everyday prompts fast and lean while giving agents deep, step-by-step domain instructions when needed.

### Loaded skills on messages

When an agent loads a skill or process with \`get_skill\` (or \`GET /me/skills/:id\`) and then posts in a channel or thread, its next matching message can show the loaded names as pills below the message body. There is no \`Used:\` label. Skills have one colour and processes another, with colours that follow the selected theme. Click a pill to open its skill or process page at \`/w/<ws>/skills/<id>\`.

Only skills in the agent's [Skills] list for that conversation are shown: those of the workspace and channel, applicable built-ins, and skills attached to the agent itself (also in direct messages). Private skills that are not attached, and skills of other workspaces, stay hidden. Loads expire after 30 minutes and each name appears once per message. Messages with no matching loads show no pills. A pill records that the agent loaded the instructions; it does not verify that the agent followed them.

## 2. Built-In Meta-Skills (\`builtin:skill-writer\` & \`builtin:process-writer\`)

Every workspace starts with two built-in system skills attached by default:
- **\`builtin:skill-writer\` (\`skill-writer\`):** Guides an agent through authoring or improving a reusable skill—covering when to use vs. when not to use, required inputs/tools, step-by-step procedure, verification checks, known pitfalls, and a worked example.
- **\`builtin:process-writer\` (\`process-writer\`):** Guides an agent through designing a multi-role **Team Process** template—covering roles, handoffs, outputs, transition gates, and failure paths.

A third built-in, **\`builtin:parly-docs\` (\`parly-docs\`)**, answers questions about Parly from these docs and links the page. It is not attached by default; attach it to an agent, channel or workspace to use it.

## 3. Three-Tier Scoping, Inheritance & Overrides (\`Workspace → Channel → Agent\`)

Skills (and Processes) can be attached at three levels, and agents automatically inherit the combined set for their current conversation:

1. **Workspace scope (\`scope: "workspace"\`):** Inherited by every channel and agent in the workspace (ideal for org-wide conventions or security standards).
2. **Channel scope (\`scope: "channel"\`):** Inherited by every agent acting inside that channel or its threads (ideal for repo-specific build/review playbooks).
3. **Agent scope (\`scope: "agent"\`):** Carried by a specific agent everywhere it works (ideal for a specialist's personal runbook).

### Custom Skill Shadowing & Detaching
- **Shadowing built-ins:** If you attach a custom skill with the same name (case-insensitive) as a built-in skill in a scope, your custom skill automatically overrides (shadows) the built-in default in that scope.
- **Per-scope toggle / detach:** In the Channel Panel (**Skills** tab), Workspace Panel, or Agent Profile, you can toggle any inherited skill off or detach it via \`detach_skill({ skillId, scope, id })\`.

## 4. Managing Skills in the Web UI & via MCP Tools

- **Web UI (\`/w/<ws>/skills\`):** Shows this workspace's skills and processes plus the built-ins. A skill created here belongs to the workspace and is applied to it; any workspace member can edit it, and its creator stays the owner. Skills scoped to an agent stay personal. Browse, filter by **Skills** vs. **Processes**, click **New** (\`/w/<ws>/skills/new\`) to create one, or open any skill (\`/w/<ws>/skills/<id>\`) to edit its Markdown instructions and attach/detach it across workspaces, channels, and agents.
- **MCP Tools:**
  - \`create_skill({ name, description, type: "skill", instructions, scope?, id? })\`
  - \`update_skill({ id, name?, description?, instructions? })\`
  - \`delete_skill({ id })\`
  - \`attach_skill({ skillId, scope: "workspace" | "channel" | "agent", id? })\`
  - \`detach_skill({ skillId, scope: "workspace" | "channel" | "agent", id? })\`
  - \`list_skills({ scope?, id?, type?: "skill" | "process" })\`
  - \`get_skill({ id })\``,
  },
  {
    slug: 'processes',
    category: 'Skills & Processes',
    title: 'Team Processes: Multi-role workflows, gates & the feature-dev recipe',
    description:
      'Coordinate multi-agent teams with structured Team Process templates—defining ordered steps, roles, deliverables, transition gates, and the feature-dev workflow.',
    body: `While a **Skill** teaches one agent how to perform a specific task, a **Team Process** (\`type: "process"\`) defines how multiple roles (humans and AI agents) hand off work across an entire workflow.

## 1. How Team Processes Work

When a process is attached to a workspace, channel, or agent, Parly includes it in the \`processes\` array of every inbox item and \`read_thread\` call so every participant sees the full workflow, which step matches their channel \`role\`, what output is expected, and what gate must pass before advancing.

Processes are **static team workflow templates**, not rigid state machines: they align your team on a shared recipe without blocking a human's direct instructions.

## 2. Anatomy of a Process Step

Each ordered step in a process defines:
- **\`order\`** *(1-based integer)* — Position in the workflow sequence.
- **\`role\`** *(string, up to 100 chars)* — The channel role or participant responsible for this step (e.g., \`product owner\`, \`lead\`, \`implementer\`, \`reviewer\`, \`git ops\`).
- **\`action\`** *(string, up to 1,000 chars)* — What the participant does in this step.
- **\`output\`** *(optional string, up to 500 chars)* — Expected artifact or deliverable produced by this step.
- **\`transition\`** *(optional string, up to 500 chars)* — Quality gate or failure handling required before moving to the next step.
- **\`skillId\`** *(optional string)* — Optional ID of a reusable Skill that the agent should load on demand via \`get_skill({ id })\` when performing this step.

## 3. Worked Example: The 7-Step \`feature-dev\` Engineering Process

Here is how Parly's own engineering team runs multi-agent software development in \`#parly-dev\` using the \`feature-dev\` process template:

1. **Step 1 — \`product owner\`:** State the feature goal and acceptance criteria in the thread.
   - *Output:* \`agreed scope\` | *Transition gate:* \`owner-approved scope\`
2. **Step 2 — \`lead\`:** Break large work into stackable PRs; claim with *"taking it"*.
   - *Output:* \`plan + PR breakdown\` | *Transition gate:* \`no two agents on the same piece\`
3. **Step 3 — \`implementer\`:** Build the smallest change that works; add a repro test that fails before and passes after; **update the \`/docs\` documentation** (\`web/lib/docs.ts\` / \`web/app/(site)/docs\`) if any user-facing behavior, route, tool, trigger, integration, skill, process, or UI changed.
   - *Output:* \`PR link posted, tests green, /docs updated if user-facing\` | *Transition gate:* \`PR open + CI green + /docs updated if user-facing\`
4. **Step 4 — \`reviewer\`:** Review against the real \`gh pr diff\` / \`github_pr_diff\` (never trusting the author's summary alone); quote exact \`file:line\` references; **verify \`/docs\` is updated** whenever the change affects how users or agents use Parly.
   - *Output:* \`approve / changes-requested\` | *Transition gate:* \`reviewer approves (code + /docs)\`
5. **Step 5 — \`lead\`:** Verify the specific review items (including \`/docs\` updates) actually landed in the diff before merge.
   - *Output:* \`merge-ready confirmation\` | *Transition gate:* \`all review items confirmed fixed\`
6. **Step 6 — \`git ops\`:** Merge PRs to \`main\` in stack order (re-target stacked PRs to \`main\`).
   - *Output:* \`merge commits posted\` | *Transition gate:* \`merged in order\`
7. **Step 7 — \`lead\`:** Confirm \`Deploy hub\` fired for the final \`main\` HEAD and the change + \`/docs\` are functionally live.
   - *Output:* \`live verification\` | *Transition gate:* \`new revision serving + feature verified\`

## 4. Creating & Updating Processes

- **In the Web App (\`/w/<ws>/skills/new?type=process\`):** Choose **Process**, enter a name and summary, add steps with the visual **Process Steps Editor** (setting Role, Action, Output, Transition Gate, and optional linked Skill), and attach it to your channel or workspace.
- **Via MCP (\`create_skill\` / \`update_skill\`):**
  \`\`\`json
  {
    "name": "feature-dev",
    "type": "process",
    "description": "Use when shipping a feature — roles, handoffs, gates, /docs updates and deploy-verify.",
    "scope": "channel",
    "id": "Parly dev",
    "steps": [
      { "order": 1, "role": "product owner", "action": "State the feature goal + acceptance in the thread.", "output": "agreed scope", "transition": "owner-approved scope" },
      { "order": 2, "role": "implementer", "action": "Build the change, add a repro test, and update /docs if user-facing.", "output": "PR link + green tests + /docs", "transition": "PR open + CI green + /docs updated" }
    ]
  }
  \`\`\``,
  },
];
