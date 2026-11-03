export class AiSettingsView {
  constructor(root, api) {
    this.root = root;
    this.api = api;
    this.elements = Object.fromEntries([...root.querySelectorAll("[id]")].map((element) => [element.id.replace(/^ai-/, ""), element]));
    this.busy = false;
    this.revision = 0;
    const on = (id, callback) => this.elements[id].addEventListener("change", callback);
    on("connection", () => this.save({ connectionId: this.elements.connection.value }));
    on("model-mode", () => this.save({ modelMode: this.elements["model-mode"].value }));
    on("model", () => this.save({ modelId: this.elements.model.value }));
    on("base-url", () => this.saveConnection({ baseUrl: this.elements["base-url"].value }));
    on("default-model", () => this.saveConnection({ defaultModelId: this.elements["default-model"].value }));
    on("api-key", () => {
      const apiKey = this.elements["api-key"].value;
      if (apiKey.trim()) void this.save({}, { apiKey });
    });
    this.elements["clear-key"].addEventListener("click", () => this.save({}, { clearKey: true }));
    this.elements.check.addEventListener("click", () => this.check());
    this.unsubscribe = api?.onAiStatus?.((state) => {
      if (this.snapshot && state.connectionId === this.snapshot.connectionId) {
        this.snapshot.state = state;
        this.render();
      }
    });
  }

  options(select, items, selected, placeholder) {
    const values = [{ id: "", name: placeholder }, ...items];
    if (selected && !values.some((item) => item.id === selected)) values.push({ id: selected, name: `${selected}（当前不可用）` });
    select.replaceChildren(...values.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      return option;
    }));
    select.value = selected;
  }

  render() {
    if (!this.snapshot) return;
    const { preferences, connections, connectionId, keyConfigured, state } = this.snapshot;
    const e = this.elements;
    this.options(e.connection, connections, preferences.connectionId, "选择连接");
    e.connection.querySelector('option[value=""]').disabled = true;
    e["model-mode"].value = preferences.modelMode;
    e["pinned-row"].hidden = preferences.modelMode !== "pinned";
    this.options(e.model, state.models || [], preferences.modelId, "请选择模型");
    const http = ["deepseek", "compatible"].includes(connectionId);
    e["http-fields"].hidden = !http;
    if (http) {
      const config = preferences.connections[connectionId];
      if (document.activeElement !== e["base-url"]) e["base-url"].value = config.baseUrl;
      this.options(e["default-model"], state.models || [], config.defaultModelId, "使用服务声明的默认模型");
      e["key-status"].textContent = keyConfigured ? "密钥已加密保存；留空保留现有密钥。" : "当前服务地址尚未设置密钥。";
    }
    e["connection-status"].textContent = state.message || "尚未检查连接。";
    e["connection-status"].dataset.state = state.status;
    e["connection-details"].textContent = [
      state.name || connectionId, state.modelId ? `当前模型：${state.modelId}` : "",
      state.runtimeVersion ? `运行程序：${state.runtimeVersion}` : "",
      state.modelProvider && state.modelProvider !== connectionId ? `模型服务：${state.modelProvider}` : "",
    ].filter(Boolean).join(" · ");
    for (const element of this.root.querySelectorAll("input, select, button")) element.disabled = this.busy;
    e.check.disabled = this.busy || state.status === "checking";
    e["clear-key"].disabled = this.busy || !keyConfigured;
  }

  async load() {
    if (!this.api?.getAiSettings) { this.elements["connection-status"].textContent = "当前应用尚未提供 AI 连接设置。"; return; }
    const revision = ++this.revision;
    try {
      const snapshot = await this.api.getAiSettings();
      if (revision !== this.revision) return;
      this.snapshot = snapshot;
      this.render();
      await this.check();
    } catch { this.elements["connection-status"].textContent = "无法读取 AI 连接设置，请重新打开设置。"; }
  }

  async check() {
    const revision = ++this.revision;
    this.elements.check.disabled = true;
    try {
      const snapshot = await this.api.checkAiConnection();
      if (revision !== this.revision) return;
      this.snapshot = snapshot;
      this.render();
    } catch {
      if (revision === this.revision) {
        this.elements["connection-status"].textContent = "连接检查失败，请稍后重试。";
        this.elements.check.disabled = false;
      }
    }
  }

  saveConnection(patch) {
    const id = this.snapshot.connectionId;
    return this.save({ connections: { [id]: { ...this.snapshot.preferences.connections[id], ...patch } } });
  }

  async save(preferences, extra = {}) {
    if (this.busy || !this.snapshot) return;
    this.busy = true;
    ++this.revision;
    this.elements["save-status"].textContent = "正在保存…";
    this.render();
    try {
      this.snapshot = await this.api.updateAiSettings({ preferences, ...extra });
      this.elements["api-key"].value = "";
      this.elements["save-status"].textContent = "已保存";
    } catch {
      this.elements["save-status"].textContent = "保存失败，请检查输入并重试。";
      // Keep unsaved credential text for correction; never echo it elsewhere.
    } finally {
      this.busy = false;
      this.render();
    }
    await this.check();
  }
}
