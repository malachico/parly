import { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, requireAgent } from '../lib/auth.js';
import { json } from './helpers.js';

/** Triggers: your sources and listeners, and an agent's own. */
export function triggersRoutes(router: Router, hub: HubService): void {
  /**
   * Your triggers (shared, like your apps): GET lists each source with its listeners; POST `{slug, config}` makes one
   * (or returns the same active one); DELETE turns it off (archived with its listeners, history kept); POST …/restore
   * turns it back on. Listeners: POST `{agentId?, channelId?, filter?, task?, grantTool?}`, PATCH `{enabled?, filter?,
   * task?}`, DELETE (turned off, kept for its history).
   */
  router.get(
    '/me/triggers',
    requireAgent,
    json(async (req) => hub.triggerService.mySources(agentOf(req)!)),
  );
  router.post(
    '/me/triggers',
    requireAgent,
    json(async (req, res) => {
      const source = await hub.triggerService.ensureSource(agentOf(req)!, (req.body ?? {}) as Record<string, unknown>);
      res.status(201);
      return source;
    }),
  );
  router.delete(
    '/me/triggers/:id',
    requireAgent,
    json(async (req) => (await hub.triggerService.archiveSource(agentOf(req)!, String(req.params.id)), { ok: true })),
  );
  router.post(
    '/me/triggers/:id/restore',
    requireAgent,
    json(async (req) => hub.triggerService.restoreSource(agentOf(req)!, String(req.params.id))),
  );
  router.post(
    '/me/triggers/:id/listeners',
    requireAgent,
    json(async (req, res) => {
      const listener = await hub.triggerService.addListener(agentOf(req)!, String(req.params.id), (req.body ?? {}) as Record<string, never>);
      res.status(201);
      return listener;
    }),
  );
  router.patch(
    '/me/triggers/:id/listeners/:lid',
    requireAgent,
    json(async (req) => hub.triggerService.updateListener(agentOf(req)!, String(req.params.id), String(req.params.lid), (req.body ?? {}) as Record<string, never>)),
  );
  router.delete(
    '/me/triggers/:id/listeners/:lid',
    requireAgent,
    json(async (req) => hub.triggerService.updateListener(agentOf(req)!, String(req.params.id), String(req.params.lid), { enabled: false })),
  );

  /** What your connected apps can tell an agent about: `[{toolkit, app, types: [{slug, name, description, config}]}]`. */
  router.get(
    '/me/trigger-types',
    requireAgent,
    json(async (req) => hub.triggerService.triggerTypes(agentOf(req)!)),
  );
  /**
   * Triggers on a cloud agent of yours: GET lists them; POST `{kind: "gmail", from?, subject?}` tells the agent about
   * each new email (that matches) in your connected Gmail; DELETE …/:tid turns one off.
   */
  router.get(
    '/agents/:id/triggers',
    requireAgent,
    json(async (req) => hub.triggerService.agentTriggers(agentOf(req)!, String(req.params.id))),
  );
  router.post(
    '/agents/:id/triggers',
    requireAgent,
    json(async (req, res) => {
      const t = await hub.triggerService.createTrigger(agentOf(req)!, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      res.status(201);
      return t;
    }),
  );
  router.delete(
    '/agents/:id/triggers/:tid',
    requireAgent,
    json(async (req) => (await hub.triggerService.deleteTrigger(agentOf(req)!, String(req.params.id), String(req.params.tid)), { ok: true })),
  );
}
