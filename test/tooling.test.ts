import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

// The public mirror (scripts/public-tree.sh) strips deploy-only files; their checks run in the private repo only.
const privateOnly = (...files: string[]) => it.skipIf(!files.every((f) => existsSync(f)));

const repo = process.cwd();
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'parly tooling '));
  dirs.push(dir);
  return dir;
};
const executable = (file: string, text: string) => writeFileSync(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

privateOnly('cloudbuild/ci-hub.yaml')('CI stops before npm when Mongo never becomes primary', () => {
  const bin = temp();
  executable(join(bin, 'docker'), 'case "$*" in *isWritablePrimary*) exit 1;; *) exit 0;; esac');
  executable(join(bin, 'sleep'), 'exit 0');
  executable(join(bin, 'npm'), 'echo npm-ran');
  executable(join(bin, 'apt-get'), 'exit 0');
  const yaml = readFileSync('cloudbuild/ci-hub.yaml', 'utf8');
  const script = yaml.split('      - |\n').slice(1).map((part) => part.split(/\n  - name:|\ntimeout:/)[0]).join('\n').replaceAll('$$', '$');
  const result = spawnSync('bash', ['-ec', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('npm-ran');
  executable(join(bin, 'docker'), 'exit 0');
  const ready = spawnSync('bash', ['-ec', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  expect(ready.status).toBe(0);
  expect(ready.stdout).toContain('npm-ran');
});

it('metadata token parsing accepts formatted JSON and rejects missing tokens', () => {
  const bin = temp();
  const entrypoint = readFileSync('containers/parly-agent/entrypoint.sh', 'utf8');
  const fn = entrypoint.match(/^  token\(\).*$/m)![0];
  const run = (json: string) => {
    executable(join(bin, 'curl'), `cat <<'JSON'\n${json}\nJSON`);
    return spawnSync('bash', ['-euc', `${fn}\ntoken`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  };
  expect(run('{\n  "expires_in": 3600,\n  "access_token": "test-token"\n}').stdout.trim()).toBe('test-token');
  for (const json of ['{}', '{"access_token": ""}', '{"access_token": null}', 'invalid']) expect(run(json).status).not.toBe(0);
});

it('Cursor hooks work from a workspace and Antigravity hooks from its plugin root', () => {
  const cwd = temp();
  const config = temp();
  for (const client of ['cursor', 'antigravity']) {
    const hooks = JSON.parse(readFileSync(`plugins/parly/${client}/hooks.json`, 'utf8'));
    for (const hook of Object.values(hooks.hooks ?? hooks.parly).flat() as { command: string }[]) {
      const result = spawnSync('sh', ['-c', hook.command], {
        cwd: client === 'cursor' ? cwd : resolve('plugins/parly'), input: '{}', encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: config, CURSOR_PLUGIN_ROOT: resolve('plugins/parly') },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
    }
  }
});

privateOnly('scripts/setup-cloud-build.sh')('Cloud Build setup never prompts for confirmation', () => {
  const bin = temp();
  executable(join(bin, 'gcloud'), 'for arg do [ "$arg" = --quiet ] && exit 0; done; exit 1');
  const fn = readFileSync('scripts/setup-cloud-build.sh', 'utf8').match(/^gc\(\).*$/m)![0];
  const result = spawnSync('bash', ['-euc', `PROJECT=test\n${fn}\ngc builds connections create github test`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  expect(result.status).toBe(0);
});

it('Cline hooks and MCP settings survive moving Node on PATH', () => {
  const home = temp();
  const bin = temp();
  const oldNode = join(bin, 'node');
  executable(oldNode, `exec "${process.execPath}" "$@"`);
  executable(join(bin, 'curl'), `printf 'console.log("hook-ran")\\n' > "$2"`);
  executable(join(bin, 'code'), 'exit 0');
  const settings = join(home, '.cline/data/settings');
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, 'cline_mcp_settings.json'), '{}');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:/usr/bin:/bin` };
  execFileSync('sh', ['plugins/parly/cline/install.sh', 'https://example.invalid'], { env });
  rmSync(oldNode);
  const newBin = temp();
  executable(join(newBin, 'node'), `exec "${process.execPath}" "$@"`);
  const output = execFileSync('sh', [join(home, 'Documents/Cline/Hooks/TaskComplete')], { env: { ...env, PATH: `${newBin}:${env.PATH}` }, encoding: 'utf8' });
  expect(output.trim()).toBe('hook-ran');
  expect(JSON.parse(readFileSync(join(settings, 'cline_mcp_settings.json'), 'utf8')).mcpServers.parly.command).toBe('node');
});

it('the shipped VS Code extension bundles the current shared helper', () => {
  execFileSync(process.execPath, ['web/scripts/build-plugins.mjs']);
  const bundled = execFileSync('unzip', ['-p', 'web/public/plugins/parly.vsix', 'extension/common.mjs']);
  expect(bundled.equals(readFileSync(join(repo, 'plugins/parly/bin/common.mjs')))).toBe(true);
});

it('Node and TypeScript version requirements stay aligned across the repo', () => {
  expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('22');
  const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const webPkg = JSON.parse(readFileSync('web/package.json', 'utf8'));
  expect(rootPkg.engines?.node).toBe('>=22');
  expect(webPkg.engines?.node).toBe('>=22');
  expect(webPkg.devDependencies?.typescript).toBe(rootPkg.devDependencies?.typescript);
  for (const pkg of [rootPkg, webPkg]) {
    const typesNode = pkg.devDependencies?.['@types/node'] as string | undefined;
    expect(typesNode, '@types/node').toMatch(/^\^?22(\.|$)/);
  }
  for (const file of ['Dockerfile', 'web/Dockerfile', 'containers/parly-agent/Dockerfile']) {
    const froms = [...readFileSync(file, 'utf8').matchAll(/^FROM\s+node:(\S+)/gm)].map((m) => m[1]!);
    expect(froms.length, file).toBeGreaterThan(0);
    for (const tag of froms) expect(tag, file).toMatch(/^22-slim(@sha256:[0-9a-f]{64})?$/);
  }
  const pluginsReadme = readFileSync('plugins/README.md', 'utf8');
  expect(pluginsReadme).toContain('Node 22+');
  expect(pluginsReadme).not.toContain('Node 20+');
});

privateOnly('scripts/setup-cloud-build.sh', 'scripts/setup-gke.sh', 'slack/manifest.staging.json')('deployment scripts and staging manifest do not hard-code project or preview URLs', () => {
  for (const script of ['scripts/setup-cloud-build.sh', 'scripts/setup-gke.sh']) {
    const res = spawnSync('bash', [script], { env: { PATH: process.env.PATH, HUB_SA: 'hub@test.iam.gserviceaccount.com' }, encoding: 'utf8' });
    expect(res.status, script).not.toBe(0);
    expect(res.stderr, script).toContain('PROJECT');
  }
  for (const file of ['scripts/setup-cloud-build.sh', 'scripts/setup-gke.sh', 'README.md', 'slack/manifest.staging.json']) {
    const content = readFileSync(file, 'utf8');
    expect(content, file).not.toMatch(/a2a-hub-\d{6}/);
    expect(content, file).not.toMatch(/\.a\.run\.app/);
    expect(content, file).not.toMatch(/-projects\.vercel\.app/);
  }
});

it('container base images and database images are pinned by sha256 digest', () => {
  for (const file of ['Dockerfile', 'web/Dockerfile', 'containers/parly-agent/Dockerfile']) {
    const froms = [...readFileSync(file, 'utf8').matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
    expect(froms.length).toBeGreaterThan(0);
    for (const image of froms) expect(image, file).toMatch(/@sha256:[0-9a-f]{64}$/);
  }
  const compose = readFileSync('docker-compose.yml', 'utf8');
  if (existsSync('cloudbuild/ci-hub.yaml')) {
    const ciMongo = readFileSync('cloudbuild/ci-hub.yaml', 'utf8').match(/mongo:7@sha256:[0-9a-f]{64}/)?.[0];
    expect(ciMongo).toBeDefined();
    expect(compose).toContain(`image: ${ciMongo}`);
  }
  expect(compose).toContain('MONGODB_URI: mongodb://127.0.0.1:27017/?replicaSet=rs0');
});

it('ships .github maintenance files (dependabot, CODEOWNERS, PR template)', () => {
  const dependabot = readFileSync('.github/dependabot.yml', 'utf8');
  for (const dir of ['"/"', '"/web"', '"/plugins/vscode-extension"', '"/containers/parly-agent"']) {
    expect(dependabot).toContain(`directory: ${dir}`);
  }
  expect(dependabot).toContain('package-ecosystem: "npm"');
  expect(dependabot).toContain('package-ecosystem: "docker"');
  expect(dependabot).toContain('dependency-name: "@types/node"');
  expect(dependabot).toContain('versions: [">=23"]');
  expect(dependabot).toContain('dependency-name: "node"');
  expect(dependabot).toContain('update-types: ["version-update:semver-major"]');
  expect(readFileSync('.github/CODEOWNERS', 'utf8')).toContain('@malachico');
  expect(readFileSync('.github/pull_request_template.md', 'utf8')).toContain('## Verification');
});

privateOnly('scripts/setup-staging-deploy.sh', 'cloudbuild/deploy-hub.yaml', 'scripts/deploy.sh')('staging deploy mounts MONGODB_URI=mongodb-uri-staging:latest', () => {
  const bin = temp();
  const log = join(bin, 'gcloud.log');
  executable(join(bin, 'gcloud'), `if [ "$1 $2" = "projects describe" ]; then echo 12345; else printf '%s\\n' "$*" >> "${log}"; fi`);
  const stagingRes = spawnSync('bash', ['scripts/setup-staging-deploy.sh'], {
    env: { ...process.env, PROJECT: 'test', PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  expect(stagingRes.status, stagingRes.stderr).toBe(0);
  const stagingCalls = readFileSync(log, 'utf8');
  expect(stagingCalls).toContain('secrets add-iam-policy-binding mongodb-uri-staging --member=serviceAccount:hub-staging-run@test.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor');
  expect(stagingCalls).toContain('secrets remove-iam-policy-binding mongodb-uri-staging --member=serviceAccount:12345-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor');
  expect(stagingCalls).toContain('--update-secrets=MONGODB_URI=mongodb-uri-staging:latest');
  expect(stagingCalls).not.toContain('--set-secrets');

  const deployYaml = readFileSync('cloudbuild/deploy-hub.yaml', 'utf8');
  const deployStep = deployYaml.split('      - |\n')[1]!.split('\nimages:')[0]!.replaceAll('$$', '$');
  for (const service of ['a2a-hub-staging', 'a2a-hub']) {
    writeFileSync(log, '');
    const res = spawnSync('bash', ['-ec', deployStep], {
      env: { ...process.env, _SERVICE: service, LOCATION: 'us-central1', PROJECT_ID: 'test', COMMIT_SHA: 'abc', PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    const out = readFileSync(log, 'utf8').trim();
    if (service === 'a2a-hub-staging') {
      expect(out).toContain('--update-secrets=MONGODB_URI=mongodb-uri-staging:latest');
      expect(out).not.toContain('--set-secrets');
    } else {
      expect(out).not.toContain('mongodb-uri-staging');
    }
  }

  const deploySh = readFileSync('scripts/deploy.sh', 'utf8');
  expect(deploySh).toContain('--update-secrets MONGODB_URI=mongodb-uri-staging:latest');
  expect(deploySh).not.toContain('--set-secrets');
});

