export class AiSettingsView {
  constructor(root, api) {
    this.root = root;
    this.api = api;
    this.elements = Object.fromEntries([...root.querySelectorAll("[id]")].map((element) => [element.id.replace(/^ai-/, ""), element]));
    this.busy = false;
    this.revision = 0;
    this.httpCatalog = null;
    this.editEndpoint = false;
    this.adding = false;
    this.addBusy = false;
    this.addCatalog = null;
    const on = (id, callback) => this.elements[id].addEventListener("change", callback);
    on("connection", () => { this.editEndpoint = false; return this.save({ connectionId: this.elements.connection.value }); });
    on("model-mode", () => this.save({ modelMode: this.elements["model-mode"].value }));
    on("model", () => this.save({ modelId: this.elements.model.value, ...(this.isHttp() ? { modelMode: "pinned" } : {}) }));
    on("base-url", () => this.saveConnection({ baseUrl: this.elements["base-url"].value }));
    on("api-key", () => {
      const apiKey = this.elements["api-key"].value;
      if (apiKey.trim()) return this.save({}, { apiKey });
    });
    this.elements["edit-endpoint"].addEventListener("click", () => {
      this.editEndpoint = !this.editEndpoint;
      this.render();
    });
    this.elements["clear-key"].addEventListener("click", () => this.save({}, { clearKey: true }));
    this.elements.check.addEventListener("click", () => this.check());
    this.elements.add.addEventListener("click", () => this.openAdd());
    this.elements["add-cancel"].addEventListener("click", () => this.closeAdd());
    this.elements["add-type"].addEventListener("change", () => this.resetAddType());
    this.elements["add-edit-endpoint"].addEventListener("click", () => { this.addEditEndpoint = !this.addEditEndpoint; this.renderAdd(); });
    for (const id of ["add-url", "add-key"]) this.elements[id].addEventListener("input", () => {
      this.addCatalog = null; this.elements["add-status"].textContent = ""; this.renderAdd();
    });
    this.elements["add-model"].addEventListener("change", () => this.renderAdd());
    this.elements["add-fetch"].addEventListener("click", () => this.configureAdd(false));
    this.elements["add-confirm"].addEventListener("click", () => this.configureAdd(true));
    this.unsubscribeConnections = api?.onAgentConnectionsChanged?.(state => {
      this.agentConnections = Object.fromEntries((state.providers || []).map(item => [item.id, item]));
      this.render();
      const signature = JSON.stringify(state.providers?.map(item => [item.id, item.state, item.availability?.state]));
      if (signature === this.connectionSignature) return;
      this.connectionSignature = signature;
      this.connectionsPending = true;
      void this.refreshConnections();
    });
    this.unsubscribe = api?.onAiStatus?.((state) => {
      if (this.snapshot && state.connectionId === this.snapshot.connectionId) {
        this.snapshot.state = state;
        this.render();
      }
    });
  }

  isHttp() { return ["deepseek", "compatible"].includes(this.snapshot?.connectionId); }

  usableConnections() {
    const agents = this.agentConnections || this.snapshot.agentConnections;
    return this.snapshot.availableConnections.filter(item => {
      if (agents && ['codex', 'claude'].includes(item.id)) {
        return agents[item.id]?.state === 'connected' && agents[item.id]?.availability?.state === 'available';
      }
      return this.snapshot.connections.some(connected => connected.id === item.id);
    });
  }

  async refreshConnections() {
    if (!this.connectionsPending || this.refreshingConnections || this.busy || this.addBusy) return;
    this.refreshingConnections = true;
    let selectionChanged = false;
    try {
      while (this.connectionsPending && !this.busy && !this.addBusy) {
        this.connectionsPending = false;
        const revision = this.revision;
        const snapshot = await this.api.getAiSettings();
        if (revision !== this.revision || this.busy || this.addBusy) {
          this.connectionsPending = true;
          continue;
        }
        selectionChanged ||= snapshot.connectionId !== this.snapshot?.connectionId;
        this.snapshot = snapshot;
        this.render();
      }
    } catch {
      // Live agent events still remove unusable choices even if the IPC read fails.
    } finally { this.refreshingConnections = false; }
    if (selectionChanged) await this.check();
  }

