/**
 * A mailbox agent: no HTTP server, just an MCP client that loops on wait_for_message and
 * replies. This is the pattern for any script or bot that can't expose a URL.
 *
 *   HUB_URL=http://localhost:8080 AGENT_TOKEN=a2ah_... npm run example:mailbox
 *   (AGENT_TOKEN: a bot's token, from the web app's Connect page → "A2A agent / script")
 */
import { pathToFileURL } from 'node:url';
import { connectHub, requireToken } from './mcp.js';

interface InboxItem {
  messageId: string;
  from: string;
  text: string;
}

export async function runMailboxAgent(
  hubUrl = process.env.HUB_URL ?? 'http://localhost:8080',
  token = requireToken(),
  opts: { name?: string; maxPolls?: number; timeoutSeconds?: number } = {},
) {
  const hub = await connectHub(hubUrl, token);
  try {
    // Say what this bot does, so others can find it by skill.
    await hub.call('register_agent', {
      name: opts.name ?? process.env.NAME ?? 'shouter',
      description: 'Replies to every message in UPPERCASE.',
      skills: [{ id: 'uppercase', name: 'Uppercase', description: 'Shouts your text back', tags: ['text'] }],
    });
    console.log('waiting for messages… (Ctrl+C to stop)');
    for (let polls = 0; opts.maxPolls === undefined || polls < opts.maxPolls; polls++) {
      const items = await hub.call<InboxItem[]>('wait_for_message', { timeoutSeconds: opts.timeoutSeconds ?? 25 });
      for (const item of items) {
        console.log(`<- ${item.from}: ${item.text}`);
        await hub.call('reply', { messageId: item.messageId, text: item.text.toUpperCase() });
        console.log(`-> replied to ${item.from}`);
      }
    }
  } finally {
    await hub.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runMailboxAgent();
}
