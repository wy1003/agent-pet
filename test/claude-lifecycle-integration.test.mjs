import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import mutableFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as api from '../desktop/claude/integration.mjs';

const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'];
const marker = 'agent-pet:lifecycle:v1';
const enhancementEvents = ['PermissionRequest', 'Notification', 'PostToolUse'];
const selectHooks = (hooks, names) => Object.fromEntries(names.map(name => [name, hooks[name]]));
const bridge = fileURLToPath(new URL('../desktop/claude/hook-bridge.mjs', import.meta.url));
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value));
async function fixture(t, settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pet-lifecycle ' 中文-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir);
  const files = { settings: path.join(configDir, 'settings.json'), mcp: path.join(configDir, '.claude.json'),
    record: path.join(configDir, 'agent-pet-lifecycle.json'), legacy: path.join(configDir, 'agent-pet-integration.json') };
  await write(files.settings, settings);
  await fs.writeFile(files.mcp, '{ "mcpServers": {"other": {"command":"keep"}}, "future": true }\n');
  const options = { configDir, nodePath: process.execPath, bridgePath: bridge, eventsDir: path.join(root, "events ' 中文") };
  const full = { ...options, statuslineBridgePath: fileURLToPath(new URL('../desktop/claude/statusline-bridge.mjs', import.meta.url)), usagePath: path.join(root, 'usage.json'),
    mcpConfig: { mcpServers: { 'agent-pet': { command: process.execPath, args: [path.join(root, 'stdio.mjs')] } } } };
  return { root, files, options, full };
}
async function snapshot(configDir) {
  return Object.fromEntries(await Promise.all((await fs.readdir(configDir)).sort().map(async name => [name, await fs.readFile(path.join(configDir, name), 'utf8')])));
}
function assertAPI() {
  for (const name of ['getClaudeLifecycleStatus', 'installClaudeLifecycle', 'removeClaudeLifecycle']) assert.equal(typeof api[name], 'function', name);
}

test('exports lifecycle-only API', assertAPI);

test('lifecycle installs just five hooks, preserves unrelated settings and MCP bytes, and is idempotent', async t => {
  assertAPI();
  const original = { model: 'keep', permissions: { ask: ['Bash(*)'] }, statusLine: { type: 'command', command: 'foreign' },
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'foreign' }] }], Notification: [] } };
  const { files, options } = await fixture(t, original);
  const beforeMcp = await fs.readFile(files.mcp, 'utf8');
  assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'not-installed');
  const result = await api.installClaudeLifecycle(options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'installed');
  assert.equal(result.changed, true);
  assert.equal(result.backups.length, 1);
  assert.equal(await fs.readFile(result.backups[0], 'utf8'), JSON.stringify(original));
  const current = await json(files.settings);
  for (const key of ['model', 'permissions', 'statusLine']) assert.deepEqual(current[key], original[key]);
  assert.deepEqual(current.hooks.Stop[0], original.hooks.Stop[0]);
  assert.deepEqual(Object.keys(current.hooks).filter(event => current.hooks[event].some(group => JSON.stringify(group).includes(marker))).sort(), [...events].sort());
  assert.equal(await fs.readFile(files.mcp, 'utf8'), beforeMcp);
  await assert.rejects(fs.stat(files.legacy), { code: 'ENOENT' });
  const before = await snapshot(options.configDir);
  assert.equal((await api.getClaudeLifecycleStatus({ configDir: options.configDir })).state, 'installed');
  assert.equal((await api.installClaudeLifecycle(options)).changed, false);
  assert.deepEqual(await snapshot(options.configDir), before);
  assert.equal((await api.removeClaudeLifecycle(options)).state, 'not-installed');
  assert.deepEqual(await json(files.settings), original);
  assert.equal(await fs.readFile(files.mcp, 'utf8'), beforeMcp);
  assert.equal((await api.removeClaudeLifecycle(options)).changed, false);
});

test('absent Claude config is not created by any lifecycle operation', async t => {
  assertAPI();
  const { options } = await fixture(t);
  options.configDir = path.join(options.configDir, 'absent');
  for (const name of ['getClaudeLifecycleStatus', 'installClaudeLifecycle', 'removeClaudeLifecycle']) {
    assert.equal((await api[name](options)).state, 'not-detected');
    await assert.rejects(fs.stat(options.configDir), { code: 'ENOENT' });
  }
});

