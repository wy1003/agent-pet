import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import mutableFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import * as api from '../desktop/claude/integration.mjs';

const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value));
function assertAPI() {
  for (const name of ['getClaudeNotebookStatus', 'installClaudeNotebook']) assert.equal(typeof api[name], 'function', name);
}
async function fixture(t) {
  assertAPI();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pet-notebook ' 中文-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir);
  const files = { settings: path.join(configDir, 'settings.json'), mcp: path.join(configDir, '.claude.json'),
    full: path.join(configDir, 'agent-pet-integration.json'), notebook: path.join(configDir, 'agent-pet-notebook.json') };
  await fs.writeFile(files.settings, '{ "model":"keep", "permissions":{"ask":["Bash(*)"]}, "statusLine":{"type":"command","command":"keep"}, "env":{"AUTH":"fake-secret"} }\n');
  await write(files.mcp, { oauthAccount: { token: 'fake-secret' }, projects: { private: {} }, mcpServers: { other: { command: 'keep' } } });
  const notebookMcpConfig = { command: process.execPath, args: [path.join(root, 'stdio.mjs'), '--connection', path.join(root, 'connection.json')], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const options = { configDir, notebookMcpConfig };
  const full = { configDir, nodePath: process.execPath, bridgePath: path.join(root, 'hook.mjs'), eventsDir: path.join(root, 'events'),
    mcpConfig: { mcpServers: { 'agent-pet-notebook': notebookMcpConfig } } };
  return { root, files, options, full };
}
async function snapshot(dir) {
  return Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async name => [name, await fs.readFile(path.join(dir, name), 'utf8')])));
}
function publicResult(result) {
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.configured, 'boolean');
  assert.equal(typeof result.changed, 'boolean');
  assert.equal(typeof result.state, 'string');
  assert.ok(Object.keys(result).every(key => ['ok', 'state', 'configured', 'changed', 'backups'].includes(key)));
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
}
async function withFsFault(name, factory, operation) {
  const original = mutableFs[name];
  mutableFs[name] = factory(original);
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { mutableFs[name] = original; syncBuiltinESMExports(); }
}

test('notebook exports redacted MCP-only API', assertAPI);

// Recreate the shipped key-less manifests, rather than guessing ownership from disk.
async function legacyFixture(t, owners) {
  const f = await fixture(t);
  if (owners.includes('full')) assert.equal((await api.installClaudeIntegration(f.full)).ok, true);
  if (owners.includes('notebook')) assert.equal((await api.installClaudeNotebook(f.options)).ok, true);
  const global = await json(f.files.mcp);
  global.mcpServers['agent-pet'] = f.options.notebookMcpConfig;
  delete global.mcpServers['agent-pet-notebook'];
  await write(f.files.mcp, global);
  for (const owner of owners) {
    const record = await json(f.files[owner]);
    delete record.mcpName;
    await write(f.files[owner], record);
  }
  return f;
}

async function missingOwnedFixture(t, owners, { sameSnapshot = true, sameName = true } = {}) {
  const f = await fixture(t);
  if (owners.includes('full')) assert.equal((await api.installClaudeIntegration(f.full)).ok, true);
  if (owners.includes('notebook')) assert.equal((await api.installClaudeNotebook(f.options)).ok, true);
  const oldMcp = { ...f.options.notebookMcpConfig, args: [path.join(f.root, '0.12.0', 'stdio.mjs'), '--connection', path.join(f.root, '0.12.0', 'connection.json')] };
  const global = await json(f.files.mcp);
  delete global.mcpServers['agent-pet-notebook'];
  delete global.mcpServers['agent-pet'];
  await write(f.files.mcp, global);
  for (const [index, owner] of owners.entries()) {
    const record = await json(f.files[owner]);
    record.mcp = index && !sameSnapshot ? { ...oldMcp, args: [...oldMcp.args, '--different-owner'] } : oldMcp;
    if (index && !sameName) record.mcpName = 'agent-pet-notebook';
    else delete record.mcpName;
    await write(f.files[owner], record);
  }
  return { ...f, oldMcp };
}

