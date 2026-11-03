import { createNotebookSource } from "./notebook-source.mjs";
import { deadlineText } from "./notebook-deadline.mjs";
import { createDeadlinePicker } from "./notebook-deadline-picker.js";
import { createNotebookGlass } from "./notebook-glass.js";

const glass = createNotebookGlass(document.querySelector(".notebook"));
let notebookCollapsed = false;
let notebookStyle = "classic";
let revealRevision = 0;
function syncGlassPresentation() {
  const revision = ++revealRevision;
  const surface = document.querySelector(".notebook"), orb = document.querySelector("#notebook-orb");
  const glassStyle = notebookStyle === "glass";
  surface.classList.remove("is-warming");
  orb.hidden = !notebookCollapsed;
  glass.setEnabled(glassStyle && !notebookCollapsed, { retainFrame: glassStyle && notebookCollapsed });
  if (!notebookCollapsed && glassStyle && !glass.hasFrame()) {
    surface.classList.add("is-warming");
    orb.hidden = false;
    void glass.whenReady().then(() => {
      if (revision !== revealRevision || notebookCollapsed) return;
      surface.classList.remove("is-warming");
      orb.hidden = true;
      if (document.activeElement === orb) (lastNotebookFocus?.isConnected ? lastNotebookFocus : collapseButton).focus({ preventScroll: true });
    });
  }
}
let appearanceRevision = 0;
function applyAppearance(appearance) {
  notebookStyle = appearance?.style === "glass" ? "glass" : "classic";
  document.documentElement.dataset.notebookStyle = notebookStyle;
  syncGlassPresentation();
}
window.companion?.onNotebookAppearanceChanged?.(appearance => {
  appearanceRevision++;
  applyAppearance(appearance);
});
const initialAppearanceRevision = appearanceRevision;
window.companion?.getNotebookAppearance?.().then(appearance => {
  if (appearanceRevision === initialAppearanceRevision) applyAppearance(appearance);
}).catch(() => {});

