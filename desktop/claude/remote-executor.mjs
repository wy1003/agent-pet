import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRemoteRequest } from '../../src/remote-request.mjs';
import { resolveClaudeExecutable } from './runtime.mjs';

const FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
const FORBIDDEN_TOOLS = ['Bash', 'WebSearch', 'WebFetch', 'Agent', 'Task', 'Workflow', 'Skill', 'mcp__*'];
const RAW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function rawSessionId(value) {
  if (typeof value !== 'string' || !value.startsWith('claude:') || !RAW_ID.test(value.slice(7))) {
    throw new TypeError('恢复任务需要 claude:<原生会话 ID>');
  }
  return value.slice(7);
}

async function verifiedDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('授权项目目录不能为空');
  try {
    const cwd = await realpath(value.trim());
    if (!(await stat(cwd)).isDirectory()) throw new Error('not_a_directory');
    return cwd;
  } catch (cause) { throw new Error('授权项目目录不存在或不可访问', { cause }); }
}

function checkAborted(signal) {
  if (signal?.aborted) throw new DOMException('Claude 远程任务已中断', 'AbortError');
}

function executionError(source, { route = 'sdk', turnStarted = false, submitted = false } = {}) {
  const error = new Error(source?.message || String(source || 'Claude 远程任务执行失败'), { cause: source });
  error.name = source?.name === 'AbortError' ? 'AbortError' : 'Error';
  error.code = source?.code || 'claude_execution_failed';
  error.route = route;
  error.providerId = 'claude';
  error.turnStarted = turnStarted || source?.turnStarted === true;
  // A dispatched request with no terminal acknowledgement is NOT safe to resend.
  error.submissionState = error.turnStarted ? 'started' : submitted ? 'unknown' : 'not-submitted';
  error.safeToRetry = !submitted && !error.turnStarted;
  error.transient = false;
  return error;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function safeSpelling(value) {
  return typeof value === 'string' && Boolean(value) && !value.includes('\0')
    && !value.split(/[\\/]/).some((part) => part === '..' || /[. ]$/.test(part) && part !== '.')
    && !/^(?:\\\\|\/\/|[a-z]+:\/\/)/i.test(value);
}

// Reject links (including junctions), not merely lexical prefix matches. For a new
// file, inspect every existing ancestor before accepting the missing suffix.
async function authorizedPath(root, requested, write = false) {
  if (!safeSpelling(requested)) throw new Error('非法路径');
  if (path.win32.isAbsolute(requested) && !path.isAbsolute(requested)) throw new Error('外部绝对路径');
  const candidate = path.resolve(root, requested.replace(/[\\/]/g, path.sep));
  if (!within(root, candidate)) throw new Error('路径超出授权项目');
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  if (parts.some((part) => /[:*?<>|]/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('特殊路径不允许');
  if (write && parts.some((part) => ['.git', '.claude'].includes(part.toLowerCase()))) throw new Error('不允许修改执行配置');
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('授权目录已变化');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (info.isSymbolicLink() || !within(root, await realpath(cursor))) throw new Error('不允许链接路径');
    if (info.isFile() && info.nlink > 1) throw new Error('不允许多重硬链接文件');
  }
  return candidate;
}

async function verifySearchTree(root, target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !within(root, await realpath(target))) throw new Error('搜索路径含链接');
  if (info.isFile() && info.nlink > 1) throw new Error('搜索范围含多重硬链接文件');
  if (!info.isDirectory()) return;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    await verifySearchTree(root, path.join(target, entry.name));
  }
}

function permissionHandler(cwd, ready, signal) {
  return async (toolName, input, context = {}) => {
    const deny = (message) => ({ behavior: 'deny', message });
    if (!FILE_TOOLS.includes(toolName)) return deny('远程任务禁止命令、网络、MCP 和子代理工具');
    if (!ready() || signal.aborted || context.signal?.aborted) return deny('会话尚未持久化或任务已中止');
    try {
      const search = toolName === 'Glob' || toolName === 'Grep';
      const target = await authorizedPath(cwd, search ? input.path ?? '.' : input.file_path, toolName === 'Edit' || toolName === 'Write');
      if (toolName === 'Glob') {
        if (!safeSpelling(input.pattern) || input.pattern.includes('..') || path.posix.isAbsolute(input.pattern) || path.win32.isAbsolute(input.pattern) || input.pattern.includes(':')) throw new Error('非法搜索模式');
      }
      if (search) await verifySearchTree(cwd, target);
      return { behavior: 'allow', updatedInput: { ...input, [search ? 'path' : 'file_path']: target } };
    } catch { return deny('工具路径不在授权项目内、包含链接或无法验证'); }
  };
}

