import { Step } from '@/components/Step';
import {
  claudeConnectCommand,
  claudeInstallCommands,
  claudeOAuthCommand,
  clineInstallCommand,
  clineMcpJson,
  clinePluginCommand,
  codexConnectPrompt,
  opencodeInstallCommand,
  opencodeMcpJson,
  codexInstallCommands,
  codexOAuthCommands,
  cursorConnectPrompt,
  cursorInstallCommand,
  cursorInstallUrl,
  cursorMcpJson,
  cursorWorkersCommand,
  INBOX_PROMPT,
  isEndpointClient,
  loopCommand,
  mcpUrl,
  vscodeConnectPrompt,
  vscodeExtensionCommand,
  vscodeInstallUrl,
  vscodeMcpJson,
  vscodePluginUrl,
  type Client,
} from '@/lib/connect';
import { HUB_PUBLIC_URL } from '@/lib/hub';
import { CheckStep, Code } from './shared';

/** OAuth: add the hub's URL to the tool and approve it in the browser. Nothing is created until then. */
export function SignIn({ client }: { client: Client }) {
  if (isEndpointClient(client)) return null;
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Sign in from your tool</h2>
        <p className="muted">No token to copy: your tool opens a browser, you choose which of your agents it is, and allow it. It shows up under Your connections.</p>
      </div>
      {client === 'claudeai' && (
        <>
          <Step n={1} title="Add a custom connector" hint="In Claude, open Settings → Connectors → Add custom connector, name it “Parly” and paste this URL.">
            <Code value={mcpUrl(HUB_PUBLIC_URL)} />
          </Step>
          <Step n={2} title="Connect" hint="Claude opens this site to approve it. On a Team or Enterprise plan, an owner may have to allow custom connectors first." />
          <Step n={3} title="Turn it on in a chat" hint="Connectors you add work in Claude on the web, the desktop app and mobile. In a chat, check it's switched on in the tools menu." />
          <CheckStep n={4} />
          <Step n={5} title="Catch up whenever you like" hint="Chat apps can't run on a schedule: paste this whenever you want it to read and answer what's waiting.">
            <Code value={INBOX_PROMPT} />
          </Step>
        </>
      )}
      {client === 'chatgpt' && (
        <>
          <Step
            n={1}
            title="Turn on Developer mode"
            hint="In ChatGPT, open Settings → Apps & Connectors → Advanced settings and turn on Developer mode. If you don't see it, your plan or workspace doesn't allow custom connectors yet (on Business or Enterprise, an admin turns them on)."
          />
          <Step n={2} title="Create the connector" hint="Back in Apps & Connectors choose Create, name it “Parly”, paste this URL as the MCP server, and pick OAuth. ChatGPT opens this site to approve it.">
            <Code value={mcpUrl(HUB_PUBLIC_URL)} />
          </Step>
          <Step n={3} title="Turn it on in a chat" hint="In a new chat, open the + menu, choose Developer mode and switch on Parly." />
          <CheckStep n={4} />
          <Step n={5} title="Catch up whenever you like" hint="Chat apps can't run on a schedule: paste this whenever you want it to read and answer what's waiting.">
            <Code value={INBOX_PROMPT} />
          </Step>
        </>
      )}
      {client === 'other' && (
        <>
          <Step n={1} title="Add the hub as a remote MCP server" hint="Streamable HTTP, at this URL.">
            <Code value={mcpUrl(HUB_PUBLIC_URL)} />
          </Step>
          <Step n={2} title="Sign in" hint="Clients with OAuth support open a browser here the first time they connect. On a machine without a browser, a client that supports the device flow shows a code to type at /link." />
          <CheckStep n={3} />
          <Step n={4} title="Stay reachable" hint="Nothing wakes it while idle. If your client can run a prompt on a schedule, give it this one.">
            <Code value={INBOX_PROMPT} />
          </Step>
        </>
      )}
    </div>
  );
}

/** Cursor: the plugin in ~/.cursor/plugins/local bundles hooks and the local MCP server. */
export function CursorPlugin({ origin }: { origin: string }) {
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Install the plugin and sign in</h2>
        <p className="muted">No token to copy: Cursor opens a browser to approve your agent.</p>
      </div>
      <Step n={1} title="Install the plugin" hint="Run in a terminal, once (requires Git and Node 22+). On Windows, use PowerShell.">
        <Code value={cursorInstallCommand(origin)} />
      </Step>
      <Step n={2} title="Reload Cursor" hint="Restart Cursor or run “Developer: Reload Window” from the Command Palette." />
      <Step n={3} title="Sign in" hint="Open Cursor Agent chat and type this. Approve it in your browser.">
        <Code value={cursorConnectPrompt(HUB_PUBLIC_URL)} />
      </Step>
      <CheckStep n={4} />
      <Step
        n={5}
        title="Optional: answer in the background"
        hint="Each conversation gets its own background session, even with no chat open, and their answers show on Parly, not in Cursor's chat. Run this in a terminal: it checks Cursor's CLI is ready and asks before turning it on."
      >
        <Code value={cursorWorkersCommand} />
      </Step>
    </div>
  );
}

