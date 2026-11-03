import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { normalizeDeadline } from "../../public/notebook-deadline.mjs";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const check = (condition, message) => { if (!condition) throw new NotebookError(message); };
export class NotebookError extends Error {}

function planFields(value) {
  check(value && typeof value === "object", "计划内容无效。");
  check(typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 120, "请填写不超过 120 字的标题。");
  check(typeof value.detail === "string" && value.detail.length <= 10_000, "具体事项最多 10,000 字。");
  check(typeof value.deadline === "string" && typeof value.deadlineTime === "string", "截止日期或时间无效。");
  const deadline = normalizeDeadline(value.deadline, value.deadlineTime);
  check(deadline, "截止日期或时间无效。");
  check(typeof value.important === "boolean", "重要标记无效。");
  return { title: value.title.trim(), detail: value.detail.trim(), ...deadline, important: value.important };
}
function validateRecord(record, kind, id) {
  check(record && record.version === 1 && record.kind === kind && record.id === id, "文件格式不受支持。");
  check(Number.isSafeInteger(record.revision) && record.revision > 0 && iso(record.createdAt) && iso(record.updatedAt), "文件时间或版本无效。");
  if (kind === "idea") {
    check(typeof record.content === "string" && record.content.trim() && record.content.length <= 10_000, "灵感内容无效。");
    check(record.originalText === undefined || (typeof record.originalText === "string" && record.originalText.length <= 10_000), "灵感原话无效。");
    check(record.events === undefined || Array.isArray(record.events), "灵感历史无效。");
    return record;
  }
  planFields(record);
  check(typeof record.done === "boolean" && (record.completedAt === "" || iso(record.completedAt))
    && (record.archivedAt === "" || iso(record.archivedAt)) && record.done === Boolean(record.completedAt)
    && (!record.archivedAt || record.done), "计划状态无效。");
  check(Array.isArray(record.completions) && Array.isArray(record.events), "操作记录无效。");
  for (const completion of record.completions) {
    check(ID.test(completion.id) && iso(completion.completedAt) && (completion.revokedAt === "" || iso(completion.revokedAt)), "完成记录无效。");
    planFields(completion.snapshot);
    check(iso(completion.snapshot.createdAt), "完成快照无效。");
  }
  check(record.completions.filter(item => !item.revokedAt).length === (record.done ? 1 : 0), "完成记录与状态不一致。");
  if (record.done) check(record.completions.find(item => !item.revokedAt)?.completedAt === record.completedAt, "完成时间不一致。");
  for (const event of record.events) check(ID.test(event.id) && iso(event.at)
    && ["created", "edited", "completed", "completion_revoked", "archived", "restored"].includes(event.type), "操作记录无效。");
  return record;
}

