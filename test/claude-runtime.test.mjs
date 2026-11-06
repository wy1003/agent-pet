import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeExecutable, resolveClaudeConfigDirectory, getClaudeRuntimeStatus } from '../desktop/claude/runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pet-claude-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exe = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
  await writeFile(exe, 'not executable: runtime must only locate, never launch');
  return { root, exe };
}

test('runtime verifies explicit executable and never executes it', async (t) => {
  const { exe, root } = await fixture(t);
  assert.equal(await resolveClaudeExecutable(exe), await realpath(exe));
  await assert.rejects(resolveClaudeExecutable(root));
  await assert.rejects(resolveClaudeExecutable(path.join(root, 'missing')));
});

test('runtime detects PATH executable and safely reports absence', async (t) => {
  const { root, exe } = await fixture(t);
  const options = { env: { PATH: root }, bundledExecutable: '', homeDir: root };
  assert.equal(await resolveClaudeExecutable('', options), await realpath(exe));
  const status = await getClaudeRuntimeStatus({ ...options, env: { PATH: '' } });
  assert.equal(status.available, false);
  assert.equal(status.authenticated, null);
  assert.equal(status.configDirectory, path.join(root, '.claude'));
});

test('runtime supports configured path, bundled path and config directory without reading secrets', async (t) => {
  const { root, exe } = await fixture(t);
  const config = path.join(root, 'config');
  await mkdir(config);
  const env = { AGENT_PET_CLAUDE_EXECUTABLE: exe, CLAUDE_CONFIG_DIR: config };
  assert.equal(resolveClaudeConfigDirectory({ env, homeDir: root }), config);
  const status = await getClaudeRuntimeStatus({ env, homeDir: root, bundledExecutable: '' });
  assert.equal(status.available, true);
  assert.equal(status.executablePath, await realpath(exe));
  assert.equal(status.authenticated, null);
  assert.equal(await resolveClaudeExecutable('', { env: {}, homeDir: root, bundledExecutable: exe }), await realpath(exe));
});
