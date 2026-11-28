/** Several Parly agents on one Claude Code: the router picks up the ones added there, each in a config dir of its own. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error .mjs module without d.ts
import { createRouter, markRead, worktreeDir } from '../plugins/parly/bin/workers.mjs';

const BIN = path.join(import.meta.dirname, '..', 'plugins', 'parly', 'bin');
const workers = { max: 2, permissionMode: 'bypassPermissions' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'siblings-'));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
  expect(ok()).toBe(true);
};

describe('agents added on this client', () => {
  const savedDir = process.env.A2A_HUB_CONFIG_DIR;
  afterEach(() => {
    if (savedDir === undefined) delete process.env.A2A_HUB_CONFIG_DIR;
    else process.env.A2A_HUB_CONFIG_DIR = savedDir;
  });

  it('keep their worktrees apart', () => {
    const meta = { key: 'dm:a_b', cwd: '/work' };
    expect(worktreeDir({ ...meta, agentId: 'cc1' })).not.toBe(worktreeDir({ ...meta, agentId: 'cc2' }));
  });

  it("answer in a session that uses the agent's own config dir", async () => {
    const cc2 = path.join(tmp(), 'agents', 'cc2');
    fs.mkdirSync(cc2, { recursive: true });
    process.env.A2A_HUB_CONFIG_DIR = cc2;
    fs.writeFileSync(path.join(cc2, 'claude-code.json'), JSON.stringify({ hubUrl: 'http://127.0.0.1:9', token: 't', agentId: 'cc2', workers }));
    const dirs: (string | undefined)[] = [];
    const exec = async (_c: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => {
      dirs.push(o.env.A2A_HUB_CONFIG_DIR);
      markRead('claude-code', 'dm:a_cc2');
      return { status: 0, stdout: '{"is_error":false}', stderr: '' };
    };
    const router = createRouter('claude-code', { exec });
    router.add([{ id: 'm1', conversation: 'dm:a_cc2' }], workers, '/work', 'cc2');
    await router.drained();
    expect(dirs).toEqual([cc2]);
  });

  it('answer a message to cc2 as cc2: its config dir, name and worktree, not the main agent\'s', async () => {
    const cc1 = tmp();
    const cc2 = path.join(cc1, 'agents', 'cc2');
    fs.mkdirSync(cc2, { recursive: true });
    fs.writeFileSync(path.join(cc1, 'claude-code.json'), JSON.stringify({ hubUrl: 'http://127.0.0.1:9', token: 't1', agentId: 'cc1', name: 'One', workers }));
    fs.writeFileSync(path.join(cc2, 'claude-code.json'), JSON.stringify({ hubUrl: 'http://127.0.0.1:9', token: 't2', agentId: 'cc2', name: 'Two', workers }));
    process.env.A2A_HUB_CONFIG_DIR = cc2; // what the router gives the sibling's listener
    const runs: { dir?: string; prompt: string }[] = [];
    const exec = async (_c: string, a: string[], o: { env: NodeJS.ProcessEnv }) => {
      runs.push({ dir: o.env.A2A_HUB_CONFIG_DIR, prompt: a.at(-1) ?? '' });
      markRead('claude-code', 'dm:a_cc2');
      return { status: 0, stdout: '{"is_error":false}', stderr: '' };
    };
    const router = createRouter('claude-code', { exec });
    router.add([{ id: 'm1', conversation: 'dm:a_cc2' }], workers, '/work', 'cc2');
    await router.drained();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.dir).toBe(cc2);
    expect(runs[0]?.prompt).toContain('You are Two on Parly');
    expect(runs[0]?.prompt).toContain(`${path.join('/work', '.parly-worktrees', 'cc2')}${path.sep}`);
    expect(runs[0]?.prompt).not.toMatch(/\.parly-worktrees[\\/]cc1|You are One/);
    expect(fs.existsSync(path.join(cc2, 'claude-code.workers'))).toBe(true);
    expect(fs.existsSync(path.join(cc1, 'claude-code.workers'))).toBe(false);
  });

  it('are picked up by the router: redeemed, saved in their own folder, and listened for', async () => {
    const dir = tmp();
    const seen: string[] = [];
    let pairings = [{ agentId: 'cc2', name: 'Two', code: 'K7QF-2M9X' }];
    const hub = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url?.split('?')[0]} ${req.headers.authorization ?? ''}`.trim());
      const send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/agents/me/sibling-pairings') return send({ pairings: pairings.splice(0) }); // each taken once
      if (req.url === '/pairings/redeem') return send({ agent: { id: 'cc2', name: 'Two' }, token: 'sibling-secret' });
      if (req.url?.startsWith('/events')) return setTimeout(() => send({ events: [], cursor: 'c1' }), 200);
      send({});
    });
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
    const hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
    fs.writeFileSync(path.join(dir, 'claude-code.json'), JSON.stringify({ hubUrl, token: 't', agentId: 'cc1', workers }));
    const session = spawn('sleep', ['60']); // the Claude Code session both listeners belong to
    const env: NodeJS.ProcessEnv = { ...process.env, A2A_HUB_CONFIG_DIR: dir };
    delete env.PARLY_WORKER;
    const router = spawn('node', [path.join(BIN, 'hub-events.mjs'), '--client', 'claude-code', '--event', 'listen', '--watch', String(session.pid)], { env });
    let out = '';
    router.stdout.on('data', (d) => (out += d));
    router.stderr.on('data', (d) => (out += d));
    const cc2 = path.join(dir, 'agents', 'cc2');
    try {
      await until(() => fs.existsSync(path.join(cc2, 'claude-code.listen.json')));
      const saved = path.join(cc2, 'claude-code.json');
      expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(saved, 'utf8'))).toMatchObject({ hubUrl, token: 'sibling-secret', agentId: 'cc2', name: 'Two', workers });
      expect(seen.some((s) => s.startsWith('POST /pairings/redeem'))).toBe(true);
      // starting the sibling must not stall the main router's own polling
      const mainPolls = () => seen.filter((s) => s.startsWith('GET /events') && s.endsWith('Bearer t')).length;
      const before = mainPolls();
      await until(() => mainPolls() >= before + 3);
      expect(out).not.toContain('sibling-secret');
    } finally {
      session.kill();
      router.kill();
      hub.closeAllConnections();
      hub.close();
    }
  }, 20_000);
});
