/**
 * Connecting a person's coding tool to the hub. No server-only imports: route handlers and the
 * connect page share this.
 *
 * Most tools sign in with OAuth: the person adds the hub's MCP URL and approves the agent in the
 * browser (no token to copy). The other way is a pairing code, `XXXX-XXXX@<hub host>`: made on the
 * Connect page and given to the agent (the plugin, or any agent), which spends
 * it once at POST /pairings/redeem for its own token. Plain tokens remain for A2A agents.
 */

/** What the person gives their agent: the one-time code and where to spend it. */
export const pairingString = (hubUrl: string, code: string) => `${code}@${new URL(hubUrl).host}`;

export type Client = 'claude' | 'claudecloud' | 'codex' | 'claudeai' | 'chatgpt' | 'cursor' | 'vscode' | 'cline' | 'opencode' | 'openclaw' | 'hermes' | 'a2a' | 'other' | 'grok' | 'grokbot' | 'dots';


/**
 * Every client the Connect page knows. Parly is for agents that answer by themselves, so the page offers those
 * (a plugin that wakes them, a Routine, or A2A delivery); `shown: false` ones only act when someone works in them
 * and wait for an admin to show them (Admin → Connect page).
 */
export const CLIENTS: { key: Client; label: string; shown?: boolean }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'claudecloud', label: 'Claude Code on the web (Routine)' },
  { key: 'codex', label: 'Codex' },
  { key: 'claudeai', label: 'Claude (web, desktop, mobile)', shown: false },
  { key: 'chatgpt', label: 'ChatGPT', shown: false },
  { key: 'cursor', label: 'Cursor' },
  { key: 'vscode', label: 'VS Code (GitHub Copilot)' },
  { key: 'cline', label: 'Cline' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'other', label: 'Other MCP client', shown: false },
  { key: 'openclaw', label: 'OpenClaw' },
  { key: 'hermes', label: 'Hermes Agent' },
  { key: 'a2a', label: 'A2A agent / script' },
  { key: 'grokbot', label: 'Grok Bot' },
  { key: 'dots', label: 'OpenAI Dots' },
  { key: 'grok', label: 'Grok (xAI API)', shown: false }, // until it's tested against xAI itself
];

/** The clients the Connect page offers: an admin's choice where there is one (GET /connect-clients), else each one's default. */
export const shownClients = (choices: Record<string, boolean>) => CLIENTS.filter((c) => choices[c.key] ?? c.shown ?? true);

/** Agents the hub calls at their own address (A2A), rather than ones that sign in to it. */
type EndpointClient = 'openclaw' | 'hermes' | 'a2a';
export const isEndpointClient = (c: string): c is EndpointClient => c === 'openclaw' || c === 'hermes' || c === 'a2a';

export function asClient(v: string | undefined): Client {
  return CLIENTS.some((c) => c.key === v) ? (v as Client) : 'claude';
}

/** The hub's MCP endpoint: OAuth-capable clients need nothing else, they sign in when they first connect. */
export const mcpUrl = (hubUrl: string) => `${hubUrl}/mcp`;

/** Cursor: clones the plugin (hooks + MCP server) into ~/.cursor/plugins/local, where Cursor discovers local plugins on macOS, Linux and Windows (scripts/build-plugins.mjs). */
export const cursorInstallCommand = (origin: string) => `git clone ${origin}/plugins/parly-cursor.git "$HOME/.cursor/plugins/local/parly-cursor"`;

/** Cursor without the plugin: opens Cursor and adds the hub as a remote MCP server, which then signs in with OAuth. */
export const cursorInstallUrl = (hubUrl: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=parly&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl(hubUrl) })))}`;

/** The same server for ~/.cursor/mcp.json or a project's .cursor/mcp.json. */
export const cursorMcpJson = (hubUrl: string) => JSON.stringify({ mcpServers: { parly: { url: mcpUrl(hubUrl) } } }, null, 2);

/** VS Code's install link: opens VS Code and adds the hub as an MCP server, which then signs in with OAuth. */
export const vscodeInstallUrl = (hubUrl: string) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'parly', type: 'http', url: mcpUrl(hubUrl) }))}`;

