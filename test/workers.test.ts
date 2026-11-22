import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error .mjs module without d.ts
import { cantResume, cleanupWorktrees, conversationOf, createRouter, cursorAgent, cursorProblem, markRead, otherSessions, runSession, spawnAsync, workerSettings, workersFor, worktreeDir } from '../plugins/parly/bin/workers.mjs';

const settings = { max: 2, permissionMode: 'bypassPermissions' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workers-'));
/** Hands messages to a router; with no config written, nothing runs. */
const enqueue = (client: string, events: object[], cwd: string) => createRouter(client).add(events, settings, cwd);

describe('one session per conversation (plugins/parly/bin/workers.mjs)', () => {
  it('kills a run that floods output past maxBuffer, and one that outlives its timeout', async () => {
    const flood = await spawnAsync('yes', [], { maxBuffer: 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(flood.stdout.length).toBe(1000);
    expect(flood.status).toBeNull();
    const hung = await spawnAsync('sleep', ['10'], { timeout: 200, stdio: 'ignore' });
    expect(hung.status).toBeNull();
  });
  it('is off unless the person chose what headless sessions may do', () => {
    expect(workerSettings({})).toBeUndefined();
    expect(workerSettings({ workers: { max: 3 } })).toBeUndefined();
    expect(workerSettings({ workers: { max: 3, permissionMode: 'acceptEdits' } })).toEqual({ max: 3, permissionMode: 'acceptEdits' });
  });

  it("files a channel's new posts under the channel and each thread under itself", () => {
    expect(conversationOf({ id: 'p1', conversation: 'channel:c1' })).toBe('channel:c1');
    expect(conversationOf({ id: 'm2', conversation: 'thread:c1:p1' })).toBe('thread:c1:p1');
    expect(conversationOf({ id: 'm3', conversation: 'dm:a_b' })).toBe('dm:a_b');
  });

  it('runs at most max sessions, one per conversation, and gives mail that came mid-run to the next run', async () => {
    const dir = tmp();
    process.env.A2A_HUB_CONFIG_DIR = dir;
    fs.writeFileSync(path.join(dir, 'claude-code.json'), JSON.stringify({ hubUrl: 'http://127.0.0.1:9', token: 't', agentId: 'a', workers: settings }));
    const runs: { key: string; ids: string[]; end: () => void }[] = [];
    let live = 0;
    let peak = 0;
    const ids = new Map<string, string[]>();
    const exec = (_c: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => new Promise((resolve) => {
      const key = String(o.env.PARLY_WORKER);
      peak = Math.max(peak, ++live);
      markRead('claude-code', key);
      runs.push({ key, ids: ids.get(key)!, end: () => (live--, resolve({ status: 0, stdout: '{"is_error":false}', stderr: '' })) });
    });
    const done: string[][] = [];
    const router = createRouter('claude-code', { exec, onDone: (d: string[]) => done.push(d) });
    const tick = () => new Promise((r) => setTimeout(r, 20));
    router.add([{ id: 'm1', conversation: 'dm:a_b' }, { id: 'p1', conversation: 'channel:c1' }, { id: 'p2', conversation: 'channel:c2' }], settings, '/work');
    await tick();
    expect(runs.map((r) => r.key)).toEqual(['dm:a_b', 'channel:c1']);
    router.add([{ id: 'm2', conversation: 'dm:a_b' }], settings, '/work');
    await tick();
    expect(runs).toHaveLength(2); // dm:a_b is running: m2 waits for it
    runs[0]!.end();
    await tick();
    expect(runs.map((r) => r.key)).toEqual(['dm:a_b', 'channel:c1', 'channel:c2']);
    runs[1]!.end();
    await tick();
    expect(runs.map((r) => r.key)).toEqual(['dm:a_b', 'channel:c1', 'channel:c2', 'dm:a_b']);
    expect(router.idle()).toBe(false);
    runs[2]!.end();
    runs[3]!.end();
    await router.drained();
    expect(peak).toBe(2);
    expect(done).toEqual([['m1'], ['p1'], ['p2'], ['m2']]);
    expect(router.idle()).toBe(true);
  });

  it("tells each session what the agent's other sessions are on", async () => {
    process.env.A2A_HUB_CONFIG_DIR = tmp();
    const at = new Date().toISOString();
    enqueue('claude-code', [{ id: 'm1', conversation: 'dm:a_b', from: 'Ann', text: 'fix the login bug', at }, { id: 'm2', conversation: 'channel:c1', from: 'Bob', text: 'ship the pricing page', at }], '/work');
    expect(otherSessions('claude-code', 'dm:a_b').map((o: { key: string; text: string }) => [o.key, o.text])).toEqual([['channel:c1', 'ship the pricing page']]);
    const calls: string[][] = [];
    await runSession('claude-code', { key: 'dm:a_b', cwd: '/work' }, settings, 'Scout', path.join(tmp(), 'w.log'), (_c: string, a: string[]) => (calls.push(a), { status: 0, stdout: '{"is_error":false}', stderr: '' }));
    expect(calls[0]!.at(-1)).toContain('channel:c1: Bob: "ship the pricing page"');
    expect(calls[0]!.at(-1)).not.toContain('fix the login bug');
  });

  it('sends the full prompt on the first turn only, and the other sessions again only when they changed', async () => {
    process.env.A2A_HUB_CONFIG_DIR = tmp();
    const at = new Date().toISOString();
    enqueue('claude-code', [{ id: 'm1', conversation: 'dm:a_b', from: 'Ann', text: 'hi', at }, { id: 'm2', conversation: 'channel:c1', from: 'Bob', text: 'ship it', at }], '/work');
    const meta: { key: string; cwd: string; session?: string } = { key: 'dm:a_b', cwd: '/work' };
    const prompts: string[] = [];
    const turn = () => runSession('claude-code', meta, settings, 'Scout', path.join(tmp(), 'w.log'), (_c: string, a: string[]) => (prompts.push(a.at(-1)!), { status: 0, stdout: '{"is_error":false}', stderr: '' }));
    await turn();
    expect(prompts[0]).toContain('You are Scout');
    expect(prompts[0]).toContain('channel:c1: Bob: "ship it"');
    expect(prompts[0]).toContain('work it through to completion');
    expect(prompts[0]).toContain('check the result works');
    expect(prompts[0]).not.toContain('Stop once you have answered');
    await turn();
    expect(prompts[1]).toBe('New messages in dm:a_b: call check_inbox with conversation "dm:a_b" and answer as before.');
    enqueue('claude-code', [{ id: 'm3', conversation: 'channel:c1', from: 'Bob', text: 'shipped', at: new Date(Date.now() + 1000).toISOString() }], '/work');
    await turn();
    expect(prompts[2]).not.toContain('You are Scout');
    expect(prompts[2]).toContain('channel:c1: Bob: "shipped"');
  });

  it("keeps a DM's text out of sessions in shared conversations, and other channels' too", () => {
    process.env.A2A_HUB_CONFIG_DIR = tmp();
    const at = new Date().toISOString();
    enqueue('claude-code', [
      { id: 'm1', conversation: 'dm:a_b', from: 'Ann', text: 'my salary is private', at },
      { id: 'm2', conversation: 'agent:b', from: 'Ann', text: 'also private', at },
      { id: 'm3', conversation: 'channel:c1', from: 'Bob', text: 'ship it', at },
      { id: 'm4', conversation: 'thread:c1:p1', from: 'Bob', text: 'which branch?', at },
      { id: 'm5', conversation: 'thread:c2:p2', from: 'Cy', text: 'another team', at },
    ], '/work');
    const keys = (key: string) => otherSessions('claude-code', key).map((o: { key: string }) => o.key).sort();
    expect(keys('channel:c1')).toEqual(['thread:c1:p1']);
    expect(keys('thread:c1:p1')).toEqual(['channel:c1']);
    expect(keys('thread:c2:p2')).toEqual([]);
    expect(keys('dm:a_b')).toEqual(['agent:b', 'channel:c1', 'thread:c1:p1', 'thread:c2:p2']);
  });

  it('Claude Code: a new session the first time, the same one resumed after; a failed run says so', async () => {
    const calls: string[][] = [];
    const meta: { key: string; cwd: string; session?: string } = { key: 'dm:a_b', cwd: '/work' };
    const ok = (args: string[]) => (calls.push(args), { status: 0, stdout: JSON.stringify({ is_error: false, session_id: args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1] }), stderr: '' });
    const log = path.join(tmp(), 'w.log');
    expect(await runSession('claude-code', meta, settings, 'Scout', log, (_c: string, a: string[]) => ok(a))).toEqual({ ok: true });
    const first = meta.session;
    expect(calls[0]).toContain('--session-id');
    expect(calls[0]!.at(-1)).toContain('conversation "dm:a_b"');
    expect(await runSession('claude-code', meta, settings, 'Scout', log, (_c: string, a: string[]) => ok(a))).toEqual({ ok: true });
    expect(calls[1]).toEqual(expect.arrayContaining(['--resume', first]));
    const failed = await runSession('claude-code', meta, settings, 'Scout', log, () => ({ status: 1, stdout: JSON.stringify({ is_error: true, result: 'Credit balance is too low' }), stderr: '' }));
    expect(failed).toEqual({ ok: false, problem: 'Credit balance is too low' });
  });

  it('Claude Code: compacts a session at about 80k tokens rather than letting it grow', async () => {
    let window: string | undefined;
    await runSession('claude-code', { key: 'dm:a_b', cwd: '/work' }, settings, 'Scout', path.join(tmp(), 'w.log'), (_c: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => {
      window = o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      return { status: 0, stdout: '{"is_error":false}', stderr: '' };
    });
    expect(window).toBe('113000');
  });

  it('Codex: keeps the thread id it started, resumes it, and waits while an earlier run still holds it', async () => {
    const meta: { key: string; cwd: string; session?: string } = { key: 'dm:a_b', cwd: '/work' };
    const log = path.join(tmp(), 'w.log');
    const lines = (...l: object[]) => l.map((x) => JSON.stringify(x)).join('\n');
    const calls: string[][] = [];
    const run = (stdout: string, status = 0, stderr = '') => (_c: string, a: string[]) => (calls.push(a), { status, stdout, stderr });
    expect(await runSession('codex', meta, settings, 'Scout', log, run(lines({ type: 'thread.started', thread_id: 't-1' }, { type: 'turn.completed' })))).toEqual({ ok: true });
    expect(meta.session).toBe('t-1');
    expect(calls[0]).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(await runSession('codex', meta, settings, 'Scout', log, run(lines({ type: 'thread.started', thread_id: 't-1' }, { type: 'turn.completed' })))).toEqual({ ok: true });
    expect(calls[1]!.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(calls[1]).toContain('t-1');
    expect(await runSession('codex', meta, settings, 'Scout', log, run('', 1, 'thread t-1 already has an active writer'))).toEqual({ ok: false, busy: true });
    expect(await runSession('codex', meta, settings, 'Scout', log, run(lines({ type: 'turn.failed', error: { message: 'usage limit' } }), 1))).toEqual({ ok: false, problem: 'usage limit' });
  });

  it('Cursor: keeps the session its CLI returns, resumes it, and never goes through a shell', async () => {
    const meta: { key: string; cwd: string; session?: string } = { key: 'dm:a_b', cwd: '/work' };
    const log = path.join(tmp(), 'w.log');
    const calls: { args: string[]; shell: unknown }[] = [];
    const ok = (_c: string, args: string[], o: { shell?: unknown }) => (calls.push({ args, shell: o.shell }), { status: 0, stdout: JSON.stringify({ type: 'result', is_error: false, session_id: 'c-1' }), stderr: '' });
    expect(await runSession('cursor', meta, settings, 'Scout', log, ok)).toEqual({ ok: true });
    expect(meta.session).toBe('c-1');
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-p', '--trust', '--approve-mcps', '--force', '--workspace', '/work']));
    expect(calls[0]!.args).not.toContain('--resume');
    expect(calls[0]!.shell).toBeUndefined();
    expect(await runSession('cursor', meta, { ...settings, permissionMode: 'default' }, 'Scout', log, ok)).toEqual({ ok: true });
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'c-1']));
    expect(calls[1]!.args).not.toContain('--force');
  });

  it('Cursor: says when its CLI needs signing in, and forgets a chat it can no longer resume', async () => {
    const meta: { key: string; cwd: string; session?: string } = { key: 'dm:a_b', cwd: '/work', session: 'gone' };
    const log = path.join(tmp(), 'w.log');
    expect((await runSession('cursor', meta, settings, 'Scout', log, () => ({ status: 1, stdout: '', stderr: 'Authentication required' }))).problem).toMatch(/agent login/);
    expect((await runSession('cursor', meta, settings, 'Scout', log, () => ({ status: 1, stdout: '', stderr: 'Chat not found' }))).ok).toBe(false);
    expect(meta.session).toBeUndefined();
  });

  it("forgets a session only when its client says it can't resume it, not on any error that says session or chat", async () => {
    for (const t of ['No conversation found with session ID: 0f3c', 'Chat not found', 'Error: session c-1 not found', 'could not resume session']) expect(cantResume(t), t).toBe(true);
    for (const t of ['chat rate limited', 'session hook failed', 'session hook failed: file not found', 'SessionStart hook error', 'Credit balance is too low']) expect(cantResume(t), t).toBe(false);
    const meta: { key: string; cwd: string; session?: string } = { key: 'dm:a_b', cwd: '/work', session: 's-1' };
    await runSession('claude-code', meta, settings, 'Scout', path.join(tmp(), 'w.log'), () => ({ status: 1, stdout: JSON.stringify({ is_error: true, result: 'chat rate limited' }), stderr: '' }));
    expect(meta.session).toBe('s-1');
  });

  it('Windows: only a real agent.exe; a launcher would put message text through a shell', () => {
    const appData = tmp();
    expect(cursorAgent('win32', { LOCALAPPDATA: appData })).toBeUndefined();
    fs.mkdirSync(path.join(appData, 'cursor-agent'));
    fs.writeFileSync(path.join(appData, 'cursor-agent', 'agent.cmd'), '');
    expect(cursorAgent('win32', { LOCALAPPDATA: appData })).toBeUndefined();
    fs.writeFileSync(path.join(appData, 'cursor-agent', 'agent.exe'), '');
    expect(cursorAgent('win32', { LOCALAPPDATA: appData })).toBe(path.join(appData, 'cursor-agent', 'agent.exe'));
  });

  it("says what's stopping Cursor's CLI, and doesn't guess when it can't tell", () => {
    const answers = (r: object) => () => r;
    expect(cursorProblem('agent', answers({ error: { code: 'ENOENT' } }))).toMatch(/isn't installed/);
    expect(cursorProblem('agent', answers({ status: 1, stdout: 'Not logged in' }))).toMatch(/agent login/);
    expect(cursorProblem('agent', answers({ status: 0, stdout: '✓ Logged in as a@b.c' }))).toBeUndefined();
    expect(cursorProblem('agent', answers({ error: { code: 'ETIMEDOUT' } }))).toBeUndefined();
  });

  it('workers are for the clients that have headless sessions', () => {
    expect(workersFor('claude-code', { workers: settings })).toEqual(settings);
    expect(workersFor('codex', { workers: settings })).toEqual(settings);
    expect(workersFor('vscode', { workers: settings })).toBeUndefined();
    if (process.platform !== 'win32') expect(workersFor('cursor', { workers: settings })).toEqual(settings);
    expect(workersFor('cursor', {})).toBeUndefined();
  });

  describe('cleaning up a turn’s worktrees', () => {
    /** A real git repo, and a worktree of it at this conversation's deterministic path on branch `wip`. */
    function worktree(key = 'dm:a_b') {
      const repo = tmp();
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
      execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
      const meta = { key, cwd: tmp() };
      const wt = path.join(worktreeDir(meta), 'repo');
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wip', wt]);
      return { meta, wt };
    }

    it('removes a clean worktree that is on a branch', () => {
      const { meta, wt } = worktree();
      cleanupWorktrees(meta);
      expect(fs.existsSync(wt)).toBe(false);
    });

    it('leaves a worktree with uncommitted changes', () => {
      const { meta, wt } = worktree();
      fs.writeFileSync(path.join(wt, 'scratch.txt'), 'wip');
      cleanupWorktrees(meta);
      expect(fs.existsSync(wt)).toBe(true);
    });

    it('leaves a detached-HEAD worktree so its commits are not orphaned', () => {
      const { meta, wt } = worktree();
      execFileSync('git', ['-C', wt, 'checkout', '-q', '--detach']);
      cleanupWorktrees(meta);
      expect(fs.existsSync(wt)).toBe(true);
    });

    it('does nothing when the conversation made no worktrees', () => {
      expect(() => cleanupWorktrees({ key: 'dm:none', cwd: tmp() })).not.toThrow();
    });
  });

  describe('a session that never reached its inbox', () => {
    /** A conversation with mail waiting, a hub recording replies, and a session that does what `run` says. */
    async function setup(reads: (run: number) => boolean, event: Record<string, unknown> = { id: 'm1', conversation: 'dm:a_b' }) {
      const dir = tmp();
      process.env.A2A_HUB_CONFIG_DIR = dir;
      const replies: string[] = [];
      const hub = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          replies.push(`${req.url} ${JSON.parse(body || '{}').text}`);
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
      });
      await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
      fs.writeFileSync(path.join(dir, 'claude-code.json'), JSON.stringify({ hubUrl: `http://127.0.0.1:${(hub.address() as AddressInfo).port}`, token: 't', agentId: 'a', workers }));
      let runs = 0;
      const exec = () => {
        if (reads(++runs)) markRead('claude-code', String(event.conversation));
        return { status: 0, stdout: '{"is_error":false,"session_id":"s1"}', stderr: '' };
      };
      const router = createRouter('claude-code', { exec, retryWaitMs: 1 });
      router.add([event], workers, '/work');
      await router.drained();
      hub.close();
      return { runs, replies, left: router.idle() ? [] : ['queued'] };
    }
    const workers = settings;

    it('stays quiet when the session read and chose not to answer', async () => {
      expect(await setup(() => true)).toEqual({ runs: 1, replies: [], left: [] });
    });

    it('goes again, and stops once a run gets through', async () => {
      expect(await setup((run) => run === 2)).toEqual({ runs: 2, replies: [], left: [] });
    });

    it('gives up after a few tries and says so, once', async () => {
      const { runs, replies, left } = await setup(() => false);
      expect(runs).toBe(3);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatch(/\/messages\/m1\/reply .*couldn't reach its Parly tools/);
      expect(left).toEqual([]);
    });

    it('stays quiet in a thread where nobody asked it anything', async () => {
      expect(await setup(() => false, { id: 'm1', conversation: 'thread:c1:p1', mentions: ['someone-else'] })).toEqual({ runs: 3, replies: [], left: [] });
    });

    it('says so in a thread where it was @mentioned', async () => {
      const { replies } = await setup(() => false, { id: 'm1', conversation: 'thread:c1:p1', mentions: ['a'] });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatch(/couldn't reach its Parly tools/);
    });
  });
});
