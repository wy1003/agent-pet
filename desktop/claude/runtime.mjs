import { stat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

async function existingFile(candidate) {
  if (!candidate) return '';
  try { return (await stat(candidate)).isFile() ? await realpath(candidate) : ''; }
  catch { return ''; }
}

function bundledExecutable(platform, arch) {
  try {
    const root = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/package.json`));
    return path.join(root, platform === 'win32' ? 'claude.exe' : 'claude')
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  } catch { return ''; }
}

// Discovery only: no process launch, auth probe, configuration or credential reads.
export function resolveClaudeConfigDirectory(options = {}) {
  const env = options.env ?? process.env;
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(options.homeDir ?? os.homedir(), '.claude'));
}

export async function resolveClaudeExecutable(explicitPath = '', options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? os.homedir();
  const override = explicitPath || env.AGENT_PET_CLAUDE_EXECUTABLE;
  if (override) {
    const found = await existingFile(path.resolve(override));
    if (!found) throw new Error('指定的 Claude 可执行文件不存在');
    return found;
  }
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const paths = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const candidates = [
    options.bundledExecutable ?? bundledExecutable(platform, options.arch ?? process.arch),
    ...paths.map((dir) => path.join(dir.replace(/^"|"$/g, ''), name)),
    path.join(home, '.local', 'bin', name),
  ];
  for (const candidate of candidates) {
    const found = await existingFile(candidate);
    if (found) return found;
  }
  return '';
}

// Probe only Node's version; never launch Electron as a desktop app or invoke a model.
export async function resolveNodeExecutable(explicitPath = '', options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const electron = options.electron ?? Boolean(process.versions.electron);
  const execPath = options.execPath ?? process.execPath;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  const paths = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const candidates = explicitPath ? [path.resolve(explicitPath)] : [
    !electron && process.execPath,
    env.npm_node_execpath,
    ...paths.map(dir => path.join(dir.replace(/^"|"$/g, ''), name)),
    ...(platform === 'win32' ? [
      env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs', name),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs', name),
    ] : []),
  ];
  const probeEnv = { ...env };
  delete probeEnv.NODE_OPTIONS;
  delete probeEnv.ELECTRON_RUN_AS_NODE;
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (!path.isAbsolute(candidate)) continue;
    const found = await existingFile(candidate);
    if (!found || (electron && found.toLowerCase() === execPath.toLowerCase())) continue;
    try {
      const { stdout } = await promisify(execFile)(found, ['--version'], {
        env: probeEnv, windowsHide: true, timeout: 2000, maxBuffer: 4096,
      });
      if (Number(/^v(\d+)\./.exec(stdout.trim())?.[1]) >= 20) return found;
    } catch { /* Try the next local runtime. */ }
  }
  if (explicitPath) throw new Error('指定的 Node.js 运行时不可用，需要 Node.js 20 或更高版本');
  return '';
}

export async function getClaudeRuntimeStatus(options = {}) {
  const configDirectory = resolveClaudeConfigDirectory(options);
  try {
    const executablePath = await resolveClaudeExecutable(options.executablePath || '', options);
    return { available: Boolean(executablePath), executablePath, configDirectory, authenticated: null };
  } catch (error) {
    return { available: false, executablePath: '', configDirectory, authenticated: null, error: error.message };
  }
}
