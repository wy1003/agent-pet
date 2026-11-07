import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { installClaudeIntegration, removeClaudeIntegration, getClaudeIntegrationStatus, previewClaudeIntegration } from '../desktop/claude/integration.mjs';
const bridge = fileURLToPath(new URL('../desktop/claude/statusline-bridge.mjs', import.meta.url));
const status = await import('../desktop/claude/statusline-bridge.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const q = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function fixture(t, statuslineShell = 'bash') {
  // Exercise the tilde in Windows 8.3 paths even when the local TEMP has none.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pet-status-RUNNER~1-'中文 "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config'); await fs.mkdir(configDir);
  const originalFile = path.join(root, 'original.mjs');
  await fs.writeFile(originalFile, `let input='';for await(const c of process.stdin)input+=c;process.stdout.write('原输出:'+input);process.stderr.write('原错误');process.exitCode=7;`);
  // statusLine.command is interpreted by Claude's bash host in both modes.
  const original = { type: 'command', command: `${q(process.execPath.replaceAll('\\', '/'))} ${q(originalFile.replaceAll('\\', '/'))}`, padding: 2, refreshInterval: 5 };
  await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ statusLine: original }));
  return { root, original, configDir, statuslineShell, eventsDir: path.join(root, 'events'), nodePath: process.execPath,
    bridgePath: path.join(root, 'hook.mjs'), statuslineBridgePath: bridge, usagePath: path.join(root, 'usage', 'snapshot.json'),
    mcpConfig: { mcpServers: { 'agent-pet-notebook': { command: process.execPath, args: [path.join(root, 'mcp.mjs')] } } } };
}
function env(root) { return { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root }; }
async function run(command, input, root, shell = 'bash', timeout = 15000) {
  // Both implementations are commands for Claude's default bash host.
  // PowerShell is an explicitly launched child, never an assumed outer host.
  const bash = process.platform === 'win32' ? [process.env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'usr', 'bin', 'bash.exe')].find(p => p && existsSync(p)) : '/bin/sh';
  const executable = bash;
  assert.ok(executable, 'Git Bash is required to verify the Windows bash host');
  const args = ['-c', command];
  const child = spawn(executable, args, { env: env(root), windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', () => {});
  let timedOut = false;
  const killTree = () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout);
  try {
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    child.stdin.end(input);
    const status = await closed;
    assert.equal(timedOut, false, 'Statusline timed out; its controlled process tree was terminated');
    return { status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), stdoutBytes: Buffer.concat(stdout), stderrBytes: Buffer.concat(stderr) };
  } finally { clearTimeout(timer); killTree(); }
}

test('snapshot includes only necessary fields and never invents quota zero', () => {
  assert.equal(typeof status.usageSnapshot, 'function');
  const snapshot = status.usageSnapshot({ session_id: 's', rate_limits: { five_hour: { used_percentage: 0, resets_at: 123, secret: 'no' }, seven_day: { used_percentage: 42 }, other: 'no' }, cost: { total_cost_usd: 1.2, secret: 'no' }, transcript_path: 'private', cwd: 'private' }, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(snapshot, { capturedAt: '2026-01-01T00:00:00.000Z', session_id: 's', rate_limits: { five_hour: { used_percentage: 0, resets_at: 123 }, seven_day: { used_percentage: 42 } }, cost: { total_cost_usd: 1.2 } });
  assert.deepEqual(status.usageSnapshot({}).rate_limits, {});
  assert.deepEqual(status.usageSnapshot({ rate_limits: { five_hour: { used_percentage: null }, seven_day: { used_percentage: '20' } } }).rate_limits, {});
});

test('quoted tildes remain literal in statusline paths and arguments', async t => {
  const o = await fixture(t);
  const executable = process.execPath.replaceAll('\\', '/');
  const script = path.join(o.root, 'original.mjs').replaceAll('\\', '/');
  for (const literal of [q('~/literal'), '"~/literal"', q('RUNNER~1'), q('~')]) {
    const original = { type: 'command', command: `${q(executable)} ${q(script)} ${literal}` };
    const command = status.makeStatusline({ ...o, original }).command;
    const payload = command.match(/--agent-pet-statusline-v1' '([A-Za-z0-9_-]+)'/)?.[1];
    assert.ok(payload, 'bash launcher must carry the original arguments');
    const expected = literal.slice(1, -1);
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).argv, [executable, script, expected]);
  }
});

