import * as config from '../claude/integration.mjs';
import { resolveNodeExecutable } from '../claude/runtime.mjs';

// All destinations are supplied by the main process, never by the renderer.
export function createClaudeLifecycleController({ getPreferences, getOptions,
  isConnected = () => true,
  resolveNode = resolveNodeExecutable,
  integration = { status: config.getClaudeLifecycleStatus, install: config.installClaudeLifecycle,
    remove: config.removeClaudeLifecycle } }) {
  let state = { ok: true, state: 'pending' };
  let queue = Promise.resolve();
  let closed = false;
  const sync = () => {
    if (closed) return Promise.resolve({ ...state });
    queue = queue.then(async () => {
      try {
        const preferences = getPreferences().claude || {};
        const options = await getOptions();
        if (!isConnected()) {
          const current = await integration.status(options);
          if (!current.ok) state = current;
          else if (['installed', 'legacy-installed'].includes(current.state)) {
            const removed = await integration.remove(options);
            state = removed.ok ? { ...removed, state: 'disconnected' } : removed;
          } else state = { ok: true, state: 'disconnected' };
        } else if (preferences.autoLifecycleHooks === false) {
          const removed = await integration.remove(options);
          state = removed.ok ? { ...removed, state: 'disabled' } : removed;
        } else {
          const current = await integration.status(options);
          if (!current.ok || ['disabled', 'not-detected', 'conflict', 'modified'].includes(current.state)) {
            state = current;
          } else {
            const nodePath = await resolveNode(preferences.nodePath || '');
            state = nodePath ? await integration.install({ ...options, nodePath })
              : { ok: false, state: 'runtime-unavailable', message: '未发现 Node.js 20+，保留只读任务发现。' };
          }
        }
      } catch {
        state = { ok: false, state: 'error', message: '自动状态上报配置未完成，请检查运行时及配置；只读发现仍可使用。' };
      }
      return { ...state };
    });
    return queue;
  };
  const status = async () => {
    await queue;
    try {
      const current = await integration.status(await getOptions());
      if (!isConnected() && current.ok && ['not-installed', 'not-detected'].includes(current.state)) return { ...current, state: 'disconnected' };
      if (current.state === 'not-installed') {
        if (getPreferences().claude?.autoLifecycleHooks === false) return { ...current, state: 'disabled' };
      }
      if (!state.ok && current.ok && ['installed', 'legacy-installed', 'not-installed'].includes(current.state)) return { ...state };
      return current;
    } catch { return { ok: false, state: 'error' }; }
  };
  return { sync, status, snapshot: () => ({ ...state }), async close() { closed = true; await queue; } };
}
