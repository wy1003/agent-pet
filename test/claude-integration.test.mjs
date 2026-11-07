import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const api = await import('../desktop/claude/integration.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const events = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd'];
async function fixture(t, settings = {}, global = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pet-集成-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'custom');
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(configDir, '.claude.json'), JSON.stringify(global));
  return { root, configDir, eventsDir: path.join(root, "events ' 中文"), nodePath: process.execPath,
    bridgePath: path.join(root, "hook ' 中文.mjs"),
    mcpConfig: { mcpServers: { 'agent-pet-notebook': { command: process.execPath, args: [path.join(root, 'stdio.mjs'), '--connection', path.join(root, 'connection.json')], env: { ELECTRON_RUN_AS_NODE: '1' } } } } };
}
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('exports integration API', () => {
  for (const name of ['installClaudeIntegration', 'removeClaudeIntegration', 'getClaudeIntegrationStatus', 'previewClaudeIntegration']) assert.equal(typeof api[name], 'function', name);
});

test('custom config merges user MCP outside settings, preserves unknown fields, idempotent and reversible', async t => {
  const original = { permissions: { ask: ['Bash(*)'] }, env: { MY_SETTING: 'keep' }, model: 'chosen', enabledPlugins: { 'a@b': true }, future: [1, 2], statusLine: { type: 'command', command: 'complicated | existing' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'original' }] }] } };
  const global = { projects: { project: { trusted: true } }, mcpServers: { existing: { command: 'keep' } }, future: 3 };
  const o = await fixture(t, original, global);
  const preview = await api.previewClaudeIntegration(o);
  assert.equal(preview.ok, true);
  assert.deepEqual(await json(path.join(o.configDir, 'settings.json')), original);
  assert.equal(preview.paths.mcp, path.join(o.configDir, '.claude.json'));
  assert.equal(preview.preview.mcpServers['agent-pet-notebook'].command, process.execPath);
  const installed = await api.installClaudeIntegration(o);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.changed, true);
  assert.ok(installed.backups.length >= 2);
  const current = await json(installed.paths.settings);
  assert.equal(current.mcpServers, undefined);
  for (const name of events) assert.ok(current.hooks[name].some(g => g.hooks.some(h => JSON.stringify(h).includes('agent-pet:hook:v1'))), name);
  assert.deepEqual(current.statusLine, original.statusLine);
  for (const key of ['permissions', 'env', 'model', 'enabledPlugins', 'future']) assert.deepEqual(current[key], original[key]);
  assert.deepEqual((await json(installed.paths.mcp)).mcpServers.existing, global.mcpServers.existing);
  assert.equal((await api.installClaudeIntegration(o)).changed, false);
  assert.equal((await api.getClaudeIntegrationStatus({ configDir: o.configDir })).state, 'installed');
  current.future.push(3);
  await fs.writeFile(installed.paths.settings, JSON.stringify(current));
  const removed = await api.removeClaudeIntegration({ configDir: o.configDir });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.deepEqual(await json(installed.paths.settings), { ...original, future: [1, 2, 3] });
  assert.deepEqual(await json(installed.paths.mcp), global);
  assert.equal((await api.removeClaudeIntegration({ configDir: o.configDir })).changed, false);
});

test('invalid JSON and malformed relevant fields are never reset', async t => {
  for (const raw of ['{broken', '[]', '{"hooks":null}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[{"hooks":"bad"}]}}']) {
    const o = await fixture(t);
    const file = path.join(o.configDir, 'settings.json');
    await fs.writeFile(file, raw);
    assert.equal((await api.installClaudeIntegration(o)).ok, false, raw);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    assert.deepEqual(await json(path.join(o.configDir, '.claude.json')), {});
  }
  const o = await fixture(t, {}, { mcpServers: [] });
  assert.equal((await api.installClaudeIntegration(o)).ok, false);
});

