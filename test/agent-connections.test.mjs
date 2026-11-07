import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentConnectionController, installAgentConnectionIpc } from '../desktop/agents/connection-controller.mjs';
import { PreferenceStore, normalizePreferences } from '../desktop/preferences.mjs';
import { MultiAgentCollector } from '../src/multi-agent-collector.mjs';
import { UsageProviderRegistry } from '../desktop/usage/usage-provider-registry.mjs';
import { createDesktopProviders } from '../desktop/agents/desktop-runtime.mjs';
import { RemoteExecutorRouter } from '../desktop/agents/remote-executor-router.mjs';
import { createClaudeLifecycleController } from '../desktop/agents/claude-lifecycle.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-connections-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PreferenceStore(path.join(root, 'preferences.json'));
  await store.load();
  const calls = [], updates = [];
  const controller = new AgentConnectionController({ getPreferences: () => store.get(), savePreferences: patch => store.update(patch),
    inspect: async () => 'missing', checkAvailability: async () => ({ state: 'available', message: 'fixture check passed' }),
    prepare: async (id, opts) => { calls.push([id, opts.allowDownload]); }, apply: async () => {},
    onChange: state => updates.push(state), ...options });
  t.after(() => controller.close());
  return { controller, store, calls, updates };
}

test('fresh and legacy settings never implicitly connect, download, or enable a source', async t => {
  const f = await fixture(t);
  assert.deepEqual(normalizePreferences({ version: 20, agent: { activeProviderId: 'claude' } }).agent.connections, { codex: false, claude: false });
  await f.controller.restore();
  assert.deepEqual(f.calls, []);
  assert.equal(f.controller.connected('codex'), false);
});

test('independent simultaneous connections persist; restart prepares offline; default remains independent', async t => {
  const f = await fixture(t);
  await Promise.all(['codex', 'claude'].map(id => f.controller.connect(id)));
  assert.deepEqual(f.store.get().agent.connections, { codex: true, claude: true });
  assert.equal(f.store.get().remoteControl.defaultProviderId, 'codex');
  assert.deepEqual(f.calls.sort(), [['claude', true], ['codex', true]]);
  const calls = [];
  const restored = new AgentConnectionController({ getPreferences: () => f.store.get(), savePreferences: patch => f.store.update(patch),
    prepare: async (id, options) => calls.push([id, options.allowDownload]), apply: async () => {} });
  await restored.restore();
  assert.deepEqual(calls.sort(), [['claude', false], ['codex', false]]);
  await f.controller.disconnect('claude');
  assert.deepEqual(f.store.get().agent.connections, { codex: true, claude: false });
  assert.equal(f.controller.connected('codex'), true);
});

test('first successful agent becomes the explicit AI default, later connections and disconnects do not switch it', async t => {
  const f = await fixture(t);
  assert.equal(f.store.get().ai.connectionId, '');
  await f.controller.connect('claude');
  assert.equal(f.store.get().ai.connectionId, 'claude');
  await f.controller.connect('codex');
  await f.controller.disconnect('claude');
  assert.equal(f.store.get().ai.connectionId, 'claude');
});

