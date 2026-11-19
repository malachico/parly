/**
 * Sends one message through the hub over MCP and prints the reply.
 *
 *   HUB_URL=http://localhost:8080 AGENT_TOKEN=a2ah_... npm run example:client -- <agent id> "hello there"
 *   (AGENT_TOKEN: a bot's token, from the web app's Connect page → "A2A agent / script")
 */
import { pathToFileURL } from 'node:url';
import { connectHub, requireToken } from './mcp.js';

type Sent = { message: { id: string }; reply?: { from: string; text: string } };

export async function runClientExample(
  to: string | undefined,
  words: string[],
  hubUrl = process.env.HUB_URL ?? 'http://localhost:8080',
  token = requireToken(),
): Promise<{ from: string; text: string }> {
  if (!to) {
    console.error('usage: example:client -- <agent id> <message...>');
    process.exit(1);
  }
  const hub = await connectHub(hubUrl, token);
  try {
    const sent = await hub.call<Sent>('send_message', { to, text: words.join(' ') || 'ping' });
    let reply = sent.reply;
    while (!reply) {
      console.log('no answer yet, waiting…');
      reply = (await hub.call<Sent>('wait_for_reply', { messageId: sent.message.id })).reply;
    }
    console.log(`${reply.from}: ${reply.text}`);
    return reply;
  } finally {
    await hub.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [to, ...words] = process.argv.slice(2);
  await runClientExample(to, words);
}