  openAdd() {
    if (!this.snapshot || this.busy) return;
    this.adding = true;
    this.elements["add-type"].value = this.snapshot.availableConnections.find(item => !this.usableConnections().some(connected => connected.id === item.id))?.id || "codex";
    this.resetAddType();
    this.render();
    this.elements["add-type"].focus();
  }

  closeAdd() {
    if (this.addBusy) return;
    this.adding = false;
    this.addCatalog = null;
    this.elements["add-key"].value = "";
    this.render();
    this.elements.add.focus();
  }

  resetAddType() {
    this.addCatalog = null;
    this.addEditEndpoint = false;
    const id = this.elements["add-type"].value;
    this.elements["add-url"].value = this.snapshot.preferences.connections[id]?.baseUrl || "";
    this.elements["add-key"].value = "";
    this.elements["add-model"].value = "";
    this.elements["add-status"].textContent = "";
    this.renderAdd();
  }

  renderAdd() {
    const e = this.elements;
    const http = ["deepseek", "compatible"].includes(e["add-type"].value);
    const locked = this.busy || this.addBusy;
    const standardDeepSeek = e["add-type"].value === "deepseek" && e["add-url"].value === "https://api.deepseek.com";
    e["add-panel"].hidden = !this.adding;
    e.add.setAttribute("aria-expanded", String(this.adding));
    e.add.hidden = this.adding;
    e["add-http"].hidden = !http;
    e["add-agent-help"].hidden = http;
    e["add-url-row"].hidden = standardDeepSeek && !this.addEditEndpoint;
    e["add-edit-endpoint"].hidden = !standardDeepSeek;
    e["add-edit-endpoint"].textContent = this.addEditEndpoint ? "收起服务地址" : "修改服务地址";
    e["add-edit-endpoint"].setAttribute("aria-expanded", String(this.addEditEndpoint));
    e["add-model-row"].hidden = !this.addCatalog?.models?.length;
    for (const id of ["add-type", "add-url", "add-key", "add-model", "add-fetch", "add-cancel", "add-edit-endpoint"]) e[id].disabled = locked;
    e["add-fetch"].disabled = locked || !e["add-key"].value.trim() || !e["add-url"].value.trim();
    e["add-fetch"].textContent = this.addBusy ? "正在获取模型…" : "获取可用模型";
    e["add-confirm"].hidden = http && !this.addCatalog?.models?.length;
    e["add-confirm"].textContent = this.addBusy ? "正在连接…" : http ? "添加并使用" : "连接并使用";
    e["add-confirm"].disabled = locked || (http && (!this.addCatalog || !e["add-model"].value));
  }

  async configureAdd(save) {
    if (this.addBusy) return;
    const e = this.elements;
    const id = e["add-type"].value;
    const http = ["deepseek", "compatible"].includes(id);
    this.addBusy = true;
    e["add-status"].dataset.state = "checking";
    e["add-status"].textContent = http ? "正在获取可用模型…" : "正在连接，缺少的组件将自动下载…";
    this.render();
    try {
      if (http) {
        const result = await this.api.configureAiConnection({ connectionId: id, baseUrl: e["add-url"].value,
          apiKey: e["add-key"].value, modelId: e["add-model"].value, save });
        if (result.error) throw Object.assign(new Error(result.error), { display: true });
        if (!save) {
          this.addCatalog = result.catalog;
          this.options(e["add-model"], result.catalog.models, result.catalog.defaultModelId || "", "请选择模型");
          e["add-status"].textContent = result.catalog.models.length ? "已获取可用模型，请选择后添加。" : "服务未返回可用模型，请检查密钥权限。";
          return;
        }
        this.snapshot = result.snapshot;
      } else {
        const state = await this.api.connectAgent(id);
        if (state[id]?.state !== "connected") throw Object.assign(new Error("连接未完成，请在上方智能体连接区域查看状态并重试。"), { display: true });
        if (state[id]?.availability?.state !== 'available') throw Object.assign(new Error(state[id]?.availability?.message || '已连接，但尚未通过可用性检查，请检查登录状态。'), { display: true });
        this.snapshot = await this.api.updateAiSettings({ preferences: { connectionId: id } });
      }
      this.adding = false;
      this.addCatalog = null;
      this.httpCatalog = null;
      e["add-key"].value = "";
      e["add-status"].textContent = "";
    } catch (error) {
      e["add-status"].dataset.state = "error";
      e["add-status"].textContent = error.display ? error.message : "添加失败，请检查配置并重试。";
    } finally {
      this.addBusy = false;
      this.render();
      await this.refreshConnections();
    }
    if (!this.adding) { e.connection.focus(); await this.check(); }
  }

