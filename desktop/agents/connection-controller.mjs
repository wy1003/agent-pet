import { publicAiError } from '../ai/errors.mjs';

export const AGENT_IDS = Object.freeze(['codex', 'claude']);
export const isAgentConnected = (preferences, id) => preferences?.agent?.connections?.[id] === true;

export class AgentConnectionController {
  constructor({ getPreferences, savePreferences, prepare, apply, inspect = async () => 'unknown',
    checkAvailability = async () => ({ state: 'unchecked', message: '尚未检查登录和模型。' }), onChange = () => {} }) {
    Object.assign(this, { getPreferences, savePreferences, prepare, apply, inspect, checkAvailability, onChange });
    this.states = new Map(AGENT_IDS.map(id => [id, { state: 'disconnected', components: 'unknown', availability: { state: 'unchecked' } }]));
    this.operations = new Map();
    this.checks = new Map();
    this.commit = Promise.resolve();
    this.closed = false;
  }
  snapshot() { return structuredClone(Object.fromEntries(this.states)); }
  connected(id) { return this.states.get(id)?.state === 'connected'; }
  available(id) { return this.connected(id) && this.states.get(id)?.availability?.state === 'available'; }
  #set(id, state) { this.states.set(id, { ...this.states.get(id), ...state }); this.onChange(this.snapshot()); }
  #serialize(operation) {
    const result = this.commit.then(operation);
    this.commit = result.catch(() => {});
    return result;
  }
  async refreshComponents() {
    await Promise.all(AGENT_IDS.map(async id => {
      try { this.#set(id, { components: await this.inspect(id) }); }
      catch { this.#set(id, { components: 'unknown', message: '无法读取组件状态，请重试连接。' }); }
    }));
  }
  verify(id) {
    if (!AGENT_IDS.includes(id)) return Promise.reject(new TypeError('未知智能体'));
    if (this.closed || !this.connected(id)) return Promise.resolve(this.snapshot());
    if (this.checks.has(id)) return this.checks.get(id).promise;
    const abort = new AbortController(), operation = { abort };
    this.#set(id, { availability: { state: 'checking', message: '正在检查登录和模型…' } });
    operation.promise = (async () => {
      let availability;
      try { availability = await this.checkAvailability(id, { signal: abort.signal }); }
      catch (error) { const safe = publicAiError(error); availability = { state: 'unavailable', code: safe.code, message: safe.message }; }
      if (abort.signal.aborted || !this.connected(id) || this.checks.get(id) !== operation) return this.snapshot();
      if (availability.state === 'available') await this.#serialize(async () => {
        if (!abort.signal.aborted && this.connected(id) && !this.getPreferences().ai?.connectionId) {
          await this.savePreferences({ ai: { connectionId: id } });
        }
      });
      if (!abort.signal.aborted && this.connected(id)) this.#set(id, { availability });
      return this.snapshot();
    })().finally(() => { if (this.checks.get(id) === operation) this.checks.delete(id); });
    this.checks.set(id, operation);
    return operation.promise;
  }
  observeAiStatus(status) {
    const id = status?.connectionId;
    if (!this.connected(id) || this.checks.has(id)) return;
    let availability;
    if (status.status === 'ready') availability = { state: 'available', message: status.compatibility === 'verified'
      ? '最近一次模型调用成功。' : '登录与模型检查通过；实际额度以服务端调用结果为准。' };
    if (status.status === 'error' && ['authentication', 'rate_limit', 'connection_failed', 'runtime_incompatible'].includes(status.code)) {
      availability = { state: 'unavailable', code: status.code, message: status.message };
    }
    if (availability && JSON.stringify(availability) !== JSON.stringify(this.states.get(id).availability)) this.#set(id, { availability });
  }
  connect(id, { restore = false } = {}) {
    if (!AGENT_IDS.includes(id)) return Promise.reject(new TypeError('未知智能体'));
    if (this.closed) return Promise.reject(new Error('应用正在退出'));
    if (this.operations.has(id)) return this.operations.get(id).promise;
    if (this.connected(id)) return this.verify(id);
    const abort = new AbortController();
    const operation = { abort };
    this.#set(id, { state: 'checking', message: '', availability: { state: 'unchecked' } });
    operation.promise = (async () => {
      try {
        await this.prepare(id, { allowDownload: !restore, signal: abort.signal,
          onProgress: progress => { if (!abort.signal.aborted) this.#set(id, { ...progress, state: progress.phase }); } });
        this.#set(id, { components: 'ready' });
        abort.signal.throwIfAborted();
        await this.#serialize(async () => {
          abort.signal.throwIfAborted();
          await this.apply(id, true);
          try { await this.savePreferences({ agent: { connections: { [id]: true } } }); }
          catch (error) { await this.apply(id, false); throw error; }
          this.#set(id, { state: 'connected', components: 'ready', message: '' });
        });
        if (restore) void this.verify(id).catch(() => {});
        else await this.verify(id);
      } catch (error) {
        this.#set(id, abort.signal.aborted ? { state: 'disconnected' }
          : { state: 'error', message: error.message || '连接失败，请重试。' });
      } finally { this.operations.delete(id); }
      return this.snapshot();
    })();
    this.operations.set(id, operation);
    return operation.promise;
  }
  async disconnect(id) {
    if (!AGENT_IDS.includes(id)) throw new TypeError('未知智能体');
    const operation = this.operations.get(id);
    operation?.abort.abort();
    const check = this.checks.get(id);
    check?.abort.abort();
    await operation?.promise;
    await check?.promise;
    return this.#serialize(async () => {
      const previous = this.states.get(id);
      this.#set(id, { state: 'disconnecting' });
      try {
        await this.apply(id, false);
        await this.savePreferences({ agent: { connections: { [id]: false } } });
        this.#set(id, { state: 'disconnected', availability: { state: 'unchecked' }, message: '' });
      } catch (error) {
        if (previous.state === 'connected') await this.apply(id, true);
        this.#set(id, { ...previous, message: error.message });
        throw error;
      }
      return this.snapshot();
    });
  }
  async restore() {
    await this.refreshComponents();
    await Promise.all(AGENT_IDS.filter(id => isAgentConnected(this.getPreferences(), id)).map(id => this.connect(id, { restore: true })));
  }
  async close() {
    this.closed = true;
    for (const operation of this.operations.values()) operation.abort.abort();
    for (const check of this.checks.values()) check.abort.abort();
    await Promise.all([...this.operations.values()].map(operation => operation.promise));
    await Promise.all([...this.checks.values()].map(check => check.promise));
    await this.commit;
  }
}

export function installAgentConnectionIpc({ ipcMain, requireSettingsMainFrame, controller, setDefault }) {
  for (const action of ['connect', 'disconnect', 'verify']) ipcMain.handle(`agent-providers:${action}`, async (event, id) => {
    requireSettingsMainFrame(event);
    if (typeof id !== 'string' || !AGENT_IDS.includes(id)) throw new TypeError('未知智能体');
    return controller[action](id);
  });
  if (setDefault) ipcMain.handle('agent-providers:set-default', async (event, id) => {
    requireSettingsMainFrame(event);
    if (typeof id !== 'string' || !AGENT_IDS.includes(id)) throw new TypeError('未知智能体');
    if (!controller.connected(id)) throw new Error('请先连接所选智能体。');
    return setDefault(id);
  });
}
