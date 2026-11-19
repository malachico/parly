#!/usr/bin/env node
// Packages the plugin into public/plugins/ (git-ignored), before `next build`: as a ZIP for the
// Claude Code marketplace this site serves, and as a static Git repository (parly.git, read over
// Git's "dumb" HTTP protocol) that is the Codex marketplace, since Codex only adds marketplaces from
// Git. No dependencies and no `git` binary: a small ZIP writer and loose Git objects via zlib.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const plugin = join(repo, 'plugins', 'parly');
const out = join(here, '..', 'public', 'plugins');

if (!existsSync(join(plugin, '.claude-plugin', 'plugin.json'))) {
  console.error(`build-plugins: ${plugin} not found. The web app must be built from a checkout of the whole repository.`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The archive's root folder is the plugin name, as `claude plugin` expects of a plugin directory.
const files = walk(plugin).map((abs) => ({ name: `${manifest.name}/${relative(plugin, abs).split('\\').join('/')}`, data: readFileSync(abs) }));
const zip = buildZip(files);
const zipName = `${manifest.name}-claude-code.zip`;
writeFileSync(join(out, zipName), zip);

// The Codex marketplace: the plugin under parly/, beside a marketplace that lists it. Codex reads Claude's marketplace format.
const marketplace = {
  name: 'parly',
  owner: { name: 'Parly' },
  plugins: [{ name: manifest.name, description: manifest.description, version: manifest.version, source: `./${manifest.name}` }],
};
const commit = writeGitRepo(join(out, 'parly.git'), [
  { name: '.claude-plugin/marketplace.json', data: Buffer.from(JSON.stringify(marketplace, null, 2) + '\n') },
  ...files,
]);

// VS Code installs a plugin from a Git URL, with the plugin at the repository's root. It reads Claude's layout,
// so its own hooks (no background listener: VS Code would wait on it) and MCP config take Claude's places.
const vscodeFiles = [
  ...files.filter((f) => f.name.startsWith(`${manifest.name}/bin/`)).map((f) => ({ ...f, name: f.name.slice(manifest.name.length + 1) })),
  {
    name: '.claude-plugin/plugin.json',
    data: Buffer.from(JSON.stringify({ ...manifest, description: 'Messages from other agents and people on Parly, in Copilot Chat: new mail is shown when a session starts and before the agent stops, and the hub\'s tools let you answer.' }, null, 2) + '\n'),
  },
  { name: 'hooks/hooks.json', data: readFileSync(join(plugin, 'vscode', 'hooks.json')) },
  { name: '.mcp.json', data: readFileSync(join(plugin, 'vscode', 'mcp.json')) },
];
const vscodeCommit = writeGitRepo(join(out, 'parly-vscode.git'), vscodeFiles);

// Cursor: its own plugin layout, cloned into ~/.cursor/plugins/local. Stop hooks run from the workspace root.
// ponytail: local install until the plugin is in Cursor's marketplace (which wants an open-source repo).
writeGitRepo(join(out, 'parly-cursor.git'), [
  ...vscodeFiles.filter((f) => f.name.startsWith('bin/')),
  {
    name: '.cursor-plugin/plugin.json',
    // Its own name: Cursor also imports Claude Code's plugins, and of two named the same it starts Claude's, which signs in as Claude Code.
    data: Buffer.from(JSON.stringify({ name: 'parly-cursor', displayName: 'Parly', version: manifest.version, description: 'Messages from other agents and people on Parly, in Cursor: new mail is shown when a chat starts, after tool calls and before the agent stops, and the hub\'s tools let you answer.' }, null, 2) + '\n'),
  },
  { name: 'hooks/hooks.json', data: readFileSync(join(plugin, 'cursor', 'hooks.json')) },
  { name: 'mcp.json', data: readFileSync(join(plugin, 'cursor', 'mcp.json')) },
]);

// Cline has no plugins: an install script (served beside the scripts it downloads) puts them in place, with Cline hooks.
mkdirSync(join(out, 'cline'));
for (const f of ['common.mjs', 'hub-connect.mjs', 'hub-events.mjs', 'hub-mcp.mjs', 'workers.mjs']) writeFileSync(join(out, 'cline', f), readFileSync(join(plugin, 'bin', f)));
writeFileSync(join(out, 'cline-install.sh'), readFileSync(join(plugin, 'cline', 'install.sh')));

// Cline's CLI, Kanban and Desktop do have plugins: `cline plugin install <site>/plugins/parly-cline.git` clones this
// (Git's dumb HTTP protocol, like parly.git), with the package at the root and the scripts it runs in bin/.
const clineDir = join(plugin, 'cline-plugin');
const clineCommit = writeGitRepo(join(out, 'parly-cline.git'), [
  ...['package.json', 'index.js', 'shell.js'].map((name) => ({ name, data: readFileSync(join(clineDir, name)) })),
  ...files.filter((f) => f.name.startsWith(`${manifest.name}/bin/`)).map((f) => ({ ...f, name: f.name.slice(manifest.name.length + 1) })),
]);

// OpenCode loads plugins from its plugins folder: an install script puts parly.js there, with the scripts in parly/bin.
mkdirSync(join(out, 'opencode', 'bin'), { recursive: true });
writeFileSync(join(out, 'opencode', 'parly.js'), readFileSync(join(plugin, 'opencode', 'parly.js')));
for (const f of ['common.mjs', 'hub-connect.mjs', 'hub-events.mjs', 'hub-mcp.mjs', 'workers.mjs']) writeFileSync(join(out, 'opencode', 'bin', f), readFileSync(join(plugin, 'bin', f)));
writeFileSync(join(out, 'opencode-install.sh'), readFileSync(join(plugin, 'opencode', 'install.sh')));

// The VS Code extension that wakes an idle Copilot Chat, as a .vsix (a ZIP with a manifest), with the plugin's common.mjs.
const extDir = join(repo, 'plugins', 'vscode-extension');
const ext = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8'));
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
writeFileSync(
  join(out, 'parly.vsix'),
  buildZip([
    {
      name: 'extension.vsixmanifest',
      data: Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${ext.name}" Version="${ext.version}" Publisher="${ext.publisher}" />
    <DisplayName>${xml(ext.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(ext.description)}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${ext.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`,
      ),
    },
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".mjs" ContentType="application/javascript"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>',
      ),
    },
    { name: 'extension/package.json', data: readFileSync(join(extDir, 'package.json')) },
    { name: 'extension/extension.js', data: readFileSync(join(extDir, 'extension.js')) },
    { name: 'extension/common.mjs', data: readFileSync(join(plugin, 'bin', 'common.mjs')) },
  ]),
);

writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify({ name: manifest.name, version: manifest.version, description: manifest.description, zip: zipName, sha256: createHash('sha256').update(zip).digest('hex') }, null, 2) + '\n',
);
console.log(`build-plugins: ${zipName} parly.git (${commit.slice(0, 7)}), parly-vscode.git (${vscodeCommit.slice(0, 7)}) and parly-cline.git (${clineCommit.slice(0, 7)}) with ${files.length} files, v${manifest.version}, are in public/plugins/`);

function walk(dir) {
  const result = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) result.push(...walk(abs));
    else result.push(abs);
  }
  return result;
}

/**
 * A bare Git repository with one commit holding `{name, data}` files on `main`, servable as static files
 * (Git's dumb HTTP protocol: HEAD, info/refs and loose objects). The commit is a fixed time and author,
 * so the same files give the same commit and an unchanged plugin is no update. Returns the commit id.
 */
function writeGitRepo(dir, entries) {
  const object = (type, body) => {
    const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const id = createHash('sha1').update(raw).digest('hex');
    mkdirSync(join(dir, 'objects', id.slice(0, 2)), { recursive: true });
    writeFileSync(join(dir, 'objects', id.slice(0, 2), id.slice(2)), deflateSync(raw));
    return id;
  };
  // A folder: `{ name: id-or-folder }`, written depth first. Git orders entries by name, a folder's as `name/`.
  const root = {};
  for (const { name, data } of entries) {
    const parts = name.split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)] = { blob: object('blob', data), exec: name.endsWith('.mjs') || name.endsWith('.sh') };
  }
  const tree = (node) => {
    const rows = Object.entries(node).map(([name, v]) =>
      v.blob ? { key: name, mode: v.exec ? '100755' : '100644', name, id: v.blob } : { key: `${name}/`, mode: '40000', name, id: tree(v) },
    );
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return object('tree', Buffer.concat(rows.flatMap((r) => [Buffer.from(`${r.mode} ${r.name}\0`), Buffer.from(r.id, 'hex')])));
  };
  const who = 'Parly <plugins@parly.dev> 0 +0000';
  const commit = object('commit', Buffer.from(`tree ${tree(root)}\nauthor ${who}\ncommitter ${who}\n\nThe Parly plugin\n`));
  mkdirSync(join(dir, 'refs', 'heads'), { recursive: true });
  mkdirSync(join(dir, 'info'), { recursive: true });
  mkdirSync(join(dir, 'objects', 'info'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'refs', 'heads', 'main'), `${commit}\n`);
  writeFileSync(join(dir, 'info', 'refs'), `${commit}\trefs/heads/main\n`);
  writeFileSync(join(dir, 'objects', 'info', 'packs'), '');
  return commit;
}

/** A ZIP file (deflate, no encryption) from `{name, data}` entries. */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const time = dosTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time.t, 10);
    local.writeUInt16LE(time.d, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time.t, 12);
    central.writeUInt16LE(time.d, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((name.endsWith('.mjs') || name.endsWith('.sh') ? 0o100755 : 0o100644) << 16) >>> 0, 38); // unix mode
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function dosTime(d) {
  return {
    t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    d: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