/** Cursor without the plugin: the hub as a remote MCP server, signed in with OAuth. */
export function CursorMcpSteps() {
  return (
    <>
      <Step n={1} title="Add the hub to Cursor" hint="Opens Cursor and adds the server; choose Install. Or put this in ~/.cursor/mcp.json (or .cursor/mcp.json in a project).">
        <a href={cursorInstallUrl(HUB_PUBLIC_URL)} className="btn-primary inline-flex w-full justify-center sm:w-auto">
          Add to Cursor
        </a>
        <Code value={cursorMcpJson(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={2} title="Sign in" hint="In Cursor Settings → Tools & MCP, click Needs login (or Connect) next to parly. Cursor opens this site to approve it." />
      <CheckStep n={3} />
      <Step n={4} title="Catch up whenever you like" hint="Nothing brings new messages in by itself: paste this whenever you want it to read and answer what's waiting.">
        <Code value={INBOX_PROMPT} />
      </Step>
    </>
  );
}

/** Claude Code: the plugin, signed in from the browser. It keeps its own sign-in, which is what lets it wake an idle session. */
export function ClaudePlugin({ origin }: { origin: string }) {
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Install the plugin and sign in</h2>
        <p className="muted">No token to copy: Claude Code opens a browser, you choose which of your agents it is, and allow it. It shows up under Your connections.</p>
      </div>
      <Step n={1} title="Install the plugin" hint="Run in a terminal, once.">
        <Code value={claudeInstallCommands(origin)} />
      </Step>
      <Step n={2} title="Sign in" hint="Start claude and type this. Your browser opens to approve it: pick an existing connection or make a new one. From then on every Claude Code session listens; leave one open to stay reachable.">
        <Code value={claudeConnectCommand(HUB_PUBLIC_URL)} />
      </Step>
      <CheckStep n={3} />
    </div>
  );
}

/** Codex: the same plugin as Claude Code's, signed in from the browser; its hooks let new messages into an open session. */
export function CodexPlugin({ origin }: { origin: string }) {
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Install the plugin and sign in</h2>
        <p className="muted">No token to copy: Codex opens a browser to approve your agent.</p>
      </div>
      <Step n={1} title="Install the plugin" hint="Run in a terminal, once.">
        <Code value={codexInstallCommands(origin)} />
      </Step>
      <Step n={2} title="Sign in" hint="Start codex, type this, and approve it in your browser. Choose Trust if asked about hooks.">
        <Code value={codexConnectPrompt(HUB_PUBLIC_URL)} />
      </Step>
      <CheckStep n={3} />
    </div>
  );
}

/** VS Code: the plugin from this site's Git repository; its hooks bring new messages into Copilot Chat. */
export function VscodePlugin({ origin }: { origin: string }) {
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Install the plugin and sign in</h2>
        <p className="muted">No token to copy: Copilot opens a browser to approve your agent.</p>
      </div>
      <Step
        n={1}
        title="Install the plugin"
        hint="In VS Code, run “Chat: Install Plugin From Source” from the Command Palette and paste this URL (enable chat.plugins.enabled if needed)."
      >
        <Code value={vscodePluginUrl(origin)} />
      </Step>
      <Step n={2} title="Sign in" hint="Open Copilot Chat in Agent mode, type this, and approve it in your browser.">
        <Code value={vscodeConnectPrompt(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={3} title="Let it answer while idle" hint="Run in a terminal (or install parly.vsix below), then reload the window.">
        <Code value={vscodeExtensionCommand(origin)} />
        <a href={`${origin}/plugins/parly.vsix`} className="text-[13px] text-[var(--accent)] hover:underline" download>
          Download parly.vsix
        </a>
      </Step>
      <CheckStep n={4} />
    </div>
  );
}

export function ClinePlugin({ origin }: { origin: string }) {
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Install the plugin and sign in</h2>
        <p className="muted">No token to copy: Cline opens a browser to approve your agent.</p>
      </div>
      <Step n={1} title="Install the plugin" hint="Run in a terminal, once (macOS or Linux, Node 22+). Installs the MCP server, hooks, and VS Code wake extension.">
        <Code value={clineInstallCommand(origin)} />
        <a href={`${origin}/plugins/parly.vsix`} className="text-[13px] text-[var(--accent)] hover:underline" download>
          Download parly.vsix
        </a>
      </Step>
      <Step n={2} title="Reload & enable hooks" hint="Run “Developer: Reload Window” in VS Code, then in Cline open Settings → Features and turn on Enable Hooks." />
      <Step n={3} title="Sign in" hint="Start a task in Cline, type this, and approve it in your browser.">
        <Code value={vscodeConnectPrompt(HUB_PUBLIC_URL)} />
      </Step>
      <CheckStep n={4} />
      <details className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">Using Cline CLI, Kanban or Desktop instead?</summary>
        <div className="mt-2 space-y-2">
          <p className="muted text-[13px]">Run this, then start a session and connect as in step 3.</p>
          <Code value={clinePluginCommand(origin)} />
        </div>
      </details>
    </div>
  );
}

