import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'agent-pet:statusline:v1';
const FLAG = '--agent-pet-statusline-v1';
const MAX_INPUT = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function unsupported() {
  throw Object.assign(new Error('现有状态栏不支持安全包装：仅支持绝对路径可执行程序及字面参数；管道、变量、重定向和递归包装不支持。原配置未修改。'), { code: 'UNSUPPORTED_STATUSLINE', publicMessage: true });
}
const psQuote = text => `'${text.replaceAll("'", "''")}'`;
const shQuote = text => `'${text.replaceAll("'", "'\"'\"'")}'`;
const windowsArg = text => `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) unsupported();
  return path.resolve(value);
}
// Deliberately a small shell-literal subset, not a shell interpreter. Reject all
// expansions/operators rather than change their meaning. Quoted tildes are
// literal characters, including the tilde in Windows 8.3 paths such as RUNNER~1.
function originalArgv(original, bridgePath, shell) {
  if (original === undefined || original === null) return null;
  if (!object(original) || original.type !== 'command' || typeof original.command !== 'string') unsupported();
  if (Object.keys(original).some(key => !['type', 'command', 'padding', 'refreshInterval', 'hideVimModeIndicator'].includes(key))) unsupported();
  if ((original.padding !== undefined && (typeof original.padding !== 'number' || !Number.isFinite(original.padding)))
      || (original.refreshInterval !== undefined && (typeof original.refreshInterval !== 'number' || original.refreshInterval < 1))
      || (original.hideVimModeIndicator !== undefined && typeof original.hideVimModeIndicator !== 'boolean')) unsupported();
  const command = shell === 'powershell' ? original.command.replace(/^\s*&\s+/, '') : original.command;
  if (!command || /[\0\r\n$`|;&<>*?#]/.test(command) || command.includes(MARKER) || command.includes(FLAG)) unsupported();
  const args = []; let token = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (shell === 'powershell' && quote === "'" && c === "'" && command[i + 1] === "'") { token += "'"; i++; }
      else if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') unsupported();
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { args.push(token); token = ''; started = false; } }
    else if (c === '\\' || c === '~') unsupported();
    else { token += c; started = true; }
  }
  if (quote) unsupported();
  if (started) args.push(token);
  if (!args.length || !path.isAbsolute(args[0])) unsupported();
  // Scripts may themselves call another statusline: a process-local recursion
  // guard also prevents that case, without modifying the saved original command.
  if (args.some(arg => arg.includes('statusline-bridge.mjs') || arg === bridgePath || arg === FLAG)) unsupported();
  if (process.platform === 'win32' && !/\.exe$/i.test(args[0])) unsupported();
  return args;
}

/** Pure config builder. No shell is used to run the saved original command. */
export function makeStatusline({ nodePath, statuslineBridgePath, usagePath, original, statuslineShell = 'bash' }) {
  if (!['bash', 'powershell'].includes(statuslineShell) || statuslineShell === 'powershell' && process.platform !== 'win32') unsupported();
  nodePath = absolute(nodePath);
  statuslineBridgePath = absolute(statuslineBridgePath);
  usagePath = absolute(usagePath);
  const argv = originalArgv(original, statuslineBridgePath, 'bash');
  const payload = Buffer.from(JSON.stringify({ usagePath, argv })).toString('base64url');
  const args = [statuslineBridgePath, FLAG, payload];
  let command;
  if (statuslineShell === 'powershell') {
    // Claude runs the command in bash. Launch PowerShell explicitly, and copy
    // raw bytes inside it rather than using PowerShell's text/object pipeline.
    const script = `$p=[System.Diagnostics.ProcessStartInfo]::new();$p.FileName=${psQuote(nodePath)};$p.Arguments=${psQuote(args.map(windowsArg).join(' '))};$p.UseShellExecute=$false;$p.CreateNoWindow=$true;$p.RedirectStandardInput=$true;$p.RedirectStandardOutput=$true;$p.RedirectStandardError=$true;$c=[System.Diagnostics.Process]::Start($p);try{$o=$c.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$e=$c.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());try{[void][Console]::OpenStandardInput().CopyToAsync($c.StandardInput.BaseStream).GetAwaiter().GetResult()}catch{}finally{$c.StandardInput.Close()};$c.WaitForExit();[void]$o.GetAwaiter().GetResult();[void]$e.GetAwaiter().GetResult();$code=$c.ExitCode}finally{if(!$c.HasExited){$c.Kill();$c.WaitForExit()};$c.Dispose()};exit $code`;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').replaceAll('\\', '/');
    command = `${shQuote(powershell)} -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')} # ${MARKER}`;
  } else {
    // Claude's bash host (including Git Bash) forwards stdio and exit status
    // directly. Forward slashes keep Windows paths valid for the bash launcher.
    const shellPaths = [nodePath, statuslineBridgePath].map(value => process.platform === 'win32' ? value.replaceAll('\\', '/') : value);
    command = `${[...shellPaths, FLAG, payload].map(shQuote).join(' ')} # ${MARKER}`;
  }
  return { ...(original ?? {}), type: 'command', command };
}