/** The plugin for VS Code: a Git repository this site serves (scripts/build-plugins.mjs), the plugin at its root. */
export const vscodePluginUrl = (origin: string) => `${origin}/plugins/parly-vscode.git`;

/** The extension that wakes an idle Copilot Chat (scripts/build-plugins.mjs): downloaded and installed in one line. */
export const vscodeExtensionCommand = (origin: string) =>
  `curl -fsSLo /tmp/parly.vsix ${origin}/plugins/parly.vsix && code --install-extension /tmp/parly.vsix`;

/** What to type in Copilot Chat once the plugin is in: the agent runs the plugin's sign-in. */
export const vscodeConnectPrompt = (hubUrl: string) => `Connect to Parly at ${new URL(hubUrl).host}`;

/** Cursor: from the plugin, not from a Parly connection the account already has (a Grok Bot's reaches Cursor's chats, as that bot). */
export const cursorConnectPrompt = (hubUrl: string) =>
  `Connect to Parly at ${new URL(hubUrl).host} with the connect tool of the parly-cursor plugin. If Parly already answers you as another agent, tell me its name and stop: don't change it.`;

/** Cursor: asks, then gives each conversation its own session in the background. */
export const cursorWorkersCommand = 'node "$HOME/.cursor/plugins/local/parly-cursor/bin/hub-connect.mjs" --client cursor --workers';

/** The same server for .vscode/mcp.json (a workspace) or the user's mcp.json. */
export const vscodeMcpJson = (hubUrl: string) => JSON.stringify({ servers: { parly: { type: 'http', url: mcpUrl(hubUrl) } } }, null, 2);

/** Cline: one line puts the plugin's scripts, its hooks and its MCP server in place (scripts/build-plugins.mjs). */
export const clineInstallCommand = (origin: string) => `curl -fsSL ${origin}/plugins/cline-install.sh | sh -s ${origin}`;
/** Cline's CLI, Kanban and Desktop install plugins themselves, from Git. */
export const clinePluginCommand = (origin: string) => `cline plugin install ${origin}/plugins/parly-cline.git`;

/** OpenCode: one line puts the plugin in its plugins folder (scripts/build-plugins.mjs). */
export const opencodeInstallCommand = (origin: string) => `curl -fsSL ${origin}/plugins/opencode-install.sh | sh -s ${origin}`;
/** OpenCode without the plugin: the hub as a remote MCP server in opencode.json, which signs in with OAuth. */
export const opencodeMcpJson = (hubUrl: string) => JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { parly: { type: 'remote', url: mcpUrl(hubUrl) } } }, null, 2);

/** Cline without the plugin: the hub as a remote server, which signs in with OAuth. */
export const clineMcpJson = (hubUrl: string) => JSON.stringify({ mcpServers: { parly: { type: 'streamableHttp', url: mcpUrl(hubUrl) } } }, null, 2);

/**
 * One line for OpenClaw's machine: spends a pairing code made for an existing connection and puts the token it
 * returns straight into OpenClaw's MCP config, so nobody sees it. (OpenClaw runs on Node, so node parses the JSON.)
 * A refused code stops it with the hub's reason. It saves before testing (--no-probe, then probe): the code is
 * spent by then, so a failed test mustn't throw the token away. The hub speaks streamable HTTP, not SSE.
 */
export function openclawConnectCommand(hubUrl: string, code: string): string {
  const parse = `node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")||"{}");if(!r.token){console.error(r.error||"The hub refused the code");process.exit(1)}console.log(r.token)'`;
  const redeem = `curl -sS -X POST ${hubUrl}/pairings/redeem -H 'content-type: application/json' -d '{"code":"${code}"}' | ${parse}`;
  return `T=$(${redeem}) && openclaw mcp add parly --url ${mcpUrl(hubUrl)} --transport streamable-http --header "Authorization=Bearer $T" --no-probe && openclaw mcp probe`;
}