test('malformed full MCP snapshots fail closed across status, connect, install, and remove without writes', async t => {
  for (const badMcp of [
    {},
    { command: '', args: [] },
    { command: 'node', args: 'bad' },
    { command: 'node', args: [1] },
  ]) {
    await t.test(JSON.stringify(badMcp), async t => {
      const { files, options, full } = await fixture(t);
      assert.equal((await api.installClaudeIntegration(full)).ok, true);
      const record = await json(files.full);
      record.mcp = badMcp;
      await write(files.full, record);
      const global = await json(files.mcp);
      delete global.mcpServers['agent-pet-notebook'];
      delete global.mcpServers['agent-pet'];
      await write(files.mcp, global);
      const before = await snapshot(options.configDir);
      const operations = [
        ['notebook status', () => api.getClaudeNotebookStatus(options), false],
        ['notebook connect', () => api.installClaudeNotebook(options), false],
        ['full status', () => api.getClaudeIntegrationStatus(full), true],
        ['full install', () => api.installClaudeIntegration(full), true],
        ['full remove', () => api.removeClaudeIntegration(full), true],
      ];
      for (const [name, operation, exposesCode] of operations) {
        const result = await operation();
        assert.equal(result.ok, false, name);
        assert.equal(result.state, 'error', name);
        if (exposesCode) assert.equal(result.code, 'INVALID_CONFIG', name);
        assert.deepEqual(await snapshot(options.configDir), before, `${name} must not write`);
      }
    });
  }
});