  options(select, items, selected, placeholder, missingLabel = "当前不可用") {
    const values = [{ id: "", name: placeholder }, ...items];
    if (selected && !values.some((item) => item.id === selected)) values.push({ id: selected, name: `${selected}（${missingLabel}）` });
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
    const { preferences, connectionId, keyConfigured } = this.snapshot;
    const connections = this.usableConnections();
    let state = this.snapshot.state;
    if (state.connectionId && state.connectionId !== connectionId) state = { status: "unchecked", models: [] };
    const e = this.elements;
    const selectedAvailable = connections.some(item => item.id === connectionId);
    const showCurrent = selectedAvailable && !this.adding;
    const selectedName = this.snapshot.availableConnections.find(item => item.id === connectionId)?.name || connectionId;
    const agent = (this.agentConnections || this.snapshot.agentConnections)?.[connectionId];
    const pending = agent?.state === 'connected' && ['checking', 'unchecked'].includes(agent.availability?.state);
    const missingConnectionLabel = pending ? (agent.availability.state === 'checking' ? '检查中…' : '待检查')
      : agent?.state === 'connected' ? '不可用' : '需重新连接';
    const http = this.isHttp();
    const config = preferences.connections[connectionId];
    const catalogKey = `${connectionId}:${config?.baseUrl || ""}`;
    if (!http || !keyConfigured || this.httpCatalog?.key !== catalogKey || state.code === "authentication") this.httpCatalog = null;
    if (http && keyConfigured && state.connectionId === connectionId && state.code !== "authentication" && (state.models?.length || ["model_required", "model_unavailable"].includes(state.code))) {
      this.httpCatalog = { key: catalogKey, models: state.models || [], defaultModelId: state.defaultModelId };
    }
    const models = http ? this.httpCatalog?.models || [] : state.models || [];
    const needsKey = http && !keyConfigured;
    const hasModels = http && keyConfigured && models.length > 0;
    const selectedModel = http && preferences.modelMode === "default"
      ? this.httpCatalog?.defaultModelId || config.defaultModelId : preferences.modelId;
    if (http && state.code === "model_required" && hasModels) state = { ...state, status: "unchecked", message: "已获取可用模型，请选择要使用的模型。" };
    if (http && state.code === "model_required" && !hasModels && keyConfigured) state = { ...state, message: "服务未返回可用模型，请检查密钥权限或重试。" };
    const choices = [...connections];
    if (connectionId && !selectedAvailable) choices.push({ id: connectionId, name: `${selectedName}（${missingConnectionLabel}）` });
    this.options(e.connection, choices, connectionId, "请选择 AI 服务");
    e.connection.querySelector('option[value=""]').disabled = true;
    for (const option of e.connection.children) if (option.value === connectionId && !selectedAvailable) option.disabled = true;
    e["connection-row"].hidden = !connections.length && !connectionId;
    e.empty.hidden = selectedAvailable;
    e.empty.textContent = !connectionId ? (connections.length ? "请选择可用的 AI 服务。" : "暂无可用的 AI 服务，请先连接并通过检查，或添加服务。")
      : pending ? `${selectedName} ${agent.availability.state === 'checking' ? '正在检查可用性' : '尚未通过可用性检查'}，通过后可继续使用。`
      : agent?.state === 'connected' ? `${selectedName} 当前不可用，请在上方重新检查${connections.length ? "或选择其他可用服务" : ""}。`
      : `${selectedName} 尚未连接或配置已失效，请重新添加${connections.length ? "或选择其他可用服务" : ""}。`;
    e["model-mode"].value = preferences.modelMode;
    e["model-mode-row"].hidden = !showCurrent || http;
    e["pinned-row"].hidden = !showCurrent || (http ? !hasModels : preferences.modelMode !== "pinned");
    e["model-label"].textContent = http ? "选择模型" : "指定模型";
    e["model-help"].textContent = http ? "列表来自当前服务，选择后自动保存。" : "模型不可用时保留选择，并提示重新选择。";
    e.model.setAttribute("aria-label", http ? "选择模型" : "指定模型");
    const missingModelLabel = state.status === "checking" ? "正在检查…"
      : state.status === "unchecked" ? "待检查"
      : state.status === "ready" || state.code === "model_unavailable" || state.models?.length ? "当前不可用"
      : "未验证";
    this.options(e.model, models, selectedModel, "请选择模型", missingModelLabel);
    e["http-fields"].hidden = !http || !showCurrent;
    if (http) {
      if (document.activeElement !== e["base-url"]) e["base-url"].value = config.baseUrl;
      const standardDeepSeek = connectionId === "deepseek" && config.baseUrl === "https://api.deepseek.com";
      e["base-url-row"].hidden = standardDeepSeek && !this.editEndpoint;
      e["edit-endpoint"].hidden = !standardDeepSeek;
      e["edit-endpoint"].textContent = this.editEndpoint ? "收起服务地址" : "修改服务地址";
      e["edit-endpoint"].setAttribute("aria-expanded", String(this.editEndpoint));
      e["clear-key"].hidden = !keyConfigured;
      e["key-status"].textContent = keyConfigured ? "密钥已加密保存；留空保留现有密钥。" : "保存密钥后自动获取可用模型，再选择要使用的模型。";
      e["setup-status"].textContent = needsKey ? (config.baseUrl ? "请先填写 API 密钥。" : "请先填写服务地址和 API 密钥。") : "";
      e["setup-status"].hidden = !needsKey;
    }
    e["connection-summary"].hidden = needsKey || !showCurrent;
    e["connection-status"].hidden = needsKey || !showCurrent;
    e["connection-details"].hidden = needsKey || !showCurrent;
    const ready = state.status === "ready";
    const statusLabel = ready ? (state.compatibility === "verified" ? "模型已成功生成内容" : "连接与模型检查通过")
      : state.status === "checking" ? "正在检查连接与模型…"
      : state.message || "尚未检查连接。";
    e["status-indicator"].dataset.state = state.status;
    e["status-indicator"].setAttribute("aria-label", statusLabel);
    e["status-indicator"].title = statusLabel;
    e["connection-status"].textContent = statusLabel;
    e["connection-status"].dataset.state = state.status;
    e["current-model"].textContent = state.modelId || (http ? (hasModels && selectedModel) : (preferences.modelMode === "pinned" && preferences.modelId)) || "等待选择";
    e["detail-connection"].textContent = state.name || connections.find(item => item.id === connectionId)?.name || connectionId;
    e["detail-provider"].textContent = state.modelProvider || "";
    e["detail-provider-row"].hidden = !state.modelProvider;
    e["detail-runtime"].textContent = state.runtimeVersion || "";
    e["detail-runtime-row"].hidden = !state.runtimeVersion;
    e["check-description"].textContent = ready ? state.message || statusLabel : "";
    for (const element of this.root.querySelectorAll("input, select, button")) element.disabled = this.busy || this.addBusy;
    e.connection.disabled = this.busy || this.addBusy || this.adding || !connections.length;
    e.check.disabled = this.busy || this.addBusy || state.status === "checking" || needsKey;
    e["clear-key"].disabled = this.busy || this.addBusy || !keyConfigured;
    if (http) e.model.disabled = this.busy || this.addBusy || !hasModels || state.status === "checking";
    this.renderAdd();
  }

