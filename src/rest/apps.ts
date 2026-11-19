import type { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, requireAgent } from '../lib/auth.js';
import { json, str } from './helpers.js';

/** A workspace's apps and API keys (owners only). Keys and webhook secrets are shown once, when made. */
export function appsRoutes(router: Router, hub: HubService) {
  /** `{name, webhookUrl?}` → `{app, key}`: the key and `app.webhookSecret` are shown only here. */
  router.post('/workspaces/:id/apps', requireAgent, json(async (req, res) => {
    const made = await hub.apps.create(agentOf(req)!, String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
    res.status(201);
    return made;
  }));
  router.get('/workspaces/:id/apps', requireAgent, json(async (req) => hub.apps.list(agentOf(req)!, String(req.params.id))));
  /** Another key (rotate: add one, switch over, revoke the old). */
  router.post('/workspaces/:id/apps/:app/keys', requireAgent, json(async (req, res) => {
    const made = await hub.apps.addKey(agentOf(req)!, String(req.params.id), String(req.params.app));
    res.status(201);
    return made;
  }));
  router.delete('/workspaces/:id/apps/:app/keys/:prefix', requireAgent, json(async (req) => {
    await hub.apps.revokeKey(agentOf(req)!, String(req.params.id), String(req.params.app), str(req.params.prefix) ?? '');
    return { ok: true };
  }));
  /** Deletes the app and revokes all its keys. */
  router.delete('/workspaces/:id/apps/:app', requireAgent, json(async (req) => {
    await hub.apps.delete(agentOf(req)!, String(req.params.id), String(req.params.app));
    return { ok: true };
  }));
}
