import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HUB_MCP = path.resolve('plugins/parly/bin/hub-mcp.mjs');
const COMMON = path.resolve('plugins/parly/bin/common.mjs');
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });

const servers: http.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A hub answering `initialize` and `tools/list` after `delayMs`, and counting what it was asked. */
async function fakeHub(delayMs: number, tools = [tool('check_inbox')]) {
  const asked: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    headers.push(req.headers);
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const msg = JSON.parse(body);
      asked.push(msg.method);
      const send = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: '[]' }] });
      setTimeout(() => send(msg.method === 'initialize' ? { instructions: 'from the hub' } : { tools }), delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, headers };
}

function configured(hubUrl: string, agentId = 'a1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify({ hubUrl, token: 't', agentId, name: 'Test' }));
  return dir;
}

const cacheFile = (dir: string) => path.join(dir, 'codex.mcp-cache.json');

type Line = { msg: { id?: number; method?: string; result?: { tools?: { name: string }[]; instructions?: string } } };

/**
 * Runs the bridge, sends `msgs`, and stops it once `done(lines)` holds (checked on every line and every 20ms), with
 * `ms` only as a ceiling. Waiting on the outcome, not a fixed time, is what keeps this green on slow CI runners.
 */
function bridge(dir: string, msgs: unknown[], done: (lines: Line[]) => boolean, env: NodeJS.ProcessEnv = {}, ms = 10_000) {
  return new Promise<Line[]>((resolve) => {
    const p = spawn('node', [HUB_MCP, '--client', 'codex'], { env: { ...process.env, ...env, A2A_HUB_CONFIG_DIR: dir } });
    const lines: Line[] = [];
    let buffer = '';
    const check = () => done(lines) && p.kill();
    p.stdout.on('data', (d) => {
      buffer += d;
      const parts = buffer.split('\n');
      buffer = parts.pop()!;
      for (const l of parts) lines.push({ msg: JSON.parse(l) });
      check();
    });
    p.stdin.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const poll = setInterval(check, 20);
    const ceiling = setTimeout(() => p.kill(), ms);
    p.on('close', () => {
      clearInterval(poll);
      clearTimeout(ceiling);
      resolve(lines);
    });
  });
}

const answered = (id: number) => (lines: Line[]) => lines.some((l) => l.msg.id === id);
/** The background refresh is over once it has rewritten the cache (an atomic rename, so a new inode); it decides whether to notify in the same step. */
const refreshed = (dir: string) => {
  const ino = fs.existsSync(cacheFile(dir)) ? fs.statSync(cacheFile(dir)).ino : -1;
  return (lines: Line[]) => answered(2)(lines) && fs.existsSync(cacheFile(dir)) && fs.statSync(cacheFile(dir)).ino !== ino;
};

const handshake = [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }];

