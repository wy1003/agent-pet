import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../desktop/claude/runtime.mjs';

test('Node discovery uses the current real Node without invoking Claude', async () => {
  assert.equal(typeof runtime.resolveNodeExecutable, 'function');
  assert.equal(await runtime.resolveNodeExecutable('', { env: {}, electron: false }), process.execPath);
});

test('Node discovery excludes the Electron executable and returns unavailable without candidates', async () => {
  assert.equal(await runtime.resolveNodeExecutable('', { env: {}, electron: true }), '');
});

test('Node discovery validates explicit paths and never silently substitutes a missing override', async () => {
  await assert.rejects(runtime.resolveNodeExecutable('/missing-agent-pet-node'), /Node/);
  assert.equal(await runtime.resolveNodeExecutable(process.execPath), process.execPath);
});

test('Node discovery can use npm runtime when running inside Electron', async () => {
  assert.equal(await runtime.resolveNodeExecutable('', {
    electron: true, execPath: '/unavailable/electron.exe', env: { npm_node_execpath: process.execPath },
  }), process.execPath);
});