test('disableAllHooks prevents installation without writing backups or changing policy', async t => {
  assertAPI();
  const { options } = await fixture(t, { disableAllHooks: true, model: 'keep' });
  const before = await snapshot(options.configDir);
  assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'disabled');
  const result = await api.installClaudeLifecycle(options);
  assert.equal(result.state, 'disabled');
  assert.equal(result.changed, false);
  assert.deepEqual(await snapshot(options.configDir), before);
});

test('upgraded paths replace only untouched owned hooks and preserve later user additions', async t => {
  assertAPI();
  const { files, options, root } = await fixture(t);
  assert.equal((await api.installClaudeLifecycle(options)).ok, true);
  const current = await json(files.settings);
  current.model = 'later';
  current.hooks.Stop.push({ hooks: [{ type: 'command', command: 'later' }] });
  await write(files.settings, current);
  const updated = { ...options, nodePath: path.join(root, 'new node.exe'), bridgePath: path.join(root, 'new bridge.mjs'), eventsDir: path.join(root, 'new events') };
  const result = await api.installClaudeLifecycle(updated);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(result.backups.length, 2);
  const next = await json(files.settings);
  assert.equal(next.hooks.Stop.length, 2);
  assert.equal(next.hooks.Stop[0].hooks[0].command, updated.nodePath);
  assert.deepEqual(next.hooks.Stop[0].hooks[0].args.slice(-2), [updated.bridgePath, updated.eventsDir]);
  assert.equal(next.model, 'later');
  assert.equal((await api.installClaudeLifecycle(updated)).changed, false);
  assert.equal((await api.removeClaudeLifecycle(updated)).ok, true);
  assert.deepEqual(await json(files.settings), { model: 'later', hooks: { Stop: [current.hooks.Stop[1]] } });
});