const orb = document.querySelector("#notebook-orb");
const collapseButton = document.querySelector("#collapse-board");
let presentationRevision = 0, lastNotebookFocus = null, changingPresentation = false;
function applyPresentation(value) {
  const collapsed = value?.collapsed === true;
  const changed = notebookCollapsed !== collapsed;
  if (changed && collapsed) lastNotebookFocus = document.activeElement;
  notebookCollapsed = collapsed;
  document.documentElement.dataset.notebookCollapsed = String(collapsed);
  document.querySelector(".notebook").hidden = collapsed;
  syncGlassPresentation();
  if (changed) {
    if (collapsed) orb.focus({ preventScroll: true });
    else if (orb.hidden) (lastNotebookFocus?.isConnected ? lastNotebookFocus : collapseButton).focus({ preventScroll: true });
  }
}
window.companion?.onNotebookPresentationChanged?.(value => {
  presentationRevision++;
  applyPresentation(value);
});
const initialPresentationRevision = presentationRevision;
window.companion?.getNotebookPresentation?.().then(value => {
  if (presentationRevision === initialPresentationRevision) applyPresentation(value);
}).catch(() => { collapseButton.title = "请重新启动 Agent Pet 后使用收起功能"; });
async function changePresentation(collapsed) {
  if (changingPresentation) return;
  changingPresentation = true;
  try {
    if (!window.companion?.setNotebookCollapsed) throw new Error("请重新启动 Agent Pet 后使用收起功能。");
    applyPresentation(await window.companion.setNotebookCollapsed(collapsed));
  } catch (error) {
    const message = error.message || "无法切换窗口，请重试。";
    document.querySelector("#notebook-error").textContent = message;
    document.querySelector("#notebook-error").hidden = false;
    orb.title = message;
  } finally { changingPresentation = false; }
}
collapseButton.addEventListener("click", () => void changePresentation(true));
let orbGesture = null, finishingOrbGesture = false;
orb.addEventListener("pointerdown", event => {
  if (event.button !== 0 || !event.isPrimary || orbGesture || finishingOrbGesture) return;
  event.preventDefault();
  orb.setPointerCapture(event.pointerId);
  orbGesture = { id: event.pointerId, started: window.companion?.startNotebookDrag?.().catch(() => false) };
  orb.dataset.dragging = "true";
});
async function finishOrbGesture(event, cancelled = false) {
  if (!orbGesture || event.pointerId !== orbGesture.id) return;
  const gesture = orbGesture; orbGesture = null;
  finishingOrbGesture = true;
  delete orb.dataset.dragging;
  if (orb.hasPointerCapture(event.pointerId)) orb.releasePointerCapture(event.pointerId);
  try {
    const started = await gesture.started;
    const result = await window.companion?.finishNotebookDrag?.(cancelled);
    if (started && !cancelled && !result?.dragged) await changePresentation(false);
  } catch { orb.title = "无法移动记事板，请重试。"; }
  finally { finishingOrbGesture = false; }
}
orb.addEventListener("pointerup", event => void finishOrbGesture(event));
orb.addEventListener("pointercancel", event => void finishOrbGesture(event, true));
orb.addEventListener("lostpointercapture", event => void finishOrbGesture(event, true));
orb.addEventListener("click", event => { if (event.detail === 0) void changePresentation(false); });
window.addEventListener("blur", () => {
  if (orbGesture) void finishOrbGesture({ pointerId: orbGesture.id }, true);
});
function updateOrbCount(plans) {
  const count = plans.filter(plan => !plan.done && !plan.archivedAt).length;
  document.querySelector("#notebook-orb-count").textContent = count > 99 ? "99+" : String(count);
  orb.setAttribute("aria-label", `展开记事板，${count} 项未完成计划`);
  orb.title = `${count} 项未完成计划 · 点击展开，拖动移动`;
}
function markOrbUnavailable() {
  document.querySelector("#notebook-orb-count").textContent = "!";
  orb.setAttribute("aria-label", "计划读取失败，点击展开记事板重试");
  orb.title = "计划读取失败，点击展开重试";
}

