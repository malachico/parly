import { Router } from 'express';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import { agentOf, requireAgent } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { skillView } from '../lib/present.js';
import type { SkillScope, SkillType } from '../registry/types.js';
import { json, str } from './helpers.js';

/** Process steps from a REST body: same shape MCP create_skill accepts. */
const processStepSchema = z.object({
  order: z.number().int().positive().optional(),
  role: z.string(),
  action: z.string(),
  output: z.string().optional(),
  transition: z.string().optional(),
  skillId: z.string().optional(),
});

function stepsOf(raw: unknown): z.infer<typeof processStepSchema>[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new HubError('invalid', 'steps must be an array');
  const parsed = z.array(processStepSchema).safeParse(raw);
  if (!parsed.success) throw new HubError('invalid', parsed.error.issues[0]?.message ?? 'Invalid steps');
  return parsed.data;
}

/**
 * Skills & Processes REST API:
 * - Library catalog (`GET/POST /me/skills`, `GET/PATCH/DELETE /me/skills/:id`) with `readOnly` and `whereUsed`
 * - Effective scope listings (`GET /agents|channels|workspaces/:id/skills`) with `{ skill, source, enabled }`
 * - Plug-and-play attach/detach (`POST|DELETE /agents|channels|workspaces/:id/skills/:skillId`)
 */
export function skillsRoutes(router: Router, hub: HubService): void {
  router.get(
    '/me/skills',
    requireAgent,
    json(async (req) => {
      const type = str(req.query.type) as SkillType | undefined;
      return hub.registry.mySkillsCatalog(agentOf(req)!, { type });
    }),
  );

  router.get(
    '/me/skills/:id',
    requireAgent,
    json(async (req) => {
      const caller = agentOf(req)!;
      const skill = await hub.registry.requireAccessibleSkill(caller, String(req.params.id));
      const enriched = await hub.registry.enrichSkillRecord(caller, skill);
      await hub.chat.recordSkillLoad(caller, skill);
      return {
        ...skillView(skill, enriched.steps),
        readOnly: enriched.readOnly,
        whereUsed: enriched.whereUsed,
      };
    }),
  );

  router.post(
    '/me/skills',
    requireAgent,
    json(async (req, res) => {
      const caller = agentOf(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created = await hub.registry.createSkill(caller, {
        name: typeof body.name === 'string' ? body.name : '',
        description: typeof body.description === 'string' ? body.description : '',
        type: str(body.type) as SkillType | undefined,
        instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
        steps: stepsOf(body.steps),
        scope: str(body.scope) as SkillScope | undefined,
        id: str(body.id),
      });
      const enriched = await hub.registry.enrichSkillRecord(caller, created);
      res.status(201);
      return {
        ...skillView(created, enriched.steps),
        readOnly: enriched.readOnly,
        whereUsed: enriched.whereUsed,
      };
    }),
  );

  router.patch(
    '/me/skills/:id',
    requireAgent,
    json(async (req) => {
      const caller = agentOf(req)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated = await hub.registry.updateSkill(caller, String(req.params.id), {
        ...(body.name !== undefined ? { name: typeof body.name === 'string' ? body.name : '' } : {}),
        ...(body.description !== undefined ? { description: typeof body.description === 'string' ? body.description : '' } : {}),
        ...(body.type !== undefined ? { type: str(body.type) as SkillType } : {}),
        ...(body.instructions !== undefined ? { instructions: typeof body.instructions === 'string' ? body.instructions : '' } : {}),
        ...(body.steps !== undefined ? { steps: stepsOf(body.steps) ?? [] } : {}),
      });
      const enriched = await hub.registry.enrichSkillRecord(caller, updated);
      return {
        ...skillView(updated, enriched.steps),
        readOnly: enriched.readOnly,
        whereUsed: enriched.whereUsed,
      };
    }),
  );

  router.delete(
    '/me/skills/:id',
    requireAgent,
    json(async (req) => hub.registry.deleteSkill(agentOf(req)!, String(req.params.id))),
  );

  const scopes: Array<{ path: 'agents' | 'channels' | 'workspaces'; scope: SkillScope }> = [
    { path: 'agents', scope: 'agent' },
    { path: 'channels', scope: 'channel' },
    { path: 'workspaces', scope: 'workspace' },
  ];

  for (const { path, scope } of scopes) {
    router.get(
      `/${path}/:id/skills`,
      requireAgent,
      json(async (req) =>
        hub.registry.scopeEffectiveSkills(agentOf(req)!, scope, String(req.params.id), {
          workspaceId: str(req.query.workspaceId),
          channelId: str(req.query.channelId),
          type: str(req.query.type) as SkillType | undefined,
        }),
      ),
    );

    router.post(
      `/${path}/:id/skills/:skillId`,
      requireAgent,
      json(async (req) => hub.registry.attachSkill(agentOf(req)!, scope, String(req.params.id), String(req.params.skillId))),
    );

    router.delete(
      `/${path}/:id/skills/:skillId`,
      requireAgent,
      json(async (req) => hub.registry.detachSkill(agentOf(req)!, scope, String(req.params.id), String(req.params.skillId))),
    );
  }
}
