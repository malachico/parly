import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('parly-agent-runner.mjs', () => {
  it('reads the inbox itself, runs ZeroClaw once when something waits, and keeps its keys off the agent disk', async () => {
    // @ts-expect-error .mjs module without d.ts
    const { buildZeroClawConfig, runZeroClawTurn } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const cfg = {
      agentId: 'agent-zc',
      agentName: 'Scout',
      agentToken: 'tok_scout',
      hubUrl: 'https://parly.dev',
      llmBaseUrl: 'https://parly.dev/llm/vertex',
      llmKey: 'plk_key_99',
      model: 'gemini-3.8-flash',
    };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-state-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-run-'));
    const workspace = { workDir: stateDir, stateDir };

    const toml = buildZeroClawConfig(cfg, workspace);
    expect(toml).toContain('shell_env_passthrough = ["PARLY_AGENT_ID", "PARLY_HUB_URL"]');
    expect(toml).not.toContain('"PARLY_AGENT_TOKEN"');
    expect(toml).not.toContain('"PARLY_LLM_KEY"');
    expect(toml).toContain('uri = "https://parly.dev/llm/openai"');
    expect(toml).toContain('url = "https://parly.dev/mcp"');
    expect(toml).toContain('Authorization = "Bearer tok_scout"');
    expect(toml).toContain('"a2a-hub__reply"');
    expect(toml).toContain('"a2a-hub__run_tool"');
    expect(toml).toContain('"a2a-hub__watch"');
    // Read-only skill tools, so the prompt's load rule can be followed; the write/attach ones stay out.
    expect(toml).toContain('"a2a-hub__get_skill"');
    expect(toml).toContain('"a2a-hub__list_skills"');
    for (const t of ['create_skill', 'update_skill', 'delete_skill', 'attach_skill', 'detach_skill']) expect(toml).not.toContain(`"a2a-hub__${t}"`);
    expect(toml).toContain('native_tools = true');
    expect(toml).not.toContain('[browser]');
    expect(toml).toContain('max_tool_iterations = 1000');

    let inbox = [{ messageId: 'm1', text: 'hi' }];
    const fakeFetch = async (url: string) => {
      expect(url).toBe('https://parly.dev/mcp');
      const text = JSON.stringify(inbox);
      inbox = [];
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text }] } }) };
    };
    const runs: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
    const execImpl = async (cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      runs.push({ cmd, args, env: opts.env });
      return { stdout: 'done', stderr: '' };
    };
    const deps = { fetchImpl: fakeFetch, execImpl, configDir };
    expect(await runZeroClawTurn(cfg, workspace, deps)).toEqual({ ok: true, engine: 'zeroclaw', handled: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cmd).toBe('zeroclaw');
    expect(runs[0]!.args.slice(0, 6)).toEqual(['--config-dir', configDir, 'agent', '-a', 'main', '-m']);
    expect(runs[0]!.args[6]).toContain('m1');
    // ZeroClaw's memory (<config dir>/data) is kept with the agent's state.
    expect(fs.realpathSync(path.join(configDir, 'data'))).toBe(fs.realpathSync(path.join(stateDir, 'zeroclaw')));
    // The keys live only in the config under /run (here configDir), not on the agent's persistent disk.
    expect(fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8')).toContain('plk_key_99');
    const onDisk = fs.readdirSync(stateDir, { recursive: true }).map((f) => path.join(stateDir, String(f)));
    expect(onDisk.some((f) => fs.statSync(f).isFile() && fs.readFileSync(f, 'utf8').includes('plk_key_99'))).toBe(false);
    // An empty inbox costs no run at all.
    expect(await runZeroClawTurn(cfg, workspace, deps)).toEqual({ ok: true, engine: 'zeroclaw', handled: 0 });
    expect(runs).toHaveLength(1);
  });

  it('answers each message with a short note when ZeroClaw gives up on a turn', async () => {
    // @ts-expect-error .mjs module without d.ts
    const { runZeroClawTurn } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-fail-'));
    const cfg = { agentId: 'a', agentName: 'Scout', agentToken: 't', hubUrl: 'https://parly.dev', llmBaseUrl: 'https://parly.dev/llm/vertex', llmKey: 'k', model: 'm' };
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const fakeFetch = async (_url: string, init: { body: string }) => {
      const { params } = JSON.parse(init.body);
      calls.push(params);
      const text = params.name === 'check_inbox' ? JSON.stringify([{ messageId: 'm1' }, { messageId: 'm2' }]) : '{}';
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text }] } }) };
    };
    const execImpl = async () => ({ stdout: 'I generated an internal tool-call format error and could not complete this request. Please try again.\n' });
    const result = await runZeroClawTurn(cfg, { workDir: dir, stateDir: dir }, { fetchImpl: fakeFetch, execImpl, configDir: dir, resumeWaitsMs: [] });
    expect(result).toEqual({ ok: false, engine: 'zeroclaw', handled: 1 });
    expect(calls.filter((c) => c.name === 'reply').map((c) => c.arguments.messageId)).toEqual(['m1', 'm2']);
  });

  /** A hosted turn against a fake hub: its working dir, and the replies it posted. */
  async function resumeRig(prefix: string, inbox = ['m1'], note?: string) {
    // @ts-expect-error .mjs module without d.ts
    const { runZeroClawTurn } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const replies: string[] = [];
    const noted: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body));
      if (method === 'tools/call' && params.name === 'reply') replies.push(params.arguments.text);
      if (method === 'tools/call' && params.name === 'reply') noted.push(params.arguments.messageId);
      const text = params?.name === 'check_inbox' ? JSON.stringify(inbox.map((messageId) => ({ messageId, text: 'long job' }))) : 'ok';
      const content = [{ type: 'text', text }, ...(params?.name === 'check_inbox' && note ? [{ type: 'text', text: note }] : [])];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content } }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const cfg = { agentId: 'a', agentName: 'Atlas', agentToken: 't', hubUrl: 'http://hub', llmBaseUrl: 'http://hub/llm/vertex', llmKey: 'k', model: 'm' };
    const run = (execImpl: (c: string, args: string[]) => Promise<{ stdout: string }>, resumeWaitsMs = [1]) =>
      runZeroClawTurn(cfg, { workDir: dir, stateDir: dir }, { fetchImpl, execImpl, configDir: dir, resumeWaitsMs, traceWatchMs: 5 });
    return { dir, run, replies, noted };
  }

  it('an error ZeroClaw ends with exit 0 resumes too; running out of steps does not', async () => {
    const { run } = await resumeRig('resume-soft-');
    const prompts: string[] = [];
    const ok = await run(async (_c, args) => {
      prompts.push(args.at(-1)!);
      return { stdout: prompts.length === 1 ? 'I could not complete this request' : 'done' };
    });
    expect(ok.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('cut off by an error');
    let calls = 0;
    await run(async () => {
      calls++;
      return { stdout: 'Turn stopped: reached maximum tool iterations' };
    });
    expect(calls).toBe(1);
  });

  it('a resumed turn is told what it tried, not that it worked', async () => {
    const { dir, run } = await resumeRig('resume-told-');
    const prompts: string[] = [];
    await run(async (_c, args) => {
      prompts.push(args.at(-1)!);
      if (prompts.length > 1) return { stdout: 'done' };
      fs.mkdirSync(path.join(dir, 'zeroclaw', 'state'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'zeroclaw', 'state', 'runtime-trace.jsonl'), `${JSON.stringify({ attributes: { trace_id: 't', tool: 'a2a-hub__reply' } })}\n`);
      throw new Error('zeroclaw exited with 1');
    });
    expect(prompts[1]).toContain('I tried: reply.');
    expect(prompts[1]).toContain('may have failed');
    expect(prompts[1]).not.toContain('already went out');
  });

  /** What ZeroClaw's trace holds for a reply call: its arguments as a JSON string, then its result. */
  function traceReply(dir: string, messageId: string, { trace_id = 't', error_reason, started = true, finished = true }: { trace_id?: string; error_reason?: string; started?: boolean; finished?: boolean } = {}) {
    const state = path.join(dir, 'zeroclaw', 'state');
    fs.mkdirSync(state, { recursive: true });
    const tool = 'a2a-hub__reply';
    const lines = [
      ...(started ? [{ message: 'tool_call_start', attributes: { trace_id, tool, arguments: JSON.stringify({ messageId, text: 'hi' }) } }] : []),
      ...(finished ? [{ message: 'tool_call_result', attributes: { trace_id, tool, error_reason: error_reason ?? null, output: 'ok' } }] : []),
    ];
    fs.appendFileSync(path.join(state, 'runtime-trace.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }

  it('a resume leaves out messages it already answered, and the failure note does too', async () => {
    const { dir, run, noted } = await resumeRig('resume-partial-', ['m1', 'm2']);
    const prompts: string[] = [];
    const result = await run(async (_c, args) => {
      prompts.push(args.at(-1)!);
      if (prompts.length === 1) traceReply(dir, 'm1');
      throw new Error('zeroclaw exited with 1');
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('"m1"');
    expect(prompts[1]).not.toContain('"m1"');
    expect(prompts[1]).toContain('"m2"');
    expect(result.ok).toBe(false);
    expect(noted).toEqual(['m2']);
  });

  describe('check_inbox with a note after its JSON block', () => {
    const NOTE = 'You have new messages in 1 Parly conversation.';

    it('an empty inbox with a note starts no turn', async () => {
      const { run } = await resumeRig('note-empty-', [], NOTE);
      let calls = 0;
      const result = await run(async () => {
        calls++;
        return { stdout: 'done' };
      });
      expect(result).toEqual({ ok: true, engine: 'zeroclaw', handled: 0 });
      expect(calls).toBe(0);
    });

    it('a resume leaves out answered messages and keeps the note after them', async () => {
      const { dir, run } = await resumeRig('note-resume-', ['m1', 'm2'], NOTE);
      const prompts: string[] = [];
      await run(async (_c, args) => {
        prompts.push(args.at(-1)!);
        if (prompts.length === 1) traceReply(dir, 'm1');
        throw new Error('zeroclaw exited with 1');
      });
      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.indexOf(NOTE)).toBeGreaterThan(prompts[0]!.indexOf('"m2"'));
      expect(prompts[1]).toContain('Your new Parly messages are below');
      expect(prompts[1]).not.toContain('"m1"');
      expect(prompts[1]).toContain('"m2"');
      expect(prompts[1]!.indexOf(NOTE)).toBeGreaterThan(prompts[1]!.indexOf('"m2"'));
      expect(prompts[1]!.split(NOTE)).toHaveLength(2);
    });

    it('the failure note reaches each unanswered message', async () => {
      const { dir, run, noted } = await resumeRig('note-failed-', ['m1', 'm2'], NOTE);
      const result = await run(async () => {
        traceReply(dir, 'm1');
        throw new Error('zeroclaw exited with 1');
      }, []);
      expect(result.ok).toBe(false);
      expect(noted).toEqual(['m2']);
    });

    it('a turn that answered everything before dying is done: no resume, no failure note', async () => {
      const { dir, run, noted } = await resumeRig('note-done-', ['m1', 'm2'], NOTE);
      let calls = 0;
      const result = await run(async () => {
        calls++;
        traceReply(dir, 'm1');
        traceReply(dir, 'm2');
        throw new Error('zeroclaw exited with 1');
      });
      expect(calls).toBe(1);
      expect(result.ok).toBe(true);
      expect(noted).toEqual([]);
    });
  });

  it('tells the agent to commit and push as it goes, on a resume too', async () => {
    const { run } = await resumeRig('commit-line-');
    const prompts: string[] = [];
    await run(async (_c, args) => {
      prompts.push(args.at(-1)!);
      if (prompts.length === 1) throw new Error('zeroclaw exited with 1');
      return { stdout: 'done' };
    });
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt).toMatch(/commit and push after each step/i);
  });

  it('a turn that answered everything before dying is done: no resume, no failure note', async () => {
    const { dir, run, noted } = await resumeRig('resume-done-', ['m1', 'm2']);
    let calls = 0;
    const result = await run(async () => {
      calls++;
      traceReply(dir, 'm1');
      traceReply(dir, 'm2');
      throw new Error('zeroclaw exited with 1');
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(noted).toEqual([]);
  });

  it('a reply that failed, or one from an earlier turn, is not counted as answered', async () => {
    const { dir, run } = await resumeRig('resume-failed-', ['m1']);
    traceReply(dir, 'm1', { trace_id: 'earlier' });
    const prompts: string[] = [];
    await run(async (_c, args) => {
      prompts.push(args.at(-1)!);
      if (prompts.length === 1) traceReply(dir, 'm1', { error_reason: 'MCP `reply` returned isError: not found' });
      throw new Error('zeroclaw exited with 1');
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"m1"');
  });

  it('a reply cut off before its result stays unanswered, and does not take the next attempt\'s result', async () => {
    const { dir, run } = await resumeRig('resume-cut-', ['m1', 'm2']);
    const prompts: string[] = [];
    await run(async (_c, args) => {
      prompts.push(args.at(-1)!);
      if (prompts.length === 1) traceReply(dir, 'm1', { trace_id: 'a1', finished: false });
      if (prompts.length === 2) traceReply(dir, 'm2', { trace_id: 'a2' });
      throw new Error('zeroclaw exited with 1');
    }, [1, 1]);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('"m1"');
    expect(prompts[2]).not.toContain('"m2"');
  });

  it('the trace is a rolling log: a reply counts even if the file shrinks, or rolls away before the turn ends', async () => {
    const { dir, run, noted } = await resumeRig('resume-roll-', ['m1', 'm2']);
    const trace = path.join(dir, 'zeroclaw', 'state', 'runtime-trace.jsonl');
    for (let i = 0; i < 50; i++) traceReply(dir, 'old', { trace_id: 'earlier' }); // A long file, so a byte offset would land past the new one.
    const prompts: string[] = [];
    await run(async (_c, args) => {
      prompts.push(args.at(-1)!);
      if (prompts.length > 1) throw new Error('zeroclaw exited with 1');
      fs.writeFileSync(trace, '');
      traceReply(dir, 'm1', { trace_id: 'now' });
      await new Promise((r) => setTimeout(r, 40));
      fs.writeFileSync(trace, ''); // rolled out of the log before this attempt ended
      throw new Error('zeroclaw exited with 1');
    });
    expect(prompts[1]).not.toContain('"m1"');
    expect(noted).toEqual(['m2']);
  });

  it('a turn cut off by an error resumes from its work, and says so only if it keeps failing', async () => {
    // @ts-expect-error .mjs module without d.ts
    const { runZeroClawTurn } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    const replies: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body));
      if (method === 'tools/call' && params.name === 'reply') replies.push(params.arguments.text);
      const text = params?.name === 'check_inbox' ? JSON.stringify([{ messageId: 'm1', text: 'long job' }]) : 'ok';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const cfg = { agentId: 'a', agentName: 'Atlas', agentToken: 't', hubUrl: 'http://hub', llmBaseUrl: 'http://hub/llm/vertex', llmKey: 'k', model: 'm' };
    const workspace = { workDir: dir, stateDir: dir };
    const prompts: string[] = [];
    const flaky = async (_c: string, args: string[]) => {
      prompts.push(args.at(-1)!);
      if (prompts.length < 3) throw new Error('zeroclaw exited with 1');
      return { stdout: 'done' };
    };
    const ok = await runZeroClawTurn(cfg, workspace, { fetchImpl: fakeFetch, execImpl: flaky, configDir: dir, resumeWaitsMs: [1, 1] });
    expect(ok).toMatchObject({ ok: true, handled: 1 });
    expect(prompts[0]).not.toContain('cut off by an error');
    expect(prompts[2]).toContain('cut off by an error');
    expect(replies).toEqual([]);

    const dead = async () => {
      throw new Error('zeroclaw exited with 1');
    };
    const gaveUp = await runZeroClawTurn(cfg, workspace, { fetchImpl: fakeFetch, execImpl: dead, configDir: dir, resumeWaitsMs: [1] });
    expect(gaveUp.ok).toBe(false);
    expect(replies).toHaveLength(1);
  });

  it('answers when ZeroClaw runs out of tool iterations, with where it got to', async () => {
    // @ts-expect-error .mjs module without d.ts
    const { runZeroClawTurn } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-steps-'));
    const cfg = { agentId: 'a', agentName: 'Scout', agentToken: 't', hubUrl: 'https://parly.dev', llmBaseUrl: 'https://parly.dev/llm/vertex', llmKey: 'k', model: 'm' };
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const fakeFetch = async (_url: string, init: { body: string }) => {
      const { params } = JSON.parse(init.body);
      calls.push(params);
      const text = params.name === 'check_inbox' ? JSON.stringify([{ messageId: 'm1' }]) : '{}';
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text }] } }) };
    };
    const execImpl = async () => ({ stdout: 'Remaining: open the PR.\n\n*Turn stopped: reached maximum tool iterations (60).*\n' });
    const result = await runZeroClawTurn(cfg, { workDir: dir, stateDir: dir }, { fetchImpl: fakeFetch, execImpl, configDir: dir });
    expect(result).toEqual({ ok: false, engine: 'zeroclaw', handled: 1 });
    const reply = calls.find((c) => c.name === 'reply')!;
    expect(reply.arguments.messageId).toBe('m1');
    expect(String(reply.arguments.text)).toContain('Remaining: open the PR.');
  });

  it('names the turn in the model URL, and says so when the hub stopped it at its spending limit', async () => {
    // @ts-expect-error .mjs module without d.ts
    const { runZeroClawTurn, buildZeroClawConfig } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-budget-'));
    const cfg = { agentId: 'a', agentName: 'Scout', agentToken: 't', hubUrl: 'https://parly.dev', llmBaseUrl: 'https://parly.dev/llm/vertex', llmKey: 'k', model: 'm' };
    expect(buildZeroClawConfig({ ...cfg, turnId: 'turn-abc123' }, { workDir: dir, stateDir: dir })).toContain('uri = "https://parly.dev/llm/openai/turn/turn-abc123"');
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const fakeFetch = async (_url: string, init: { body: string }) => {
      const { params } = JSON.parse(init.body);
      calls.push(params);
      const text = params.name === 'check_inbox' ? JSON.stringify([{ messageId: 'm1' }]) : '{}';
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text }] } }) };
    };
    let runs = 0;
    const execImpl = async () => ((runs += 1), { stdout: 'Cloned and patched; tests left.\nTurn stopped: reached its spending limit ($45.00).\n' });
    const result = await runZeroClawTurn(cfg, { workDir: dir, stateDir: dir }, { fetchImpl: fakeFetch, execImpl, configDir: dir, turnId: 'turn-xyz789' });
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toContain('/llm/openai/turn/turn-xyz789"');
    expect(result).toEqual({ ok: false, engine: 'zeroclaw', handled: 1 });
    // Not resumed: starting over would only hit the same limit.
    expect(runs).toBe(1);
    const reply = calls.find((c) => c.name === 'reply')!;
    expect(String(reply.arguments.text)).toContain("I reached this turn's spending limit before finishing.");
    expect(String(reply.arguments.text)).toContain('Cloned and patched; tests left.');
    expect(String(reply.arguments.text)).not.toContain('Turn stopped');
  });

  it("says what a failed turn tried, from ZeroClaw's trace", async () => {
    // @ts-expect-error .mjs module without d.ts
    const { whatItTried } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zc-trace-')), 'runtime-trace.jsonl');
    const ev = (o: object) => JSON.stringify(o);
    fs.writeFileSync(
      file,
      [
        ev({ attributes: { trace_id: 'old', tool: 'shell' } }),
        ev({ attributes: { trace_id: 't2', tool: 'file_read' } }),
        ev({ attributes: { trace_id: 't2', tool: 'file_read' } }),
        ev({ attributes: { trace_id: 't2', tool: 'a2a-hub__find_tools' } }),
        ev({ attributes: { trace_id: 't2' }, message: 'tool_loop_exhausted' }),
        'not json',
      ].join('\n'),
    );
    expect(whatItTried(file)).toBe('I ran out of steps before I could answer. I tried: file_read ×2, find_tools.');
    expect(whatItTried(file + '.missing')).toBe('');
  });

  it('strips PARLY_AGENT_TOKEN and PARLY_LLM_KEY from the ZeroClaw child env', async () => {
    // @ts-expect-error .mjs module without d.ts
    const { runZeroClawTurn } = await import('../containers/parly-agent/parly-agent-runner.mjs');
    const prevToken = process.env.PARLY_AGENT_TOKEN;
    const prevKey = process.env.PARLY_LLM_KEY;
    const prevId = process.env.PARLY_AGENT_ID;
    try {
      process.env.PARLY_AGENT_ID = 'agent-env-strip';
      process.env.PARLY_AGENT_TOKEN = 'leaked-token';
      process.env.PARLY_LLM_KEY = 'leaked-key';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-strip-'));
      let childEnv: Record<string, string | undefined> = {};
      await runZeroClawTurn(
        {
          agentId: 'agent-env-strip',
          agentName: 'Agent',
          agentToken: 'secret-agent-token',
          hubUrl: 'https://parly.dev',
          llmBaseUrl: 'https://parly.dev/llm/vertex',
          llmKey: 'secret-llm-key',
          model: 'gemini-4-argon',
        },
        { workDir: dir, stateDir: dir },
        {
          configDir: dir,
          fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify([{ messageId: 'm1' }]) }] } }) }),
          execImpl: async (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
            childEnv = opts.env;
            return { stdout: 'done' };
          },
        },
      );
      expect(childEnv.PARLY_AGENT_TOKEN).toBeUndefined();
      expect(childEnv.PARLY_LLM_KEY).toBeUndefined();
      expect(childEnv.PARLY_AGENT_ID).toBe('agent-env-strip');
    } finally {
      if (prevToken === undefined) delete process.env.PARLY_AGENT_TOKEN;
      else process.env.PARLY_AGENT_TOKEN = prevToken;
      if (prevKey === undefined) delete process.env.PARLY_LLM_KEY;
      else process.env.PARLY_LLM_KEY = prevKey;
      if (prevId === undefined) delete process.env.PARLY_AGENT_ID;
      else process.env.PARLY_AGENT_ID = prevId;
    }
  });
});
