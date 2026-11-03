import { z } from "zod";
import { NotebookError } from "../notebook-store.mjs";

const id = z.string().uuid();
const revision = z.number().int().positive().describe("先查询记录取得 revision；版本冲突时重新读取并与用户确认，不能强制覆盖。");
const requestId = z.string().trim().min(1).max(120).describe("本次新增的唯一编号（建议 UUID）；同一次请求重试必须复用，新的内容使用新编号。");
const title = z.string().trim().min(1).max(120);
const text = z.string().max(10_000);
const planFields = { title, detail: text, deadline: z.string().describe("本地日期 YYYY-MM-DD；未指定则留空。"),
  deadlineTime: z.string().describe("本地 24 小时制 HH:mm；可留空，必须同时有日期。"), important: z.boolean() };
const definitions = [
  { name: "notebook_list", description: "查询记事板计划或灵感的摘要和编号。搜索已有内容避免重复添加；分页返回，不包含完整正文。",
    schema: z.object({ kind: z.enum(["plan", "idea", "all"]).default("all"), scope: z.enum(["active", "archived", "all"]).default("active"),
      query: z.string().max(200).default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }).strict(), readOnly: true },
  { name: "notebook_get", description: "读取指定记录的完整内容、revision、原话和历史。修改前先调用本工具。",
    schema: z.object({ kind: z.enum(["plan", "idea"]), id }).strict(), readOnly: true },
  { name: "notebook_add_plan", description: "将用户要求记录的计划写入 Agent Pet。AI 整理标题和具体事项；不要擅自指定截止时间或重要程度。成功后窗口自动更新，写入时间由软件生成。",
    schema: z.object({ requestId, title, detail: text.default(""), deadline: planFields.deadline.default(""), deadlineTime: planFields.deadlineTime.default(""),
      important: z.boolean().default(false), originalText: text.default("").describe("如有用户原话，原样保留，不要编造。") }).strict() },
  { name: "notebook_add_idea", description: "记录用户的一句话灵感及 AI 补充。必须保留原话；content 首行是简短标题，其后为整理内容或下一步建议。补充要克制，不编造已确认的事实。",
    schema: z.object({ requestId, originalText: z.string().trim().min(1).max(10_000), content: z.string().trim().min(1).max(10_000) }).strict() },
  { name: "notebook_update_plan", description: "按 id 和 revision 修改计划，只传需要更改的字段。原话、写入时间及历史保留；不能修改已归档计划。冲突时保留用户修改，不得盲目重试覆盖。",
    schema: z.object({ id, revision, changes: z.object(Object.fromEntries(Object.entries(planFields).map(([key, field]) => [key, field.optional()])))
      .strict().refine(value => Object.keys(value).length > 0, "至少提供一个修改字段") }).strict() },
  { name: "notebook_update_idea", description: "按 id 和 revision 补充或修改灵感正文。保留原始想法与历次修改；先读取再修改，冲突时不得强制覆盖。",
    schema: z.object({ id, revision, content: z.string().trim().min(1).max(10_000) }).strict() },
];
export const notebookTools = Object.freeze(definitions);

/** Domain interface shared by the MCP transport and the app; only the app owns storage. */
export function createNotebookTools(store) {
  const records = snapshot => [...snapshot.plans, ...snapshot.ideas];
  const get = (snapshot, kind, recordId) => {
    const record = records(snapshot).find(item => item.id === recordId && item.kind === kind);
    if (!record) throw new NotebookError("记录不存在或未能读取。");
    return record;
  };
  return { async call(name, args) {
    const tool = definitions.find(item => item.name === name);
    if (!tool) throw new NotebookError("不支持的记事板工具。");
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw new NotebookError(`参数无效：${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")}`);
    const value = parsed.data;
    if (name === "notebook_get") return get(await store.snapshot(), value.kind, value.id);
    if (name === "notebook_list") {
      const all = records(await store.snapshot()).filter(item => (value.kind === "all" || item.kind === value.kind)
        && (value.scope === "all" || (value.scope === "archived" ? Boolean(item.archivedAt) : !item.archivedAt))
        && `${item.title || ""}\n${item.detail || item.content || ""}`.toLowerCase().includes(value.query.toLowerCase()));
      return { total: all.length, offset: value.offset, records: all.slice(value.offset, value.offset + value.limit).map(item => ({
        id: item.id, kind: item.kind, revision: item.revision, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt,
        origin: item.origin || "manual", ...(item.kind === "plan" ? { important: item.important, deadline: item.deadline, deadlineTime: item.deadlineTime,
          done: item.done, archived: Boolean(item.archivedAt) } : {}),
      })) };
    }
    let command, kind;
    if (name === "notebook_add_plan") {
      kind = "plan"; const { requestId: _request, originalText: _original, ...fields } = value;
      command = { type: "create-plan", value: fields };
    } else if (name === "notebook_add_idea") { kind = "idea"; command = { type: "create-idea", value: value.content }; }
    else if (name === "notebook_update_plan") { kind = "plan"; command = { type: "edit-plan", id: value.id, revision: value.revision, value: value.changes }; }
    else { kind = "idea"; command = { type: "edit-idea", id: value.id, revision: value.revision, value: value.content }; }
    const { snapshot, result } = await store.execute(command, { actor: "ai", requestId: value.requestId || "", originalText: value.originalText || "" });
    return { saved: true, duplicate: Boolean(result.duplicate), record: get(snapshot, kind, result.id) };
  } };
}
