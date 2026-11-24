import { appsRoutes } from './apps.js';
import { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { accountRoutes } from './account.js';
import { companiesRoutes } from './companies.js';
import { triggersRoutes } from './triggers.js';
import { skillsRoutes } from './skills.js';
import { agentsRoutes } from './agents.js';
import { workspacesRoutes } from './workspaces.js';
import { conversationsRoutes } from './conversations.js';
import { integrationsRoutes } from './integrations.js';
export { hookText } from './helpers.js';

/**
 * Plain REST API: registration for non-MCP clients, and a read API for dashboards.
 * The directory shows public agents, plus everyone in the caller's workspaces when a bearer token is sent.
 * Tasks are only visible to the agents involved.
 */
export function restRouter(hub: HubService, stream: { sealingKey?: Buffer; publicUrl?: string; webUrl?: string } = {}): Router {
  const router = Router();
  // In this order: Express matches routes as they were added (/agents/bots before /agents/:id).
  accountRoutes(router, hub);
  companiesRoutes(router, hub);
  appsRoutes(router, hub);
  triggersRoutes(router, hub);
  skillsRoutes(router, hub);
  agentsRoutes(router, hub);
  workspacesRoutes(router, hub);
  conversationsRoutes(router, hub, stream);
  integrationsRoutes(router, hub);
  return router;
}
