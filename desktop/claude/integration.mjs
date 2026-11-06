import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';

// User MCP scope: https://code.claude.com/docs/en/mcp
// Verified with isolated `claude mcp add-json --scope user` on 2.1.309.
// Hook exec form avoids shell-default differences (Git Bash / PowerShell).
// https://code.claude.com/docs/en/hooks#exec-form-and-shell-form
const MARKER = 'agent-pet:hook:v1';
const LIFECYCLE_MARKER = 'agent-pet:lifecycle:v1';
const LIFECYCLE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'];
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd'];
const ENHANCEMENT_EVENTS = EVENTS.filter(event => !LIFECYCLE_EVENTS.includes(event));
const selectHooks = (hooks, events) => Object.fromEntries(events.map(event => [event, hooks[event]]));
// A bounded, synchronous observer preserves ordering between lifecycle events.
// Never propagate bridge stdout or exit 2 (permission/blocking decisions).
const OBSERVER = `/* ${MARKER} */ const {spawnSync}=require('node:child_process');try{spawnSync(process.execPath,[process.argv[1],'--events-dir',process.argv[2]],{stdio:['inherit','ignore','ignore'],timeout:1500,windowsHide:true});}catch{};`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);
const hash = raw => raw === null ? null : createHash('sha256').update(raw).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = (code, message) => { throw Object.assign(new Error(message), { code, publicMessage: true }); };
const requireObject = (value, name) => { if (!object(value)) fail('INVALID_CONFIG', `${name} 必须是 JSON 对象，未修改配置。`); };
function absolute(value, name) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) fail('INVALID_OPTIONS', `${name} 必须是绝对路径。`);
  return path.resolve(value);
}
function locations(options) {
  const custom = options.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const configDir = absolute(custom || path.join(os.homedir(), '.claude'), 'configDir');
  return { configDir, settings: path.join(configDir, 'settings.json'),
    mcp: custom ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json'),
    manifest: path.join(configDir, 'agent-pet-integration.json'), lifecycle: path.join(configDir, 'agent-pet-lifecycle.json'),
    lock: path.join(configDir, 'agent-pet-integration.lock') };
}
async function rawFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_CONFIG', '配置文件不是普通文件，未进行修改。');
    return await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function read(file) {
  const raw = await rawFile(file);
  let value = {};
  if (raw !== null) {
    try { value = JSON.parse(raw.replace(/^﻿/, '')); }
    catch { fail('INVALID_CONFIG', '配置 JSON 无效，请先手动修复；不会重置文件。'); }
    requireObject(value, path.basename(file));
  }
  return { file, raw, value };
}
function validate(settings, global) {
  if (own(settings, 'hooks')) {
    requireObject(settings.hooks, 'hooks');
    for (const groups of Object.values(settings.hooks)) {
      if (!Array.isArray(groups)) fail('INVALID_CONFIG', 'Hook 事件必须是数组。');
      for (const group of groups) {
        requireObject(group, 'Hook 匹配组');
        if (!Array.isArray(group.hooks) || (own(group, 'matcher') && typeof group.matcher !== 'string')) fail('INVALID_CONFIG', 'Hook 匹配组格式无效。');
        for (const hook of group.hooks) {
          requireObject(hook, 'Hook');
          if (typeof hook.type !== 'string' || (hook.type === 'command' && typeof hook.command !== 'string')) fail('INVALID_CONFIG', 'Hook 格式无效。');
        }
      }
    }
  }
  if (own(global, 'mcpServers')) {
    requireObject(global.mcpServers, 'mcpServers');
    for (const server of Object.values(global.mcpServers)) requireObject(server, 'MCP server');
  }
}
function hasMarker(group) { return JSON.stringify(group).includes(MARKER); }
function verifyManifest(manifest) {
  if (manifest.version !== 1 || !object(manifest.hooks) || !object(manifest.mcp) || !object(manifest.original)
      || !Array.isArray(manifest.original.events) || typeof manifest.original.hooks !== 'boolean' || typeof manifest.original.mcp !== 'boolean'
      || (own(manifest, 'hooksManagedBy') && manifest.hooksManagedBy !== 'lifecycle')
      || !(equal(Object.keys(manifest.hooks).sort(), manifest.hooksManagedBy === 'lifecycle' ? [...ENHANCEMENT_EVENTS].sort() : [...EVENTS].sort())
        || manifest.hooksManagedBy === 'lifecycle' && !Object.keys(manifest.hooks).length)) fail('INVALID_CONFIG', 'AgentPet 安装记录损坏，需手动检查备份。');
  for (const group of Object.values(manifest.hooks)) {
    if (!object(group) || !Array.isArray(group.hooks) || !hasMarker(group)) fail('INVALID_CONFIG', 'AgentPet Hook 安装记录损坏。');
  }
}
function conflicts(settings, global, manifest) {
  const result = [];
  if (!manifest) {
    if (own(global.mcpServers ?? {}, 'agent-pet')) result.push('mcpServers.agent-pet');
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) if (groups.some(hasMarker)) result.push(`hooks.${event}`);
    if (JSON.stringify(settings.statusLine ?? '').includes('agent-pet:statusline:v1')) result.push('statusLine');
    return result;
  }
  for (const [event, expected] of Object.entries(manifest.hooks)) {
    const groups = settings.hooks?.[event] ?? [];
    if (groups.filter(group => equal(group, expected)).length !== 1 || groups.filter(hasMarker).length !== 1) result.push(`hooks.${event}`);
  }
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) if (!own(manifest.hooks, event) && groups.some(hasMarker)) result.push(`hooks.${event}`);
  if (!equal(global.mcpServers?.['agent-pet'], manifest.mcp)) result.push('mcpServers.agent-pet');
  if (manifest.statusLine && !equal(settings.statusLine, manifest.statusLine.installed)) result.push('statusLine');
  return result;
}
async function load(paths) {
  const [settings, global, record, lifecycleRecord] = await Promise.all([read(paths.settings), read(paths.mcp), read(paths.manifest), read(paths.lifecycle)]);
  validate(settings.value, global.value);
  const manifest = record.raw === null ? null : record.value;
  const lifecycle = lifecycleRecord.raw === null ? null : lifecycleRecord.value;
  if (manifest) verifyManifest(manifest);
  if (lifecycle) verifyLifecycleManifest(lifecycle);
  return { settings, global, record, manifest, lifecycleRecord, lifecycle, conflicts: conflicts(settings.value, global.value, manifest) };
}
function summary(paths, loaded) {
  const state = loaded.conflicts.length ? (loaded.manifest ? 'modified' : 'conflict') : loaded.manifest ? 'installed' : 'not-installed';
  const warnings = ['需要支持 Hook exec form 的 Claude Code；已核对 2.1.309。CLI 与 VSCode 必须使用同一个配置目录。', '项目级配置、企业策略或禁用 Hook/MCP 的设置仍可能覆盖用户级接入；这里不修改审批权限。'];
  if (loaded.settings.value.disableAllHooks) warnings.push('用户配置 disableAllHooks 已开启，接入事件不会执行。');
  return { ok: !loaded.conflicts.length, state, configured: state === 'installed', changed: false, paths, conflicts: loaded.conflicts, warnings, statuslineEnabled: Boolean(loaded.manifest?.statusLine) };
}
function desired(options) {
  const nodePath = absolute(options.nodePath, 'nodePath');
  const bridgePath = absolute(options.bridgePath, 'bridgePath');
  const eventsDir = absolute(options.eventsDir, 'eventsDir');
  const source = options.mcpConfig?.mcpServers;
  requireObject(source, 'mcpConfig.mcpServers');
  const server = source['agent-pet'] ?? source['agent-pet-notebook'];
  requireObject(server, 'AgentPet MCP');
  if (typeof server.command !== 'string' || !server.command || !Array.isArray(server.args) || !server.args.every(x => typeof x === 'string')
      || (own(server, 'env') && (!object(server.env) || !Object.values(server.env).every(x => typeof x === 'string')))
      || (own(server, 'type') && server.type !== 'stdio')) fail('INVALID_OPTIONS', '需要 notebookMcpConfig 返回的 stdio MCP 配置。');
  const hook = { type: 'command', command: nodePath, args: ['-e', OBSERVER, bridgePath, eventsDir], timeout: 3, onFailure: 'continue' };
  return { hooks: Object.fromEntries(EVENTS.map(event => [event, { hooks: [clone(hook)] }])), mcp: clone(server) };
}
async function plan(options, paths, loaded) {
  if (loaded.conflicts.length) fail('CONFLICT', '同名项冲突或 AgentPet 项已被用户修改；请检查状态和备份，不会覆盖。');
  if (hookConflicts(loaded.settings.value, loaded.lifecycle?.hooks, hasLifecycleMarker).length) fail('CONFLICT', '自动生命周期 Hook 已被修改或缺少记录，不重复注册。');
  const expected = desired(options);
  const lifecycleManaged = loaded.lifecycle !== null || loaded.manifest?.hooksManagedBy === 'lifecycle';
  if (lifecycleManaged) expected.hooks = selectHooks(expected.hooks, ENHANCEMENT_EVENTS);
  const settings = clone(loaded.settings.value), global = clone(loaded.global.value);
  let manifest = clone(loaded.manifest);
  if (manifest) {
    // Accept the earlier MCP/statusLine-only record and restore the optional
    // three observer hooks on an explicit full install, never the automatic five.
    if (manifest.hooksManagedBy === 'lifecycle' && !Object.keys(manifest.hooks).length) {
      manifest.hooks = clone(expected.hooks);
      settings.hooks ??= {};
      for (const [event, group] of Object.entries(expected.hooks)) (settings.hooks[event] ??= []).push(clone(group));
    }
    if (!equal(manifest.hooks, expected.hooks) || !equal(manifest.mcp, expected.mcp)) fail('OPTIONS_CHANGED', '接入路径或 MCP 配置发生变化；请先卸载旧接入，再安装。');
  } else {
    manifest = { version: 1, ...expected, ...(lifecycleManaged ? { hooksManagedBy: 'lifecycle' } : {}), original: { hooks: own(settings, 'hooks'), events: Object.keys(settings.hooks ?? {}), mcp: own(global, 'mcpServers') } };
    if (Object.keys(expected.hooks).length) settings.hooks ??= {};
    for (const [event, group] of Object.entries(expected.hooks)) (settings.hooks[event] ??= []).push(clone(group));
    global.mcpServers ??= {};
    global.mcpServers['agent-pet'] = clone(expected.mcp);
  }
  if (options.enableStatusline !== undefined && typeof options.enableStatusline !== 'boolean') fail('INVALID_OPTIONS', 'enableStatusline 必须是布尔值。');
  if (options.enableStatusline === true) {
    const { makeStatusline } = await import('./statusline-bridge.mjs');
    const original = manifest.statusLine ? manifest.statusLine.original : settings.statusLine;
    const installed = makeStatusline({ ...options, original });
    if (manifest.statusLine && !equal(installed, manifest.statusLine.installed)) fail('OPTIONS_CHANGED', '状态栏路径变化，请先卸载旧接入。');
    manifest.statusLine = { original: original ?? null, installed };
    settings.statusLine = installed;
  }
  const preview = { hooks: Object.fromEntries(Object.entries(expected.hooks).map(([event, group]) => [event, [group]])), mcpServers: { 'agent-pet': expected.mcp }, ...(manifest.statusLine ? { statusLine: manifest.statusLine.installed } : {}) };
  return { settings, global, manifest, preview };
}
async function guarded(options, operation) {
  let paths;
  try { paths = locations(options); return await operation(paths); }
  catch (error) {
    return { ok: false, state: error.code === 'CONFLICT' ? 'conflict' : 'error', changed: false, code: error.publicMessage ? error.code : 'IO_ERROR',
      message: error.publicMessage ? error.message : '无法安全读写接入配置；请检查目录权限与备份。', ...(paths ? { paths } : {}) };
  }
}
function hasLifecycleMarker(group) { return JSON.stringify(group).includes(LIFECYCLE_MARKER); }
function hookConflicts(settings, expected = {}, marked) {
  const result = [];
  for (const [event, group] of Object.entries(expected)) {
    const groups = settings.hooks?.[event] ?? [];
    if (groups.filter(value => equal(value, group)).length !== 1 || groups.filter(marked).length !== 1) result.push(`hooks.${event}`);
  }
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!own(expected, event) && groups.some(marked)) result.push(`hooks.${event}`);
  }
  return result;
}
function lifecycleHooks(options) {
  const nodePath = absolute(options.nodePath, 'nodePath');
  const bridgePath = absolute(options.bridgePath, 'bridgePath');
  const eventsDir = absolute(options.eventsDir, 'eventsDir');
  const hook = { type: 'command', command: nodePath, args: ['-e', OBSERVER.replace(MARKER, LIFECYCLE_MARKER), bridgePath, eventsDir], timeout: 3, onFailure: 'continue' };
  return Object.fromEntries(LIFECYCLE_EVENTS.map(event => [event, { hooks: [clone(hook)] }]));
}
function verifyLifecycleManifest(manifest) {
  if (manifest.version !== 1 || !object(manifest.hooks) || !object(manifest.original)
      || typeof manifest.original.hooks !== 'boolean' || !Array.isArray(manifest.original.events)
      || !manifest.original.events.every(event => typeof event === 'string')
      || !equal(Object.keys(manifest.hooks).sort(), [...LIFECYCLE_EVENTS].sort())) fail('INVALID_CONFIG', '生命周期安装记录损坏，需手动检查备份。');
  const hook = manifest.hooks.SessionStart?.hooks?.[0];
  if (!hook || !Array.isArray(hook.args)) fail('INVALID_CONFIG', '生命周期 Hook 安装记录损坏。');
  const expected = lifecycleHooks({ nodePath: hook.command, bridgePath: hook.args[2], eventsDir: hook.args[3] });
  if (!equal(manifest.hooks, expected)) fail('INVALID_CONFIG', '生命周期 Hook 安装记录与支持的格式不符。');
}
async function detected(paths) {
  try {
    const stat = await fs.lstat(paths.configDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_CONFIG', 'Claude 配置目录不是普通目录，不自动修改。');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// Lifecycle ownership is independent of MCP and statusLine. Never open .claude.json here.
async function loadLifecycle(paths) {
  const [settings, record, legacyRecord] = await Promise.all([read(paths.settings), read(paths.lifecycle), read(paths.manifest)]);
  validate(settings.value, {});
  const manifest = record.raw === null ? null : record.value;
  const legacy = legacyRecord.raw === null ? null : legacyRecord.value;
  if (manifest) verifyLifecycleManifest(manifest);
  if (legacy) verifyManifest(legacy);
  const problems = [
    ...hookConflicts(settings.value, manifest?.hooks, hasLifecycleMarker),
    ...hookConflicts(settings.value, legacy?.hooks, hasMarker),
  ];
  const legacyInstalled = Boolean(legacy && legacy.hooksManagedBy !== 'lifecycle');
  if (manifest && legacyInstalled) problems.push('duplicate-ownership');
  return { settings, record, manifest, legacyRecord, legacy, legacyInstalled, conflicts: problems };
}
function lifecycleSummary(loaded, respectDisabled = true) {
  if (loaded.conflicts.length) return { ok: false, state: 'conflict', changed: false, message: '生命周期 Hook 冲突、缺失或已被用户修改；未修改配置。' };
  if (respectDisabled && loaded.settings.value.disableAllHooks) return { ok: false, state: 'disabled', changed: false, message: 'disableAllHooks 已开启，保留用户策略，不安装 Hook。' };
  return { ok: true, state: loaded.manifest ? 'installed' : loaded.legacyInstalled ? 'legacy-installed' : 'not-installed', changed: false };
}
const notDetected = () => ({ ok: true, state: 'not-detected', changed: false });
/** Read-only disk configuration status; does not claim a running Claude session has reloaded it. */
export async function getClaudeLifecycleStatus(options = {}) {
  return guarded(options, async paths => !await detected(paths) ? notDetected() : lifecycleSummary(await loadLifecycle(paths)));
}
/** Maintain only five observer hooks, without installing MCP or wrapping statusLine. */
export async function installClaudeLifecycle(options = {}) {
  return guarded(options, async paths => {
    if (!await detected(paths)) return notDetected();
    const first = lifecycleSummary(await loadLifecycle(paths));
    if (!first.ok) return first;
    const hooks = lifecycleHooks(options);
    return locked(paths, async () => {
      const loaded = await loadLifecycle(paths);
      const status = lifecycleSummary(loaded);
      if (!status.ok) return status;
      const settings = clone(loaded.settings.value);
      const previousHooks = loaded.manifest?.hooks ?? (loaded.legacyInstalled ? selectHooks(loaded.legacy.hooks, LIFECYCLE_EVENTS) : null);
      // A legacy full install owns all eight hooks. Transfer only the five
      // lifecycle entries and their cleanup provenance in the same transaction;
      // the optional three, MCP and statusLine remain manually owned.
      const original = loaded.legacyInstalled
        ? { hooks: loaded.legacy.original.hooks, events: clone(loaded.legacy.original.events) }
        : { hooks: own(settings, 'hooks'), events: Object.keys(settings.hooks ?? {}) };
      const manifest = loaded.manifest ? { ...clone(loaded.manifest), hooks } : { version: 1, hooks, original };
      const legacy = loaded.legacyInstalled
        ? { ...clone(loaded.legacy), hooksManagedBy: 'lifecycle', hooks: selectHooks(loaded.legacy.hooks, ENHANCEMENT_EVENTS) }
        : loaded.legacy;
      settings.hooks ??= {};
      for (const [event, group] of Object.entries(hooks)) {
        if (previousHooks) {
          const index = settings.hooks[event].findIndex(value => equal(value, previousHooks[event]));
          settings.hooks[event][index] = clone(group);
        } else (settings.hooks[event] ??= []).push(clone(group));
      }
      const changed = !equal(manifest, loaded.manifest) || !equal(settings, loaded.settings.value) || !equal(legacy, loaded.legacy);
      const backups = await commit(paths, [
        { snapshot: loaded.settings, value: settings }, { snapshot: loaded.legacyRecord, value: legacy },
        { snapshot: loaded.record, value: manifest },
      ]);
      return { ok: true, state: 'installed', changed, backups };
    }, false);
  });
}
/** Remove only manifest-owned, unchanged automatic hooks. Legacy manual hooks are never ours. */
export async function removeClaudeLifecycle(options = {}) {
  return guarded(options, async paths => {
    if (!await detected(paths)) return notDetected();
    const first = lifecycleSummary(await loadLifecycle(paths), false);
    if (!first.ok || first.state !== 'installed') return first;
    return locked(paths, async () => {
      const loaded = await loadLifecycle(paths);
      const status = lifecycleSummary(loaded, false);
      if (!status.ok || status.state !== 'installed') return status;
      const { manifest } = loaded;
      const settings = clone(loaded.settings.value);
      for (const [event, expected] of Object.entries(manifest.hooks)) {
        settings.hooks[event] = settings.hooks[event].filter(group => !equal(group, expected));
        if (!settings.hooks[event].length && !manifest.original.events.includes(event)) delete settings.hooks[event];
      }
      if (!Object.keys(settings.hooks).length && !manifest.original.hooks) delete settings.hooks;
      const backups = await commit(paths, [
        { snapshot: loaded.legacyRecord, value: loaded.legacy },
        { snapshot: loaded.settings, value: settings }, { snapshot: loaded.record, value: null },
      ]);
      return { ok: true, state: 'not-installed', changed: true, backups };
    }, false);
  });
}

/** Read-only. Only configDir is required when using an isolated/custom profile. */
export async function getClaudeIntegrationStatus(options = {}) {
  return guarded(options, async paths => summary(paths, await load(paths)));
}
/** Read-only proposed AgentPet entries; never returns unrelated account/config values. */
export async function previewClaudeIntegration(options = {}) {
  return guarded(options, async paths => {
    const loaded = await load(paths);
    const result = summary(paths, loaded);
    if (!result.ok) return result;
    const proposed = await plan(options, paths, loaded);
    return { ...result, preview: proposed.preview };
  });
}
async function locked(paths, operation, createDirectory = true) {
  if (createDirectory) await fs.mkdir(paths.configDir, { recursive: true });
  let lock;
  try { lock = await fs.open(paths.lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('BUSY', '接入正在修改，或上次操作遗留锁；请确认没有操作运行后再检查锁文件。'); throw error; }
  try { return await operation(); }
  finally { await lock.close(); await fs.unlink(paths.lock); }
}
async function check(snapshot) {
  if (hash(await rawFile(snapshot.file)) !== hash(snapshot.raw)) fail('CONCURRENT_CHANGE', '配置在操作期间被修改；已停止写入，请重新检查状态。');
}
async function replace(snapshot, next) {
  await check(snapshot);
  if (next === null) { await fs.unlink(snapshot.file); return; }
  const temporary = `${snapshot.file}.agent-pet-${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(next, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await check(snapshot);
    await fs.rename(temporary, snapshot.file);
  } finally { await fs.rm(temporary, { force: true }); }
}
// Each file is atomically replaced, not a multi-file filesystem transaction.
// Rollback is CAS-guarded: never undo a concurrent external editor's changes.
async function commit(paths, entries) {
  const changed = entries.filter(({ snapshot, value }) => value === null ? snapshot.raw !== null : !equal(snapshot.value, value) || snapshot.raw === null);
  if (!changed.length) return [];
  for (const { snapshot } of entries) await check(snapshot);
  const backups = [], completed = [];
  for (const { snapshot } of changed) if (snapshot.raw !== null) {
    const backup = `${snapshot.file}.agent-pet-backup-${Date.now()}-${randomUUID()}`;
    await fs.writeFile(backup, snapshot.raw, { flag: 'wx', mode: 0o600 });
    backups.push(backup);
  }
  try {
    for (const { snapshot } of entries) await check(snapshot);
    for (const { snapshot, value } of changed) {
      const next = value === null ? null : encode(value);
      await replace(snapshot, next);
      completed.push({ snapshot, next });
    }
  } catch (error) {
    let incomplete = false;
    for (const { snapshot, next } of completed.reverse()) {
      try { await replace({ file: snapshot.file, raw: next }, snapshot.raw); }
      catch { incomplete = true; }
    }
    if (incomplete) fail('PARTIAL_WRITE', '并发修改阻止完整回滚；请检查配置、安装记录与 agent-pet-backup 备份。');
    throw error;
  }
  return backups;
}
/** Explicit settings-button action only; importing/status/preview never installs. */
export async function installClaudeIntegration(options = {}) {
  return guarded(options, async paths => {
    // Parse and validate before creating a directory, lock, or backup.
    await plan(options, paths, await load(paths));
    return locked(paths, async () => {
      const loaded = await load(paths);
      const next = await plan(options, paths, loaded);
      const changed = !equal(next.settings, loaded.settings.value) || !equal(next.global, loaded.global.value) || !equal(next.manifest, loaded.manifest);
      const backups = await commit(paths, [{ snapshot: loaded.lifecycleRecord, value: loaded.lifecycle }, { snapshot: loaded.settings, value: next.settings }, { snapshot: loaded.global, value: next.global }, { snapshot: loaded.record, value: next.manifest }]);
      return { ...summary(paths, await load(paths)), changed, backups, preview: next.preview };
    });
  });
}
/** Removes only unchanged, manifest-owned entries; restores the original statusLine. */
export async function removeClaudeIntegration(options = {}) {
  return guarded(options, async paths => {
    const first = await load(paths);
    if (!first.manifest && !first.conflicts.length) return { ...summary(paths, first), backups: [] };
    return locked(paths, async () => {
      const loaded = await load(paths);
      if (loaded.conflicts.length) fail('CONFLICT', 'AgentPet 配置已被修改或缺少安装记录，不自动删除；请手动检查。');
      if (!loaded.manifest) return { ...summary(paths, loaded), backups: [] };
      const { manifest } = loaded;
      const settings = clone(loaded.settings.value), global = clone(loaded.global.value);
      for (const [event, expected] of Object.entries(manifest.hooks)) {
        settings.hooks[event] = settings.hooks[event].filter(group => !equal(group, expected));
        if (!settings.hooks[event].length && !manifest.original.events.includes(event)) delete settings.hooks[event];
      }
      if (settings.hooks && !Object.keys(settings.hooks).length && !manifest.original.hooks) delete settings.hooks;
      delete global.mcpServers['agent-pet'];
      if (!Object.keys(global.mcpServers).length && !manifest.original.mcp) delete global.mcpServers;
      if (manifest.statusLine) {
        if (manifest.statusLine.original === null) delete settings.statusLine;
        else settings.statusLine = clone(manifest.statusLine.original);
      }
      const backups = await commit(paths, [{ snapshot: loaded.settings, value: settings }, { snapshot: loaded.global, value: global }, { snapshot: loaded.record, value: null }]);
      return { ...summary(paths, await load(paths)), changed: true, backups };
    });
  });
}
