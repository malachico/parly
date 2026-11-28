/**
 * The coding-agent plugin's scripts (plugins/parly/bin) against a real hub over HTTP: the
 * connection code from the web's Connect page, the prompt hook that turns the event feed into
 * context, and the stdio bridge that stands in for the hub as an MCP server.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testConfig, testDb, freePort } from './helpers.js';

const BIN = join(import.meta.dirname, '..', 'plugins', 'parly', 'bin');
const exec = promisify(execFile);

describe('coding-agent plugin scripts', () => {
  let hubUrl: string;
  let server: Server;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let ownerToken: string;
  let owned: { id: string; name: string; token: string };
  let danaToken: string;

  const rest = async <T = any>(token: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  /** Runs a plugin script; never throws (the hooks are supposed to exit 0 whatever happens). */
  const run = async (file: string, args: string[]) => {
    try {
      const { stdout, stderr } = await exec('node', [join(BIN, file), ...args], { env });
      return { code: 0, out: stdout, err: stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
    }
  };
  const context = (out: string) => (out ? (JSON.parse(out).hookSpecificOutput as { hookEventName: string; additionalContext: string }) : undefined);
  const code = (c: { hubUrl: string; token: string; agentId: string; name: string }) => `a2ac_${Buffer.from(JSON.stringify(c)).toString('base64url')}`;

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    // "<email>|<sub>" stands in for a verified Google credential: owned bots need a Google-signed-in owner.
    const verifyGoogle = async (idToken: string) => {
      const [email = '', sub = ''] = idToken.split('|');
      return { email, sub, name: 'Michal' };
    };
    const { app } = createApp({ db: testDb(), config: testConfig({ port, publicUrl: hubUrl, webUrl: 'http://web.test' }), verifyGoogle });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    dir = mkdtempSync(join(tmpdir(), 'a2a-plugin-'));
    env = { ...process.env, A2A_HUB_CONFIG_DIR: dir, A2A_HUB_NO_BROWSER: '1', CODEX_HOME: join(dir, 'codex') };
    ownerToken = (await rest(undefined, 'POST', '/auth/google', { idToken: 'michal@example.com|g-michal' })).body.token;
    const created = await rest(ownerToken, 'POST', '/agents/bots', { name: "Michal's Claude Code", follow: true });
    owned = { id: created.body.agent.id, name: created.body.agent.name, token: created.body.token };
    // Only an agent's owner and the owner's other agents message it in private, so Dana is Michal's too.
    danaToken = (await rest(ownerToken, 'POST', '/agents/bots', { name: 'Dana' })).body.token;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('connects with a code, shows what waits, then only what is new', async () => {
    // Not connected: a session start says so; a prompt stays quiet.
    expect(context((await run('hub-events.mjs', ['--client', 'claude-code', '--event', 'session-start'])).out)?.additionalContext).toMatch(/not connected/);
    expect((await run('hub-events.mjs', ['--client', 'claude-code', '--event', 'prompt'])).out).toBe('');

    const bad = await run('hub-connect.mjs', ['--client', 'claude-code', code({ hubUrl, token: 'a2ah_nope', agentId: 'x', name: 'x' })]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/did not accept/);

    // Mail already waiting before the first run is counted, not listed.
    await rest(ownerToken, 'POST', `/conversations/agent:${owned.id}/messages`, { text: 'remember the milk' });
    const ok = await run('hub-connect.mjs', ['--client', 'claude-code', code({ hubUrl, token: owned.token, agentId: owned.id, name: owned.name })]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain(`Connected as "${owned.name}"`);
    expect(JSON.parse(readFileSync(join(dir, 'claude-code.json'), 'utf8'))).toMatchObject({ hubUrl, token: owned.token, agentId: owned.id });

    const first = context((await run('hub-events.mjs', ['--client', 'claude-code', '--event', 'session-start'])).out);
    expect(first).toMatchObject({ hookEventName: 'SessionStart' });
    expect(first!.additionalContext).toMatch(/new messages in 1 conversation/);
    expect((await run('hub-events.mjs', ['--client', 'claude-code', '--event', 'prompt'])).out).toBe('');

    // A new message from another agent, and a reply to something the owned agent sent.
    // Agents are private by default: only those sharing a workspace reach each other. Michal puts their bot and Dana in one.
    const ws = (await rest(ownerToken, 'GET', '/me')).body.workspaces[0].id as string;
    const danaId = (await rest(danaToken, 'GET', '/me')).body.id as string;
    for (const agentId of [owned.id, danaId]) expect((await rest(ownerToken, 'POST', `/workspaces/${ws}/members`, { agentId })).status).toBe(200);
    const sentByDana = await rest(danaToken, 'POST', `/conversations/agent:${owned.id}/messages`, { text: 'Can you add the dark logo?' });
    expect(sentByDana.status).toBe(201);
    const asked = await rest(owned.token, 'POST', `/conversations/agent:${danaId}/messages`, { text: 'status?' });
    const answer = await rest(danaToken, 'POST', `/messages/${asked.body.id}/reply`, { text: 'all green' });

    const next = context((await run('hub-events.mjs', ['--client', 'claude-code', '--event', 'prompt'])).out);
    expect(next).toMatchObject({ hookEventName: 'UserPromptSubmit' });
    expect(next!.additionalContext).toContain(`[messageId ${sentByDana.body.id}] from Dana: "Can you add the dark logo?"`);
    expect(next!.additionalContext).toContain(`[messageId ${answer.body.id}] from Dana: "all green"`);
    expect(next!.additionalContext).toMatch(/check_inbox; it says when to reply/);
    // The cursor moved: nothing is repeated, and nothing was marked read (the hook only shows).
    expect((await run('hub-events.mjs', ['--client', 'claude-code', '--event', 'prompt'])).out).toBe('');
    expect((await rest(owned.token, 'GET', '/me')).body.pending).toBe(2);
  });

  it('turns background sessions on only once asked and signed in, and signing in again keeps them', async () => {
    expect((await run('hub-connect.mjs', ['--client', 'bg', '--workers', '--yes'])).err).toMatch(/Sign in to Parly first/);
    const connect = () => run('hub-connect.mjs', ['--client', 'bg', code({ hubUrl, token: owned.token, agentId: owned.id, name: owned.name })]);
    expect((await connect()).code).toBe(0);
    const unasked = await run('hub-connect.mjs', ['--client', 'bg', '--workers']);
    expect(unasked.code).toBe(1); // no terminal to ask in
    expect(JSON.parse(readFileSync(join(dir, 'bg.json'), 'utf8')).workers).toBeUndefined();
    expect((await run('hub-connect.mjs', ['--client', 'bg', '--workers', '--yes'])).code).toBe(0);
    await connect();
    expect(JSON.parse(readFileSync(join(dir, 'bg.json'), 'utf8')).workers).toEqual({ max: 2, permissionMode: 'bypassPermissions' });
  });

  it("Cursor's workspaceOpen leaves the news for the chat when background sessions are off", async () => {
    await run('hub-connect.mjs', ['--client', 'cursor', code({ hubUrl, token: owned.token, agentId: owned.id, name: owned.name })]);
    const before = readFileSync(join(dir, 'cursor.state.json'), 'utf8');
    await rest(danaToken, 'POST', `/conversations/agent:${owned.id}/messages`, { text: 'for the chat' });
    expect((await run('hub-events.mjs', ['--client', 'cursor', '--event', 'workspace-open'])).out).toBe('');
    expect(readFileSync(join(dir, 'cursor.state.json'), 'utf8')).toBe(before);
    for (const f of ['cursor.json', 'cursor.state.json']) rmSync(join(dir, f), { force: true }); // later tests start signed out
  });

  it('says so when its config is damaged, rather than looking signed out', async () => {
    writeFileSync(join(dir, 'broken.json'), '"workers": {"max": 2}');
    const said = context((await run('hub-events.mjs', ['--client', 'broken', '--event', 'session-start'])).out);
    expect(said!.additionalContext).toMatch(/isn't a usable sign-in/);
    expect((await run('hub-connect.mjs', ['--client', 'broken', '--workers', '--yes'])).err).toMatch(/isn't a usable sign-in/);
  });

  it('connects with a one-time pairing code, which then stops working', async () => {
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: "Michal's Codex" });
    const pairing = `${body.code}@${hubUrl.replace('http://', '')}`;
    const ok = await run('hub-connect.mjs', ['--client', 'codex', pairing]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain(`Connected as "Michal's Codex"`);
    const saved = JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8'));
    expect((await rest(saved.token, 'GET', '/me')).body).toMatchObject({ name: "Michal's Codex", ownerId: expect.any(String) });
    const again = await run('hub-connect.mjs', ['--client', 'codex', pairing]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/used or expired/);
  });

  it('signs in with the browser as an existing connection, and refreshes the token when it runs out', async () => {
    const started = await run('hub-connect.mjs', ['--client', 'signin', hubUrl]);
    expect(started.code, started.err).toBe(0);
    const userCode = /code (\S+)\./.exec(started.out)![1]!;
    expect(started.out).toContain(`/link?code=${userCode}`);

    // What the /link page does once the person picks their existing connection.
    const request = await rest(ownerToken, 'GET', `/oauth/requests?user_code=${userCode}`);
    expect(request.body.client.name).toBe('signin');
    expect((await rest(ownerToken, 'POST', '/oauth/consent', { request: request.body.id, approve: true, bot: owned.id })).status).toBe(200);

    const finished = await run('hub-connect.mjs', ['--client', 'signin', '--finish']);
    expect(finished.code, finished.err).toBe(0);
    expect(finished.out).toContain(`Connected as "${owned.name}"`);
    const path = join(dir, 'signin.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved).toMatchObject({ hubUrl, agentId: owned.id, token: expect.stringMatching(/^a2aa_/), refreshToken: expect.stringMatching(/^a2ar_/) });
    expect((await run('hub-connect.mjs', ['--client', 'signin', '--finish'])).err).toMatch(/No sign-in is in progress/);

    // The access token is about to run out: the next hook refreshes it first.
    writeFileSync(path, JSON.stringify({ ...saved, expiresAt: Date.now() }));
    const first = await run('hub-events.mjs', ['--client', 'signin', '--event', 'session-start']);
    expect(first.code).toBe(0);
    const refreshed = JSON.parse(readFileSync(path, 'utf8'));
    expect(refreshed.token).not.toBe(saved.token);
    expect(refreshed.refreshToken).not.toBe(saved.refreshToken);
    expect((await rest(refreshed.token, 'GET', '/me')).body.id).toBe(owned.id);
  }, 30_000);

  it('bridges stdio MCP to the hub with the stored token, and the pending note comes through', async () => {
    const lines = await new Promise<string[]>((resolve) => {
      const p = spawn('node', [join(BIN, 'hub-mcp.mjs'), '--client', 'claude-code'], { env });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => resolve(out.trim().split('\n').filter(Boolean)));
      const msgs = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      ];
      p.stdin.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
      setTimeout(() => p.stdin.end(), 3000);
    });
    const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    expect(byId[1].result.instructions).toMatch(/This is Parly/);
    expect(byId[2].result.tools.map((t: { name: string }) => t.name)).toContain('check_inbox');
    const blocks = byId[3].result.content as { text: string }[];
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ id: owned.id, owner: { name: 'Michal' } });
    expect(blocks[1]!.text).toMatch(/new messages in 2 Parly conversations/);
  });

  it('offers a connect tool until connected, then the hub\'s tools', async () => {
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: 'Tool-connected' });
    const lines = await new Promise<string[]>((resolve) => {
      const p = spawn('node', [join(BIN, 'hub-mcp.mjs'), '--client', 'toolconnect'], { env });
      let out = '';
      const send = (m: object) => p.stdin.write(JSON.stringify(m) + '\n');
      // Ask again once connect has answered, and stop once that is answered: fixed sleeps lost the race on slow runners.
      let asked = false;
      p.stdout.on('data', (d) => {
        out += d;
        if (!asked && /"id":2\b/.test(out)) (asked = true), send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
        if (/"id":3\b/.test(out)) p.stdin.end();
      });
      p.on('close', () => resolve(out.trim().split('\n').filter(Boolean)));
      send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connect', arguments: { address: `${body.code}@${hubUrl.replace('http://', '')}` } } });
    });
    const msgs = lines.map((l) => JSON.parse(l));
    const byId = Object.fromEntries(msgs.filter((m) => m.id).map((m) => [m.id, m]));
    expect(byId[1].result.tools.map((t: { name: string }) => t.name)).toEqual(['connect']);
    expect(byId[2].result.isError).toBe(false);
    expect(byId[2].result.content[0].text).toContain('Connected as "Tool-connected"');
    expect(msgs.some((m) => m.method === 'notifications/tools/list_changed')).toBe(true);
    expect(byId[3].result.tools.map((t: { name: string }) => t.name)).toContain('check_inbox');
  }, 20_000);

  it("keeps Claude Code's status: what the person typed, then what woke it, cleared when its turn ends", async () => {
    // Connected as the owned bot by the first test (claude-code.json).
    const status = async () => (await rest(owned.token, 'GET', `/agents/${owned.id}/day`)).body.status as { text: string; conversationId: string } | undefined;
    const prompt = async (input: object) =>
      new Promise<void>((resolve) => {
        const p = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'claude-code', '--event', 'prompt'], { env });
        p.on('close', () => resolve());
        p.stdin.end(JSON.stringify(input));
      });

    // A typed prompt: "Working on" it, said in its DM with its owner (only they see it).
    await prompt({ prompt: 'Fix the login bug\nand add a test' });
    expect(await status()).toMatchObject({ text: 'Working on: Fix the login bug and add a test' });
    expect((await status())!.conversationId).toMatch(/^dm:/);
    // Our own wake-up notices aren't a task.
    await prompt({ prompt: 'Parly: 1 new message for you' });
    expect((await status())!.text).toBe('Working on: Fix the login bug and add a test');

    // The turn ends (the Stop hook starts the listener): the status is cleared.
    const l = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'claude-code', '--event', 'listen'], { env });
    await expect.poll(status).toBeUndefined();

    // A message wakes it: answering it is the status, where the message is.
    const danaId = (await rest(danaToken, 'GET', '/me')).body.id as string;
    const sent = await rest(danaToken, 'POST', `/conversations/agent:${owned.id}/messages`, { text: 'Please review my pull request when you can' });
    expect(sent.status).toBe(201);
    await new Promise<void>((r) => l.on('close', () => r()));
    expect(await status()).toMatchObject({ text: 'Answering Dana: Please review my pull request when you can' });
    expect((await status())!.conversationId).toContain(danaId);
  }, 30_000);

  it('listens in the background and exits 2 with the news, which wakes the session', async () => {
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: 'Listener' });
    expect((await run('hub-connect.mjs', ['--client', 'listener', `${body.code}@${hubUrl.replace('http://', '')}`])).code).toBe(0);
    const me = JSON.parse(readFileSync(join(dir, 'listener.json'), 'utf8'));
    const p = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'listener', '--event', 'listen'], { env });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const exited = new Promise<number | null>((r) => p.on('close', r));
    await new Promise((r) => setTimeout(r, 1500)); // the listener is waiting on the feed
    const sent = await rest(ownerToken, 'POST', `/conversations/agent:${me.agentId}/messages`, { text: 'wake up' });
    expect(sent.status).toBe(201);
    expect(await exited).toBe(2);
    expect(err).toContain(`[messageId ${sent.body.id}] from Michal: "wake up"`);
  }, 20_000);

  it('keeps the news with one open session; another takes over only once it exits', async () => {
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: 'Sticky' });
    expect((await run('hub-connect.mjs', ['--client', 'sticky', `${body.code}@${hubUrl.replace('http://', '')}`])).code).toBe(0);
    const session = spawn('sleep', ['60']); // stands in for the owning session's process
    const owner = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'sticky', '--event', 'listen', '--watch', String(session.pid)], { env });
    const ownerExited = new Promise<number | null>((r) => owner.on('close', r));
    await new Promise((r) => setTimeout(r, 1000));
    const other = await run('hub-events.mjs', ['--client', 'sticky', '--event', 'listen']);
    expect(other.code).toBe(0); // backed off at once
    expect(JSON.parse(readFileSync(join(dir, 'sticky.listen.json'), 'utf8')).owner).toBe(session.pid);
    session.kill();
    expect(await ownerExited).toBe(0);
    const next = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'sticky', '--event', 'listen'], { env });
    await new Promise((r) => setTimeout(r, 1000));
    expect(JSON.parse(readFileSync(join(dir, 'sticky.listen.json'), 'utf8')).owner).toBe(process.pid);
    next.kill();
  }, 60_000);

  it("VS Code's stop hook keeps the agent going once with what's new, and stays quiet otherwise", async () => {
    /** The stop hook with VS Code's input on stdin; the block it asks for, if any. */
    const stop = (active = false) =>
      new Promise<{ decision: string; reason: string; top: { decision: string; reason: string } } | undefined>((resolve) => {
        const p = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'vscode', '--event', 'stop'], { env });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => resolve(out ? { ...JSON.parse(out).hookSpecificOutput, top: JSON.parse(out) } : undefined));
        p.stdin.end(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: active }));
      });
    expect(await stop()).toBeUndefined(); // not connected: nothing to say at a stop
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: 'Copilot' });
    expect((await run('hub-connect.mjs', ['--client', 'vscode', `${body.code}@${hubUrl.replace('http://', '')}`])).code).toBe(0);
    const me = JSON.parse(readFileSync(join(dir, 'vscode.json'), 'utf8'));
    await stop(); // the first run starts the feed from now
    const sent = await rest(ownerToken, 'POST', `/conversations/agent:${me.agentId}/messages`, { text: 'review the PR' });
    expect(await stop(true)).toBeUndefined(); // already kept going once: stop now, the news waits
    const blocked = await stop();
    expect(blocked).toMatchObject({ hookEventName: 'Stop', decision: 'block' });
    expect(blocked!.top).toMatchObject({ decision: 'block', reason: blocked!.reason }); // Copilot CLI reads the top level
    expect(blocked!.reason).toContain(`[messageId ${sent.body.id}] from Michal: "review the PR"`);
    expect(await stop()).toBeUndefined(); // shown once
  });

  it("Cline's hooks always answer in its format, with what's new as contextModification", async () => {
    const hook = async (event: string) => JSON.parse((await run('hub-events.mjs', ['--client', 'cline', '--event', event])).out);
    expect(await hook('prompt')).toEqual({ cancel: false }); // not connected: an answer all the same
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: 'Cline' });
    expect((await run('hub-connect.mjs', ['--client', 'cline', `${body.code}@${hubUrl.replace('http://', '')}`])).code).toBe(0);
    const me = JSON.parse(readFileSync(join(dir, 'cline.json'), 'utf8'));
    await hook('session-start'); // the first run starts the feed from now
    const sent = await rest(ownerToken, 'POST', `/conversations/agent:${me.agentId}/messages`, { text: 'ship it' });
    const out = await hook('prompt');
    expect(out.cancel).toBe(false);
    expect(out.contextModification).toContain(`[messageId ${sent.body.id}] from Michal: "ship it"`);
    expect(JSON.parse(readFileSync(join(dir, 'cline.state.json'), 'utf8')).busy).toBe(true); // a task at work: the extension waits
    expect(await hook('done')).toEqual({ cancel: false });
    expect(JSON.parse(readFileSync(join(dir, 'cline.state.json'), 'utf8')).busy).toBe(false);
    expect(readFileSync(join(BIN, '..', 'cline', 'install.sh'), 'utf8')).toContain('--client cline --event');
  });

  it("Cline's plugin keeps shell commands from waiting on a keyboard, and its manifest points at its entry", async () => {
    const root = join(BIN, '..', 'cline-plugin');
    const { guardCommands } = await import(join(root, 'shell.js'));
    const prefix = 'export GIT_PAGER=cat PAGER=cat GIT_EDITOR=true GIT_TERMINAL_PROMPT=0; ';
    expect(guardCommands({ commands: ['git status -s && git diff --stat'] }, 'linux')).toEqual({ input: { commands: [`${prefix}git status -s && git diff --stat`] } });
    expect(guardCommands({ commands: [`${prefix}ls`] }, 'linux')).toEqual({ input: { commands: [`${prefix}ls`] } }); // once
    expect(guardCommands({ commands: [{ command: 'git', args: ['diff'] }] }, 'linux')).toEqual({ input: { commands: [{ command: 'git', args: ['--no-pager', 'diff'] }] } });
    for (const cmd of ['git log | less', 'vim notes.md', 'tail -f app.log', 'FOO=1 sudo top']) expect(guardCommands({ commands: [cmd] }, 'linux')).toMatchObject({ skip: true });
    expect(guardCommands({ commands: ['top -b -n 1', 'tail -n 5 app.log'] }, 'linux')).not.toHaveProperty('skip');
    expect(guardCommands({ commands: ['git status'] }, 'win32')).toEqual({ input: { commands: ['git status'] } });
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const p of pkg.cline.plugins[0].paths) expect(existsSync(join(root, p))).toBe(true);
    expect(readFileSync(join(root, 'index.js'), 'utf8')).toContain("const CLIENT = 'cline-cli'");
  });

  it("OpenCode's plugin adds the Parly MCP server, and its installer fetches the scripts it runs", async () => {
    const plugin = (await import(join(BIN, '..', 'opencode', 'parly.js'))).default;
    const servers = new Map<string, any>([['parly', { type: 'remote', url: 'https://hub.example/mcp' }]]);
    const hooks: string[] = [];
    const stop = await plugin.setup({ mcp: { transform: async (f: any) => f(servers) }, session: { hook: async (name: string) => void hooks.push(name), prompt: async () => {} } });
    expect(plugin.id).toBe('parly');
    expect(servers.get('parly')).toMatchObject({ type: 'local' }); // replaces a hand-added remote entry
    expect(servers.get('parly').command.slice(-3)).toEqual([join(BIN, 'hub-mcp.mjs'), '--client', 'opencode']);
    expect(hooks).toEqual(['prompt', 'experimental.idle']); // news on each prompt; an idle session woken by new mail
    stop();
    const install = readFileSync(join(BIN, '..', 'opencode', 'install.sh'), 'utf8');
    for (const f of ['common.mjs', 'hub-connect.mjs', 'hub-events.mjs', 'hub-mcp.mjs', 'workers.mjs']) {
      expect(existsSync(join(BIN, f))).toBe(true);
      expect(install).toContain(f);
    }
    expect(install).toContain('location_idle_timeout = false'); // else OpenCode unloads the plugin, and its listener, after an hour idle
  });

  it("Cursor's hooks answer in its format: additional_context, and followup_message at a completed stop", async () => {
    /** A hook with Cursor's input on stdin; its JSON answer. */
    const hook = (event: string, input = {}) =>
      new Promise<Record<string, string>>((resolve) => {
        const p = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'cursor', '--event', event], { env });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => resolve(JSON.parse(out)));
        p.stdin.end(JSON.stringify(input));
      });
    expect((await hook('session-start')).additional_context).toContain('not connected yet');
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: 'Cursor' });
    expect((await run('hub-connect.mjs', ['--client', 'cursor', `${body.code}@${hubUrl.replace('http://', '')}`])).code).toBe(0);
    const me = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8'));
    await hook('session-start'); // the first run starts the feed from now
    const sent = await rest(ownerToken, 'POST', `/conversations/agent:${me.agentId}/messages`, { text: 'ship it' });
    expect(await hook('stop', { status: 'aborted', loop_count: 0 })).toEqual({}); // the person stopped it: no follow-up
    expect((await hook('stop', { status: 'completed', loop_count: 0 })).followup_message).toContain(`[messageId ${sent.body.id}] from Michal: "ship it"`);
    expect(await hook('prompt')).toEqual({}); // shown once
    expect(readFileSync(join(BIN, '..', 'cursor', 'hooks.json'), 'utf8')).toContain('--client cursor --event');
  });

  it("Antigravity: its hooks remember the conversation, and the sidecar wakes it there with new messages", async () => {
    /** A hook or the sidecar with Antigravity's input on stdin; its exit code and output. */
    const hook = (event: string, input: Record<string, unknown>, extraEnv: Record<string, string> = {}) => {
      const p = spawn('node', [join(BIN, 'hub-events.mjs'), '--client', 'antigravity', '--event', event], { env: { ...env, ...extraEnv } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stdin.end(JSON.stringify(input));
      return Object.assign(new Promise<{ code: number | null; out: string }>((resolve) => p.on('close', (code) => resolve({ code, out }))), { p });
    };
    const { body } = await rest(ownerToken, 'POST', '/pairings', { name: 'Antigravity' });
    expect((await run('hub-connect.mjs', ['--client', 'antigravity', `${body.code}@${hubUrl.replace('http://', '')}`])).code).toBe(0);
    const me = JSON.parse(readFileSync(join(dir, 'antigravity.json'), 'utf8'));
    expect(JSON.parse((await hook('session-start', { conversationId: 'conv-1' })).out || '{}')).toEqual({}); // starts the feed from now

    // The sidecar: news goes into the conversation the hooks saw, through Antigravity's agentapi (a stand-in here).
    const fakeBin = mkdtempSync(join(tmpdir(), 'agentapi-'));
    const calls = join(fakeBin, 'calls.txt');
    writeFileSync(join(fakeBin, 'agentapi'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${calls}\n`, { mode: 0o755 });
    const sidecar = hook('listen-sidecar', {}, { PATH: `${fakeBin}:${process.env.PATH}` });
    await new Promise((r) => setTimeout(r, 1500)); // it waits on the feed
    const sent = await rest(ownerToken, 'POST', `/conversations/agent:${me.agentId}/messages`, { text: 'take a look' });
    for (let i = 0; i < 50 && !existsSync(calls); i++) await new Promise((r) => setTimeout(r, 200));
    sidecar.p.kill();
    const args = readFileSync(calls, 'utf8').split('\n');
    expect(args.slice(0, 2)).toEqual(['send-message', 'conv-1']);
    expect(args.slice(2).join('\n')).toContain(`[messageId ${sent.body.id}] from Michal: "take a look"`);

    // The Stop hook: what's waiting continues the agent once; a cancelled turn just stops.
    await rest(ownerToken, 'POST', `/conversations/agent:${me.agentId}/messages`, { text: 'and this' });
    expect(await hook('stop', { conversationId: 'conv-2', terminationReason: 'EXECUTOR_TERMINATION_REASON_USER_CANCELED' })).toEqual({ code: 0, out: '{}\n' });
    const answer = JSON.parse((await hook('stop', { conversationId: 'conv-2', terminationReason: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL' })).out);
    expect(answer.decision).toBe('continue');
    expect(answer.reason).toContain('"and this"');
    expect(JSON.parse((await hook('stop', { conversationId: 'conv-2' })).out)).toEqual({}); // nothing new: it stops
    expect(JSON.parse(readFileSync(join(dir, 'antigravity.state.json'), 'utf8')).conversation).toBe('conv-2');

    const root = join(BIN, '..', 'antigravity');
    expect(JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).name).toBe('parly');
    const hooks = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8')).parly;
    expect(hooks.Stop[0].command).toBe('node bin/hub-events.mjs --client antigravity --event stop');
    expect(JSON.parse(readFileSync(join(root, 'sidecars', 'listener', 'sidecar.json'), 'utf8')).args).toContain('listen-sidecar');
  }, 30_000);

  it("VS Code's hooks and MCP server run as the vscode client", () => {
    const root = join(BIN, '..', 'vscode');
    const hooks = readFileSync(join(root, 'hooks.json'), 'utf8');
    for (const ev of ['session-start', 'stop']) expect(hooks).toContain(`--client vscode --event ${ev}`);
    expect(hooks).not.toContain('listen');
    expect(JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')).mcpServers.parly.args).toContain('vscode');
  });

  it("Codex's manifest points at files that exist, and its hooks run the Codex events", () => {
    const root = join(BIN, '..');
    const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.version).toBe(JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version);
    for (const key of ['skills', 'mcpServers', 'hooks']) expect(existsSync(join(root, manifest[key]))).toBe(true);
    const hooks = JSON.stringify(JSON.parse(readFileSync(join(root, manifest.hooks), 'utf8')));
    for (const ev of ['session-start', 'listen-codex', 'prompt']) expect(hooks).toContain(`--client codex --event ${ev}`);
  });
});