function safeOptions(cwd, abortController, ready) {
  return {
    cwd, abortController, persistSession: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // The installed SDK requires 'project' for normal CLAUDE.md discovery.
    // Exclude user/local settings; disable configured hooks and all configured MCP.
    settingSources: ['project'],
    settings: {
      disableAllHooks: true,
      autoMemoryEnabled: false, disableClaudeAiConnectors: true,
      syncClaudeAiSkills: false, syncClaudeAiPlugins: false,
      apiKeyHelper: '', proxyAuthHelper: '', awsCredentialExport: '', awsAuthRefresh: '', gcpAuthRefresh: '',
      permissions: {
        defaultMode: 'default', disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable',
        ask: [...FILE_TOOLS], deny: [...FORBIDDEN_TOOLS],
        blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true,
        workingDirectoriesAsGiven: [cwd],
      },
    },
    permissionMode: 'default', allowDangerouslySkipPermissions: false,
    tools: [...FILE_TOOLS], disallowedTools: [...FORBIDDEN_TOOLS],
    mcpServers: {}, strictMcpConfig: true, agents: {}, skills: [], plugins: [],
    canUseTool: permissionHandler(cwd, ready, abortController.signal),
  };
}

function resultValue(nativeSessionId, finalResponse, usage, route) {
  return { sessionId: `claude:${nativeSessionId}`, finalResponse: route === 'sdk' ? finalResponse.trim() : finalResponse, usage: usage ?? null, providerId: 'claude', nativeSessionId, route };
}

export class ClaudeRemoteExecutor {
  constructor({ query, originalClient = null, isSessionActive, onUsage, onDiagnostic, onEvent, emitEvent = onEvent, sessionIdFactory = randomUUID, executablePath = '' } = {}) {
    this.query = query;
    this.originalClient = originalClient;
    this.isSessionActive = isSessionActive;
    this.onUsage = onUsage;
    this.onDiagnostic = onDiagnostic;
    this.emitEvent = emitEvent;
    this.sessionIdFactory = sessionIdFactory;
    this.executablePath = executablePath;
    this.capabilities = Object.freeze({
      originalWindow: false, sdkResume: true, requiresInactiveSession: true,
      osSandbox: false, toolBoundary: 'verified-project-paths',
      // File checks cannot provide an OS-level sandbox or prevent external TOCTOU races.
      networkTools: false, subagents: false,
    });
  }

  async start(value = {}) {
    try {
      checkAborted(value.signal);
      const cwd = await verifiedDirectory(value.cwd);
      if (typeof value.onThreadStarted !== 'function') throw new TypeError('新建远程任务必须提供会话持久化回调');
      const prompt = buildRemoteRequest(String(value.prompt || '').trim().slice(0, 4_000));
      return await this.#run(value, cwd, prompt);
    } catch (error) { if (error?.providerId === 'claude') throw error; throw executionError(error); }
  }

  async resume(value = {}) {
    try {
      checkAborted(value.signal);
      const rawId = rawSessionId(value.sessionId);
      const cwd = await verifiedDirectory(value.cwd);
      const prompt = buildRemoteRequest(String(value.prompt || '').trim().slice(0, 4_000));
      if (this.originalClient) {
        checkAborted(value.signal);
        try {
          const result = await this.originalClient.tryResume({ ...value, cwd, nativeSessionId: rawId, input: prompt });
          if (result !== null) {
            if (!result || ![rawId, value.sessionId].includes(result.sessionId) || typeof result.finalResponse !== 'string' || result.is_error === true) {
              throw new Error('原客户端提交状态不明，请在电脑端确认；不会通过 SDK 重发');
            }
            return resultValue(rawId, result.finalResponse, result.usage, 'original-client');
          }
        } catch (error) { throw executionError(error, { route: 'original-client', submitted: true }); }
      }
      checkAborted(value.signal);
      let active;
      try { active = await this.isSessionActive?.(rawId); }
      catch (cause) { throw new Error('无法确认 Claude 原客户端活动状态，拒绝 SDK 恢复', { cause }); }
      if (active !== false) throw new Error('Claude 会话活动中或拥有者状态未知，拒绝 SDK 恢复');
      return await this.#run(value, cwd, prompt, rawId);
    } catch (error) { if (error?.providerId === 'claude') throw error; throw executionError(error); }
  }