test('unquoted tilde expansion remains unsupported', async t => {
  const o = await fixture(t);
  for (const suffix of ['~', '~/script.mjs', '~user/script.mjs', '~+/script.mjs', 'PATH=~/bin']) {
    const original = { type: 'command', command: `${q(process.execPath.replaceAll('\\', '/'))} ${suffix}` };
    assert.throws(() => status.makeStatusline({ ...o, original }), { code: 'UNSUPPORTED_STATUSLINE' }, suffix);
  }
});

test('launcher uses the declared host and Windows children are explicitly windowless', async t => {
  const o = await fixture(t);
  const command = status.makeStatusline({ ...o, original: o.original }).command;
  assert.ok(!command.includes('-EncodedCommand'), 'bash must launch Node directly, without nested PowerShell');
  if (process.platform === 'win32') {
    const ps = await fixture(t, 'powershell');
    const psCommand = status.makeStatusline({ ...ps, original: ps.original }).command;
    const encoded = psCommand.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    assert.ok(encoded, 'PowerShell implementation must provide a complete bash-launchable command');
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(script, /CreateNoWindow=\$true/);
    assert.match(script, /RedirectStandardInput=\$true/);
    assert.match(script, /RedirectStandardOutput=\$true/);
    assert.match(script, /RedirectStandardError=\$true/);
  }
});

for (const shell of process.platform === 'win32' ? ['bash', 'powershell'] : ['bash']) {
test(`without explicit opt-in statusLine is untouched; enable later, preserve output/stderr/exit/stdin and restore (${shell})`, async t => {
  const o = await fixture(t, shell);
  assert.equal((await installClaudeIntegration(o)).ok, true);
  assert.deepEqual((await json(path.join(o.configDir, 'settings.json'))).statusLine, o.original);
  const installed = await installClaudeIntegration({ ...o, enableStatusline: true });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.statuslineEnabled, true);
  const repeated = await installClaudeIntegration({ ...o, enableStatusline: true });
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.changed, false);
  const current = (await json(installed.paths.settings)).statusLine;
  assert.equal(current.padding, 2);
  assert.equal(current.refreshInterval, 5);
  const input = JSON.stringify({ session_id: 'session', rate_limits: { five_hour: { used_percentage: 25.5, resets_at: 123456 } }, cost: { total_cost_usd: 0.25 }, private_data: 'exclude' });
  const result = await run(current.command, input, o.root, shell);
  assert.equal(result.status, 7, result.error?.stack || result.stderr);
  assert.equal(result.stdout, '原输出:' + input);
  assert.equal(result.stderr, '原错误');
  const snapshot = await json(o.usagePath);
  assert.equal(snapshot.session_id, 'session');
  assert.equal(snapshot.rate_limits.five_hour.used_percentage, 25.5);
  assert.equal(snapshot.private_data, undefined);
  assert.ok(Number.isFinite(Date.parse(snapshot.capturedAt)));
  assert.equal((await removeClaudeIntegration({ configDir: o.configDir })).ok, true);
  assert.deepEqual((await json(installed.paths.settings)).statusLine, o.original);
});