/** Single-writer local repository. No renderer paths or native window handles cross this boundary. */
export class NotebookStore {
  #records = new Map();
  #warnings = [];
  #loading;
  #queue = Promise.resolve();
  #closing = false;
  constructor(rootPath, { io = fs, now = () => new Date(), uuid = randomUUID, onChange = () => {} } = {}) {
    this.rootPath = path.resolve(rootPath);
    this.io = io;
    this.now = now;
    this.uuid = uuid;
    this.onChange = onChange;
  }
  #file(kind, id) {
    check(ID.test(id), "记录编号无效。");
    return path.join(this.rootPath, kind === "plan" ? "plans" : "ideas", `${id}.json`);
  }
  async #atomic(file, value) {
    const temporary = `${file}.tmp-${this.uuid()}`;
    let handle;
    try {
      handle = await this.io.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close(); handle = null;
      await this.io.rename(temporary, file);
    } finally {
      await handle?.close().catch(() => {});
      await this.io.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async #read(file, kind, id) {
    const info = await this.io.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new NotebookError("记录必须是本地普通文件。"), { futureVersion: true });
    const record = JSON.parse(await this.io.readFile(file, "utf8"));
    if (record?.version !== 1) throw Object.assign(new NotebookError("文件版本不受支持，请勿覆盖。"), { futureVersion: true });
    return validateRecord(record, kind, id);
  }
  async load() {
    if (!this.#loading) this.#loading = this.#load().catch(error => { this.#loading = null; throw error; });
    await this.#loading;
  }
  async #load() {
    const loaded = new Map(), warnings = [];
    for (const kind of ["plan", "idea"]) {
      const directory = path.join(this.rootPath, kind === "plan" ? "plans" : "ideas");
      await this.io.mkdir(directory, { recursive: true });
      const names = await this.io.readdir(directory);
      const ids = new Set(names.filter(name => /\.json(?:\.bak)?$/.test(name)).map(name => name.replace(/\.json(?:\.bak)?$/, "")).filter(id => ID.test(id)));
      for (const id of ids) {
        const file = this.#file(kind, id);
        let record;
        try { record = await this.#read(file, kind, id); }
        catch (error) {
          if (error.code && error.code !== "ENOENT") throw error;
          if (!error.futureVersion) {
            try {
              record = await this.#read(`${file}.bak`, kind, id);
              if (names.includes(`${id}.json`)) await this.io.copyFile(file, `${file}.damaged-${this.uuid()}`);
              await this.#atomic(file, record);
              warnings.push(`一条${kind === "plan" ? "计划" : "灵感"}已从备份恢复，最近一次修改可能未保留。`);
            } catch (recoveryError) {
              if (recoveryError.code && recoveryError.code !== "ENOENT") throw recoveryError;
              record = null;
            }
          }
          if (!record) warnings.push(`有一条${kind === "plan" ? "计划" : "灵感"}无法读取，原文件已保留，请查看数据目录。`);
        }
        if (record) loaded.set(`${kind}:${id}`, record);
      }
    }
    this.#records = loaded;
    this.#warnings = warnings;
  }
  #snapshot() {
    const plans = [...this.#records.values()].filter(item => item.kind === "plan")
      .sort((a, b) => Number(b.important) - Number(a.important) || b.createdAt.localeCompare(a.createdAt));
    const ideas = [...this.#records.values()].filter(item => item.kind === "idea")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(idea => ({ ...idea,
        title: idea.content.split("\n")[0], text: idea.content.split("\n").slice(1).join("\n"),
        source: idea.origin === "ai" ? "AI" : "手动", planId: plans.find(plan => plan.sourceIdeaId === idea.id)?.id || "" }));
    return structuredClone({ plans, ideas, warnings: this.#warnings });
  }
  async snapshot() { await this.load(); await this.#queue; return this.#snapshot(); }
  async #write(record) {
    validateRecord(record, record.kind, record.id);
    const file = this.#file(record.kind, record.id);
    const previous = this.#records.get(`${record.kind}:${record.id}`);
    if (!previous) for (const candidate of [file, `${file}.bak`]) {
      try { await this.io.lstat(candidate); throw new NotebookError("同编号文件已存在，已阻止覆盖，请检查数据目录。"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (previous) await this.#atomic(`${file}.bak`, previous);
    await this.#atomic(file, record);
    this.#records.set(`${record.kind}:${record.id}`, record);
  }
  #plan(id) {
    this.#file("plan", id);
    const plan = this.#records.get(`plan:${id}`);
    check(plan, "计划不存在或未能读取。");
    return structuredClone(plan);
  }
  #event(plan, type, at, extra = {}) { plan.events.push({ id: this.uuid(), type, at, ...extra }); }
  #newPlan(id, fields, at, sourceIdeaId = "") {
    return { version: 1, kind: "plan", id, revision: 1, ...planFields(fields), createdAt: at, updatedAt: at,
      done: false, completedAt: "", archivedAt: "", archiveBatchId: "", sourceIdeaId, completions: [],
      events: [{ id: this.uuid(), type: "created", at }] };
  }
  execute(command, { actor = "manual", requestId = "", originalText = "" } = {}) {
    if (this.#closing) return Promise.reject(new NotebookError("记事板正在关闭，请稍后重试。"));
    const operation = this.#queue.then(async () => {
      await this.load();
      check(["manual", "ai"].includes(actor), "记录来源无效。");
      check(typeof requestId === "string" && requestId.length <= 120, "请求编号无效。");
      check(typeof originalText === "string" && originalText.length <= 10_000, "原始内容最多 10,000 字。");
      const result = await this.#execute(command, { actor, requestId, originalText });
      // Notification failure must never turn a committed save into a reported failure.
      try { this.onChange(); } catch {}
      return { snapshot: this.#snapshot(), result };
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  async #execute(command, context) {
    check(command && typeof command === "object", "记事操作无效。");
    const at = this.now().toISOString();
    const { actor, requestId, originalText } = context;
    let creation = { origin: actor };
    if (command.type === "create-plan" || command.type === "create-idea") {
      if (actor === "ai") check(requestId.trim(), "AI 新增记录需要唯一请求编号，重试时复用此编号。");
      const requestDigest = createHash("sha256").update(JSON.stringify({ command, originalText })).digest("hex");
      if (requestId) {
        const existing = [...this.#records.values()].find(record => record.requestId === requestId);
        if (existing) {
          check(existing.requestDigest === requestDigest, "请求编号已用于其他内容，请使用新的编号。");
          return { id: existing.id, duplicate: true };
        }
        creation = { ...creation, requestId, requestDigest };
      }
    }
    if (command.type === "create-plan") {
      const id = this.uuid();
      const plan = { ...this.#newPlan(id, command.value, at), ...creation, originalText };
      plan.events[0].actor = actor;
      await this.#write(plan);
      return { id };
    }
    if (command.type === "create-idea") {
      check(typeof command.value === "string" && command.value.trim() && command.value.length <= 10_000, "请填写不超过 10,000 字的灵感。");
      const id = this.uuid();
      await this.#write({ version: 1, kind: "idea", id, revision: 1, content: command.value.trim(), createdAt: at, updatedAt: at,
        ...creation, originalText: originalText || command.value.trim(), events: [{ id: this.uuid(), type: "created", at, actor }] });
      return { id };
    }
    if (command.type === "edit-idea") {
      this.#file("idea", command.id);
      const existing = this.#records.get(`idea:${command.id}`);
      check(existing, "灵感不存在。");
      check(command.revision === existing.revision, "此灵感已发生变化。请保留草稿，重新读取后再修改。");
      check(typeof command.value === "string" && command.value.trim() && command.value.length <= 10_000, "请填写不超过 10,000 字的灵感。");
      const idea = structuredClone(existing);
      idea.originalText ??= idea.content;
      idea.events ??= [];
      idea.events.push({ id: this.uuid(), type: "edited", at, actor, before: { content: idea.content }, after: { content: command.value.trim() } });
      idea.content = command.value.trim(); idea.revision++; idea.updatedAt = at;
      await this.#write(idea);
      return { id: idea.id };
    }
    if (command.type === "convert-idea") {
      this.#file("idea", command.id);
      const idea = this.#records.get(`idea:${command.id}`);
      check(idea, "灵感不存在。");
      // Stable ID makes conversion idempotent without a two-file transaction.
      const existing = this.#records.get(`plan:${idea.id}`);
      if (existing) return { id: existing.id };
      await this.#write(this.#newPlan(idea.id, { title: idea.content.split("\n")[0].slice(0, 120),
        detail: idea.content, deadline: "", deadlineTime: "", important: false }, at, idea.id));
      return { id: idea.id };
    }
    if (command.type === "archive" || command.type === "restore") {
      check(Array.isArray(command.ids) && command.ids.length > 0 && command.ids.every(id => typeof id === "string" && ID.test(id)), "归档编号无效。");
      const batchId = this.uuid(), ids = [], failed = [];
      for (const id of new Set(command.ids)) {
        try {
          const plan = this.#plan(id);
          if (command.type === "archive") {
            check(plan.done && !plan.archivedAt, "只有已完成且未归档的计划可以归档。");
            plan.archivedAt = at; plan.archiveBatchId = batchId;
            this.#event(plan, "archived", at, { batchId });
          } else {
            check(plan.archivedAt && (!command.batchId || plan.archiveBatchId === command.batchId), "此计划已不属于本次归档。");
            plan.archivedAt = ""; plan.archiveBatchId = "";
            this.#event(plan, "restored", at);
          }
          plan.updatedAt = at; plan.revision++;
          await this.#write(plan); ids.push(id);
        } catch (error) { failed.push({ id, message: error instanceof NotebookError ? error.message : "文件写入失败，原计划已保留。" }); }
      }
      return { ids, failed, batchId };
    }
    check(["edit-plan", "set-completed", "delete-plan"].includes(command.type), "不支持的记事操作。");
    const plan = this.#plan(command.id);
    if (command.type === "delete-plan") {
      check(plan.archivedAt, "请先归档，再删除计划。");
      const file = this.#file("plan", plan.id);
      // Remove backup first so interrupted deletion cannot resurrect a deleted primary.
      await this.io.rm(`${file}.bak`, { force: true });
      for (const name of await this.io.readdir(path.dirname(file))) {
        const prefix = `${plan.id}.json.`;
        if (name.startsWith(prefix) && /^(?:damaged|tmp)-[0-9a-f-]{36}$/.test(name.slice(prefix.length))) {
          await this.io.rm(path.join(path.dirname(file), name), { force: true });
        }
      }
      await this.io.rm(file);
      this.#records.delete(`plan:${plan.id}`);
      return { id: plan.id };
    }
    check(!plan.archivedAt, "请先移回计划列表再修改。");
    if (command.type === "edit-plan") {
      check(command.revision === plan.revision, "此计划已发生变化。请取消当前编辑后重新打开，或复制草稿后重试。");
      const before = planFields(plan);
      Object.assign(plan, planFields({ ...plan, ...command.value }));
      this.#event(plan, "edited", at, { actor, before, after: planFields(plan) });
    } else {
      check(typeof command.done === "boolean", "完成状态无效。");
      if (plan.done === command.done) return { id: plan.id };
      plan.done = command.done;
      if (plan.done) {
        const completion = { id: this.uuid(), completedAt: at, revokedAt: "",
          snapshot: { ...planFields(plan), createdAt: plan.createdAt } };
        plan.completions.push(completion); plan.completedAt = at;
        this.#event(plan, "completed", at, { completionId: completion.id });
      } else {
        const completion = plan.completions.findLast(item => !item.revokedAt);
        completion.revokedAt = at; plan.completedAt = "";
        this.#event(plan, "completion_revoked", at, { completionId: completion.id });
      }
    }
    plan.updatedAt = at; plan.revision++;
    await this.#write(plan);
    return { id: plan.id };
  }
  async close() { this.#closing = true; await this.#queue; }
}