  async #run(value, cwd, prompt, resumeId = '') {
    let stream;
    let iterator;
    let submitted = false;
    let turnStarted = false;
    let persisted = Boolean(resumeId);
    let nativeId = resumeId;
    let initialized = false;
    let interrupted = false;
    let finalResponse = '';
    let lifecycleStarted = false;
    let terminalAttempted = false;
    let outcome = 'failed';
    const promptId = randomUUID();
    const emit = async (hook_event_name, details = {}) => {
      try {
        await this.emitEvent?.({ ...details, hook_event_name, event_id: randomUUID(),
          prompt_id: promptId, session_id: nativeId, cwd, managed_by: 'AGENT_PET',
          source: 'agent-pet-remote', timestamp: new Date().toISOString() });
      } catch {
        throw Object.assign(new Error('Claude 任务状态投递失败，请在电脑端检查；不会自动重发'), { code: 'claude_event_delivery_failed' });
      }
    };
    const abortController = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    // It can reject during import/discovery, before the next race is installed.
    aborted.catch(() => {});
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      try { Promise.resolve(stream?.interrupt?.()).catch(() => {}); } catch { /* still abort our query */ }
      abortController.abort();
    };
    const stop = () => {
      interrupt();
      rejectAbort(new DOMException('Claude 远程任务已中断', 'AbortError'));
    };
    value.signal?.addEventListener('abort', stop, { once: true });
    const notify = async (callback, event) => {
      // Telemetry is observational: its failure must not turn a completed task into a retry.
      try { await Promise.race([Promise.resolve(callback?.(event)), aborted]); } catch { checkAborted(value.signal); }
    };
    try {
      checkAborted(value.signal);
      const query = this.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      const options = safeOptions(cwd, abortController, () => persisted);
      if (resumeId) options.resume = resumeId;
      else {
        nativeId = this.sessionIdFactory();
        if (typeof nativeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nativeId)) throw new Error('新会话 ID 必须是有效 UUID');
        options.sessionId = nativeId;
      }
      if (this.executablePath) options.pathToClaudeCodeExecutable = await resolveClaudeExecutable(this.executablePath);
      checkAborted(value.signal);
      await notify(this.onDiagnostic, { stage: 'runtime', providerId: 'claude', route: 'sdk', sessionId: `claude:${nativeId}` });
      // query() can submit a string prompt immediately. Persist the official
      // preallocated session ID before constructing the query, not after init.
      await Promise.race([Promise.resolve(value.onThreadStarted?.(`claude:${nativeId}`)), aborted]);
      checkAborted(value.signal);
      persisted = true;
      lifecycleStarted = true;
      await Promise.race([emit('SessionStart'), aborted]);
      checkAborted(value.signal);
      await Promise.race([emit('UserPromptSubmit', { prompt }), aborted]);
      checkAborted(value.signal);
      submitted = true;
      stream = query({ prompt, options });
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        checkAborted(value.signal);
        const { value: event, done } = await Promise.race([iterator.next(), aborted]);
        if (done) throw new Error('Claude 远程任务在完成前意外结束');
        if (event.type === 'system' && event.subtype === 'init') {
          if (!RAW_ID.test(event.session_id || '') || nativeId && nativeId !== event.session_id) throw new Error('Claude 返回的会话 ID 无效或不匹配');
          initialized = true;
        } else if (event.type === 'assistant') {
          turnStarted = true;
          if (event.error) throw new Error(`Claude assistant 错误：${event.error}`);
          const text = event.message?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
          if (text) finalResponse = text;
          await notify(value.onUsage ?? this.onUsage, event);
        } else if (event.type === 'rate_limit_event') {
          await notify(value.onUsage ?? this.onUsage, event);
        } else if (event.type === 'result') {
          turnStarted ||= Number(event.num_turns) > 0;
          await notify(value.onUsage ?? this.onUsage, event);
          if (event.subtype !== 'success' || event.is_error || event.permission_denials?.length) {
            throw new Error(event.errors?.join('\n') || (event.permission_denials?.length ? 'Claude 工具权限被拒绝，请回到电脑确认' : 'Claude 本次任务执行失败'));
          }
          if (!initialized || !persisted || event.session_id !== nativeId) throw new Error('Claude 未确认已持久化的会话 ID');
          checkAborted(value.signal);
          const result = resultValue(nativeId, typeof event.result === 'string' ? event.result : finalResponse, event.usage, 'sdk');
          terminalAttempted = true;
          await Promise.race([emit('Stop', { last_assistant_message: result.finalResponse }), aborted]);
          outcome = 'completed';
          return result;
        }
      }
    } catch (error) {
      interrupt();
      const cancelled = value.signal?.aborted || error?.name === 'AbortError';
      outcome = cancelled ? 'cancelled' : 'failed';
      if (lifecycleStarted && !cancelled && !terminalAttempted) {
        terminalAttempted = true;
        try { await emit('StopFailure', { error: 'Claude 远程任务失败' }); } catch { /* preserve the original failure */ }
      }
      throw executionError(cancelled ? new DOMException('Claude 远程任务已中断', 'AbortError') : error, { submitted, turnStarted });
    } finally {
      value.signal?.removeEventListener('abort', stop);
      let releaseError;
      if (lifecycleStarted) {
        try { await emit('SessionEnd', { reason: outcome }); }
        catch (error) {
          if (outcome === 'completed') {
            interrupt();
            releaseError = executionError(error, { submitted, turnStarted });
          }
        }
      }
      // Never await a potentially stuck iterator after abort; only this query is affected.
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* already closed */ }
      if (releaseError) throw releaseError;
    }
  }
}