  async load() {
    if (!this.api?.getAiSettings) { this.showLoadError("当前应用尚未提供 AI 连接设置。"); return; }
    const revision = ++this.revision;
    try {
      const snapshot = await this.api.getAiSettings();
      if (revision !== this.revision) return;
      this.snapshot = snapshot;
      this.render();
      await this.check();
    } catch { this.showLoadError("无法读取 AI 连接设置，请重新打开设置。"); }
  }

  showLoadError(message) {
    this.elements["connection-status"].hidden = false;
    this.elements["connection-status"].textContent = message;
    this.elements["connection-status"].dataset.state = "error";
    this.elements["status-indicator"].dataset.state = "error";
    this.elements["status-indicator"].setAttribute("aria-label", message);
    this.elements["status-indicator"].title = message;
  }

  async check() {
    const revision = ++this.revision;
    if (this.snapshot && !this.usableConnections().some(item => item.id === this.snapshot.connectionId)) { this.render(); return; }
    if (this.isHttp() && !this.snapshot.keyConfigured) { this.render(); return; }
    if (this.snapshot) {
      this.snapshot.state = { ...this.snapshot.state, status: "checking", code: undefined, message: "正在获取模型列表并检查连接…" };
      this.render();
    }
    this.elements.check.disabled = true;
    try {
      const snapshot = await this.api.checkAiConnection();
      if (revision !== this.revision) return;
      this.snapshot = snapshot;
      this.render();
    } catch {
      if (revision === this.revision) {
        if (this.snapshot) {
          this.snapshot.state = { status: "error", code: "connection_check_failed", models: [], message: "连接检查失败，请稍后重试。" };
          this.render();
        } else this.showLoadError("连接检查失败，请稍后重试。");
        this.elements.check.disabled = false;
      }
    }
  }

