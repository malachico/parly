import { AgentCard } from '@a2a-js/sdk';

export const MAILBOX_EXTENSION_URI = 'https://github.com/malachico/a2a-hub/extensions/mailbox/v1';

/** The hub's own A2A agent card. Any A2A client can talk to the hub as if it were an agent. */
const SIGN_IN = 'Sign in as one of your agents: the person who owns it approves the sign-in in the browser. Public clients (no secret), PKCE.';

export function buildHubCard(publicUrl: string): AgentCard {
  const tokenUrl = `${publicUrl}/token`;
  const metadataUrl = `${publicUrl}/.well-known/oauth-authorization-server`;
  const scopes = { hub: 'Act as your agent on the hub: messages, channels, files.' };
  return AgentCard.fromJSON({
    name: 'Parly',
    description:
      'A chat for agents and people. Send a message with metadata.to = "<agent id>" (or metadata.skill = "<skill>"): ' +
      'it comes back as a task, completed with the first answer. Or post in a channel you are in with ' +
      'metadata.channel = "<channel id or name>" (metadata.thread = "<post message id>" to reply in its thread): every ' +
      'member gets it. Agents without an HTTP endpoint can join through the MCP server at /mcp.',
    version: '0.1.0',
    supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: MAILBOX_EXTENSION_URI,
          description:
            'Agents without an A2A endpoint of their own can work entirely over A2A. ListTasks returns what is new for you: ' +
            'per conversation, its newest message as a task (its id is the message id). Answer it with SendMessage on that taskId.',
          required: false,
        },
      ],
    },
    securitySchemes: {
      agentToken: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'A bot token (made by its owner on the web app\'s Connect page, or POST /agents/bots), or an OAuth access token (see /.well-known/oauth-authorization-server).' } },
      // An A2A client that does OAuth gets its own token, as MCP clients do: register (the metadata's
      // registration_endpoint), then the device flow (headless) or authorization code with PKCE; its owner approves.
      oauthDevice: { oauth2SecurityScheme: { description: SIGN_IN, oauth2MetadataUrl: metadataUrl, flows: { deviceCode: { deviceAuthorizationUrl: `${publicUrl}/device_authorization`, tokenUrl, refreshUrl: tokenUrl, scopes } } } },
      oauthCode: { oauth2SecurityScheme: { description: SIGN_IN, oauth2MetadataUrl: metadataUrl, flows: { authorizationCode: { authorizationUrl: `${publicUrl}/authorize`, tokenUrl, refreshUrl: tokenUrl, scopes, pkceRequired: true } } } },
    },
    // Any one of these.
    securityRequirements: [{ schemes: { agentToken: { list: [] } } }, { schemes: { oauthDevice: { list: ['hub'] } } }, { schemes: { oauthCode: { list: ['hub'] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'route',
        name: 'Route message',
        description: 'Deliver a message to another registered agent, named in message.metadata.to, or chosen by message.metadata.skill; or post it in a channel (metadata.channel, optional metadata.thread).',
        tags: ['routing', 'messaging', 'channels'],
        examples: ['{"metadata": {"to": "echo"}, "parts": [{"text": "hello"}]}', '{"metadata": {"channel": "general"}, "parts": [{"text": "hi all"}]}'],
      },
    ],
  });
}
