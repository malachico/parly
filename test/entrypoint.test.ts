import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fs.readFileSync('containers/parly-agent/entrypoint.sh', 'utf8');
let tmp: string;

/** Runs the pod's entrypoint in a temp folder, with a fake GCS (`curl`) answering `code` to the restore. */
function pod(code: string, archive?: string) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const fake = `#!/bin/bash
out=/dev/null; for ((i=1;i<=$#;i++)); do [ "\${!i}" = -o ] && { j=$((i+1)); out=\${!j}; }; done
case "$*" in
  *metadata*) echo '{"access_token":"t"}' ;;
  *uploadType=media*) cp ${tmp}/run/home.tgz ${tmp}/uploaded.tgz; echo x >> ${tmp}/uploads ;;
  *) ${archive ? `cp ${archive} "$out"` : ':'}; printf ${code} ;;
esac
`;
  fs.writeFileSync(path.join(bin, 'curl'), fake, { mode: 0o755 });
  const script = path.join(tmp, 'entrypoint.sh');
  const runner = path.join(bin, 'runner');
  // The agent's turn: it makes a file, then waits for mail for as long as the pod lives.
  fs.writeFileSync(runner, `#!/bin/bash\necho work > ${tmp}/home/agents/a1/made\nexec sleep 60\n`, { mode: 0o755 });
  const body = SCRIPT.replaceAll('/usr/local/bin/parly-agent-runner', runner).replaceAll('/home/agent', `${tmp}/home`).replaceAll('/run/parly', `${tmp}/run`).replaceAll('sleep 5', 'sleep 0.05');
  fs.writeFileSync(script, body, { mode: 0o755 });
  const child = spawn('bash', [script], {
    env: { PATH: `${bin}:${process.env.PATH}`, PARLY_AGENT_ID: 'a1', PARLY_HOMES_BUCKET: 'b', PARLY_SAVE_SECONDS: '3600' },
    stdio: 'ignore',
  });
  const stopped = new Promise((done) => child.on('exit', done));
  return { child, stopped };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
};

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the hosted pod keeps its files', () => {
  it('saves work from a turn still running when the pod is told to stop', async () => {
    const { child, stopped } = pod('404');
    await until(() => fs.existsSync(path.join(tmp, 'home/agents/a1/made')));
    child.kill('SIGTERM');
    await stopped;
    expect(execFileSync('tar', ['tzf', path.join(tmp, 'uploaded.tgz')]).toString()).toContain('made');
  });

  it("doesn't save over a home it couldn't restore", async () => {
    const { child, stopped } = pod('503');
    await until(() => fs.existsSync(path.join(tmp, 'run/nosave')));
    await until(() => fs.existsSync(path.join(tmp, 'home/agents/a1/made')));
    child.kill('SIGTERM');
    await stopped;
    expect(fs.existsSync(path.join(tmp, 'uploads'))).toBe(false);
  });

  it('stops the runner before the final save, and takes a final snapshot even if a save was underway when TERM arrived', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    // On the first upload, if the runner is still alive, signal it to write `late` before the upload finishes.
    const fake = `#!/bin/bash
out=/dev/null; for ((i=1;i<=$#;i++)); do [ "\${!i}" = -o ] && { j=$((i+1)); out=\${!j}; }; done
case "$*" in
  *metadata*) echo '{"access_token":"t"}' ;;
  *uploadType=media*)
    if [ ! -e ${tmp}/first-upload ] && [ -f ${tmp}/runner.pid ] && kill -0 "$(cat ${tmp}/runner.pid)" 2>/dev/null; then
      touch ${tmp}/first-upload
      echo late-from-live-runner > ${tmp}/home/agents/a1/late
    fi
    cp ${tmp}/run/home.tgz ${tmp}/uploaded.tgz
    echo x >> ${tmp}/uploads
    ;;
  *) printf 404 ;;
esac
`;
    fs.writeFileSync(path.join(bin, 'curl'), fake, { mode: 0o755 });
    const script = path.join(tmp, 'entrypoint.sh');
    const runner = path.join(bin, 'runner');
    fs.writeFileSync(
      runner,
      `#!/bin/bash
echo $$ > ${tmp}/runner.pid
(
  trap 'sleep 0.3; echo child-flushed > ${tmp}/home/agents/a1/child-flush; exit 0' TERM INT
  touch ${tmp}/child-ready
  sleep 60 &
  wait $!
) &
trap 'echo flushed-on-term > ${tmp}/home/agents/a1/flushed; rm -f ${tmp}/runner.pid; exit 0' TERM INT
echo first > ${tmp}/home/agents/a1/first
sleep 60 &
wait $!
`,
      { mode: 0o755 },
    );
    const body = SCRIPT.replaceAll('/usr/local/bin/parly-agent-runner', runner)
      .replaceAll('/home/agent', `${tmp}/home`)
      .replaceAll('/run/parly', `${tmp}/run`)
      .replaceAll('sleep 5', 'sleep 0.05');
    fs.writeFileSync(script, body, { mode: 0o755 });
    const child = spawn('bash', [script], {
      env: { PATH: `${bin}:${process.env.PATH}`, PARLY_AGENT_ID: 'a1', PARLY_HOMES_BUCKET: 'b', PARLY_SAVE_SECONDS: '3600' },
      stdio: 'ignore',
    });
    const stopped = new Promise((done) => child.on('exit', done));

    await until(() => fs.existsSync(path.join(tmp, 'home/agents/a1/first')) && fs.existsSync(path.join(tmp, 'child-ready')));
    child.kill('SIGTERM');
    await stopped;

    const entries = execFileSync('tar', ['tzf', path.join(tmp, 'uploaded.tgz')]).toString();
    expect(entries).toContain('first');
    expect(entries).toContain('flushed');
    expect(entries).toContain('child-flush');
    expect(fs.existsSync(path.join(tmp, 'home/agents/a1/late'))).toBe(false);
  });

  it('takes a final snapshot after an in-flight periodic upload finishes when TERM arrives mid-upload', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    // The first upload is a periodic save: pause inside curl until the test writes `late` and sends TERM.
    const fake = `#!/bin/bash
out=/dev/null; for ((i=1;i<=$#;i++)); do [ "\${!i}" = -o ] && { j=$((i+1)); out=\${!j}; }; done
case "$*" in
  *metadata*) echo '{"access_token":"t"}' ;;
  *uploadType=media*)
    if [ ! -e ${tmp}/in-periodic ]; then
      touch ${tmp}/in-periodic
      while [ ! -e ${tmp}/release-periodic ]; do sleep 0.02; done
    fi
    cp ${tmp}/run/home.tgz ${tmp}/uploaded.tgz
    echo x >> ${tmp}/uploads
    ;;
  *) printf 404 ;;
esac
`;
    fs.writeFileSync(path.join(bin, 'curl'), fake, { mode: 0o755 });
    const script = path.join(tmp, 'entrypoint.sh');
    const runner = path.join(bin, 'runner');
    fs.writeFileSync(
      runner,
      `#!/bin/bash
trap 'exit 0' TERM INT
while [ ! -e ${tmp}/in-periodic ]; do
  echo first > ${tmp}/home/agents/a1/first
  sleep 0.02
done
echo late > ${tmp}/home/agents/a1/late
touch ${tmp}/wrote-late
sleep 60 &
wait $!
`,
      { mode: 0o755 },
    );
    const body = SCRIPT.replaceAll('/usr/local/bin/parly-agent-runner', runner)
      .replaceAll('/home/agent', `${tmp}/home`)
      .replaceAll('/run/parly', `${tmp}/run`)
      .replaceAll('sleep 5', 'sleep 0.05');
    fs.writeFileSync(script, body, { mode: 0o755 });
    const child = spawn('bash', [script], {
      env: { PATH: `${bin}:${process.env.PATH}`, PARLY_AGENT_ID: 'a1', PARLY_HOMES_BUCKET: 'b', PARLY_SAVE_SECONDS: '5' },
      stdio: 'ignore',
    });
    const stopped = new Promise((done) => child.on('exit', done));

    await until(() => fs.existsSync(path.join(tmp, 'wrote-late')));
    child.kill('SIGTERM');
    fs.writeFileSync(path.join(tmp, 'release-periodic'), '1');
    await stopped;

    const entries = execFileSync('tar', ['tzf', path.join(tmp, 'uploaded.tgz')]).toString();
    expect(entries).toContain('first');
    expect(entries).toContain('late');
  });

  it('writes PARLY_AGENT_TOKEN and PARLY_LLM_KEY to 0400 files under /run/parly and unsets them from the runner env', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/bash\ncase "$*" in *metadata*) echo '{"access_token":"t"}' ;; *) printf 404 ;; esac\n`,
      { mode: 0o755 },
    );
    const runner = path.join(bin, 'runner');
    fs.writeFileSync(
      runner,
      `#!/bin/bash\nprintf '%s|%s' "\${PARLY_AGENT_TOKEN-unset}" "\${PARLY_LLM_KEY-unset}" > ${tmp}/runner-env\nexec sleep 60\n`,
      { mode: 0o755 },
    );
    const script = path.join(tmp, 'entrypoint.sh');
    fs.writeFileSync(
      script,
      SCRIPT.replaceAll('/usr/local/bin/parly-agent-runner', runner)
        .replaceAll('/home/agent', `${tmp}/home`)
        .replaceAll('/run/parly', `${tmp}/run`)
        .replaceAll('sleep 5', 'sleep 0.05'),
      { mode: 0o755 },
    );
    const child = spawn('bash', [script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        PARLY_AGENT_ID: 'a1',
        PARLY_AGENT_TOKEN: 'tok_secret',
        PARLY_LLM_KEY: 'llm_secret',
        PARLY_HOMES_BUCKET: 'b',
        PARLY_SAVE_SECONDS: '3600',
      },
      stdio: 'ignore',
    });
    const stopped = new Promise((done) => child.on('exit', done));
    await until(() => fs.existsSync(path.join(tmp, 'runner-env')));
    child.kill('SIGTERM');
    await stopped;

    expect(fs.readFileSync(path.join(tmp, 'runner-env'), 'utf8')).toBe('unset|unset');
    const tokFile = path.join(tmp, 'run/agents/a1/agent-token');
    const keyFile = path.join(tmp, 'run/agents/a1/llm-key');
    expect(fs.readFileSync(tokFile, 'utf8')).toBe('tok_secret');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('llm_secret');
    expect(fs.statSync(tokFile).mode & 0o777).toBe(0o400);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o400);
  });
});