  saveConnection(patch) {
    const id = this.snapshot.connectionId;
    return this.save({ connections: { [id]: { ...this.snapshot.preferences.connections[id], ...patch } } });
  }

  async save(preferences, extra = {}) {
    if (this.busy || this.addBusy || !this.snapshot) return;
    if (preferences.connectionId && !this.usableConnections().some(item => item.id === preferences.connectionId)) {
      this.elements["save-status"].textContent = "该服务尚未通过可用性检查，请选择可用服务。";
      this.elements["save-status"].dataset.state = "error";
      this.render();
      return;
    }
    this.busy = true;
    const resetCatalog = preferences.connectionId !== undefined || preferences.connections || extra.apiKey !== undefined || extra.clearKey;
    if (resetCatalog) this.httpCatalog = null;
    ++this.revision;
    this.elements["save-status"].textContent = "正在保存…";
    this.elements["save-status"].dataset.state = "saving";
    this.render();
    let saved = false;
    try {
      this.snapshot = await this.api.updateAiSettings({ preferences, ...extra });
      if (resetCatalog) this.httpCatalog = null;
      saved = true;
      this.elements["api-key"].value = "";
      this.elements["save-status"].textContent = "";
      this.elements["save-status"].dataset.state = "saved";
    } catch {
      this.elements["save-status"].textContent = "保存失败，请检查输入并重试。";
      this.elements["save-status"].dataset.state = "error";
      // Keep unsaved credential text for correction; never echo it elsewhere.
    } finally {
      this.busy = false;
      this.render();
      await this.refreshConnections();
    }
    if (saved) await this.check();
  }
}