/** Official stdin fields only; an absent/invalid limit remains absent, not zero. */
export function usageSnapshot(input, capturedAt = new Date().toISOString()) {
  const snapshot = { capturedAt, session_id: typeof input?.session_id === 'string' ? input.session_id : null, rate_limits: {} };
  for (const key of ['five_hour', 'seven_day']) {
    const window = input?.rate_limits?.[key];
    if (typeof window?.used_percentage !== 'number' || !Number.isFinite(window.used_percentage) || window.used_percentage < 0 || window.used_percentage > 100) continue;
    snapshot.rate_limits[key] = { used_percentage: window.used_percentage };
    if (typeof window.resets_at === 'number' && Number.isFinite(window.resets_at) && window.resets_at >= 0) snapshot.rate_limits[key].resets_at = window.resets_at;
  }
  if (typeof input?.cost?.total_cost_usd === 'number' && Number.isFinite(input.cost.total_cost_usd) && input.cost.total_cost_usd >= 0) snapshot.cost = { total_cost_usd: input.cost.total_cost_usd };
  return snapshot;
}
async function capture(usagePath, input) {
  const snapshot = usageSnapshot(JSON.parse(input));
  await mkdir(path.dirname(usagePath), { recursive: true });
  const temporary = `${usagePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    await rename(temporary, usagePath);
  } finally { await rm(temporary, { force: true }); }
}
async function main() {
  if (process.env.AGENT_PET_STATUSLINE_ACTIVE === '1') return;
  if (process.argv.length !== 4 || process.argv[2] !== FLAG) throw new Error('Invalid wrapper arguments');
  const config = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
  const usagePath = absolute(config.usagePath);
  if (config.argv !== null && (!Array.isArray(config.argv) || !config.argv.length || !config.argv.every(arg => typeof arg === 'string') || !path.isAbsolute(config.argv[0]))) throw new Error('Invalid original command');
  let child, done;
  if (config.argv) {
    child = spawn(config.argv[0], config.argv.slice(1), { shell: false, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, AGENT_PET_STATUSLINE_ACTIVE: '1' } });
    // Original programs may close stdin early. This is not a capture failure.
    child.stdin.on('error', () => {});
    done = new Promise(resolve => {
      child.once('error', () => resolve({ code: 127 }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    process.stdin.pipe(child.stdin);
  }
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size <= MAX_INPUT) chunks.push(chunk);
    else chunks.length = 0;
  }
  if (size <= MAX_INPUT) {
    try { await capture(usagePath, Buffer.concat(chunks).toString('utf8')); }
    catch { /* Observation must not change the original program's streams/exit. */ }
  }
  if (done) {
    const { code, signal } = await done;
    if (signal && process.platform !== 'win32') process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.exitCode = 1; });
}