test('missing legacy notebook ownership is read-only repairable and explicit connect restores current canonical MCP', async t => {
  const { files, options } = await missingOwnedFixture(t, ['notebook']);
  const before = await snapshot(options.configDir);
  assert.deepEqual(await api.getClaudeNotebookStatus(options), { ok: true, state: 'repairable', configured: false, changed: false });
  assert.deepEqual(await snapshot(options.configDir), before, 'status must not repair or claim ownership');

  const result = await api.installClaudeNotebook(options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(result.configured, true);
  assert.deepEqual((await json(files.mcp)).mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
  assert.equal((await json(files.mcp)).mcpServers['agent-pet'], undefined);
  assert.deepEqual(await json(files.notebook), { version: 1, mcpName: 'agent-pet-notebook', mcp: options.notebookMcpConfig });
});

test('recovered notebook exact repeat is read-only and creates no lock or backup', async t => {
  const { options } = await missingOwnedFixture(t, ['notebook']);
  assert.equal((await api.installClaudeNotebook(options)).ok, true);
  const before = await snapshot(options.configDir);
  const calls = [];
  const operation = ['open', 'writeFile', 'unlink', 'rename'].reduce((next, name) =>
    () => withFsFault(name, () => async () => {
      calls.push(name);
      throw Object.assign(new Error('repeat must be read-only'), { code: 'EACCES' });
    }, next), () => api.installClaudeNotebook(options));
  const result = await operation();
  assert.deepEqual(result, { ok: true, state: 'installed', configured: true, changed: false, backups: [] });
  assert.deepEqual(calls, []);
  assert.deepEqual(await snapshot(options.configDir), before);
});

test('missing owned MCP does not overwrite an externally occupied canonical target', async t => {
  const { files, options } = await missingOwnedFixture(t, ['notebook']);
  const global = await json(files.mcp);
  global.mcpServers['agent-pet-notebook'] = { command: 'foreign', args: [] };
  await write(files.mcp, global);
  const before = await snapshot(options.configDir);
  for (const operation of [() => api.getClaudeNotebookStatus(options), () => api.installClaudeNotebook(options)]) {
    const result = await operation();
    assert.equal(result.ok, false);
    assert.equal(result.state, 'conflict');
  }
  assert.deepEqual(await snapshot(options.configDir), before);
});

test('missing MCP with agreeing full and notebook owners restores canonical and synchronizes both records', async t => {
  const { files, options } = await missingOwnedFixture(t, ['full', 'notebook']);
  const result = await api.installClaudeNotebook(options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.deepEqual((await json(files.mcp)).mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
  for (const owner of ['full', 'notebook']) {
    assert.equal((await json(files[owner])).mcpName, 'agent-pet-notebook');
    assert.deepEqual((await json(files[owner])).mcp, options.notebookMcpConfig);
  }
});

for (const disagreement of ['snapshot', 'name']) {
  test(`missing MCP with dual owners that disagree on ${disagreement} stays conflict`, async t => {
    const { options } = await missingOwnedFixture(t, ['full', 'notebook'], {
      sameSnapshot: disagreement !== 'snapshot', sameName: disagreement !== 'name',
    });
    const before = await snapshot(options.configDir);
    for (const operation of [() => api.getClaudeNotebookStatus(options), () => api.installClaudeNotebook(options)]) {
      const result = await operation();
      assert.equal(result.ok, false);
      assert.equal(result.state, 'conflict');
    }
    assert.deepEqual(await snapshot(options.configDir), before);
  });
}

test('full install safely restores a missing MCP from its valid owner record', async t => {
  const { files, full, options } = await missingOwnedFixture(t, ['full']);
  const result = await api.installClaudeIntegration(full);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.deepEqual((await json(files.mcp)).mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
  assert.equal((await json(files.full)).mcpName, 'agent-pet-notebook');
  assert.deepEqual((await json(files.full)).mcp, options.notebookMcpConfig);
});

test('full removal succeeds when its owned MCP is already missing', async t => {
  const { files, full } = await missingOwnedFixture(t, ['full']);
  const result = await api.removeClaudeIntegration(full);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  await assert.rejects(fs.stat(files.full), { code: 'ENOENT' });
  assert.deepEqual(await json(files.settings), { model: 'keep', permissions: { ask: ['Bash(*)'] }, statusLine: { type: 'command', command: 'keep' }, env: { AUTH: 'fake-secret' } });
  assert.deepEqual((await json(files.mcp)).mcpServers, { other: { command: 'keep' } });
});

test('missing-MCP recovery publish failure restores the missing state and original owner record', async t => {
  const { files, options } = await missingOwnedFixture(t, ['notebook']);
  const mcpBefore = await fs.readFile(files.mcp, 'utf8');
  const recordBefore = await fs.readFile(files.notebook, 'utf8');
  const result = await withFsFault('rename', original => async (from, to) => {
    if (to === files.notebook) throw Object.assign(new Error('failure'), { code: 'EACCES' });
    return original(from, to);
  }, () => api.installClaudeNotebook(options));
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(files.mcp, 'utf8'), mcpBefore);
  assert.equal(await fs.readFile(files.notebook, 'utf8'), recordBefore);
  assert.ok(!(await fs.readdir(options.configDir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
  assert.deepEqual(await api.getClaudeNotebookStatus(options), { ok: true, state: 'repairable', configured: false, changed: false });
});

for (const owners of [['full'], ['notebook'], ['full', 'notebook']]) {
  for (const action of ['full', 'notebook']) {
    test(`legacy ${owners.join('+')} migrates only on explicit ${action} connect`, async t => {
      const { files, options, full } = await legacyFixture(t, owners);
      const before = await snapshot(options.configDir);
      assert.equal((await api.getClaudeNotebookStatus(options)).configured, true);
      assert.equal((await api.getClaudeIntegrationStatus(full)).ok, true);
      assert.equal((await api.previewClaudeIntegration(full)).ok, true);
      assert.deepEqual(await snapshot(options.configDir), before, 'status and preview never migrate or claim ownership');
      const settings = await fs.readFile(files.settings, 'utf8');
      const result = action === 'full' ? await api.installClaudeIntegration(full) : await api.installClaudeNotebook(options);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.changed, true);
      const global = await json(files.mcp);
      assert.equal(global.mcpServers['agent-pet'], undefined);
      assert.deepEqual(global.mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
      for (const owner of new Set([...owners, action])) {
        assert.equal((await json(files[owner])).mcpName, 'agent-pet-notebook');
        assert.deepEqual((await json(files[owner])).mcp, options.notebookMcpConfig);
      }
      if (action === 'notebook') assert.equal(await fs.readFile(files.settings, 'utf8'), settings);
      assert.equal((await api.removeClaudeIntegration(full)).ok, true);
      assert.equal((await api.getClaudeNotebookStatus(options)).configured, owners.includes('notebook') || action === 'notebook');
    });
  }
}

for (const kind of ['target-foreign', 'target-identical', 'old-modified', 'records-disagree', 'names-disagree', 'keyless-canonical', 'unknown-name', 'unowned-old']) {
  test(`migration refuses ${kind} without any writes`, async t => {
    const { files, options, full } = await legacyFixture(t, ['full', 'notebook']);
    const global = await json(files.mcp);
    if (kind.startsWith('target-')) global.mcpServers['agent-pet-notebook'] = kind === 'target-identical' ? options.notebookMcpConfig : { command: 'foreign', args: [] };
    if (kind === 'old-modified') global.mcpServers['agent-pet'].args.push('--user-edit');
    if (kind === 'records-disagree') await write(files.notebook, { version: 1, mcp: { command: 'different', args: [] } });
    if (kind === 'names-disagree' || kind === 'unknown-name') await write(files.notebook, { version: 1, mcpName: kind === 'names-disagree' ? 'agent-pet-notebook' : 'other', mcp: options.notebookMcpConfig });
    if (kind === 'keyless-canonical') {
      global.mcpServers['agent-pet-notebook'] = global.mcpServers['agent-pet'];
      delete global.mcpServers['agent-pet'];
    }
    if (kind === 'unowned-old') { await fs.unlink(files.full); await fs.unlink(files.notebook); }
    await write(files.mcp, global);
    const before = await snapshot(options.configDir);
    for (const operation of [() => api.getClaudeNotebookStatus(options), () => api.installClaudeNotebook(options), () => api.installClaudeIntegration(full), () => api.removeClaudeIntegration(full)]) {
      assert.equal((await operation()).ok, false, kind);
      assert.deepEqual(await snapshot(options.configDir), before);
    }
  });
}

for (const owners of [['full'], ['full', 'notebook']]) {
  test(`legacy full removal preserves only explicit notebook ownership (${owners.join('+')})`, async t => {
    const { files, options, full } = await legacyFixture(t, owners);
    assert.equal((await api.removeClaudeIntegration(full)).ok, true);
    const global = await json(files.mcp);
    assert.equal(global.mcpServers['agent-pet-notebook'], undefined, 'remove must not migrate');
    assert.deepEqual(global.mcpServers['agent-pet'], owners.includes('notebook') ? options.notebookMcpConfig : undefined);
    assert.equal((await api.getClaudeNotebookStatus(options)).configured, owners.includes('notebook'));
  });
}

for (const action of ['notebook', 'full']) {
  test(`legacy ${action} migration rolls back MCP and both ownership records on publish failure`, async t => {
    const { files, options, full } = await legacyFixture(t, ['full', 'notebook']);
    const before = await snapshot(options.configDir);
    const result = await withFsFault('rename', original => async (from, to) => {
      if (to === files.notebook) throw Object.assign(new Error('failure'), { code: 'EACCES' });
      return original(from, to);
    }, () => action === 'notebook' ? api.installClaudeNotebook(options) : api.installClaudeIntegration(full));
    assert.equal(result.ok, false);
    for (const [name, raw] of Object.entries(before)) assert.equal(await fs.readFile(path.join(options.configDir, name), 'utf8'), raw);
    assert.ok(!(await fs.readdir(options.configDir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
    assert.equal((await api.getClaudeNotebookStatus(options)).configured, true);
  });
}


test('first connection only writes user MCP and ownership, preserving settings bytes and account data', async t => {
  const { files, options } = await fixture(t);
  const beforeSettings = await fs.readFile(files.settings, 'utf8');
  const beforeMcp = await fs.readFile(files.mcp, 'utf8');
  assert.deepEqual(await api.getClaudeNotebookStatus(options), { ok: true, state: 'not-installed', configured: false, changed: false });
  const result = await api.installClaudeNotebook(options);
  publicResult(result);
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.changed, true);
  assert.equal(result.backups.length, 1);
  assert.equal(await fs.readFile(result.backups[0], 'utf8'), beforeMcp);
  assert.equal(await fs.readFile(files.settings, 'utf8'), beforeSettings);
  assert.deepEqual(await json(files.mcp), { ...JSON.parse(beforeMcp), mcpServers: { other: { command: 'keep' }, 'agent-pet-notebook': options.notebookMcpConfig } });
  assert.deepEqual(await json(files.notebook), { version: 1, mcpName: 'agent-pet-notebook', mcp: options.notebookMcpConfig });
  await assert.rejects(fs.stat(files.full), { code: 'ENOENT' });
});

test('exact repeat and status do not rewrite any file or create backups', async t => {
  const { options } = await fixture(t);
  assert.equal((await api.installClaudeNotebook(options)).ok, true);
  const before = await snapshot(options.configDir);
  assert.deepEqual(await api.getClaudeNotebookStatus({ configDir: options.configDir }), { ok: true, state: 'installed', configured: true, changed: false });
  const result = await api.installClaudeNotebook(options);
  publicResult(result);
  assert.equal(result.changed, false);
  assert.deepEqual(result.backups, []);
  assert.deepEqual(await snapshot(options.configDir), before);
});

test('exact repeat stays configured on a read-only profile without opening a lock or issuing writes', async t => {
  for (const shared of [false, true]) {
    const { options, full } = await fixture(t);
    assert.equal((await api.installClaudeNotebook(options)).ok, true);
    if (shared) assert.equal((await api.installClaudeIntegration(full)).ok, true);
    const before = await snapshot(options.configDir);
    const calls = [];
    // Windows directory chmod does not reliably enforce read-only access. Deny
    // every mutation entry point instead, including the transient lock creation.
    const operation = ['open', 'writeFile', 'unlink', 'rename'].reduce((next, name) =>
      () => withFsFault(name, () => async () => {
        calls.push(name);
        throw Object.assign(new Error('read-only profile'), { code: 'EACCES' });
      }, next), () => api.installClaudeNotebook(options));
    const result = await operation();
    assert.deepEqual(calls, [], 'an exact repeat must not attempt even transient filesystem writes');
    assert.deepEqual(result, { ok: true, state: 'installed', configured: true, changed: false, backups: [] });
    assert.equal((await api.getClaudeNotebookStatus(options)).configured, true);
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

for (const order of ['full-first', 'notebook-first']) {
  test(`${order} shares agent-pet and full removal retains explicitly connected notebook`, async t => {
    const { files, options, full } = await fixture(t);
    const settings = await fs.readFile(files.settings, 'utf8');
    if (order === 'full-first') {
      assert.equal((await api.installClaudeIntegration(full)).ok, true);
      assert.equal((await api.getClaudeNotebookStatus(options)).configured, true);
    }
    assert.equal((await api.installClaudeNotebook(options)).ok, true);
    assert.equal((await api.installClaudeIntegration(full)).ok, true);
    assert.equal((await api.getClaudeIntegrationStatus(full)).state, 'installed');
    assert.deepEqual(Object.keys((await json(files.mcp)).mcpServers).sort(), ['agent-pet-notebook', 'other']);
    assert.equal((await api.removeClaudeIntegration(full)).ok, true);
    assert.equal((await api.getClaudeNotebookStatus(options)).configured, true);
    assert.deepEqual((await json(files.mcp)).mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
    assert.deepEqual(await json(files.settings), JSON.parse(settings));
    assert.equal((await api.removeClaudeIntegration(full)).changed, false);
    assert.equal((await api.installClaudeNotebook(options)).changed, false);
    assert.equal((await api.installClaudeIntegration(full)).ok, true);
  });
}

test('status alone never claims ownership of an existing full installation', async t => {
  const { files, options, full } = await fixture(t);
  await api.installClaudeIntegration(full);
  const before = await snapshot(options.configDir);
  assert.equal((await api.getClaudeNotebookStatus(options)).configured, true);
  assert.deepEqual(await snapshot(options.configDir), before);
  await api.removeClaudeIntegration(full);
  assert.equal((await api.getClaudeNotebookStatus(options)).configured, false);
  assert.equal((await json(files.mcp)).mcpServers['agent-pet-notebook'], undefined);
});

for (const source of ['notebook', 'full']) {
  test(`${source} updates owned app paths and both manifests without creating a conflict`, async t => {
    const { root, files, options, full } = await fixture(t);
    await api.installClaudeNotebook(options);
    await api.installClaudeIntegration(full);
    const settings = await fs.readFile(files.settings, 'utf8');
    const mcp = { ...options.notebookMcpConfig, command: path.join(root, 'new app.exe'), args: [path.join(root, 'new stdio.mjs')] };
    const updatedNotebook = { ...options, notebookMcpConfig: mcp };
    const updatedFull = { ...full, mcpConfig: { mcpServers: { 'agent-pet-notebook': mcp } } };
    const result = source === 'notebook' ? await api.installClaudeNotebook(updatedNotebook) : await api.installClaudeIntegration(updatedFull);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.changed, true);
    assert.equal(await fs.readFile(files.settings, 'utf8'), settings);
    assert.deepEqual((await json(files.full)).mcp, mcp);
    assert.deepEqual((await json(files.notebook)).mcp, mcp);
    assert.equal((await api.getClaudeIntegrationStatus(full)).state, 'installed');
    assert.equal((await api.installClaudeNotebook(updatedNotebook)).changed, false);
    assert.equal((await api.installClaudeIntegration(updatedFull)).changed, false);
    assert.equal((await api.removeClaudeIntegration(full)).ok, true);
    assert.deepEqual((await json(files.mcp)).mcpServers['agent-pet-notebook'], mcp);
  });
}

for (const kind of ['foreign', 'identical-unowned', 'modified', 'disagreeing-records']) {
  test(`${kind} MCP is not overwritten or removed`, async t => {
    const { files, options, full } = await fixture(t);
    if (!['foreign', 'identical-unowned'].includes(kind)) {
      await api.installClaudeNotebook(options);
      await api.installClaudeIntegration(full);
    }
    const current = await json(files.mcp);
    current.mcpServers['agent-pet-notebook'] = kind === 'identical-unowned' ? options.notebookMcpConfig : { command: 'foreign', args: [] };
    if (kind === 'disagreeing-records') {
      current.mcpServers['agent-pet-notebook'] = options.notebookMcpConfig;
      await write(files.notebook, { version: 1, mcp: { command: 'different', args: [] } });
    }
    await write(files.mcp, current);
    const before = await snapshot(options.configDir);
    for (const name of ['getClaudeNotebookStatus', 'installClaudeNotebook']) {
      const result = await api[name](options);
      publicResult(result);
      assert.equal(result.state, 'conflict');
      assert.equal(result.configured, false);
    }
    assert.equal((await api.installClaudeIntegration(full)).ok, false);
    assert.equal((await api.removeClaudeIntegration(full)).ok, false);
    assert.deepEqual(await snapshot(options.configDir), before);
  });
}

test('bad MCP JSON and ownership records fail closed without backups', async t => {
  for (const [target, raw] of [['mcp', '{bad'], ['mcp', '[]'], ['mcp', '{"mcpServers":null}'], ['notebook', '{bad'], ['notebook', '{"version":99,"mcp":{}}'], ['full', '{bad']]) {
    const { files, options } = await fixture(t);
    await fs.writeFile(files[target], raw);
    const before = await snapshot(options.configDir);
    for (const name of ['getClaudeNotebookStatus', 'installClaudeNotebook']) {
      const result = await api[name](options);
      publicResult(result);
      assert.equal(result.state, 'error', `${target} ${raw}`);
    }
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

test('MCP-only ignores even invalid settings and never creates missing settings or credentials', async t => {
  for (const missing of [true, false]) {
    const { files, options } = await fixture(t);
    if (missing) await fs.unlink(files.settings);
    else await fs.writeFile(files.settings, '{broken');
    await fs.unlink(files.mcp);
    const result = await api.installClaudeNotebook(options);
    assert.equal(result.ok, true);
    assert.deepEqual(result.backups, []);
    if (missing) await assert.rejects(fs.stat(files.settings), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(files.settings, 'utf8'), '{broken');
    assert.deepEqual((await fs.readdir(options.configDir)).sort(), [...(missing ? [] : ['settings.json']), '.claude.json', 'agent-pet-notebook.json'].sort());
  }
});

test('absent Claude root is not manufactured', async t => {
  const { options } = await fixture(t);
  options.configDir = path.join(options.configDir, 'absent');
  for (const name of ['getClaudeNotebookStatus', 'installClaudeNotebook']) {
    assert.deepEqual(await api[name](options), { ok: true, state: 'not-detected', configured: false, changed: false });
    await assert.rejects(fs.stat(options.configDir), { code: 'ENOENT' });
  }
});

test('default home and environment/custom config roots retain distinct MCP destinations', async t => {
  const { root, options } = await fixture(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = os.homedir;
  os.homedir = () => root;
  await fs.mkdir(path.join(root, '.claude'));
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    const { configDir, ...rest } = options;
    assert.equal((await api.installClaudeNotebook(rest)).ok, true);
    assert.deepEqual((await json(path.join(root, '.claude.json'))).mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
    await assert.rejects(fs.stat(path.join(root, '.claude', '.claude.json')), { code: 'ENOENT' });
    process.env.CLAUDE_CONFIG_DIR = configDir;
    assert.equal((await api.installClaudeNotebook(rest)).ok, true);
    assert.deepEqual((await json(path.join(configDir, '.claude.json'))).mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
    const explicit = path.join(root, 'explicit');
    await fs.mkdir(explicit);
    assert.equal((await api.installClaudeNotebook({ ...options, configDir: explicit })).ok, true);
    assert.deepEqual((await json(path.join(explicit, '.claude.json'))).mcpServers['agent-pet-notebook'], options.notebookMcpConfig);
  } finally {
    os.homedir = originalHome;
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('invalid notebook stdio options never write config or backup', async t => {
  for (const notebookMcpConfig of [undefined, {}, { command: 'node', args: 'bad' }, { command: 'node', args: [], env: { TOKEN: 1 } }, { type: 'http', command: 'node', args: [] }]) {
    const { options } = await fixture(t);
    const before = await snapshot(options.configDir);
    const result = await api.installClaudeNotebook({ ...options, notebookMcpConfig });
    publicResult(result);
    assert.equal(result.ok, false);
    assert.deepEqual(await snapshot(options.configDir), before);
  }
});

test('notebook uses the shared integration lock without disturbing its holder', async t => {
  const { options } = await fixture(t);
  await fs.writeFile(path.join(options.configDir, 'agent-pet-integration.lock'), 'busy');
  const before = await snapshot(options.configDir);
  const result = await api.installClaudeNotebook(options);
  publicResult(result);
  assert.equal(result.ok, false);
  assert.deepEqual(await snapshot(options.configDir), before);
});

test('backup-time concurrent edit triggers CAS and preserves external content', async t => {
  const { files, options } = await fixture(t);
  const edited = '{"external":"fake-secret"}';
  const result = await withFsFault('writeFile', original => async (file, ...args) => {
    const written = await original(file, ...args);
    if (String(file).startsWith(`${files.mcp}.agent-pet-backup-`)) await original(files.mcp, edited);
    return written;
  }, () => api.installClaudeNotebook(options));
  publicResult(result);
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(files.mcp, 'utf8'), edited);
  await assert.rejects(fs.stat(files.notebook), { code: 'ENOENT' });
  assert.ok(!(await fs.readdir(options.configDir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
});

test('notebook record publish failure rolls back MCP and shared full record byte-for-byte', async t => {
  const { root, files, options, full } = await fixture(t);
  await api.installClaudeIntegration(full);
  const mcp = await fs.readFile(files.mcp, 'utf8');
  const legacy = await fs.readFile(files.full, 'utf8');
  const result = await withFsFault('rename', original => async (from, to) => {
    if (to === files.notebook) throw Object.assign(new Error('fake-secret'), { code: 'EACCES' });
    return original(from, to);
  }, () => api.installClaudeNotebook({ ...options, notebookMcpConfig: { command: path.join(root, 'updated.exe'), args: [] } }));
  publicResult(result);
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(files.mcp, 'utf8'), mcp);
  assert.equal(await fs.readFile(files.full, 'utf8'), legacy);
  await assert.rejects(fs.stat(files.notebook), { code: 'ENOENT' });
  assert.ok(!(await fs.readdir(options.configDir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
});

test('full transaction checks notebook ownership snapshot before modifying shared MCP', async t => {
  const { files, options, full } = await fixture(t);
  await api.installClaudeNotebook(options);
  const mcp = await fs.readFile(files.mcp, 'utf8');
  const settings = await fs.readFile(files.settings, 'utf8');
  const edited = { ...await json(files.notebook), external: true };
  const result = await withFsFault('writeFile', original => async (file, ...args) => {
    const written = await original(file, ...args);
    if (String(file).startsWith(`${files.settings}.agent-pet-backup-`)) await original(files.notebook, JSON.stringify(edited));
    return written;
  }, () => api.installClaudeIntegration(full));
  assert.equal(result.code, 'CONCURRENT_CHANGE');
  assert.equal(await fs.readFile(files.mcp, 'utf8'), mcp);
  assert.equal(await fs.readFile(files.settings, 'utf8'), settings);
  assert.deepEqual(await json(files.notebook), edited);
  await assert.rejects(fs.stat(files.full), { code: 'ENOENT' });
});
