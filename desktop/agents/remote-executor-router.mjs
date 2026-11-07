const PROVIDERS = new Set(['codex', 'claude']);

function provider(value) {
  if (!PROVIDERS.has(value)) throw new TypeError(`未知远程执行来源：${value}`);
  return value;
}

function sessionProvider(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('恢复任务缺少会话 ID');
  const colon = sessionId.indexOf(':');
  if (colon < 0) return 'codex';
  if (!sessionId.slice(colon + 1).trim()) throw new TypeError('会话 ID 不能为空');
  return provider(sessionId.slice(0, colon));
}

export class RemoteExecutorRouter {
  constructor({ codex, claude, getDefaultProvider, isConnected = () => true } = {}) {
    this.executors = { codex, claude };
    this.getDefaultProvider = getDefaultProvider;
    this.isConnected = isConnected;
  }

  #executor(id) {
    if (!this.isConnected(id)) throw new Error(`请先在“智能体与 AI”中连接 ${id === 'claude' ? 'Claude Code' : 'Codex'}。`);
    const executor = this.executors[id];
    if (!executor) throw new Error(`远程执行来源未配置：${id}`);
    return executor;
  }

  async start(value = {}) {
    const id = provider(value.providerId ?? (await this.getDefaultProvider?.()) ?? 'codex');
    if (value.sessionId !== undefined && sessionProvider(value.sessionId) !== id) throw new TypeError('来源与会话前缀冲突');
    return this.#executor(id).start(value);
  }

  async resume(value = {}) {
    const id = sessionProvider(value.sessionId);
    if (value.providerId !== undefined && provider(value.providerId) !== id) throw new TypeError('来源与会话前缀冲突');
    // Codex's existing adapter consumes bare IDs; Claude owns its own namespace.
    const input = id === 'codex' && value.sessionId.startsWith('codex:')
      ? { ...value, sessionId: value.sessionId.slice('codex:'.length) } : value;
    return this.#executor(id).resume(input);
  }
}
