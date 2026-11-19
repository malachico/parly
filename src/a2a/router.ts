import { Router, type Request, type Response } from 'express';
import { AGENT_CARD_PATH, AgentCard } from '@a2a-js/sdk';
import { UnauthenticatedUser } from '@a2a-js/sdk/server';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { agentOf, requireAgent } from '../lib/auth.js';
import { AgentUser, type HubRequestHandler } from './handler.js';

/** Mounts the hub's agent card (public) and its JSON-RPC endpoint at /a2a (agent token required). */
export function a2aRouter(handler: HubRequestHandler): Router {
  const router = Router();
  // The card as A2A JSON. (The SDK's own card handler sends its internal objects, so security schemes came out
  // as {"scheme": {"$case": ...}}, which no client reads.)
  const card = async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(AgentCard.toJSON(await handler.getAgentCard()));
  };
  router.get(`/${AGENT_CARD_PATH}`, card);
  router.get('/.well-known/agent.json', card); // legacy card path, still probed by some clients
  router.use(
    '/a2a',
    requireAgent,
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: async (req: Request) => {
        const agent = agentOf(req);
        return agent ? new AgentUser(agent) : new UnauthenticatedUser();
      },
    }),
  );
  return router;
}
