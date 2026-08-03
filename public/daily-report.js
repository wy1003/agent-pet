const reportCard = document.querySelector("#report-card");
const reportLoading = document.querySelector("#report-loading");
const reportLoadingLabel = document.querySelector("#report-loading-label");
const reportEmpty = document.querySelector("#report-empty");
const reportOutput = document.querySelector("#report-output");
const reportMeta = document.querySelector("#report-meta");
const reportStatus = document.querySelector("#report-status");
const detailButtons = [...document.querySelectorAll("[data-report-level]")];
const updateButton = document.querySelector("#update-report");
const copyButton = document.querySelector("#copy-report");
const EMPTY_MESSAGE = "今天还没有可总结的已完成工作。";
const LEVELS = ["brief", "standard", "detailed"];
const LEVEL_LABELS = { brief: "简要", standard: "标准", detailed: "完整" };

let selectedLevel = "standard";
let levelWasSelectedByUser = false;
let reportResult = null;
let variants = { brief: "", standard: "", detailed: "" };
let editedLevels = new Set();
let isBusy = false;
let feedbackTimer = null;

function validLevel(value) {
  return LEVELS.includes(value) ? value : "standard";
}

function setFeedback(message = "", state = "") {
  clearTimeout(feedbackTimer);
  feedbackTimer = null;
  reportStatus.textContent = message;
  reportStatus.dataset.state = state;
}

function currentReportText() {
  return String(variants[selectedLevel] || "");
}

function rememberVisibleEdit() {
  if (reportOutput.hidden || !reportResult) return;
  variants[selectedLevel] = reportOutput.value;
}

function setLevel(level, { persist = false } = {}) {
  rememberVisibleEdit();
  selectedLevel = validLevel(level);
  for (const button of detailButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.reportLevel === selectedLevel));
  }
  if (reportResult && !reportOutput.hidden) reportOutput.value = currentReportText();
  copyButton.disabled = !reportResult || !currentReportText().trim();
  if (!persist) return;
  levelWasSelectedByUser = true;
  window.companion.updateSettings({ dailyReport: { contentLevel: selectedLevel } })
    .catch((error) => console.warn("Daily report level could not be saved", error));
}

function setDetailButtonsDisabled(disabled) {
  for (const button of detailButtons) button.disabled = disabled;
}

function setInitialLoading(message = "正在读取今日工作日报") {
  isBusy = true;
  reportCard.setAttribute("aria-busy", "true");
  reportLoading.hidden = false;
  reportLoadingLabel.textContent = message;
  reportEmpty.hidden = true;
  reportOutput.hidden = true;
  reportEmpty.textContent = EMPTY_MESSAGE;
  reportMeta.textContent = "";
  setFeedback();
  setDetailButtonsDisabled(true);
  updateButton.disabled = true;
  updateButton.textContent = "更新日报";
  copyButton.disabled = true;
}

function finishBusyState() {
  isBusy = false;
  reportCard.setAttribute("aria-busy", "false");
  setDetailButtonsDisabled(!reportResult);
  updateButton.disabled = false;
  updateButton.textContent = "更新日报";
  copyButton.textContent = "复制日报";
  copyButton.disabled = !reportResult || !currentReportText().trim();
}

function generatedTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function normalizeVariants(result) {
  const supplied = result?.variants || {};
  const fallback = String(result?.markdown || "");
  const standard = String(supplied.standard || fallback);
  return {
    brief: String(supplied.brief || standard),
    standard,
    detailed: String(supplied.detailed || standard),
  };
}

function reportMetadata(result) {
  const source = result.source === "codex" ? "Codex 整理" : "本地整理";
  const cacheState = result.fromCache ? "已保存" : "刚刚更新";
  const taskCount = Math.max(0, Number(result.taskCount) || 0);
  const currentTaskCount = Math.max(taskCount, Number(result.currentTaskCount) || 0);
  const count = result.stale && currentTaskCount > taskCount
    ? `已汇总 ${taskCount} 项，当前 ${currentTaskCount} 项`
    : `${taskCount} 项`;
  const time = generatedTime(result.generatedAt);
  return [result.dateLabel, count, source, cacheState, time ? `${time} 生成` : ""]
    .filter(Boolean)
    .join(" · ");
}