test('damaged JSON and malformed hook configuration fail closed before creating any backup', async t => {
  assertAPI();
  for (const raw of ['{broken', '[]', '{"hooks":null}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[{"hooks":"bad"}]}}']) {
    const { files, options } = await fixture(t);
    await fs.writeFile(files.settings, raw);
    const before = await snapshot(options.configDir);
    for (const name of ['getClaudeLifecycleStatus', 'installClaudeLifecycle', 'removeClaudeLifecycle']) assert.equal((await api[name](options)).state, 'error');
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

test('orphan markers, edited, missing, duplicated and extra owned hooks refuse updates and deletion', async t => {
  assertAPI();
  for (const kind of ['orphan', 'edited', 'missing', 'duplicate', 'extra']) {
    const { files, options } = await fixture(t);
    assert.equal((await api.installClaudeLifecycle(options)).ok, true);
    const current = await json(files.settings);
    if (kind === 'orphan') await fs.unlink(files.record);
    if (kind === 'edited') current.hooks.Stop[0].hooks[0].timeout = 99;
    if (kind === 'missing') delete current.hooks.Stop;
    if (kind === 'duplicate') current.hooks.Stop.push(structuredClone(current.hooks.Stop[0]));
    if (kind === 'extra') current.hooks.Notification = [structuredClone(current.hooks.Stop[0])];
    await write(files.settings, current);
    const before = await snapshot(options.configDir);
    for (const name of ['getClaudeLifecycleStatus', 'installClaudeLifecycle', 'removeClaudeLifecycle']) assert.equal((await api[name](options)).state, 'conflict', kind);
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

test('invalid ownership records fail closed', async t => {
  assertAPI();
  for (const kind of ['broken', 'missing-event', 'foreign-hook', 'version']) {
    const { files, options } = await fixture(t);
    await api.installClaudeLifecycle(options);
    const record = await json(files.record);
    if (kind === 'missing-event') delete record.hooks.Stop;
    if (kind === 'foreign-hook') record.hooks.Stop = { hooks: [{ type: 'command', command: 'foreign' }] };
    if (kind === 'version') record.version = 999;
    await fs.writeFile(files.record, kind === 'broken' ? '{bad' : JSON.stringify(record));
    const before = await snapshot(options.configDir);
    for (const name of ['getClaudeLifecycleStatus', 'installClaudeLifecycle', 'removeClaudeLifecycle']) assert.equal((await api[name](options)).state, 'error', kind);
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

test('lifecycle shares the existing integration lock and leaves held lock untouched', async t => {
  assertAPI();
  const { files, options } = await fixture(t);
  await fs.writeFile(path.join(options.configDir, 'agent-pet-integration.lock'), 'busy');
  const before = await snapshot(options.configDir);
  assert.equal((await api.installClaudeLifecycle(options)).ok, false);
  assert.deepEqual(await snapshot(options.configDir), before);
  assert.deepEqual(await json(files.settings), {});
});

test('complete legacy manual hooks migrate lifecycle ownership and paths without changing optional integration', async t => {
  const { files, options, full, root } = await fixture(t, { model: 'keep', permissions: { ask: ['Bash(*)'] } });
  assert.equal((await api.installClaudeIntegration({ ...full, enableStatusline: true })).ok, true);
  const before = await json(files.settings);
  const mcpBefore = await fs.readFile(files.mcp, 'utf8');
  const legacyBefore = await json(files.legacy);
  assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'legacy-installed');
  assert.equal((await api.removeClaudeLifecycle(options)).changed, false);
  const updated = { ...options, nodePath: path.join(root, 'new node.exe'), bridgePath: path.join(root, 'upgraded bridge.mjs'), eventsDir: path.join(root, 'upgraded events') };
  const result = await api.installClaudeLifecycle(updated);
  assert.equal(result.state, 'installed');
  assert.equal(result.changed, true);
  assert.equal(result.backups.length, 2);
  const current = await json(files.settings);
  for (const event of events) {
    assert.equal(current.hooks[event].length, 1);
    assert.equal(current.hooks[event][0].hooks[0].command, updated.nodePath);
    assert.deepEqual(current.hooks[event][0].hooks[0].args.slice(-2), [updated.bridgePath, updated.eventsDir]);
    assert.ok(JSON.stringify(current.hooks[event]).includes(marker));
  }
  assert.deepEqual(selectHooks(current.hooks, enhancementEvents), selectHooks(before.hooks, enhancementEvents));
  for (const key of ['model', 'permissions', 'statusLine']) assert.deepEqual(current[key], before[key]);
  assert.equal(await fs.readFile(files.mcp, 'utf8'), mcpBefore);
  const legacy = await json(files.legacy);
  assert.equal(legacy.hooksManagedBy, 'lifecycle');
  assert.deepEqual(legacy.hooks, selectHooks(legacyBefore.hooks, enhancementEvents));
  assert.deepEqual(legacy.mcp, legacyBefore.mcp);
  assert.deepEqual(legacy.statusLine, legacyBefore.statusLine);
  assert.deepEqual(legacy.original, legacyBefore.original);
  assert.equal((await api.getClaudeIntegrationStatus(full)).state, 'installed');
  assert.equal((await api.installClaudeIntegration({ ...full, enableStatusline: true })).changed, false);
  const after = await snapshot(options.configDir);
  assert.equal((await api.installClaudeLifecycle(updated)).changed, false);
  assert.deepEqual(await snapshot(options.configDir), after);
});

for (const first of ['manual', 'automatic']) {
  test(`legacy ownership migration supports ${first} removal first without removing the other feature`, async t => {
    const original = { model: 'keep', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign' }] }] } };
    const { files, options, full } = await fixture(t, original);
    await api.installClaudeIntegration({ ...full, enableStatusline: true });
    assert.equal((await api.installClaudeLifecycle(options)).state, 'installed');
    const migrated = await json(files.settings);
    if (first === 'manual') {
      assert.equal((await api.removeClaudeIntegration(full)).ok, true);
      assert.deepEqual(selectHooks((await json(files.settings)).hooks, events), selectHooks(migrated.hooks, events));
      assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'installed');
      assert.equal((await api.removeClaudeLifecycle(options)).ok, true);
    } else {
      const mcp = await fs.readFile(files.mcp, 'utf8');
      const legacy = await fs.readFile(files.legacy, 'utf8');
      assert.equal((await api.removeClaudeLifecycle(options)).ok, true);
      assert.deepEqual(selectHooks((await json(files.settings)).hooks, enhancementEvents), selectHooks(migrated.hooks, enhancementEvents));
      assert.deepEqual((await json(files.settings)).statusLine, migrated.statusLine);
      assert.equal(await fs.readFile(files.mcp, 'utf8'), mcp);
      assert.equal(await fs.readFile(files.legacy, 'utf8'), legacy);
      assert.equal((await api.getClaudeIntegrationStatus(full)).state, 'installed');
      assert.equal((await api.removeClaudeIntegration(full)).ok, true);
    }
    assert.deepEqual(await json(files.settings), original);
  });
}

test('migration refuses a user-modified legacy lifecycle or enhancement hook', async t => {
  for (const event of ['Stop', 'Notification']) {
    const { files, options, full } = await fixture(t);
    await api.installClaudeIntegration(full);
    const settings = await json(files.settings);
    settings.hooks[event][0].hooks[0].timeout = 99;
    await write(files.settings, settings);
    const before = await snapshot(options.configDir);
    assert.equal((await api.installClaudeLifecycle(options)).state, 'conflict');
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

test('legacy lifecycle migration rolls back settings and legacy ownership if new record publish fails', async t => {
  const { files, options, full } = await fixture(t);
  await api.installClaudeIntegration(full);
  const settingsBefore = await fs.readFile(files.settings, 'utf8');
  const legacyBefore = await fs.readFile(files.legacy, 'utf8');
  const result = await withFsFault('rename', original => async (from, to) => {
    if (to === files.record) throw Object.assign(new Error('migration publish failure'), { code: 'EACCES' });
    return original(from, to);
  }, () => api.installClaudeLifecycle(options));
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(files.settings, 'utf8'), settingsBefore);
  assert.equal(await fs.readFile(files.legacy, 'utf8'), legacyBefore);
  await assert.rejects(fs.stat(files.record), { code: 'ENOENT' });
  assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'legacy-installed');
});

test('legacy ownership concurrent edit stops migration without changing settings', async t => {
  const { files, options, full } = await fixture(t);
  await api.installClaudeIntegration(full);
  const settingsBefore = await fs.readFile(files.settings, 'utf8');
  const edited = { ...await json(files.legacy), userNote: 'concurrent editor' };
  const result = await withFsFault('writeFile', original => async (file, ...args) => {
    const written = await original(file, ...args);
    if (String(file).startsWith(`${files.legacy}.agent-pet-backup-`)) await original(files.legacy, JSON.stringify(edited));
    return written;
  }, () => api.installClaudeLifecycle(options));
  assert.equal(result.code, 'CONCURRENT_CHANGE');
  assert.equal(await fs.readFile(files.settings, 'utf8'), settingsBefore);
  assert.deepEqual(await json(files.legacy), edited);
  await assert.rejects(fs.stat(files.record), { code: 'ENOENT' });
});

test('empty lifecycle-managed optional record upgrades to three enhancement hooks', async t => {
  const { files, options, full } = await fixture(t);
  await api.installClaudeLifecycle(options);
  await api.installClaudeIntegration(full);
  const legacy = await json(files.legacy);
  const current = await json(files.settings);
  for (const event of enhancementEvents) delete current.hooks[event];
  legacy.hooks = {};
  await write(files.settings, current);
  await write(files.legacy, legacy);
  assert.equal((await api.getClaudeIntegrationStatus(full)).state, 'installed');
  const result = await api.installClaudeIntegration(full);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const upgraded = await json(files.settings);
  assert.deepEqual(selectHooks(upgraded.hooks, events), current.hooks);
  for (const event of enhancementEvents) assert.equal(upgraded.hooks[event].length, 1);
  assert.equal((await api.installClaudeIntegration(full)).changed, false);
});

test('incomplete or orphan legacy manual hooks are not duplicated automatically', async t => {
  assertAPI();
  for (const orphan of [false, true]) {
    const { files, options, full } = await fixture(t);
    await api.installClaudeIntegration(full);
    if (orphan) await fs.unlink(files.legacy);
    else {
      const settings = await json(files.settings);
      delete settings.hooks.Stop;
      await write(files.settings, settings);
    }
    const before = await snapshot(options.configDir);
    assert.equal((await api.installClaudeLifecycle(options)).state, 'conflict');
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

test('optional integration retains three enhancement hooks without duplicating automatic lifecycle hooks', async t => {
  assertAPI();
  const { files, options, full } = await fixture(t, { statusLine: { type: 'command', command: `'${process.execPath.replaceAll('\\', '/')}' --version` } });
  await api.installClaudeLifecycle(options);
  const settings = await json(files.settings);
  const record = await fs.readFile(files.record, 'utf8');
  const result = await api.installClaudeIntegration({ ...full, enableStatusline: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  const current = await json(files.settings);
  assert.deepEqual(selectHooks(current.hooks, events), settings.hooks);
  for (const event of enhancementEvents) assert.equal(current.hooks[event]?.length, 1);
  const legacy = await json(files.legacy);
  assert.equal(legacy.hooksManagedBy, 'lifecycle');
  assert.deepEqual(Object.keys(legacy.hooks).sort(), [...enhancementEvents].sort());
  assert.equal((await api.getClaudeIntegrationStatus(full)).state, 'installed');
  assert.equal((await api.installClaudeIntegration({ ...full, enableStatusline: true })).changed, false);
  assert.equal((await api.removeClaudeIntegration(full)).ok, true);
  assert.deepEqual(await json(files.settings), settings);
  assert.equal(await fs.readFile(files.record, 'utf8'), record);
  assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'installed');
});

test('automatic removal preserves optional integration and can reinstall without duplicate hooks', async t => {
  assertAPI();
  const { files, options, full } = await fixture(t);
  await api.installClaudeLifecycle(options);
  assert.equal((await api.installClaudeIntegration({ ...full, enableStatusline: true })).ok, true);
  const settings = await json(files.settings);
  const mcp = await fs.readFile(files.mcp, 'utf8');
  const legacy = await fs.readFile(files.legacy, 'utf8');
  assert.equal((await api.removeClaudeLifecycle(options)).state, 'not-installed');
  assert.deepEqual((await json(files.settings)).statusLine, settings.statusLine);
  assert.equal(await fs.readFile(files.mcp, 'utf8'), mcp);
  assert.equal(await fs.readFile(files.legacy, 'utf8'), legacy);
  assert.equal((await api.getClaudeIntegrationStatus(full)).state, 'installed');
  assert.equal((await api.installClaudeIntegration({ ...full, enableStatusline: true })).changed, false);
  assert.equal((await api.installClaudeLifecycle(options)).state, 'installed');
  assert.deepEqual((await json(files.settings)).hooks, settings.hooks);
  await api.removeClaudeLifecycle(options);
  assert.equal((await api.removeClaudeIntegration(full)).ok, true);
});

async function withFsFault(method, replacement, operation) {
  const original = mutableFs[method];
  mutableFs[method] = replacement(original);
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { mutableFs[method] = original; syncBuiltinESMExports(); }
}

test('CAS refuses settings edited during backup without overwriting the external edit', async t => {
  const { files, options } = await fixture(t);
  const external = '{ "model": "concurrent editor" }';
  const result = await withFsFault('writeFile', original => async (file, ...args) => {
    const written = await original(file, ...args);
    if (String(file).startsWith(`${files.settings}.agent-pet-backup-`)) await original(files.settings, external);
    return written;
  }, () => api.installClaudeLifecycle(options));
  assert.equal(result.code, 'CONCURRENT_CHANGE');
  assert.equal(result.changed, false);
  assert.equal(await fs.readFile(files.settings, 'utf8'), external);
  await assert.rejects(fs.stat(files.record), { code: 'ENOENT' });
  assert.ok(!(await fs.readdir(options.configDir)).some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
});

test('failed second-file publish rolls settings back byte-for-byte and retains the backup', async t => {
  const { files, options } = await fixture(t, { model: 'original' });
  const before = await fs.readFile(files.settings, 'utf8');
  const result = await withFsFault('rename', original => async (from, to) => {
    if (to === files.record) throw Object.assign(new Error('injected write failure'), { code: 'EACCES' });
    return original(from, to);
  }, () => api.installClaudeLifecycle(options));
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(files.settings, 'utf8'), before);
  await assert.rejects(fs.stat(files.record), { code: 'ENOENT' });
  const names = await fs.readdir(options.configDir);
  assert.ok(names.some(name => name.startsWith('settings.json.agent-pet-backup-')));
  assert.ok(!names.some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
});

test('rollback never overwrites an external edit after the settings publish', async t => {
  const { files, options } = await fixture(t);
  const external = '{ "model": "edited after publish" }';
  const result = await withFsFault('rename', original => async (from, to) => {
    if (to === files.record) {
      await fs.writeFile(files.settings, external);
      throw Object.assign(new Error('injected write failure'), { code: 'EACCES' });
    }
    return original(from, to);
  }, () => api.installClaudeLifecycle(options));
  assert.equal(result.code, 'PARTIAL_WRITE');
  assert.equal(await fs.readFile(files.settings, 'utf8'), external);
  await assert.rejects(fs.stat(files.record), { code: 'ENOENT' });
});

test('disabled existing hooks are not updated but may be removed without changing disableAllHooks', async t => {
  const { files, options } = await fixture(t);
  await api.installClaudeLifecycle(options);
  const current = await json(files.settings);
  current.disableAllHooks = true;
  await write(files.settings, current);
  const before = await snapshot(options.configDir);
  assert.equal((await api.installClaudeLifecycle({ ...options, bridgePath: path.join(options.configDir, 'upgraded.mjs') })).state, 'disabled');
  assert.deepEqual(await snapshot(options.configDir), before);
  assert.equal((await api.removeClaudeLifecycle(options)).ok, true);
  assert.deepEqual(await json(files.settings), { disableAllHooks: true });
  assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'disabled');
});

test('existing config without settings is supported without creating MCP configuration', async t => {
  const { files, options } = await fixture(t);
  await fs.unlink(files.settings);
  await fs.unlink(files.mcp);
  assert.equal((await api.installClaudeLifecycle(options)).state, 'installed');
  await assert.rejects(fs.stat(files.mcp), { code: 'ENOENT' });
  assert.equal((await api.removeClaudeLifecycle(options)).state, 'not-installed');
  assert.deepEqual(await json(files.settings), {});
});

test('lifecycle never opens even malformed unrelated MCP JSON', async t => {
  const { files, options } = await fixture(t);
  await fs.writeFile(files.mcp, '{not our configuration');
  assert.equal((await api.installClaudeLifecycle(options)).state, 'installed');
  assert.equal((await api.removeClaudeLifecycle(options)).state, 'not-installed');
  assert.equal(await fs.readFile(files.mcp, 'utf8'), '{not our configuration');
});

for (const migrate of [false, true]) {
test(`${migrate ? 'migrated' : 'fresh'} exec-form commands actually write all five lifecycle events to an isolated inbox`, async t => {
  assertAPI();
  const { options, full, files, root } = await fixture(t);
  if (migrate) {
    assert.equal((await api.installClaudeIntegration(full)).ok, true);
    options.bridgePath = path.join(root, "upgraded bridge ' 中文.mjs");
    options.eventsDir = path.join(root, "upgraded events ' 中文");
    await fs.copyFile(bridge, options.bridgePath);
  }
  assert.equal((await api.installClaudeLifecycle(options)).ok, true);
  const settings = await json(files.settings);
  for (const event of events) {
    const hook = settings.hooks[event][0].hooks[0];
    assert.equal(hook.async, undefined);
    assert.equal(hook.type, 'command');
    assert.ok(hook.timeout <= 3);
    const child = spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: event, session_id: 'isolated', prompt: '中文', last_assistant_message: 'done' }),
      encoding: 'utf8', timeout: 5000, windowsHide: true, cwd: root,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: options.configDir, AGENT_PET_AUXILIARY: '0' } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
  }
  const saved = await Promise.all((await fs.readdir(options.eventsDir)).filter(name => name.endsWith('.json')).map(name => json(path.join(options.eventsDir, name))));
  assert.deepEqual(saved.map(event => event.hook_event_name).sort(), [...events].sort());
  assert.ok(saved.every(event => event.session_id === 'isolated'));
  if (migrate) {
    await assert.rejects(fs.stat(full.eventsDir), { code: 'ENOENT' });
    assert.equal((await api.removeClaudeIntegration(full)).ok, true);
    assert.equal((await api.getClaudeLifecycleStatus(options)).state, 'installed');
  }
});
}
