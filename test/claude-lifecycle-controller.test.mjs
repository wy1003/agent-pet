import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../desktop/agents/claude-lifecycle.mjs');
function fixture(create) {
  let preferences = { claude: { autoLifecycleHooks: true, nodePath: '' } };
  const calls = [];
  const controller = create({
    getPreferences: () => preferences,
    getOptions: () => ({ configDir: '/fixture', bridgePath: '/bridge', eventsDir: '/events' }),
    resolveNode: async () => '/node',
    integration: {
      status: async () => ({ ok: true, state: 'not-installed' }),
      install: async options => { calls.push(['install', options]); return { ok: true, state: 'installed' }; },
      remove: async options => { calls.push(['remove', options]); return { ok: true, state: 'not-installed' }; },
    },
  });
  return { controller, calls, disable() { preferences.claude.autoLifecycleHooks = false; } };
}

test('automatic lifecycle uses host paths and serializes enable/disable with persistent preference', async () => {
  const { createClaudeLifecycleController } = await load();
  const f = fixture(createClaudeLifecycleController);
  assert.equal((await f.controller.sync()).state, 'installed');
  assert.equal(f.calls[0][1].nodePath, '/node');
  f.disable();
  assert.equal((await f.controller.sync()).state, 'disabled');
  assert.deepEqual(f.calls.map(row => row[0]), ['install', 'remove']);
  await f.controller.close();
  await f.controller.sync();
  assert.equal(f.calls.length, 2);
});

test('missing Node and disabled client policy do not install anything', async () => {
  const { createClaudeLifecycleController } = await load();
  for (const state of ['not-installed', 'disabled', 'not-detected']) {
    let installed = false, probed = false;
    const controller = createClaudeLifecycleController({
      getPreferences: () => ({ claude: {} }), getOptions: () => ({}),
      resolveNode: async () => { probed = true; return ''; },
      integration: { status: async () => ({ ok: true, state }), install: async () => { installed = true; } },
    });
    const result = await controller.sync();
    assert.equal(installed, false);
    assert.equal(probed, state === 'not-installed');
    assert.equal(result.state, state === 'not-installed' ? 'runtime-unavailable' : state);
  }
});

test('status refresh detects external edits without reinstalling', async () => {
  const { createClaudeLifecycleController } = await load();
  let changed = false, installed = 0;
  const controller = createClaudeLifecycleController({
    getPreferences: () => ({ claude: {} }), getOptions: () => ({}), resolveNode: async () => '/node',
    integration: {
      status: async () => changed ? { ok: false, state: 'conflict' } : { ok: true, state: 'installed' },
      install: async () => { installed++; return { ok: true, state: 'installed' }; },
    },
  });
  await controller.sync();
  changed = true;
  assert.equal((await controller.status()).state, 'conflict');
  assert.equal(installed, 1);
});

test('a failed runtime update stays visible even if the previous installation still exists', async () => {
  const { createClaudeLifecycleController } = await load();
  const controller = createClaudeLifecycleController({
    getPreferences: () => ({ claude: { nodePath: '/missing-node' } }), getOptions: () => ({}),
    resolveNode: async () => { throw new Error('missing runtime'); },
    integration: { status: async () => ({ ok: true, state: 'installed' }) },
  });
  assert.equal((await controller.sync()).ok, false);
  assert.equal((await controller.status()).state, 'error');
});

test('lifecycle errors remain diagnostics and do not escape application startup', async () => {
  const { createClaudeLifecycleController } = await load();
  const controller = createClaudeLifecycleController({
    getPreferences: () => ({ claude: {} }), getOptions: () => { throw new Error('private path'); },
  });
  const result = await controller.sync();
  assert.equal(result.ok, false);
  assert.equal(result.state, 'error');
  assert.doesNotMatch(JSON.stringify(result), /private path/);
});
