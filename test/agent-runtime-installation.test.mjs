import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { c as createTar, Header } from 'tar';
import { AgentRuntimeInstallation, extractRuntimeArchive } from '../desktop/agents/runtime-installation.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archives = new Map();
  async function pkg(name, files) {
    const source = path.join(root, name), archive = `${source}.tgz`;
    await mkdir(path.join(source, 'package'), { recursive: true });
    for (const [file, text] of Object.entries({ 'package.json': JSON.stringify({ name, version: '1.0.0', type: 'module' }), ...files })) {
      await mkdir(path.dirname(path.join(source, 'package', file)), { recursive: true });
      await writeFile(path.join(source, 'package', file), text);
    }
    await createTar({ file: archive, cwd: source, gzip: true }, ['package']);
    const data = await readFile(archive), url = `https://registry.npmjs.org/${name}/-/${name}.tgz`;
    archives.set(url, data);
    return { directory: `node_modules/${name}`, version: '1.0.0', url, integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` };
  }
  const sdk = await pkg('fixture-sdk', { 'sdk.mjs': 'export function query() { return "fixture"; }' });
  const native = { ...await pkg('fixture-native', { 'claude.exe': 'fixture native bytes' }), executable: 'claude.exe' };
  const catalog = { claude: { version: '1.0.0', sdk: `${sdk.directory}/sdk.mjs`, packages: [sdk], natives: { 'win32-x64': native } } };
  const calls = [], probes = [], progress = [];
  const options = { root: path.join(root, 'installed'), sourceRoot: path.join(root, 'absent'), catalog, platform: 'win32', arch: 'x64',
    getPreferences: () => ({}), resolveLocal: async () => '', probe: async file => { probes.push(file); },
    fetch: async url => { calls.push(url); return new Response(archives.get(url)); } };
  return { root, catalog, archives, calls, probes, progress, options, sdk, native, pkg };
}
test('initialization never downloads; explicit prepare verifies and installs once; restart works offline', async t => {
  const f = await fixture(t), installer = new AgentRuntimeInstallation(f.options);
  assert.equal(f.calls.length, 0);
  assert.equal(await installer.inspect('claude'), 'missing');
  assert.equal(f.probes.length, 0, 'inventory never runs or downloads a component');
  assert.equal(f.calls.length, 0);
  await assert.rejects(installer.prepare('claude'), /缺失/); assert.equal(f.calls.length, 0);
  const result = await installer.prepare('claude', { allowDownload: true, onProgress: value => f.progress.push(value) });
  assert.equal(result.module.query(), 'fixture'); assert.equal(f.calls.length, 2);
  assert.equal(await installer.inspect('claude'), 'ready');
  assert.ok(f.progress.some(value => value.phase === 'downloading'));
  const restored = new AgentRuntimeInstallation(f.options);
  await restored.prepare('claude'); assert.equal(f.calls.length, 2);
  assert.equal((await readdir(path.join(f.options.root, 'claude', '1.0.0'))).some(name => name.startsWith('.install')), false);
});
test('existing local executable is preferred and no native package is downloaded', async t => {
  const f = await fixture(t);
  const installer = new AgentRuntimeInstallation({ ...f.options, resolveLocal: async () => '/existing/claude' });
  const result = await installer.prepare('claude', { allowDownload: true });
  assert.equal(result.executable, '/existing/claude'); assert.deepEqual(f.calls, [f.sdk.url]);
});
test('slow parent installation cannot erase an already downloaded nested dependency', async t => {
  const f = await fixture(t);
  const parent = await f.pkg('parent-sdk', { 'sdk.mjs': "export { query } from './node_modules/child-sdk/child.mjs';" });
  const child = await f.pkg('child-sdk', { 'child.mjs': 'export function query() { return "nested"; }' });
  child.directory = `${parent.directory}/node_modules/child-sdk`;
  f.catalog.claude.packages = [child, parent];
  f.catalog.claude.sdk = `${parent.directory}/sdk.mjs`;
  const installer = new AgentRuntimeInstallation({ ...f.options, fetch: async url => {
    if (url === parent.url) await new Promise(resolve => setTimeout(resolve, 40));
    return new Response(f.archives.get(url));
  } });
  assert.equal((await installer.prepare('claude', { allowDownload: true })).module.query(), 'nested');
});
test('integrity failure never publishes partial packages; retry recovers', async t => {
  const f = await fixture(t), original = f.archives.get(f.sdk.url);
  f.archives.set(f.sdk.url, Buffer.from('bad download'));
  const installer = new AgentRuntimeInstallation(f.options);
  await assert.rejects(installer.prepare('claude', { allowDownload: true }), /完整性/);
  assert.throws(() => installer.get('claude'), /请先/);
  assert.deepEqual(await readdir(path.join(f.options.root, 'claude', '1.0.0')), []);
  f.archives.set(f.sdk.url, original);
  assert.equal((await installer.prepare('claude', { allowDownload: true })).module.query(), 'fixture');
});
test('cancelled downloads leave no partial installation or late background writes', async t => {
  const f = await fixture(t), abort = new AbortController();
  const installer = new AgentRuntimeInstallation({ ...f.options, fetch: async () => { abort.abort(); abort.signal.throwIfAborted(); } });
  await assert.rejects(installer.prepare('claude', { allowDownload: true, signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(path.join(f.options.root, 'claude', '1.0.0')), []);
});
test('archives cannot extract links or path traversal', async t => {
  const f = await fixture(t), out = path.join(f.root, 'extract'); await mkdir(out);
  for (const [name, type, linkpath] of [['package/../../escape', 'File', ''], ['package/link', 'SymbolicLink', '../escape']]) {
    const header = new Header({ path: name, type, linkpath, size: 0, mode: 0o644 });
    const block = Buffer.alloc(512); header.encode(block);
    const archive = path.join(f.root, 'unsafe.tar'); await writeFile(archive, Buffer.concat([block, Buffer.alloc(1024)]));
    await assert.rejects(extractRuntimeArchive(archive, out));
    assert.deepEqual(await readdir(out), []);
  }
});
test('installer manifest is pinned while application dependencies contain neither SDK nor native agent packages', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'], undefined);
  assert.equal(pkg.dependencies['@openai/codex-sdk'], undefined);
  assert.ok(!Object.keys(lock.packages).some(key => /node_modules\/(?:@openai\/codex|@anthropic-ai\/claude-agent-sdk)/.test(key)));
  const manifest = JSON.parse(await readFile(new URL('../desktop/agents/runtime-manifest.json', import.meta.url), 'utf8'));
  for (const source of Object.values(manifest)) for (const artifact of [...source.packages, ...Object.values(source.natives)]) {
    assert.match(artifact.url, /^https:\/\/registry\.npmjs\.org\//); assert.match(artifact.integrity, /^sha512-/);
  }
});