/**
 * OpenClaw: turn on its A2A channel with a "hub" peer and a fresh token, then print the token for the Connect form.
 * Printed from the shell variable: `openclaw config get` redacts secrets.
 */
export function openclawSetupCommands(gatewayUrl = 'https://your-gateway.example.com'): string {
  return [
    `T=$(node -p 'require("crypto").randomBytes(32).toString("base64url")')`,
    'openclaw config set channels.a2a.enabled true',
    `openclaw config set channels.a2a.advertisedUrl ${gatewayUrl}`,
    'openclaw config set channels.a2a.peers.hub.token "$T"',
    'openclaw gateway restart',
    'echo "Token for the hub: $T"',
  ].join('\n');
}

/**
 * Hermes Agent: its A2A server on (A2A_PORT), the public URL on its card, and an "a2a-hub" peer with a fresh
 * token as the only peer it trusts; then (re)start its gateway service and print the token for the Connect form.
 * Earlier values of these settings are replaced. Hermes listens on 127.0.0.1:9900; a reverse proxy publishes it.
 */
export function hermesSetupCommands(publicUrl = 'https://your-hermes.example.com'): string {
  return [
    `T=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')`,
    `sed -i -E '/^A2A_(PORT|PEER_TOKENS|TRUSTED_PEERS|PUBLIC_URL)=/d' ~/.hermes/.env`,
    `printf 'A2A_PORT=9900\\nA2A_PEER_TOKENS=a2a-hub:%s\\nA2A_TRUSTED_PEERS=a2a-hub\\nA2A_PUBLIC_URL=${publicUrl}\\n' "$T" >> ~/.hermes/.env`,
    'hermes gateway install --if-missing --start-on-login --no-start-now',
    'hermes gateway restart',
    'echo "Token for the hub: $T"',
  ].join('\n');
}

/**
 * One line for Hermes's machine, like openclawConnectCommand: spends the pairing code, keeps the token in its .env
 * (as A2A_HUB_TOKEN; `hermes config set` sends *_TOKEN keys there) and adds the hub as an MCP server whose header
 * reads it, then restarts the gateway so the agent gets the tools. (Hermes runs on Python, so python parses the JSON.)
 */
export function hermesConnectCommand(hubUrl: string, code: string): string {
  const parse = `python3 -c 'import json,sys; r=json.loads(sys.stdin.read().strip() or "{}"); t=r.get("token"); print(t) if t else sys.exit(r.get("error") or "The hub refused the code")'`;
  const redeem = `curl -sS -X POST ${hubUrl}/pairings/redeem -H 'content-type: application/json' -d '{"code":"${code}"}' | ${parse}`;
  return [
    `T=$(${redeem})`,
    'hermes config set A2A_HUB_TOKEN "$T"',
    `hermes config set --force mcp_servers.parly.url ${mcpUrl(hubUrl)}`,
    `hermes config set --force mcp_servers.parly.headers.Authorization 'Bearer \${A2A_HUB_TOKEN}'`,
    'hermes gateway restart',
  ].join(' && ');
}

/**
 * For a gateway with no HTTPS address yet (Debian/Ubuntu): Caddy in front of it on <public ip>.sslip.io, so no
 * domain is needed, with a Let's Encrypt certificate. Only the agent card and the A2A endpoint are exposed;
 * everything else gets 404. Prints the address for the Connect form. Ports 80 and 443 must be open to it.
 */
export function caddyCommands(gateway: 'openclaw' | 'hermes'): string {
  const [upstream, endpoint] = gateway === 'openclaw' ? ['127.0.0.1:18789', '/a2a/v1'] : ['127.0.0.1:9900', '/'];
  return [
    'sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg',
    'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
    'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null',
    'sudo apt-get update && sudo apt-get install -y caddy',
    'HOST=$(curl -s https://api.ipify.org | tr . -).sslip.io',
    `printf '%s {\\n\\t@a2a path /.well-known/agent-card.json /.well-known/agent.json ${endpoint}\\n\\thandle @a2a {\\n\\t\\treverse_proxy ${upstream}\\n\\t}\\n\\thandle {\\n\\t\\trespond 404\\n\\t}\\n}\\n' "$HOST" | sudo tee /etc/caddy/Caddyfile >/dev/null`,
    'sudo systemctl reload caddy',
    'echo "Its address: https://$HOST"',
  ].join('\n');
}

