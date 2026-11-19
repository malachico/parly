import { Router, type NextFunction, type Request, type Response } from 'express';
import type { HubService } from '../hub/hubService.js';
import { APP_KEY_PREFIX, type AppCaller, type AppScope } from '../apps/apps.js';
import { bearer } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { json } from './helpers.js';
import { v1RoomRoutes } from './v1Rooms.js';

const callers = new WeakMap<Request, AppCaller>();

/** The app behind a /v1 request (set by requireApp). */
export function appOf(req: Request): AppCaller {
  const app = callers.get(req);
  if (!app) throw new HubError('unauthorized', 'An app API key is required');
  return app;
}

/**
 * /v1 takes only app API keys (`Authorization: Bearer pk_live_…`), never agent tokens or sessions,
 * and each route names the scope it needs.
 */
// One budget per app across every /v1 route.
const limiter = new RateLimiter(600, 60_000, 'API calls');

export function requireApp(hub: HubService, scope: AppScope) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = bearer(req);
      const app = key?.startsWith(APP_KEY_PREFIX) ? await hub.apps.authenticate(key) : undefined;
      if (!app) {
        res.status(401).json({ error: 'Send an app API key: "Authorization: Bearer pk_live_…" (workspace settings → Apps).' });
        return;
      }
      if (!app.scopes.includes(scope)) {
        res.status(403).json({ error: `This key lacks the ${scope} scope` });
        return;
      }
      limiter.hit(app.id);
      callers.set(req, app);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The public, versioned API for apps. Rooms and webhooks hang off this router. */
export function v1Router(hub: HubService): Router {
  const router = Router();
  /** Which app this key is: `{id, workspaceId, name, scopes, agents}` (agents: its template keys). */
  router.get('/me', requireApp(hub, 'rooms:read'), json(async (req) => {
    const caller = appOf(req);
    const app = (await hub.apps.get(caller.id))!;
    return { id: app.id, workspaceId: app.workspaceId, name: app.name, scopes: caller.scopes, agents: Object.keys(app.agents) };
  }));
  v1RoomRoutes(router, hub);
  return router;
}