test('missing components, connection and authentication remain separate; only availability enables a default', async t => {
  const started = deferred(), gate = deferred(); let rejected = true;
  const f = await fixture(t, { checkAvailability: async () => {
    started.resolve(); await gate.promise;
    if (rejected) throw new Error('401 Unauthorized private-secret');
    return { state: 'available' };
  } });
  await f.controller.restore();
  assert.equal(f.controller.snapshot().claude.components, 'missing');
  assert.deepEqual(f.calls, []);
  const pending = f.controller.connect('claude'); await started.promise;
  assert.equal(f.controller.connected('claude'), true);
  assert.equal(f.controller.snapshot().claude.availability.state, 'checking');
  assert.equal(f.store.get().ai.connectionId, '');
  gate.resolve(); await pending;
  assert.equal(f.controller.snapshot().claude.components, 'ready');
  assert.equal(f.controller.connected('claude'), true);
  assert.equal(f.controller.available('claude'), false);
  assert.equal(f.controller.snapshot().claude.availability.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(f.controller.snapshot()), /private-secret/);
  assert.equal(f.store.get().ai.connectionId, '');
  rejected = false; await f.controller.verify('claude');
  assert.equal(f.controller.available('claude'), true);
  assert.equal(f.store.get().ai.connectionId, 'claude');
  f.controller.observeAiStatus({ connectionId: 'claude', status: 'error', code: 'rate_limit', message: '额度不足' });
  assert.equal(f.controller.connected('claude'), true);
  assert.equal(f.controller.available('claude'), false);
  assert.equal(f.store.get().ai.connectionId, 'claude');
  await f.controller.disconnect('claude');
  assert.equal(f.controller.snapshot().claude.components, 'ready');
  assert.equal(f.controller.snapshot().claude.availability.state, 'unchecked');
});

test('disconnect cancels an availability check and ignores its late successful reply', async t => {
  const started = deferred(), gate = deferred(); let signal;
  const f = await fixture(t, { checkAvailability: async (_id, options) => {
    signal = options.signal; started.resolve(); await gate.promise; return { state: 'available' };
  } });
  const connecting = f.controller.connect('claude'); await started.promise;
  const disconnecting = f.controller.disconnect('claude');
  assert.equal(signal.aborted, true);
  gate.resolve(); await Promise.all([connecting, disconnecting]);
  assert.equal(f.controller.connected('claude'), false);
  assert.equal(f.controller.available('claude'), false);
  assert.equal(f.store.get().ai.connectionId, '');
});

test('double connect shares work, progress is visible, failure retries without enabling collection', async t => {
  const gate = deferred(); let attempts = 0, applied = 0;
  const f = await fixture(t, { prepare: async (_id, { onProgress }) => {
    attempts++;
    onProgress({ phase: 'downloading', received: 123, total: 1000 });
    await gate.promise;
    if (attempts === 1) throw new Error('组件下载失败');
  }, apply: async () => { applied++; } });
  const first = f.controller.connect('claude'), duplicate = f.controller.connect('claude');
  assert.equal(first, duplicate);
  assert.equal(f.controller.snapshot().claude.received, 123);
  gate.resolve(); await first;
  assert.equal(f.controller.snapshot().claude.state, 'error');
  assert.equal(applied, 0);
  assert.equal(f.store.get().agent.connections.claude, false);
  await f.controller.connect('claude');
  assert.equal(applied, 1);
  assert.equal(f.controller.connected('claude'), true);
});

test('cancel during download waits for cleanup, never commits a late connection, and permits retry', async t => {
  let cleaned = false, enabled = 0, attempts = 0;
  const f = await fixture(t, { prepare: async (_id, { signal }) => {
    if (++attempts > 1) return;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 5)); cleaned = true;
    signal.throwIfAborted();
  }, apply: async (_id, connected) => { if (connected) enabled++; } });
  const pending = f.controller.connect('claude');
  await f.controller.disconnect('claude'); await pending;
  assert.equal(cleaned, true); assert.equal(enabled, 0);
  assert.equal(f.controller.snapshot().claude.state, 'disconnected');
  await f.controller.connect('claude'); assert.equal(enabled, 1);
});