describe('hub-mcp starts without waiting for the hub', () => {
  it('a slow hub cannot delay the tools once they are known', async () => {
    const hub = await fakeHub(60_000); // longer than the bridge's 10s ceiling: only the cache can answer in time, however slow the runner
    const dir = configured(hub.url);
    fs.writeFileSync(cacheFile(dir), JSON.stringify({ hubUrl: hub.url, agentId: 'a1', instructions: 'cached', tools: [tool('check_inbox')] }));
    const lines = await bridge(dir, handshake, answered(2));
    expect(lines.find((l) => l.msg.id === 2)!.msg.result!.tools!.map((t) => t.name)).toEqual(['check_inbox']);
    expect(lines.find((l) => l.msg.id === 1)!.msg.result!.instructions).toBe('cached');
  });

  it('answers live on the first start, and keeps it private', async () => {
    const hub = await fakeHub(0);
    const dir = configured(hub.url);
    const lines = await bridge(dir, handshake, refreshed(dir));
    expect(lines.find((l) => l.msg.id === 2)!.msg.result!.tools!.map((t) => t.name)).toEqual(['check_inbox']);
    expect(hub.asked).toEqual(expect.arrayContaining(['initialize', 'tools/list']));
    expect(JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8'))).toMatchObject({ agentId: 'a1', instructions: 'from the hub' });
    expect(fs.statSync(cacheFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("doesn't use another hub's or agent's cache", async () => {
    const hub = await fakeHub(0, [tool('theirs')]);
    const dir = configured(hub.url, 'a2');
    fs.writeFileSync(cacheFile(dir), JSON.stringify({ hubUrl: hub.url, agentId: 'a1', instructions: 'old', tools: [tool('mine')] }));
    const lines = await bridge(dir, handshake, answered(2));
    expect(lines.find((l) => l.msg.id === 2)!.msg.result!.tools!.map((t) => t.name)).toEqual(['theirs']);
  });

  it('tells the client only when the refreshed tools really changed', async () => {
    const hub = await fakeHub(0, [tool('check_inbox'), tool('new_tool')]);
    const dir = configured(hub.url);
    fs.writeFileSync(cacheFile(dir), JSON.stringify({ hubUrl: hub.url, agentId: 'a1', instructions: 'old', tools: [tool('check_inbox')] }));
    // The cache is renamed into place just before the notice is written: stopping on the cache alone can kill the bridge in between.
    const notified = (lines: Line[]) => lines.some((l) => l.msg.method === 'notifications/tools/list_changed');
    const rewritten = refreshed(dir);
    const changed = await bridge(dir, handshake, (lines) => rewritten(lines) && notified(lines));
    expect(changed.find((l) => l.msg.id === 2)!.msg.result!.tools!.map((t) => t.name)).toEqual(['check_inbox']);
    expect(changed.some((l) => l.msg.method === 'notifications/tools/list_changed')).toBe(true);
    expect(JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')).tools).toHaveLength(2);
    const same = await bridge(dir, handshake, refreshed(dir));
    expect(same.some((l) => l.msg.method === 'notifications/tools/list_changed')).toBe(false);
  });

  it('leaves the cached tools alone when the refresh fails', async () => {
    const dir = configured('http://127.0.0.1:9');
    fs.writeFileSync(cacheFile(dir), JSON.stringify({ hubUrl: 'http://127.0.0.1:9', agentId: 'a1', instructions: 'old', tools: [tool('check_inbox')] }));
    const lines = await bridge(dir, handshake, answered(2));
    expect(lines.find((l) => l.msg.id === 2)!.msg.result!.tools!.map((t) => t.name)).toEqual(['check_inbox']);
    expect(JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')).tools).toHaveLength(1);
  });

  it("marks a conversation read when its inbox is checked, and not otherwise", async () => {
    const hub = await fakeHub(0);
    const dir = configured(hub.url);
    const call = (name: string, conversation?: string) => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: conversation ? { conversation } : {} } });
    await bridge(dir, [init, call('whoami', 'dm:a_b')], answered(3));
    const reads = () => (fs.existsSync(path.join(dir, 'codex.workers')) ? fs.readdirSync(path.join(dir, 'codex.workers')).filter((n) => n.endsWith('.read')) : []);
    expect(reads()).toEqual([]);
    await bridge(dir, [init, call('check_inbox', 'dm:a_b')], answered(3));
    expect(reads()).toHaveLength(1);
  });

  it('a worker session tells the hub its conversation, so the hub leaves out the note about the others', async () => {
    const hub = await fakeHub(0);
    const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_inbox', arguments: {} } };
    await bridge(configured(hub.url), [call], answered(3), { PARLY_WORKER: 'dm:x' });
    expect(hub.headers.at(-1)!['x-parly-conversation']).toBe('dm:x');
  });
});

describe('config files', () => {
  it('a reader never sees a half-written config while another process writes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
    process.env.A2A_HUB_CONFIG_DIR = dir;
    const { readConfig, writeConfig } = await import(COMMON);
    const config = { hubUrl: 'http://h', token: 't', padding: 'x'.repeat(200_000) };
    writeConfig('codex', config);
    const code = `import(${JSON.stringify(COMMON)}).then(({ readConfig, writeConfig }) => { const c = readConfig('codex'); const end = Date.now() + 1500; while (Date.now() < end) writeConfig('codex', c); });`;
    const writer = spawn('node', ['-e', code], { env: { ...process.env, A2A_HUB_CONFIG_DIR: dir } });
    const closed = new Promise((r) => writer.on('close', r));
    let missing = 0;
    let done = false;
    void closed.then(() => (done = true));
    while (!done) {
      for (let i = 0; i < 50; i++) if (!readConfig('codex')) missing++;
      await new Promise((r) => setImmediate(r));
    }
    expect(missing).toBe(0);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  }, 15_000);
});