test('same-name MCP and unowned hook markers are conflicts, even identical MCP content', async t => {
  const o = await fixture(t);
  await fs.writeFile(path.join(o.configDir, '.claude.json'), JSON.stringify({ mcpServers: { 'agent-pet-notebook': o.mcpConfig.mcpServers['agent-pet-notebook'] } }));
  assert.equal((await api.installClaudeIntegration(o)).code, 'CONFLICT');
  await fs.writeFile(path.join(o.configDir, '.claude.json'), '{}');
  await fs.writeFile(path.join(o.configDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-pet:hook:v1 unowned' }] }] } }));
  assert.equal((await api.installClaudeIntegration(o)).code, 'CONFLICT');
});

test('editing or removing an owned entry refuses reinstall and removal without touching other files', async t => {
  for (const target of ['hook', 'mcp', 'missing']) {
    const o = await fixture(t);
    const installed = await api.installClaudeIntegration(o);
    assert.equal(installed.ok, true);
    const file = target === 'mcp' ? installed.paths.mcp : installed.paths.settings;
    const current = await json(file);
    if (target === 'mcp') current.mcpServers['agent-pet-notebook'].args.push('--user-edit');
    else if (target === 'missing') delete current.hooks.Stop;
    else current.hooks.Stop[0].hooks[0].timeout = 99;
    await fs.writeFile(file, JSON.stringify(current));
    const before = await fs.readFile(file, 'utf8');
    assert.equal((await api.getClaudeIntegrationStatus({ configDir: o.configDir })).state, 'modified');
    assert.equal((await api.installClaudeIntegration(o)).ok, false);
    assert.equal((await api.removeClaudeIntegration({ configDir: o.configDir })).ok, false);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('lock prevents concurrent installation', async t => {
  const o = await fixture(t);
  await fs.writeFile(path.join(o.configDir, 'agent-pet-integration.lock'), 'occupied');
  const result = await api.installClaudeIntegration(o);
  assert.equal(result.code, 'BUSY');
  assert.deepEqual(await json(path.join(o.configDir, 'settings.json')), {});
});

test('CLAUDE_CONFIG_DIR is honored without accessing real HOME', async t => {
  const o = await fixture(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = o.configDir;
  try {
    const { configDir, ...rest } = o;
    const result = await api.installClaudeIntegration(rest);
    assert.equal(result.ok, true);
    assert.equal(result.paths.settings, path.join(configDir, 'settings.json'));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('exec-form hooks preserve spaces, Chinese and quotes and never emit approval stdout', async t => {
  const o = await fixture(t);
  const argsPath = path.join(o.root, 'args.json');
  await fs.writeFile(o.bridgePath, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('{"decision":"allow"}'); process.exitCode=2;`);
  const result = await api.previewClaudeIntegration(o);
  assert.equal(result.ok, true);
  const hook = result.preview.hooks.PermissionRequest[0].hooks[0];
  const child = spawnSync(hook.command, hook.args, { input: '{}', encoding: 'utf8', timeout: 10000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: o.root, USERPROFILE: o.root } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.deepEqual(await json(argsPath), ['--events-dir', o.eventsDir]);
  assert.equal(hook.async, undefined, 'bounded synchronous delivery preserves event ordering');
  assert.ok(hook.timeout <= 3);
});

test('optional local CLI probe uses isolated home and verifies user MCP destination', { skip: !process.env.AGENT_PET_TEST_CLAUDE_CLI }, async t => {
  const o = await fixture(t);
  const cli = process.env.AGENT_PET_TEST_CLAUDE_CLI;
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: o.root, TMP: o.root, HOME: o.root, USERPROFILE: o.root, APPDATA: o.root, LOCALAPPDATA: o.root, CLAUDE_CONFIG_DIR: o.configDir, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const version = spawnSync(cli, ['--version'], { cwd: o.root, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(version.status, 0, version.stderr);
  t.diagnostic(version.stdout.trim());
  const result = spawnSync(cli, ['mcp', 'add-json', '--scope', 'user', 'agent-pet-probe', JSON.stringify({ type: 'stdio', command: 'node', args: ['never-executed.mjs'] })], { cwd: o.root, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await json(path.join(o.configDir, '.claude.json'))).mcpServers['agent-pet-probe']);
  assert.equal((await json(path.join(o.configDir, 'settings.json'))).mcpServers, undefined);
});