test('connection IPC checks the settings main frame and accepts only fixed provider IDs', async t => {
  const f = await fixture(t), handlers = new Map();
  installAgentConnectionIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, controller: f.controller,
    setDefault: id => f.store.update({ remoteControl: { defaultProviderId: id } }),
    requireSettingsMainFrame: event => { if (event !== 'trusted') throw new Error('untrusted'); } });
  for (const handler of handlers.values()) {
    await assert.rejects(handler('other', 'codex'), /untrusted/);
    await assert.rejects(handler('trusted', { id: 'codex', url: 'https://attacker' }), /未知/);
    await assert.rejects(handler('trusted', '../claude'), /未知/);
  }
  assert.deepEqual(f.calls, []);
  const setDefault = handlers.get('agent-providers:set-default');
  await assert.rejects(setDefault('trusted', 'claude'), /请先连接/);
  await f.controller.connect('codex'); await f.controller.connect('claude');
  await setDefault('trusted', 'claude');
  assert.equal(f.store.get().remoteControl.defaultProviderId, 'claude');
  assert.deepEqual(f.store.get().agent.connections, { codex: true, claude: true });
});

class Collector extends EventEmitter {
  constructor(id) { super(); this.id = id; this.starts = 0; this.stops = 0; }
  async start() { this.starts++; }
  async stop() { this.stops++; }
  getSessions() { return [{ sessionId: this.id }]; }
  getTasks() { return [{ taskId: this.id, status: 'running' }]; }
}
test('live collector changes stop just the disconnected source and suppress its later events', async () => {
  const codex = new Collector('codex'), claude = new Collector('claude'), collector = new MultiAgentCollector([]);
  const events = []; collector.on('task.updated', value => events.push(value.taskId));
  await collector.start(); assert.equal(collector.getTasks().length, 0);
  await collector.setCollectors([codex]); await collector.setCollectors([codex, claude]);
  assert.equal(codex.starts, 1); assert.equal(claude.starts, 1);
  await collector.setCollectors([codex]);
  assert.equal(codex.stops, 0); assert.equal(claude.stops, 1);
  const count = events.length; claude.emit('task.updated', { taskId: 'claude' }); assert.equal(events.length, count);
  assert.deepEqual(collector.getTasks().map(task => task.taskId), ['codex']);
  await collector.setCollectors([codex, claude]); assert.equal(claude.starts, 2);
  await collector.stop();
});

test('disconnected sources cannot read quota, start/resume remote work, or open text providers', async () => {
  const connected = new Set(['codex']), isConnected = id => connected.has(id);
  const quota = new UsageProviderRegistry({ isConnected });
  let claudeReads = 0;
  quota.register({ id: 'codex', getUsage: async () => ({ status: 'ready' }) });
  quota.register({ id: 'claude', getUsage: async () => { claudeReads++; } });
  assert.deepEqual((await quota.getAllUsage()).providers.map(p => p.providerId), ['codex']); assert.equal(claudeReads, 0);
  const router = new RemoteExecutorRouter({ isConnected, getDefaultProvider: () => 'claude', claude: { start() { throw new Error('should not execute'); } } });
  await assert.rejects(router.start({}), /请先/);
  await assert.rejects(router.resume({ sessionId: 'claude:existing' }), /请先/);
  const providers = createDesktopProviders({ isConnected, getPreferences: () => normalizePreferences({}) });
  await assert.rejects(providers.text.get('claude').open({}), /请先/);
});

test('disconnected Claude never installs Hooks, and disconnect removes only managed lifecycle hooks', async () => {
  let enabled = false, installed = false; const writes = [];
  const lifecycle = createClaudeLifecycleController({ getPreferences: () => ({ claude: { autoLifecycleHooks: true } }),
    isConnected: () => enabled, getOptions: () => ({}), resolveNode: async () => '/node', integration: {
      status: async () => ({ ok: true, state: installed ? 'installed' : 'not-installed' }),
      install: async () => { installed = true; writes.push('install'); return { ok: true }; },
      remove: async () => { installed = false; writes.push('remove'); return { ok: true }; },
    } });
  await lifecycle.sync(); assert.deepEqual(writes, []);
  enabled = true; await lifecycle.sync(); enabled = false; await lifecycle.sync();
  await lifecycle.sync(); assert.deepEqual(writes, ['install', 'remove']);
});