/** Renders a repository interface. Drafts are local; committed data is acknowledged by disk writes. */
function mountNotebook(source) {
  const $ = selector => document.querySelector(selector);
  let activeTab = "plans";
  let archiveView = false;
  let busy = false;
  let selectedPlanId = null;
  const planDrafts = new Map();
  let editorKind = "plans";
  let editingIdea = null;
  let refreshPending = false, refreshing = false;
  let statusTimer;
  const editor = $("#note-editor");
  const deleteDialog = $("#delete-confirm");
  const deadlinePicker = createDeadlinePicker($("#deadline-picker"));
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const pad = value => String(value).padStart(2, "0");
  const writtenTime = (value, full = false) => {
    const date = new Date(value);
    return `${full ? `${date.getFullYear()}/` : ""}${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  function updateDeadlineButton(button, date, time) {
    const label = deadlineText(date, time);
    button.querySelector("span").textContent = label;
    button.classList.toggle("is-empty", !date);
    button.setAttribute("aria-label", `截止时间：${label}，点击设置`);
  }
  const currentPlan = () => source.getSnapshot().plans.find(plan => plan.id === selectedPlanId);
  const currentDraft = () => planDrafts.get(selectedPlanId);
  const announce = (text, undo) => {
    clearTimeout(statusTimer);
    $("#board-status").textContent = text;
    if (undo) {
      const button = element("button", "", "撤销");
      button.type = "button"; button.id = "undo-archive";
      button.addEventListener("click", undo);
      $("#board-status").append(button);
    }
    $("#board-status").hidden = false;
    statusTimer = setTimeout(() => { $("#board-status").hidden = true; }, undo ? 8000 : 2200);
  };
  async function mutate(operation, after) {
    if (busy) return null;
    busy = true;
    const controls = [...document.querySelectorAll("button,input,textarea")].filter(control => !control.disabled);
    controls.forEach(control => { control.disabled = true; });
    $("#notebook-storage-status").textContent = "正在保存…";
    $("#notebook-error").hidden = true;
    try {
      const result = await operation();
      after?.(result);
      render();
      $("#notebook-storage-status").textContent = "保存在本机";
      return result;
    } catch (error) {
      $("#notebook-error").textContent = error.message || "保存失败，请重试。";
      $("#notebook-error").hidden = false;
      $("#notebook-storage-status").textContent = "未保存，请重试";
      render();
      return null;
    } finally {
      controls.filter(control => control.isConnected).forEach(control => { control.disabled = false; });
      busy = false;
      updatePanels();
      if (refreshPending) void refreshExternal();
    }
  }
  async function refreshExternal() {
    refreshPending = true;
    if (busy || refreshing) return;
    refreshing = true;
    try {
      while (refreshPending && !busy) {
        refreshPending = false;
        readDraftFields();
        await source.load();
        readDraftFields();
        render();
        if (currentDraft() && currentPlan()?.revision !== currentDraft().revision) {
          $("#detail-edit-error").textContent = "此计划已被更新，你的草稿仍保留。请复制需要保留的内容，取消编辑后查看最新版本。";
          $("#detail-edit-error").hidden = false;
        }
      }
    } catch (error) { markOrbUnavailable(); $("#notebook-error").textContent = error.message; $("#notebook-error").hidden = false; }
    finally { refreshing = false; }
  }
  function historyDetails(label, content) {
    const details = element("details", "history-entry");
    details.append(element("summary", "", label));
    const body = element("div", "history-snapshot"); body.append(element("p", "", content)); details.append(body);
    return details;
  }
  function renderHistory(plan) {
    const list = $("#history-list"); list.replaceChildren();
    list.append(element("p", "idea-source", `创建来源：${plan.origin === "ai" ? "AI" : "手动"}`));
    if (plan.originalText) list.append(historyDetails("原始内容", plan.originalText));
    const labels = { created: "创建计划", edited: "修改计划", completed: "完成计划", completion_revoked: "取消完成", archived: "归档", restored: "移回计划列表" };
    for (const event of [...plan.events].reverse()) {
      if (event.type === "edited" && event.before && event.after) {
        const format = value => `${value.title}\n${value.detail}\n截止：${deadlineText(value.deadline, value.deadlineTime)}${value.important ? " · 重要" : ""}`;
        list.append(historyDetails(`${writtenTime(event.at, true)} · ${event.actor === "ai" ? "AI 修改" : "手动修改"}`,
          `修改前\n${format(event.before)}\n\n修改后\n${format(event.after)}`));
        continue;
      }
      const completion = plan.completions.find(item => item.id === event.completionId);
      if (event.type === "completed" && completion) {
        const entry = element("details", "history-entry");
        entry.append(element("summary", "", `${writtenTime(event.at, true)} · 完成${completion.revokedAt ? "（已撤销）" : ""}`));
        const snapshot = element("div", "history-snapshot");
        snapshot.append(element("h3", "", completion.snapshot.title), element("p", "", completion.snapshot.detail || "未填写具体事项"),
          element("small", "", `写入 ${writtenTime(completion.snapshot.createdAt, true)} · 截止 ${deadlineText(completion.snapshot.deadline, completion.snapshot.deadlineTime)}${completion.snapshot.important ? " · 重要" : ""}`));
        entry.append(snapshot); list.append(entry);
      } else list.append(element("div", "history-entry", `${writtenTime(event.at, true)} · ${labels[event.type] || event.type}`));
    }
  }
  function styleImportance(button, plan) {
    button.replaceChildren();
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L2.9 9.6l6.3-.9Z");
    icon.append(path);
    button.append(icon);
    button.setAttribute("aria-pressed", String(plan.important));
    button.title = plan.important ? "取消重要" : "标记重要，优先显示";
    button.setAttribute("aria-label", `${button.title}：${plan.title}`);
  }
  function updatePanels() {
    const detail = Boolean(selectedPlanId);
    const plan = currentPlan();
    const archived = Boolean(plan?.archivedAt);
    const editing = detail && !archived && Boolean(currentDraft());
    $(".board-tabs").hidden = detail || archiveView;
    $("#back-to-plans").hidden = !detail && !archiveView;
    $("#back-label").textContent = detail && archiveView ? "归档" : "计划";
    $("#edit-plan").hidden = !detail || editing || archived;
    $("#restore-plan").hidden = !detail || !archived;
    $("#delete-plan").hidden = !detail || !archived;
    $("#cancel-plan-edit").hidden = !editing;
    $("#save-plan-edit").hidden = !editing;
    $("#add-note").hidden = detail || archiveView;
    $("#plans-panel").hidden = detail || activeTab !== "plans";
    $("#ideas-panel").hidden = detail || activeTab !== "ideas";
    $("#plan-detail-panel").hidden = !detail;
    $("#detail-metadata").hidden = !detail;
    $("#plan-detail-panel").classList.toggle("is-editing", editing);
    $("#detail-title").hidden = editing;
    $("#detail-content").hidden = editing;
    $("#detail-title-input").hidden = !editing;
    $("#detail-content-input").hidden = !editing;
    $("#archive-actions").hidden = detail || activeTab !== "plans" || archiveView;
    $("#archive-heading").hidden = detail || !archiveView;
    if (!detail) return;
    if (!plan) { selectedPlanId = null; updatePanels(); return; }
    const displayed = { ...plan, ...(editing ? currentDraft() : {}) };
    $("#detail-title").textContent = displayed.title || plan.title;
    $("#detail-created").textContent = writtenTime(plan.createdAt, true);
    $("#detail-created").dateTime = plan.createdAt;
    updateDeadlineButton($("#detail-deadline"), displayed.deadline, displayed.deadlineTime);
    $("#detail-deadline").disabled = archived || busy;
    $("#detail-important").disabled = archived || busy;
    for (const [key, value] of [["completed", plan.completedAt], ["archived", plan.archivedAt]]) {
      $(`#${key}-metadata`).hidden = !value;
      $(`#detail-${key}`).textContent = value ? writtenTime(value, true) : "";
      $(`#detail-${key}`).dateTime = value || "";
    }
    $("#plan-history").hidden = editing;
    $("#detail-content").textContent = plan.detail || "还没有补充具体事项，可以点击右上角编辑。";
    $("#detail-content").classList.toggle("is-empty", !plan.detail);
    if (editing) {
      if ($("#detail-title-input").value !== displayed.title) $("#detail-title-input").value = displayed.title;
      if ($("#detail-content-input").value !== displayed.detail) $("#detail-content-input").value = displayed.detail;
    }
    styleImportance($("#detail-important"), displayed);
  }
  function clearEditError() {
    $("#detail-edit-error").hidden = true;
    $("#detail-title-input").removeAttribute("aria-invalid");
    $("#detail-content-input").removeAttribute("aria-invalid");
  }
  function readDraftFields() {
    const draft = currentDraft();
    if (draft) { draft.title = $("#detail-title-input").value; draft.detail = $("#detail-content-input").value; }
    return draft;
  }
  function beginPlanEdit() {
    const plan = currentPlan();
    if (!plan) return;
    const { title, detail, deadline, deadlineTime, important, revision } = plan;
    if (!currentDraft()) planDrafts.set(plan.id, { title, detail, deadline, deadlineTime, important, revision });
    clearEditError();
    updatePanels();
    $("#plan-detail-panel").scrollTop = 0;
    $("#detail-title-input").focus({ preventScroll: true });
  }
  function cancelPlanEdit() {
    planDrafts.delete(selectedPlanId);
    clearEditError();
    updatePanels();
    $("#edit-plan").focus({ preventScroll: true });
  }
  async function savePlanEdit() {
    const draft = readDraftFields();
    if (!draft) return;
    let field = "#detail-title-input", message = "";
    if (!draft.title.trim()) message = "请填写计划标题。";
    else if (draft.title.trim().length > 120) message = "标题最多 120 字。";
    else if (draft.detail.trim().length > 10_000) { field = "#detail-content-input"; message = "具体事项最多 10,000 字。"; }
    if (message) {
      $("#detail-edit-error").textContent = message;
      $("#detail-edit-error").hidden = false;
      $(field).setAttribute("aria-invalid", "true");
      $(field).focus();
      return;
    }
    const id = selectedPlanId;
    const result = await mutate(() => source.updatePlan(id, { ...draft }), () => {
      planDrafts.delete(id); clearEditError(); announce("计划已保存");
    });
    if (result) $("#edit-plan").focus({ preventScroll: true });
  }
  function openPlan(id) {
    selectedPlanId = id;
    clearEditError();
    updatePanels();
    $("#plan-detail-panel").scrollTop = 0;
    $("#plan-history").open = false;
    renderHistory(currentPlan());
    $(currentDraft() ? "#detail-title-input" : "#detail-title").focus({ preventScroll: true });
  }
  function backToPlans() {
    readDraftFields();
    clearEditError();
    const id = selectedPlanId;
    if (!id && archiveView) archiveView = false;
    selectedPlanId = null;
    render();
    document.querySelector(`[data-open-plan="${CSS.escape(id || "")}"]`)?.focus({ preventScroll: true });
  }
  function render() {
    const { plans, ideas, warnings } = source.getSnapshot();
    updateOrbCount(plans);
    $("#storage-warning").textContent = [...new Set(warnings)].join(" ");
    $("#storage-warning").hidden = !warnings.length;
    const completed = plans.filter(plan => plan.done && !plan.archivedAt);
    $("#archive-completed").hidden = !completed.length;
    $("#archive-completed").textContent = `归档已完成（${completed.length}）`;
    $("#view-archive").textContent = `归档 · ${plans.filter(plan => plan.archivedAt).length}`;
    const list = $("#plan-list");
    list.replaceChildren();
    const visiblePlans = plans.filter(plan => Boolean(plan.archivedAt) === archiveView);
    if (archiveView) visiblePlans.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.archivedAt.localeCompare(a.archivedAt));
    if (!visiblePlans.length) list.append(element("p", "empty-notes", archiveView ? "暂无归档" : "暂无计划"));
    for (const plan of visiblePlans) {
      const row = element("div", `plan-row${plan.done && !archiveView ? " is-done" : ""}${archiveView ? " archive-row" : ""}`);
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = plan.done;
      checkbox.setAttribute("aria-label", `完成：${plan.title}`);
      checkbox.dataset.planId = plan.id;
      checkbox.addEventListener("change", async () => {
        const done = checkbox.checked;
        await mutate(() => source.setCompleted(plan.id, done), () => announce(done ? "已完成，仍保留在计划列表" : "已取消完成"));
        document.querySelector(`[data-plan-id="${CSS.escape(plan.id)}"]`)?.focus({ preventScroll: true });
      });
      const open = element("button", "plan-open");
      open.dataset.openPlan = plan.id;
      open.setAttribute("aria-label", `查看计划：${plan.title}`);
      open.append(element("span", "plan-title", plan.title));
      const meta = element("span", "plan-meta");
      const displayedTime = archiveView ? plan.completedAt : plan.createdAt;
      const created = element("time", "plan-created", `${archiveView ? "完成" : "写入"} ${writtenTime(displayedTime)}`);
      created.dateTime = displayedTime;
      created.title = writtenTime(displayedTime, true);
      meta.append(created);
      if (!archiveView && plan.deadline) meta.append(element("span", "plan-deadline", `截止 ${deadlineText(plan.deadline, plan.deadlineTime, { compact: true })}`));
      open.append(meta);
      open.addEventListener("click", () => openPlan(plan.id));
      const important = element("button", "importance-button");
      important.dataset.importantPlan = plan.id;
      styleImportance(important, plan);
      important.addEventListener("click", async () => {
        await mutate(() => source.updatePlan(plan.id, { important: !plan.important }));
        document.querySelector(`[data-important-plan="${CSS.escape(plan.id)}"]`)?.focus();
      });
      if (archiveView) row.append(open);
      else row.append(checkbox, open, important);
      list.append(row);
    }
    $("#idea-list").replaceChildren();
    if (!ideas.length) $("#idea-list").append(element("p", "empty-notes", "暂无灵感"));
    for (const idea of ideas) {
      const card = element("article", "idea-card");
      card.append(element("h2", "idea-title", idea.title));
      if (idea.text) card.append(element("p", "idea-text", idea.text));
      const footer = element("div", "idea-footer");
      footer.append(element("span", "idea-source", `${idea.source} · ${writtenTime(idea.createdAt)}`));
      const actions = element("div", "idea-actions");
      const edit = element("button", "convert-button", "✎");
      edit.title = "编辑灵感"; edit.setAttribute("aria-label", `编辑灵感：${idea.title}`); edit.dataset.editIdea = idea.id;
      edit.addEventListener("click", () => openEditor(idea));
      const convert = element("button", "convert-button", idea.planId ? "✓" : "↗");
      convert.title = idea.planId ? "已转为计划" : "转为计划";
      convert.setAttribute("aria-label", `${convert.title}：${idea.title}`);
      convert.disabled = Boolean(idea.planId);
      convert.dataset.ideaId = idea.id;
      convert.addEventListener("click", async () => {
        if (await mutate(() => source.convertIdea(idea.id))) {
          $("#tab-ideas").focus({ preventScroll: true });
          announce("已加入计划");
        }
      });
      actions.append(edit, convert); footer.append(actions);
      card.append(footer);
      if (idea.originalText && (idea.origin === "ai" || idea.originalText !== idea.content)) card.append(historyDetails("原话", idea.originalText));
      if (idea.events?.some(event => event.type === "edited")) {
        const history = element("details", "idea-history"); history.append(element("summary", "", "修改记录"));
        for (const event of [...idea.events].reverse()) if (event.type === "edited" && event.before && event.after) {
          history.append(historyDetails(`${writtenTime(event.at, true)} · ${event.actor === "ai" ? "AI 修改" : "手动修改"}`,
            `修改前\n${event.before.content}\n\n修改后\n${event.after.content}`));
        }
        card.append(history);
      }
      $("#idea-list").append(card);
    }
    updatePanels();
    if (currentPlan()) renderHistory(currentPlan());
  }
  function selectTab(tab) {
    activeTab = tab;
    archiveView = false;
    selectedPlanId = null;
    for (const button of document.querySelectorAll("[data-tab]")) {
      const selected = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    render();
    const addLabel = tab === "plans" ? "添加计划" : "记下灵感";
    $("#add-note").setAttribute("aria-label", addLabel);
    $("#add-note").title = addLabel;
  }
  function openEditor(idea = null) {
    editingIdea = idea ? { id: idea.id, revision: idea.revision } : null;
    editorKind = activeTab;
    const isPlan = editorKind === "plans";
    $("#editor-title").textContent = isPlan ? "添加计划" : idea ? "编辑灵感" : "记下灵感";
    $("#editor-label").textContent = isPlan ? "具体事项" : "有什么新想法？";
    $("#plan-title-field").hidden = !isPlan;
    $("#plan-title-input").required = isPlan;
    $("#plan-title-input").value = "";
    $("#plan-options").hidden = !isPlan;
    $("#plan-deadline-input").value = "";
    $("#plan-deadline-time-input").value = "";
    updateDeadlineButton($("#plan-deadline-button"), "", "");
    $("#plan-important-input").checked = false;
    $("#note-content").maxLength = 10_000;
    $("#note-content").required = !isPlan;
    $("#note-content").placeholder = isPlan ? "写下具体步骤、注意事项或预期结果…" : "先记下来，不用想得很完整…";
    $("#note-content").value = idea?.content || "";
    $("#save-note").textContent = idea ? "保存" : "添加";
    $("#editor-error").hidden = true;
    editor.showModal();
    $(isPlan ? "#plan-title-input" : "#note-content").focus();
  }
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "plans" : event.key === "End" ? "ideas" : activeTab === "plans" ? "ideas" : "plans";
      selectTab(next);
      $(`#tab-${next}`).focus();
    });
  }
  $("#back-to-plans").addEventListener("click", backToPlans);
  $("#detail-important").addEventListener("click", async () => {
    const draft = readDraftFields();
    if (draft) { draft.important = !draft.important; styleImportance($("#detail-important"), draft); }
    else { const plan = currentPlan(); if (plan) await mutate(() => source.updatePlan(plan.id, { important: !plan.important })); }
  });
  $("#detail-deadline").addEventListener("click", async () => {
    const plan = currentPlan();
    if (!plan) return;
    const draft = readDraftFields();
    const result = await deadlinePicker.pick(draft || plan);
    if (!result) return;
    if (draft) {
      if (planDrafts.get(plan.id) !== draft) return;
      Object.assign(draft, result);
      if (selectedPlanId === plan.id) updatePanels();
    } else await mutate(() => source.updatePlan(plan.id, result), () => announce(result.deadline ? "截止时间已更新" : "已取消截止时间"));
  });
  $("#plan-deadline-button").addEventListener("click", async () => {
    const result = await deadlinePicker.pick({ deadline: $("#plan-deadline-input").value, deadlineTime: $("#plan-deadline-time-input").value });
    if (!result) return;
    $("#plan-deadline-input").value = result.deadline;
    $("#plan-deadline-time-input").value = result.deadlineTime;
    updateDeadlineButton($("#plan-deadline-button"), result.deadline, result.deadlineTime);
  });
  $("#add-note").addEventListener("click", () => openEditor());
  $("#edit-plan").addEventListener("click", beginPlanEdit);
  $("#cancel-plan-edit").addEventListener("click", cancelPlanEdit);
  $("#save-plan-edit").addEventListener("click", savePlanEdit);
  for (const input of [$("#detail-title-input"), $("#detail-content-input")]) input.addEventListener("input", () => {
    if (input.id === "detail-title-input" && /[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, " ");
    readDraftFields();
    clearEditError();
  });
  $("#detail-title-input").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); $("#detail-content-input").focus(); }
  });
  $("#cancel-note").addEventListener("click", () => editor.close());
  $("#note-form").addEventListener("submit", async event => {
    event.preventDefault();
    const value = editorKind === "plans" ? { title: $("#plan-title-input").value, detail: $("#note-content").value,
      deadline: $("#plan-deadline-input").value, deadlineTime: $("#plan-deadline-time-input").value,
      important: $("#plan-important-input").checked } : $("#note-content").value;
    const saved = await mutate(() => editingIdea ? source.updateIdea(editingIdea.id, value, editingIdea.revision)
      : source.add(editorKind, value), () => editor.close());
    if (!saved) {
      $("#editor-error").textContent = $("#notebook-error").textContent || "保存失败，请检查填写内容后重试。";
      $("#editor-error").hidden = false;
      return;
    }
    $(`#${activeTab}-panel`).scrollTop = 0;
    announce(editorKind === "plans" ? "计划已保存" : "灵感已保存");
  });
  async function hideNotebook() {
    readDraftFields();
    try { await window.companion?.hideNotebook?.(); }
    catch { $("#notebook-error").textContent = "无法保存窗口状态，请稍后重试。"; $("#notebook-error").hidden = false; }
  }
  $("#close-board").addEventListener("click", hideNotebook);
  document.addEventListener("keydown", event => {
    if (notebookCollapsed) return;
    if (busy || event.isComposing || event.key !== "Escape" || editor.open || deleteDialog.open || deadlinePicker.isOpen()) return;
    if (currentDraft()) { event.preventDefault(); cancelPlanEdit(); return; }
    if (selectedPlanId || archiveView) { event.preventDefault(); backToPlans(); }
    else hideNotebook();
  });
  $("#view-archive").addEventListener("click", () => { archiveView = true; render(); $("#plans-panel").scrollTop = 0; });
  function batchFeedback(result, action) {
    if (result.failed.length) {
      $("#notebook-error").textContent = `${action} ${result.ids.length} 项，${result.failed.length} 项未成功：${result.failed[0].message}`;
      $("#notebook-error").hidden = false;
    }
  }
  $("#archive-completed").addEventListener("click", async () => {
    const ids = source.getSnapshot().plans.filter(plan => plan.done && !plan.archivedAt).map(plan => plan.id);
    if (ids.some(id => planDrafts.has(id))) {
      $("#notebook-error").textContent = "已完成的计划还有未保存的编辑，请先保存或取消再归档。";
      $("#notebook-error").hidden = false; return;
    }
    if (!ids.length) return;
    await mutate(() => source.archive(ids), result => {
      batchFeedback(result, "已归档");
      if (result.ids.length) announce(`已归档 ${result.ids.length} 项`, async () => {
        await mutate(() => source.restore(result.ids, result.batchId), restored => {
          batchFeedback(restored, "已移回"); announce(`已移回 ${restored.ids.length} 项`);
        });
      });
    });
  });
  $("#restore-plan").addEventListener("click", async () => {
    const id = selectedPlanId;
    await mutate(() => source.restore([id]), result => {
      batchFeedback(result, "已移回");
      if (result.ids.includes(id)) { archiveView = false; announce("已移回计划列表，保留完成状态"); }
    });
  });
  $("#delete-plan").addEventListener("click", () => { $("#delete-plan-name").textContent = currentPlan().title; $("#delete-error").hidden = true; deleteDialog.showModal(); });
  $("#cancel-delete").addEventListener("click", () => deleteDialog.close());
  $("#confirm-delete").addEventListener("click", async () => {
    const id = selectedPlanId;
    const removed = await mutate(() => source.remove(id), () => { deleteDialog.close(); planDrafts.delete(id); selectedPlanId = null; announce("归档计划已删除"); });
    if (!removed) { $("#delete-error").textContent = $("#notebook-error").textContent; $("#delete-error").hidden = false; }
  });
  render();
  window.companion?.onNotebookChanged?.(() => void refreshExternal());
}

let startupControls;
async function startNotebook() {
  const controls = startupControls ??= [...document.querySelectorAll(".notebook button,.notebook input,.notebook textarea")].filter(control => !control.disabled && control !== collapseButton);
  controls.forEach(control => { control.disabled = true; });
  const error = document.querySelector("#notebook-error"), retry = document.querySelector("#retry-notebook");
  error.hidden = true; retry.hidden = true;
  try {
    if (!window.companion?.getNotebook) throw new Error("请从 Agent Pet 打开记事板，以访问本地存档。");
    const source = createNotebookSource(window.companion);
    await source.load();
    document.querySelector("#close-board").onclick = null;
    controls.forEach(control => { control.disabled = false; });
    document.querySelector("#notebook-storage-status").textContent = "保存在本机";
    mountNotebook(source);
  } catch (failure) {
    markOrbUnavailable();
    error.textContent = failure.message; error.hidden = false;
    retry.hidden = false; retry.disabled = false; retry.onclick = startNotebook;
    document.querySelector("#close-board").disabled = false;
    document.querySelector("#close-board").onclick = () => window.companion?.hideNotebook?.();
    document.querySelector("#notebook-storage-status").textContent = "读取失败，未加载任何示例内容";
  }
}
startNotebook();
