/**
 * A minimal A2A endpoint agent: replies "echo: <text>" to every message.
 *
 *   npm run example:echo                      # serves on :4001
 *   HUB_URL=http://localhost:8080 AGENT_TOKEN=a2ah_... npm run example:echo
 *     # ...and points its bot (made on the web app's Connect page) at this server
 *   PUBLIC_URL=https://xxxx.trycloudflare.com HUB_URL=https://<hub> npm run example:echo
 *     # behind a tunnel: the card advertises PUBLIC_URL, so a remote hub can reach it
 */
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { AGENT_CARD_PATH, AgentCard, Message } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';

const executor: AgentExecutor = {
  async execute(ctx, bus) {
    const message = Message.toJSON(ctx.userMessage) as { parts?: { text?: string }[] };
    const incoming = (message.parts ?? []).map((p) => p.text ?? '').join('');
    bus.publish(
      AgentEvent.message(
        Message.fromJSON({
          messageId: crypto.randomUUID(),
          contextId: ctx.contextId,
          role: 'ROLE_AGENT',
          parts: [{ text: `echo: ${incoming}` }],
        }),
      ),
    );
    bus.finished();
  },
  async cancelTask() {},
};

/** `publicUrl`: the address others reach this agent at (e.g. a tunnel), advertised in its card. */
export function startEchoAgent(port: number, host = '127.0.0.1', publicUrl?: string): Promise<{ server: Server; url: string }> {
  const url = publicUrl?.replace(/\/$/, '') ?? `http://${host}:${port}`;
  const card = AgentCard.fromJSON({
    name: 'echo',
    description: 'Replies with whatever you send it.',
    version: '1.0.0',
    supportedInterfaces: [{ url: `${url}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes the message back', tags: ['test', 'echo'] }],
  });
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  app.use(express.json());
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use('/a2a', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => resolve({ server, url }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 4001);
  const { url } = await startEchoAgent(port, process.env.HOST ?? '127.0.0.1', process.env.PUBLIC_URL);
  console.log(`echo agent on :${port}, reachable at ${url}`);
  const hub = process.env.HUB_URL;
  if (hub && !process.env.AGENT_TOKEN) console.log('Set AGENT_TOKEN (a bot token from the Connect page) to register with the hub.');
  if (hub && process.env.AGENT_TOKEN) {
    const res = await fetch(`${hub}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AGENT_TOKEN}` },
      body: JSON.stringify({ name: 'echo', url }),
    });
    console.log(`registered with ${hub}: HTTP ${res.status}`, await res.json());
  }
}
