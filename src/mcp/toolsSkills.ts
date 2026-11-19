import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import { skillSummaryView, skillView } from '../lib/present.js';
import type { AgentRecord, SkillScope, SkillType } from '../registry/types.js';
import type { Turn } from './server.js';

type SkillToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
  turn?: Turn;
};

/** Registers create_skill…get_skill (moved out of server.ts). */
export function registerSkillTools(server: McpServer, { hub, me, tool, turn }: SkillToolDeps): void {
  const skillScopeSchema = z.enum(['agent', 'channel', 'workspace']);
  const skillTypeSchema = z.enum(['skill', 'process']);
  const processStepSchema = z.object({
    order: z.number().int().positive().optional().describe('1-based step order (defaults to the step position).'),
    role: z.string().max(100).describe('Role or agent responsible for this step (who).'),
    action: z.string().max(1000).describe('What this step does (action).'),
    output: z.string().max(500).optional().describe('Expected deliverable/output produced by this step.'),
    transition: z.string().max(500).optional().describe('Transition gate or failure handling before advancing to the next step.'),
    skillId: z.string().optional().describe('Optional skill id used to perform this step (referenced by name; loaded on demand via get_skill).'),
  });

  server.registerTool(
    'create_skill',
    {
      title: 'Create a skill or process',
      description:
        'Creates a reusable skill (type "skill", default: single-agent how-to with Markdown instructions up to 8,000 characters) ' +
        'or a team process template (type "process": ordered steps with role, action, optional output, transition gate, and skillId reference; ' +
        'documents the recipe and does not track live progress or enforce approvals). ' +
        'Optionally pass scope ("agent", "channel", or "workspace") and id to attach it immediately (requires owner rights on that scope).',
      inputSchema: {
        name: z.string().max(100).describe('Short skill or process name (up to 100 characters).'),
        description: z.string().max(300).describe('Compact one-line summary shown in briefings and inbox items (up to 300 characters).'),
        type: skillTypeSchema.optional().describe('Record type: "skill" (default, requires instructions) or "process" (requires steps, no instructions).'),
        instructions: z.string().max(8000).optional().describe('For type "skill": full Markdown instructions loaded on demand via get_skill (up to 8,000 characters).'),
        steps: z.array(processStepSchema).optional().describe('For type "process": ordered workflow steps ({order?, role, action, output?, transition?, skillId?}).'),
        scope: skillScopeSchema.optional().describe('Optional scope to attach the new skill or process to immediately: "agent", "channel", or "workspace".'),
        id: z.string().optional().describe('Target id or name when scope is given (omit or pass "me" for yourself when scope is "agent").'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const created = await hub.registry.createSkill(caller, {
          ...args,
          type: args.type as SkillType | undefined,
          scope: args.scope as SkillScope | undefined,
        });
        const resolved = created.type === 'process' ? (await hub.registry.resolveProcessSteps(caller, created.steps)).steps : undefined;
        return skillView(created, resolved);
      }),
  );

  server.registerTool(
    'update_skill',
    {
      title: 'Update a skill or process',
      description:
        'Owner or scope owner only: updates a skill or process\'s name, description, type, instructions (for "skill"), or steps (for "process"). ' +
        'Switching type clears the previous type\'s content so a record never holds contradictory skill+process fields.',
      inputSchema: {
        id: z.string().describe('Skill or process id.'),
        name: z.string().max(100).optional().describe('New name (up to 100 characters).'),
        description: z.string().max(300).optional().describe('New compact description (up to 300 characters).'),
        type: skillTypeSchema.optional().describe('Target type ("skill" or "process"). Switching type requires the target type\'s body and clears the other.'),
        instructions: z.string().max(8000).optional().describe('For type "skill": new Markdown instructions (up to 8,000 characters).'),
        steps: z.array(processStepSchema).optional().describe('For type "process": new ordered steps ({order?, role, action, output?, transition?, skillId?}).'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const { id, ...changes } = args;
        const updated = await hub.registry.updateSkill(caller, id, {
          ...changes,
          type: changes.type as SkillType | undefined,
        });
        const resolved = updated.type === 'process' ? (await hub.registry.resolveProcessSteps(caller, updated.steps)).steps : undefined;
        return skillView(updated, resolved);
      }),
  );

  server.registerTool(
    'delete_skill',
    {
      title: 'Delete a skill',
      description: 'Skill owner or scope owner only: deletes a skill by id and detaches it from any scopes.',
      inputSchema: {
        id: z.string().describe('Skill id to delete.'),
      },
      annotations: { destructiveHint: true },
    },
    (args) => tool(async () => hub.registry.deleteSkill(await me(), args.id)),
  );

  server.registerTool(
    'attach_skill',
    {
      title: 'Attach a skill',
      description:
        'Attaches a skill to an agent (yourself or a bot you manage), a channel (channel/workspace owner), or a workspace (workspace owner). ' +
        'Agents in that scope see its compact summary and can load its full instructions on demand with get_skill.',
      inputSchema: {
        scope: skillScopeSchema.describe('Where to attach the skill: "agent", "channel", or "workspace".'),
        id: z.string().optional().describe('Target id (or channel/workspace name). For scope "agent", omit or pass "me" for yourself.'),
        skillId: z.string().describe('The skill id to attach.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const targetId = args.id ?? (args.scope === 'agent' ? caller.id : '');
        return hub.registry.attachSkill(caller, args.scope as SkillScope, targetId, args.skillId);
      }),
  );

  server.registerTool(
    'detach_skill',
    {
      title: 'Detach a skill',
      description: 'Detaches a skill from an agent, channel, or workspace you manage.',
      inputSchema: {
        scope: skillScopeSchema.describe('Where to detach the skill from: "agent", "channel", or "workspace".'),
        id: z.string().optional().describe('Target id (or channel/workspace name). For scope "agent", omit or pass "me" for yourself.'),
        skillId: z.string().describe('The skill id to detach.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const targetId = args.id ?? (args.scope === 'agent' ? caller.id : '');
        return hub.registry.detachSkill(caller, args.scope as SkillScope, targetId, args.skillId);
      }),
  );

  server.registerTool(
    'list_skills',
    {
      title: 'List skills and processes',
      description:
        'Lists compact summaries ({id, name, description, type}). Pass scope ("agent", "channel", or "workspace") and id to list records attached to that scope, ' +
        'and optional type ("skill" or "process") to filter by kind.',
      inputSchema: {
        scope: skillScopeSchema.optional().describe('Optional scope filter: "agent", "channel", or "workspace".'),
        id: z.string().optional().describe('Target id or name when scope is given (omit or "me" for yourself when scope is "agent").'),
        type: skillTypeSchema.optional().describe('Optional type filter: "skill" or "process".'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      tool(async () => {
        const skills = await hub.registry.listSkills(await me(), {
          scope: args.scope as SkillScope | undefined,
          id: args.id,
          type: args.type as SkillType | undefined,
        });
        return skills.map((s) =>
          skillSummaryView({
            id: s.id,
            name: s.name,
            description: s.description,
            type: s.type ?? 'skill',
            ...(s.builtin ? { builtin: true } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Get a skill or process',
      description:
        'Loads a skill\'s full Markdown instructions or a process\'s full ordered steps by id (requires access to the skill or process). ' +
        'A process is a static team workflow template and never inlines referenced skills\' private instructions.',
      inputSchema: {
        id: z.string().describe('The skill or process id to load.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const skill = await hub.registry.requireAccessibleSkill(caller, args.id);
        const resolved = skill.type === 'process' ? (await hub.registry.resolveProcessSteps(caller, skill.steps)).steps : undefined;
        await hub.chat.recordSkillLoad(caller, skill, turn);
        return skillView(skill, resolved);
      }),
  );
}
