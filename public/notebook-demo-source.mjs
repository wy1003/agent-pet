import { normalizeDeadline } from "./notebook-deadline.mjs";

/**
 * Preview-only data source. No disk, network or Weixin access.
 * A future source can implement the same snapshot and edit methods.
 * @typedef {{getSnapshot: Function, togglePlan: Function, toggleImportance: Function,
 * updatePlan: Function, add: Function, convertIdea: Function}} NotebookSource
 */
export function createNotebookDemoSource({ now = () => new Date() } = {}) {
  let serial = 0;
  const initializedAt = now();
  const writtenAgo = hours => new Date(initializedAt.getTime() - hours * 3_600_000).toISOString();
  const dateAfter = days => {
    const date = new Date(initializedAt);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const plans = [
    { id: "plan-1", title: "整理本周的工作重点", detail: "1. 回顾上周还没完成的事情。\n2. 列出本周最重要的三件事，明确每件事的交付结果。\n3. 给每件事预留一个不被打扰的时间段。", createdAt: writtenAgo(5), deadline: dateAfter(2), important: false, done: false },
    { id: "plan-2", title: "把记事板的第一版界面做出来", detail: "先完成一版可以实际体验的界面，重点把计划的查看与整理做顺手。\n\n1. 列表保持简洁，点击标题进入详情。\n2. 详情展示完整内容和写入时间。\n3. 支持设置截止日期、标记重要。\n4. 检查窄窗口、深色模式和键盘操作。\n\n验收时走一遍：新增计划 → 填写具体事项 → 设置日期 → 标记重要 → 返回列表。", createdAt: writtenAgo(28), deadline: dateAfter(5), important: true, done: false },
    { id: "plan-3", title: "梳理设置页面的布局", detail: "统一分组、间距和开关样式。\n减少重复的说明文字，检查各页面的对齐。", createdAt: writtenAgo(48), deadline: "", important: false, done: true },
    { id: "plan-4", title: "整理微信里随手记下的想法", detail: "把零散想法集中到一起。\n合并重复记录，再挑一个值得继续做的小点子，补充具体的下一步。", createdAt: writtenAgo(1), deadline: "", important: false, done: false },
  ];
  const ideas = [
    { id: "idea-1", title: "让灵感离行动更近一点", text: "在微信里随手记下一句话，回到电脑后就能在记事板里看到。想做的时候，再把它转成计划。", tag: "产品想法", source: "微信", time: "刚刚", tone: "warm" },
    { id: "idea-2", title: "一个轻一点的每日回顾", text: "每天收工前，看看今天完成了什么，再留一个明天最想推进的小目标。", tag: "工作方式", source: "桌面", time: "今天 10:24", tone: "green" },
    { id: "idea-3", title: "给宠物加一点仪式感", text: "完成一项计划时，让宠物做一个小小的庆祝动作。", tag: "随想", source: "微信", time: "昨天 21:08", tone: "plain" },
  ];
  for (const plan of plans) plan.deadlineTime = plan.id === "plan-2" ? "18:30" : "";
  const planFields = value => {
    const input = typeof value === "string" ? { title: value } : value;
    if (!input || typeof input !== "object") return null;
    const title = String(input.title ?? "").trim().slice(0, 120);
    const deadline = normalizeDeadline(String(input.deadline ?? ""), String(input.deadlineTime ?? ""));
    if (!title || !deadline) return null;
    return { title, detail: String(input.detail ?? "").trim().slice(0, 10_000),
      ...deadline, important: input.important === true };
  };
  const addPlan = value => {
    const fields = planFields(value);
    if (!fields) return false;
    const id = `added-plan-${++serial}`;
    plans.unshift({ id, ...fields, createdAt: now().toISOString(), done: false });
    return id;
  };
  return {
    getSnapshot: () => structuredClone({
      plans: [...plans].sort((a, b) => Number(b.important) - Number(a.important)
        || b.createdAt.localeCompare(a.createdAt)), ideas,
    }),
    togglePlan(id) {
      const plan = plans.find(item => item.id === id);
      if (plan) plan.done = !plan.done;
    },
    toggleImportance(id) {
      const plan = plans.find(item => item.id === id);
      if (plan) plan.important = !plan.important;
    },
    updatePlan(id, patch) {
      const plan = plans.find(item => item.id === id);
      const fields = plan && planFields({ ...plan, ...patch,
        ...(patch?.deadline === "" ? { deadlineTime: "" } : {}) });
      if (!fields) return false;
      Object.assign(plan, fields);
      return true;
    },
    add(kind, value) {
      if (kind === "plans") return addPlan(value);
      const text = String(value || "").trim().slice(0, 240);
      if (!text) return false;
      if (kind === "ideas") ideas.unshift({ id: `added-idea-${++serial}`,
        title: text.split("\n")[0], text: text.split("\n").slice(1).join("\n"),
        tag: "随想", source: "桌面", time: "刚刚", tone: "plain" });
      else return false;
      return true;
    },
    convertIdea(id) {
      const idea = ideas.find(item => item.id === id);
      if (!idea || idea.planId) return false;
      idea.planId = addPlan({ title: idea.title, detail: idea.text });
      return true;
    },
  };
}
