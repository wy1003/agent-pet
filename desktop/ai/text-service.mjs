import { aiConfigurationKey, normalizeAiPreferences, resolveAiConnection } from "./preferences.mjs";
import { aiError, publicAiError } from "./errors.mjs";

export function validateJsonOutput(value, schema, location = "结果") {
  const invalid = () => { throw aiError("invalid_output", `AI 返回的${location}不符合要求，请重试。`); };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) invalid();
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateJsonOutput(item, schema.properties[key], location);
      else if (schema.additionalProperties === false) invalid();
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) invalid();
    if (schema.items) for (const item of value) validateJsonOutput(item, schema.items, location);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) invalid();
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) invalid();
  } else if (schema.type === "boolean" && typeof value !== "boolean") invalid();
  if (schema.enum && !schema.enum.includes(value)) invalid();
  return value;
}

export class AiTextService {
  constructor({ getPreferences, providers, onStatus = () => {} }) {
    Object.assign(this, { getPreferences, providers, onStatus });
    this.state = { status: "unchecked", message: "尚未检查 AI 连接。", models: [] };
    this.operations = new Set();
    this.revision = 0;
    this.configurationRevision = 0;
    this.stopped = false;
  }

  snapshot() { return structuredClone(this.state); }

  // Catalog-only setup does not change the selected service or its live status.
  async inspectConnection(id, config, credential, { signal } = {}) {
    if (this.stopped) throw aiError("cancelled", "AI 服务已停止。");
    const controller = new AbortController();
    this.operations.add(controller);
    let connection;
    try {
      const provider = this.providers.get(id);
      if (!provider) throw aiError("unsupported_connection", "暂不支持这个 AI 服务。");
      const inspectionSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      inspectionSignal.throwIfAborted();
      connection = await provider.open(config, { credential, signal: inspectionSignal });
      inspectionSignal.throwIfAborted();
      return structuredClone(connection.catalog);
    } catch (error) { throw publicAiError(error); }
    finally {
      try { await connection?.close?.(); } finally { this.operations.delete(controller); }
    }
  }

  configurationChanged() {
    this.configurationRevision += 1;
    this.checking = null;
    this.revision += 1;
    this.state = { status: "unchecked", message: "配置已改变，正在重新检查连接。", models: [] };
    this.onStatus(this.snapshot());
  }

  check({ signal } = {}) {
    const key = aiConfigurationKey(this.getPreferences());
    if (!signal && this.checking?.key === key) return this.checking.promise;
    const promise = this.#run(null, signal);
    const checking = { key, promise };
    this.checking = checking;
    promise.finally(() => { if (this.checking === checking) this.checking = null; }).catch(() => {});
    return promise;
  }

  async generateJson({ prompt, schema, signal, purpose }) {
    return this.#run({ prompt, schema, purpose }, signal);
  }

  async #run(request, externalSignal) {
    if (this.stopped) throw aiError("cancelled", "AI 服务已停止。");
    const preferences = structuredClone(this.getPreferences());
    const key = aiConfigurationKey(preferences);
    const ai = normalizeAiPreferences(preferences.ai);
    const connectionId = resolveAiConnection(preferences);
    const revision = ++this.revision;
    const configurationRevision = this.configurationRevision;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(request ? 10 * 60_000 : 30_000), ...(externalSignal ? [externalSignal] : [])]);
    this.operations.add(controller);
    let connection;
    let details = { connectionId, modelMode: ai.modelMode, configuredModelId: ai.modelId, models: [] };
    const publish = (state) => {
      // Opening settings may finish a catalog check while generation is still
      // running. Its later server result must remain visible for the same model.
      const sameGenerationTarget = request && state.compatibility !== "catalog" && state.status !== "checking"
        && configurationRevision === this.configurationRevision
        && details.modelId && details.modelId === this.state.modelId
        && details.modelProvider === this.state.modelProvider
        && details.runtimeVersion === this.state.runtimeVersion;
      if ((revision !== this.revision && !sameGenerationTarget) || key !== aiConfigurationKey(this.getPreferences()) || this.stopped) return;
      this.state = { ...details, ...state };
      this.onStatus(this.snapshot());
    };
    publish({ status: "checking", message: "正在获取模型列表并检查连接…" });
    try {
      signal.throwIfAborted();
      if (!connectionId) throw aiError("configuration", "请先添加 AI 服务。");
      const provider = this.providers.get(connectionId);
      if (!provider) throw aiError("unsupported_connection", "当前智能体连接尚未提供 AI 文本接口，请选择已支持的 AI 连接。");
      connection = await provider.open(ai.connections[connectionId] || {}, { signal });
      signal.throwIfAborted();
      const catalog = connection.catalog;
      details = { ...details, ...catalog };
      const selectedId = ai.modelMode === "pinned" ? ai.modelId : catalog.defaultModelId;
      if (!selectedId) throw aiError("model_required", ai.modelMode === "pinned"
        ? "请选择要固定使用的模型。"
        : "当前连接没有提供默认模型，请设置连接默认模型，或选择“指定模型”。");
      const model = catalog.models.find((item) => item.id === selectedId);
      details.modelId = selectedId;
      if (!model) throw aiError("model_unavailable", ai.modelMode === "pinned"
        ? `指定模型 ${selectedId} 已不可用，已保留原选择，请重新选择。`
        : `连接默认模型 ${selectedId} 不在可用列表中，请检查连接配置。`);
      publish({ status: "ready", compatibility: "catalog", message: `连接和模型检查通过，当前模型：${selectedId}。实际生成时仍会检查服务端返回结果。` });
      if (!request) return this.snapshot();
      const result = await connection.generate({ ...request, model, signal });
      signal.throwIfAborted();
      let value;
      try { value = JSON.parse(result.text); } catch { throw aiError("invalid_output", "AI 未返回有效 JSON，请重试。"); }
      validateJsonOutput(value, request.schema);
      const generation = {
        connectionId, providerId: catalog.modelProvider || connectionId, modelId: model.id,
        modelMode: ai.modelMode, runtimeVersion: catalog.runtimeVersion || "",
      };
      publish({ status: "ready", compatibility: "verified", message: `AI 生成成功，当前模型：${model.id}。` });
      return { value, generation };
    } catch (error) {
      const safe = publicAiError(error);
      if (signal.aborted && !externalSignal?.aborted && !controller.signal.aborted) {
        safe.code = "connection_timeout";
        safe.message = "AI 连接或生成超时，请检查网络后重试。";
      }
      publish({ status: "error", compatibility: "failed", code: safe.code, message: safe.message });
      if (request) throw safe;
      return { ...details, status: "error", code: safe.code, message: safe.message };
    } finally {
      connection?.close();
      this.operations.delete(controller);
    }
  }

  stop() {
    this.stopped = true;
    for (const operation of this.operations) operation.abort();
  }
}