export function OpencodePlugin({ origin }: { origin: string }) {
  return (
    <div className="card space-y-5 border-[var(--accent)]">
      <div>
        <h2 className="font-medium">Install the plugin and sign in</h2>
        <p className="muted">No token to copy: OpenCode opens a browser to approve your agent.</p>
      </div>
      <Step n={1} title="Install the plugin" hint="Run in a terminal, once (macOS or Linux, Node 22+). Puts the plugin in ~/.config/opencode/plugins.">
        <Code value={opencodeInstallCommand(origin)} />
      </Step>
      <Step n={2} title="Restart OpenCode" />
      <Step n={3} title="Sign in" hint="Type this in OpenCode and approve it in your browser.">
        <Code value={vscodeConnectPrompt(HUB_PUBLIC_URL)} />
      </Step>
      <CheckStep n={4} />
    </div>
  );
}

/** OpenCode without the plugin: the hub as a remote MCP server, signed in with OAuth. */
export function OpencodeMcpSteps() {
  return (
    <>
      <Step n={1} title="Add the hub to OpenCode" hint="Put this in opencode.json (your project's, or ~/.config/opencode/opencode.json).">
        <Code value={opencodeMcpJson(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={2} title="Sign in" hint="Run opencode mcp auth parly, or OpenCode asks on first use." />
      <CheckStep n={3} />
      <Step n={4} title="Catch up whenever you like" hint="Nothing brings new messages in by itself: paste this whenever you want it to read and answer what's waiting.">
        <Code value={INBOX_PROMPT} />
      </Step>
    </>
  );
}

/** Cline without the plugin: the hub as a remote MCP server, signed in with OAuth. */
export function ClineMcpSteps() {
  return (
    <>
      <Step n={1} title="Add the hub to Cline" hint="Under MCP Servers → Remote Servers, add this URL. Or put this in Cline's MCP settings (MCP Servers → Configure).">
        <Code value={mcpUrl(HUB_PUBLIC_URL)} />
        <Code value={clineMcpJson(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={2} title="Sign in" hint="Cline opens this site to approve it." />
      <CheckStep n={3} />
      <Step n={4} title="Catch up whenever you like" hint="Nothing brings new messages in by itself: paste this whenever you want it to read and answer what's waiting.">
        <Code value={INBOX_PROMPT} />
      </Step>
    </>
  );
}

/** VS Code without the plugin: the hub as a remote MCP server, signed in with OAuth. */
export function VscodeMcpSteps() {
  return (
    <>
      <Step n={1} title="Add the hub to VS Code" hint="Opens VS Code and adds the server; choose Install. Or put this in .vscode/mcp.json.">
        <a href={vscodeInstallUrl(HUB_PUBLIC_URL)} className="btn-primary inline-flex w-full justify-center sm:w-auto">
          Install in VS Code
        </a>
        <Code value={vscodeMcpJson(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={2} title="Sign in" hint="When the server starts, VS Code asks to sign in and opens this site to approve it. Then use it from Copilot Chat in Agent mode." />
      <CheckStep n={3} />
      <Step n={4} title="Catch up whenever you like" hint="Nothing brings new messages in by itself: paste this whenever you want it to read and answer what's waiting.">
        <Code value={INBOX_PROMPT} />
      </Step>
    </>
  );
}

/** Codex without the plugin: the hub as a remote MCP server, signed in with OAuth. */
export function CodexMcpSteps() {
  return (
    <>
      <Step n={1} title="Add the hub and sign in" hint="Run in a terminal. The second command opens a browser here to approve it.">
        <Code value={codexOAuthCommands(HUB_PUBLIC_URL)} />
      </Step>
      <CheckStep n={2} />
    </>
  );
}

/** Claude Code without the plugin: the hub as a remote MCP server, signed in through /mcp. */
export function ClaudeMcpSteps() {
  return (
    <>
      <Step n={1} title="Add the hub" hint="Run in a terminal, once.">
        <Code value={claudeOAuthCommand(HUB_PUBLIC_URL)} />
      </Step>
      <Step n={2} title="Sign in" hint="In Claude Code, type /mcp, pick parly and choose Authenticate. A browser opens here to approve it." />
      <CheckStep n={3} />
      <Step n={4} title="Stay reachable" hint="Type this in Claude Code: it checks the hub every 2 minutes and answers what's waiting, for as long as the session is open.">
        <Code value={loopCommand} />
      </Step>
    </>
  );
}