function restoreReportFeedback() {
  if (!reportResult) return;
  const messages = [];
  if (reportResult.stale) messages.push("检测到新的已完成工作，点击“更新日报”即可纳入。");
  if (reportResult.warning) messages.push(reportResult.warning);
  setFeedback(messages.join(" "), reportResult.warning ? "warning" : reportResult.stale ? "info" : "");
}

function showEmpty(result) {
  reportResult = null;
  variants = { brief: "", standard: "", detailed: "" };
  editedLevels.clear();
  reportLoading.hidden = true;
  reportEmpty.hidden = false;
  reportOutput.hidden = true;
  reportEmpty.textContent = EMPTY_MESSAGE;
  const currentTaskCount = Math.max(0, Number(result?.currentTaskCount) || 0);
  reportMeta.textContent = result?.dateLabel
    ? `${result.dateLabel} · ${currentTaskCount} 项可汇总工作`
    : "";
  setFeedback();
  finishBusyState();
}

function showError({ keepReport = false } = {}) {
  if (keepReport && reportResult) {
    finishBusyState();
    setFeedback("更新失败，仍在显示上一次生成的日报。请稍后重试。", "error");
    return;
  }
  reportResult = null;
  reportLoading.hidden = true;
  reportEmpty.hidden = false;
  reportEmpty.textContent = "日报生成失败，请稍后重试。";
  reportOutput.hidden = true;
  reportMeta.textContent = "";
  finishBusyState();
  setFeedback("请检查 Codex 是否可用，然后点击“更新日报”。", "error");
}

function showReport(result) {
  reportResult = result;
  reportCard.dataset.fromCache = String(Boolean(result.fromCache));
  variants = normalizeVariants(result);
  editedLevels.clear();
  reportLoading.hidden = true;
  reportEmpty.hidden = true;
  reportOutput.hidden = false;
  reportOutput.value = currentReportText();
  reportMeta.textContent = reportMetadata(result);
  finishBusyState();
  restoreReportFeedback();
}

async function loadInitialReport() {
  setInitialLoading();
  try {
    const result = await window.companion.getDailyReport();
    if (result.status === "empty") showEmpty(result);
    else showReport(result);
  } catch (error) {
    console.error("Daily report loading failed", error);
    showError();
  }
}

async function updateReport() {
  if (isBusy) return;
  if (editedLevels.size && !window.confirm("更新日报会替换当前手动修改的内容，是否继续？")) return;
  const keepReport = Boolean(reportResult);
  isBusy = true;
  reportCard.setAttribute("aria-busy", "true");
  updateButton.disabled = true;
  updateButton.textContent = "更新中…";
  copyButton.textContent = "复制日报";
  setDetailButtonsDisabled(true);
  if (keepReport) {
    setFeedback("正在更新日报，当前内容仍可复制。", "info");
  } else {
    setInitialLoading("正在生成今日工作日报");
    updateButton.textContent = "更新中…";
  }
  try {
    const result = await window.companion.updateDailyReport();
    if (result.status === "empty") showEmpty(result);
    else showReport(result);
  } catch (error) {
    console.error("Daily report update failed", error);
    showError({ keepReport });
  }
}

for (const button of detailButtons) {
  button.addEventListener("click", () => setLevel(button.dataset.reportLevel, { persist: true }));
}

reportOutput.addEventListener("input", () => {
  variants[selectedLevel] = reportOutput.value;
  editedLevels.add(selectedLevel);
  copyButton.disabled = !reportOutput.value.trim();
});

updateButton.addEventListener("click", updateReport);
copyButton.addEventListener("click", async () => {
  const text = reportOutput.value.trim();
  if (!text) return;
  try {
    await window.companion.copyText(text);
    copyButton.textContent = "已复制";
    setFeedback(`“${LEVEL_LABELS[selectedLevel]}”日报已复制到剪贴板。`, "success");
    feedbackTimer = setTimeout(() => {
      copyButton.textContent = "复制日报";
      restoreReportFeedback();
    }, 1_500);
  } catch (error) {
    console.error("Daily report copy failed", error);
    setFeedback("复制失败，请重试。", "error");
  }
});

async function initialize() {
  const settingsPromise = window.companion.getSettings()
    .then((state) => state?.preferences?.dailyReport?.contentLevel)
    .catch((error) => {
      console.warn("Daily report settings could not be read", error);
      return null;
    });
  const [savedLevel] = await Promise.all([settingsPromise, loadInitialReport()]);
  if (!levelWasSelectedByUser && LEVELS.includes(savedLevel)) setLevel(savedLevel);
}

initialize();