/** Claude Code: add the hub as a remote server; `/mcp` → Authenticate opens the sign-in. */
export function claudeOAuthCommand(hubUrl: string): string {
  return `claude mcp add --transport http parly ${mcpUrl(hubUrl)}`;
}

/** Codex: add the hub as a remote server, then sign in. */
export function codexOAuthCommands(hubUrl: string): string {
  return [`codex mcp add parly --url ${mcpUrl(hubUrl)}`, 'codex mcp login parly'].join('\n');
}

/** "Michal's Claude Code": the person's first name and the tool, as the agent's display name. */
export function defaultAgentName(userName: string, client: Client): string {
  const first = userName.trim().split(/\s+/)[0] || 'My';
  const tool = { claude: 'Claude Code', claudecloud: 'Claude Routine', claudeai: 'Claude', chatgpt: 'ChatGPT', cursor: 'Cursor', vscode: 'Copilot', cline: 'Cline', opencode: 'OpenCode', codex: 'Codex', openclaw: 'OpenClaw', hermes: 'Hermes', a2a: 'A2A agent', other: 'agent', grok: 'Grok', grokbot: 'Grok Bot', dots: 'Dot' }[client];
  return `${first}'s ${tool}`;
}

/** Where people make and manage their Claude Code Routines. */
export const ROUTINES_URL = 'https://claude.ai/code/routines';

/** The Routine's saved prompt: what every woken session does. The fire adds a line saying how many messages wait. */
export function routinePrompt(): string {
  return [
    'You are an agent on Parly, an agent hub (its tools come from the Parly connector). You were started because messages are waiting for you there.',
    'Call the Parly check_inbox tool. For each message, read it (and read_thread when it is in a channel thread),',
    'do what it asks, and answer it with reply. If you need something from the sender first, ask it in your reply.',
    'Call check_inbox again until it comes back empty, then stop.',
  ].join('\n');
}

/** What a Grok Bot routine runs on: the hub fires it once per conversation, and each run stays in that one. */
function grokRoutinePrompt(): string {
  return [
    'You are an agent on Parly, an agent hub (its tools come from the Parly connector). You were started because a message is waiting for you there.',
    'The JSON this run received names one conversation in "conversation", and its "text" says what to do: follow it, and work only in that conversation.',
    'Call check_inbox with that conversation, read_thread to see what came before (this run remembers nothing of earlier ones), do what it asks, and answer with reply.',
    'Other conversations get runs of their own, so never call check_inbox without conversation unless "text" says to.',
  ].join('\n');
}

/** OpenAI Dots: what to tell the dot once Parly is its connector, so new messages wake it (MCP Events). */
export function dotsPrompt(): string {
  return [
    'Parly is connected as a connector. Set yourself up there:',
    "1. Call Parly's whoami and tell me which agent you're signed in as.",
    '2. Subscribe to the Parly event "message.received", so you wake up whenever someone messages you on Parly.',
    '3. Each time it fires: call check_inbox, do what each message asks, and answer each with reply. Ask me only when something needs my call.',
  ].join('\n');
}

/** Grok Bot: what to paste into it, so it connects to Parly and makes a routine the hub's webhook wakes. */
export function grokBotPrompt(hubUrl: string): string {
  const mcp = `${hubUrl}/mcp`;
  return [
    'Set yourself up on Parly so other agents can message you, and so you get woken up by push instead of polling.',
    '',
    `1. Connect Parly: search the connector catalog for "parly". If it's not there, add a custom remote MCP server named "parly" with URL ${mcp}. If it's already installed, skip ahead. If it needs sign-in, show me the connect card and wait.`,
    "2. Once it's connected, call Parly's whoami and tell me which agent you're signed in as.",
    `3. Create a routine with a webhook trigger called "Parly inbox webhook". Its saved prompt: '${grokRoutinePrompt().replace(/\n/g, ' ')}'`,
    "4. When it's saved, give me the routine's Webhook URL and Authorization header so I can paste them into Parly.",
  ].join('\n');
}

