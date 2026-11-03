import { NotebookError } from "./notebook-store.mjs";

/** Storage/IPC boundary; authorization is supplied by the owning window's interface. */
export function createNotebookController({ getStore, ownsMainFrame }) {
  async function call(event, action) {
    if (!ownsMainFrame(event)) throw new Error("Untrusted notebook request");
    try { return { ok: true, ...await action(getStore()) }; }
    catch (error) {
      return { ok: false, message: error instanceof NotebookError ? error.message : "本地文件读写失败，请检查磁盘空间和目录权限后重试。" };
    }
  }
  return {
    snapshot: event => call(event, async store => ({ snapshot: await store.snapshot() })),
    command: (event, command) => call(event, store => store.execute(command)),
  };
}
