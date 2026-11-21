import { Router, type NextFunction, type Request, type Response } from 'express';
import { json, str } from '../rest/helpers.js';
import { agentOf } from '../lib/auth.js';
import { isSuperAdmin } from '../lib/admin.js';
import { HubError } from '../lib/errors.js';
import type { Billing } from '../billing/billing.js';
import { Admin, type AdminAction } from './admin.js';

const ACTIONS = new Set<AdminAction>(['archive', 'restore', 'revoke-token', 'check']);

/** Super admins only. Anyone else, signed in or not, gets a 404: the admin API doesn't announce itself. */
function superAdminOnly(req: Request, res: Response, next: NextFunction) {
  const agent = agentOf(req);
  if (agent && isSuperAdmin(agent)) return next();
  res.status(404).json({ error: 'Not found' });
}

const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

/** The admin dashboard's API, under /admin. See Admin for what it shows and what it never does. */
export function adminRouter(admin: Admin, billing: Billing): Router {
  const router = Router();
  router.use('/admin', superAdminOnly);
  router.get('/admin/vouchers', json(async () => ({ vouchers: await billing.listVouchers() })));
  router.post('/admin/vouchers', json(async (req) => billing.createVoucher(agentOf(req)!.id, req.body ?? {})));
  router.patch('/admin/vouchers/:code', json(async (req) => {
    if (req.body?.active !== false) throw new HubError('invalid', 'A voucher can only be disabled');
    await billing.disableVoucher(req.params.code, agentOf(req)!.id);
    return { ok: true };
  }));

  /** Anyone signed in with Google: `{company, size, message}`, asking about Enterprise. Emailed to super admins; listed at /admin/enterprise-leads. */
  router.post(
    '/enterprise-leads',
    json(async (req) => {
      const me = agentOf(req);
      if (!me) throw new HubError('unauthorized', 'Sign in first');
      const body = (req.body ?? {}) as Record<string, unknown>;
      return admin.addEnterpriseLead(me, { company: str(body.company), size: str(body.size), message: str(body.message), plan: str(body.plan) });
    }),
  );

  /** Anyone signed in with Google: `{text}`, a client they'd like to connect. Super admins see it at /admin/client-requests. */
  router.post(
    '/client-requests',
    json(async (req) => {
      const me = agentOf(req);
      if (!me) throw new HubError('unauthorized', 'Sign in first');
      return admin.addClientRequest(me, String((req.body ?? {}).text ?? ''));
    }),
  );

  /** Anyone: which clients the Connect page shows (an admin's choices; the page has the defaults). */
  router.get('/connect-clients', json(async () => ({ shown: await admin.connectClients() })));

  router.get('/admin/connect-clients', json(async () => ({ shown: await admin.connectClients() })));

  /** `?limit=`: enqueues the next batch of the 90-day context graph backfill. Run by hand; resumes where it stopped. */
  router.post('/admin/graph/backfill', json(async (req) => admin.backfillGraph(num(req.query.limit))));

  /** `{client, shown}`: show or hide a client on the Connect page. */
  router.post(
    '/admin/connect-clients',
    json(async (req) => {
      const { client, shown } = (req.body ?? {}) as { client?: unknown; shown?: unknown };
      if (typeof shown !== 'boolean') throw new HubError('invalid', 'shown must be true or false');
      return { shown: await admin.setConnectClient(String(client ?? ''), shown) };
    }),
  );

  /** This month's model use by agent, most tokens first, with each agent's name and owner. */
  router.get('/admin/usage', json(async () => admin.usage()));

  router.get('/admin/overview', json(async (req) => admin.overview(Math.min(Math.max(num(req.query.hours) ?? 24, 1), 24 * 7))));

  router.get(
    '/admin/agents',
    json(async (req) => admin.agents({ q: str(req.query.q), kind: str(req.query.kind), filter: str(req.query.filter), offset: num(req.query.offset), limit: num(req.query.limit) })),
  );

  router.get('/admin/agents/:id', json(async (req) => admin.agent(String(req.params.id))));

  /** `{action}`: archive, restore, revoke-token or check. */
  router.post(
    '/admin/agents/:id/actions',
    json(async (req) => {
      const action = String((req.body ?? {}).action ?? '') as AdminAction;
      if (!ACTIONS.has(action)) throw new HubError('invalid', `action must be one of ${[...ACTIONS].join(', ')}`);
      return admin.act(agentOf(req)!, String(req.params.id), action);
    }),
  );

  /** `{plan, allowanceUsd?, maxWorkspaces?, maxParticipants?}`: a person's plan, e.g. an Enterprise deal (null clears an override).
   * The old `maxHired`/`maxConnected` keys still work, as maxWorkspaces/maxParticipants, until the admin page sends the new ones. */
  router.post(
    '/admin/agents/:id/billing',
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const plan = String(body.plan ?? '');
      if (!['free', 'pro', 'team', 'enterprise'].includes(plan)) throw new HubError('invalid', 'plan must be free, pro, team or enterprise');
      const amount = (v: unknown) => (v === null || v === '' ? null : v === undefined ? undefined : Number(v));
      return admin.setPlan(agentOf(req)!, String(req.params.id), { plan: plan as 'free' | 'pro' | 'team' | 'enterprise', allowanceUsd: amount(body.allowanceUsd), maxWorkspaces: amount('maxWorkspaces' in body ? body.maxWorkspaces : body.maxHired), maxParticipants: amount('maxParticipants' in body ? body.maxParticipants : body.maxConnected) });
    }),
  );

  router.get('/admin/enterprise-leads', json(async (req) => admin.enterpriseLeads(num(req.query.limit))));

  router.get('/admin/client-requests', json(async (req) => admin.clientRequests(num(req.query.limit))));

  router.get('/admin/log', json(async (req) => admin.logEntries(num(req.query.limit))));

  return router;
}