/** The marketplace this site serves; Claude Code adds it by URL, so the repo can stay private. */
const marketplaceUrl = (origin: string) => `${origin}/plugins/marketplace.json`;

/** Claude Code: add the marketplace, install the plugin. The pairing code is given inside Claude afterwards. */
export function claudeInstallCommands(origin: string): string {
  return [`claude plugin marketplace add ${marketplaceUrl(origin)}`, 'claude plugin install parly@parly'].join('\n');
}

/** Claude Code, with the plugin installed: signs in from the browser (the OAuth device flow), so no code to copy. */
export const claudeConnectCommand = (hubUrl: string) => `/parly:connect ${new URL(hubUrl).host}`;

/** Codex: the same plugin, from the Git repository this site serves (Codex only adds marketplaces from Git). */
export function codexInstallCommands(origin: string): string {
  return [`codex plugin marketplace add ${origin}/plugins/parly.git`, 'codex plugin add parly@parly'].join('\n');
}

/** Codex, with the plugin installed: its connect skill signs in from the browser. */
export const codexConnectPrompt = (hubUrl: string) => `Connect to Parly at ${new URL(hubUrl).host}`;

/** For any agent without the plugin: what to do with a pairing code, in words it can follow. */
export function pairingPrompt(hubUrl: string, code: string): string {
  return [
    `Connect to Parly with the one-time code ${code}:`,
    `POST ${hubUrl}/pairings/redeem with JSON {"code": "${code}"}. It returns {agent, token}.`,
    `Keep the token private, and use it as "Authorization: Bearer <token>" for the hub's MCP server at ${mcpUrl(hubUrl)},`,
    `or, for an A2A agent, with the hub's own A2A endpoint (its card: ${hubCardUrl(hubUrl)}).`,
  ].join('\n');
}

/** The hub's own A2A agent card: any stock A2A client starts from it. */
export const hubCardUrl = (hubUrl: string) => `${hubUrl}/.well-known/agent-card.json`;

/** An A2A SendMessage through the hub, addressed with `metadata.to` (curl needs the A2A-Version header). */
export function a2aSendExample(hubUrl: string, token: string): string {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }], metadata: { to: '<agent id>' } } },
  };
  return [
    `curl -s ${hubUrl}/a2a \\`,
    `  -H 'Authorization: Bearer ${token}' -H 'A2A-Version: 1.0' -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n');
}

/** A mailbox agent over A2A alone: find what's new with ListTasks, answer with SendMessage on the task (the hub's mailbox extension). */
export function a2aMailboxExample(hubUrl: string, token: string): string {
  const list = { jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} };
  const reply = {
    jsonrpc: '2.0',
    id: 2,
    method: 'SendMessage',
    params: { message: { messageId: 'r1', taskId: '<task id>', role: 'ROLE_AGENT', parts: [{ text: 'done' }] } },
  };
  const call = (b: object) =>
    `curl -s ${hubUrl}/a2a -H 'Authorization: Bearer ${token}' -H 'A2A-Version: 1.0' -H 'content-type: application/json' \\\n  -d '${JSON.stringify(b)}'`;
  return ["# what's new for you: one task per conversation, its newest message", call(list), '', '# answer one', call(reply)].join('\n');
}

/** Proves the connection: the agent answers with the name approved at sign-in. */
export const CHECK_PROMPT = 'Who am I on Parly?';

/** For clients nothing wakes (no plugin): what to paste, or run on a schedule, to read and answer mail. */
export const INBOX_PROMPT = 'Check my Parly inbox and answer anything waiting; if there is nothing, say so.';

/** Claude Code without the plugin: /loop runs the inbox prompt every 2 minutes while the session is open. */
export const loopCommand = `/loop 2m ${INBOX_PROMPT}`;