test('complex commands and recursion are reported unsupported and never overwritten', async t => {
  for (const command of ['node script | tee output', 'echo $SECRET', 'bash -c "something"', `${q(process.execPath)} ${q(bridge)}`, 'anything # agent-pet:statusline:v1']) {
    const o = await fixture(t, shell);
    const original = { statusLine: { type: 'command', command } };
    await fs.writeFile(path.join(o.configDir, 'settings.json'), JSON.stringify(original));
    const result = await installClaudeIntegration({ ...o, enableStatusline: true });
    assert.equal(result.ok, false, command);
    assert.ok(['UNSUPPORTED_STATUSLINE', 'CONFLICT'].includes(result.code), JSON.stringify(result));
    assert.deepEqual(await json(path.join(o.configDir, 'settings.json')), original);
    await assert.rejects(fs.stat(path.join(o.configDir, '.claude.json')), { code: 'ENOENT' });
  }
});

test('modified installed statusline is protected', async t => {
  const o = await fixture(t, shell);
  const installed = await installClaudeIntegration({ ...o, enableStatusline: true });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const settings = await json(installed.paths.settings); settings.statusLine.command += ' changed';
  await fs.writeFile(installed.paths.settings, JSON.stringify(settings));
  assert.equal((await getClaudeIntegrationStatus({ configDir: o.configDir })).state, 'modified');
  assert.equal((await removeClaudeIntegration({ configDir: o.configDir })).ok, false);
});

test('absent original stays silent and restores absence; invalid input does not break original output', async t => {
  const o = await fixture(t, shell);
  await fs.writeFile(path.join(o.configDir, 'settings.json'), '{}');
  const installed = await installClaudeIntegration({ ...o, enableStatusline: true });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const repeated = await installClaudeIntegration({ ...o, enableStatusline: true });
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.changed, false);
  const current = (await json(installed.paths.settings)).statusLine;
  const result = await run(current.command, '{}', o.root, shell);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual((await json(o.usagePath)).rate_limits, {});
  assert.equal((await removeClaudeIntegration({ configDir: o.configDir })).ok, true);
  assert.equal((await json(installed.paths.settings)).statusLine, undefined);

  await fs.writeFile(installed.paths.settings, JSON.stringify({ statusLine: o.original }));
  const preview = await previewClaudeIntegration({ ...o, enableStatusline: true });
  const invalid = await run(preview.preview.statusLine.command, '{not json', o.root, shell);
  assert.equal(invalid.status, 7, invalid.stderr);
  assert.equal(invalid.stdout, '原输出:{not json');
  assert.equal(invalid.stderr, '原错误');
});

test(`binary stdin/stdout/stderr remain byte-for-byte unchanged (${shell})`, async t => {
  const o = await fixture(t, shell);
  await fs.writeFile(path.join(o.root, 'original.mjs'), `process.stdin.pipe(process.stdout);process.stderr.write(Buffer.from([255,0,13,10,128]));process.exitCode=7;`);
  const command = status.makeStatusline({ ...o, original: o.original }).command;
  const input = Buffer.from([0, 255, 13, 10, 128, ...Buffer.from('中文')]);
  const result = await run(command, input, o.root, shell);
  assert.equal(result.status, 7);
  assert.deepEqual(result.stdoutBytes, input);
  assert.deepEqual(result.stderrBytes, Buffer.from([255, 0, 13, 10, 128]));
});

test(`timeout cleanup terminates the controlled statusline descendant (${shell})`, async t => {
  const o = await fixture(t, shell);
  const pidFile = path.join(o.root, 'child.pid');
  await fs.writeFile(path.join(o.root, 'original.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const command = status.makeStatusline({ ...o, original: o.original }).command;
  await assert.rejects(run(command, '{}', o.root, shell, 2000), /controlled process tree was terminated/);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('snapshot write failure does not alter original behavior', async t => {
  const o = await fixture(t, shell);
  await fs.writeFile(o.usagePath = path.join(o.root, 'not-directory'), 'occupied');
  const preview = await previewClaudeIntegration({ ...o, usagePath: path.join(o.usagePath, 'snapshot.json'), enableStatusline: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const result = await run(preview.preview.statusLine.command, '{}', o.root, shell);
  assert.equal(result.status, 7, result.error?.stack || result.stderr);
  assert.equal(result.stdout, '原输出:{}');
  assert.equal(result.stderr, '原错误');
});
}
