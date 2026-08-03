import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  completedTasksForLocalDay,
  DAILY_REPORT_SCHEMA,
  DailyReportGenerator,
  fallbackDailyReport,
  fallbackDailyReportVariants,
  formatDailyReport,
} from "../desktop/daily-report.mjs";

function completedTask(overrides = {}) {
  return {
    taskId: "task-1",
    sessionId: "session-1",
    turnId: "turn-1",
    threadSource: "user",
    projectName: "Agent Pet",
    sourceLabel: "Codex Desktop",
    question: "修复托盘图标",
    latestResponse: "已改用透明 PNG，并通过测试。",
    status: "completed",
    completedAt: new Date(2026, 7, 3, 10, 30).toISOString(),
    ...overrides,
  };
}

function generatedVariants(label = "") {
  return {
    variants: {
      brief: {
        overview: `完成核心优化${label}。`,
        projects: [{ name: "Agent Pet", items: [`修复托盘图标${label}`] }],
      },
      standard: {
        overview: `完成桌面应用体验优化${label}。`,
        projects: [{ name: "Agent Pet", items: [`修复 Windows 托盘图标显示问题${label}`] }],
      },
      detailed: {
        overview: `完成桌面应用体验优化并验证结果${label}。`,
        projects: [{
          name: "Agent Pet",
          items: [`修复 Windows 托盘图标显示问题，并通过自动化测试${label}`],
        }],
      },
    },
  };
}

test("daily report selects only today's completed top-level tasks", () => {
  const now = new Date(2026, 7, 3, 18, 0);
  const selected = completedTasksForLocalDay([
    completedTask(),
    completedTask({ taskId: "running", status: "running" }),
    completedTask({ taskId: "yesterday", completedAt: new Date(2026, 7, 2, 23, 59).toISOString() }),
    completedTask({ taskId: "subagent", threadSource: "subagent" }),
    completedTask({ taskId: "missing-time", completedAt: "", lastActivityAt: new Date(2026, 7, 3, 12).toISOString() }),
    completedTask({ taskId: "internal", projectName: "AgentPetCopywriter" }),
    completedTask(),
  ], now);

  assert.deepEqual(selected.map((task) => task.taskId), ["task-1"]);
});

test("local fallback groups completed work by project", () => {
  const now = new Date(2026, 7, 3, 18, 0);
  const report = fallbackDailyReport([
    completedTask(),
    completedTask({ taskId: "task-2", projectName: "文档项目", question: "整理交接文档" }),
  ]);
  const markdown = formatDailyReport(report, now);

  assert.match(markdown, /2026年8月3日 工作日报/);
  assert.match(markdown, /## Agent Pet/);
  assert.match(markdown, /修复托盘图标/);
  assert.match(markdown, /## 文档项目/);
});

test("Codex generator returns a structured editable daily report", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-daily-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let threadOptions;
  let runOptions;
  let prompt;
  const generator = new DailyReportGenerator({
    workingDirectory: root,
    cacheDirectory: path.join(root, "cache"),
    createCodex: () => ({
      startThread(options) {
        threadOptions = options;
        return {
          async run(value, options) {
            prompt = value;
            runOptions = options;
            return {
              finalResponse: JSON.stringify(generatedVariants()),
            };
          },
        };
      },
    }),
  });

  const result = await generator.generate([completedTask()], {
    now: new Date(2026, 7, 3, 18, 0),
  });

  assert.equal(result.status, "ready");
  assert.equal(result.source, "codex");
  assert.equal(result.taskCount, 1);
  assert.equal(result.currentTaskCount, 1);
  assert.equal(result.fromCache, false);
  assert.equal(result.stale, false);
  assert.match(result.markdown, /完成桌面应用体验优化/);
  assert.equal(result.markdown, result.variants.standard);
  assert.match(result.variants.brief, /完成核心优化/);
  assert.match(result.variants.detailed, /自动化测试/);
  assert.match(prompt, /brief、standard、detailed/);
  assert.equal(threadOptions.sandboxMode, "read-only");
  assert.equal(threadOptions.approvalPolicy, "never");
  assert.equal(runOptions.outputSchema, DAILY_REPORT_SCHEMA);
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
  await generator.stop();
});

test("daily report uses local output when Codex is unavailable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-daily-report-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generator = new DailyReportGenerator({
    workingDirectory: root,
    cacheDirectory: path.join(root, "cache"),
    createCodex: () => ({ startThread: () => ({ run: async () => { throw new Error("offline"); } }) }),
    logger: { warn() {} },
  });

  const result = await generator.generate([completedTask()], {
    now: new Date(2026, 7, 3, 18, 0),
  });

  assert.equal(result.status, "ready");
  assert.equal(result.source, "local");
  assert.match(result.warning, /本地整理/);
  assert.match(result.markdown, /修复托盘图标/);
  assert.match(result.variants.brief, /今日完成/);
  assert.match(result.variants.standard, /已改用透明 PNG/);
  assert.match(result.variants.detailed, /具体产出与结果/);
  await generator.stop();
});

test("daily report returns an empty state without calling Codex", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-daily-report-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generator = new DailyReportGenerator({
    workingDirectory: root,
    cacheDirectory: path.join(root, "cache"),
    createCodex: () => { throw new Error("must not be called"); },
  });

  const result = await generator.generate([], { now: new Date(2026, 7, 3, 18, 0) });
  assert.equal(result.status, "empty");
  assert.equal(result.taskCount, 0);
  assert.equal(result.currentTaskCount, 0);
  assert.deepEqual(result.variants, { brief: "", standard: "", detailed: "" });
  assert.equal(result.markdown, "");
  assert.equal(result.fromCache, false);
  assert.equal(result.stale, false);
  await generator.stop();
});

test("daily report cache is reused for the local day, reports task drift, and force refreshes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-daily-report-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDirectory = path.join(root, "cache");
  const now = new Date(2026, 7, 3, 18, 0);
  let codexCalls = 0;
  const generator = new DailyReportGenerator({
    workingDirectory: path.join(root, "working"),
    cacheDirectory,
    createCodex: () => ({
      startThread: () => ({
        run: async () => {
          codexCalls += 1;
          return { finalResponse: JSON.stringify(generatedVariants(`-${codexCalls}`)) };
        },
      }),
    }),
  });

  const first = await generator.generate([completedTask()], { now });
  assert.equal(codexCalls, 1);
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(first.taskCount, 1);

  const changedTasks = [
    completedTask(),
    completedTask({ taskId: "task-2", question: "补充缓存测试" }),
  ];
  const cached = await generator.generate(changedTasks, { now });
  assert.equal(codexCalls, 1);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, true);
  assert.equal(cached.taskCount, 1);
  assert.equal(cached.currentTaskCount, 2);
  assert.equal(cached.generatedAt, first.generatedAt);
  assert.match(cached.variants.standard, /-1/);

  const refreshed = await generator.generate(changedTasks, { now, force: true });
  assert.equal(codexCalls, 2);
  assert.equal(refreshed.fromCache, false);
  assert.equal(refreshed.stale, false);
  assert.equal(refreshed.taskCount, 2);
  assert.equal(refreshed.currentTaskCount, 2);
  assert.match(refreshed.variants.standard, /-2/);

  const freshCache = await generator.generate(changedTasks, { now });
  assert.equal(codexCalls, 2);
  assert.equal(freshCache.fromCache, true);
  assert.equal(freshCache.stale, false);
  assert.equal(freshCache.markdown, freshCache.variants.standard);

  const cacheFiles = await readdir(cacheDirectory);
  assert.deepEqual(cacheFiles, ["2026-08-03.json"]);
  const stored = JSON.parse(await readFile(path.join(cacheDirectory, cacheFiles[0]), "utf8"));
  assert.equal(stored.dateKey, "2026-08-03");
  assert.equal(stored.taskCount, 2);
  assert.deepEqual(Object.keys(stored.variants), ["brief", "standard", "detailed"]);
  assert.match(stored.taskFingerprint, /^[a-f0-9]{64}$/);
  await generator.stop();

  const restored = new DailyReportGenerator({
    workingDirectory: path.join(root, "working-restored"),
    cacheDirectory,
    createCodex: () => { throw new Error("cache should survive generator restart"); },
  });
  const afterRestart = await restored.generate(changedTasks, { now });
  assert.equal(afterRestart.fromCache, true);
  assert.equal(afterRestart.stale, false);
  assert.match(afterRestart.variants.standard, /-2/);
  const emptied = await restored.generate([], { now, force: true });
  assert.equal(emptied.status, "empty");
  assert.deepEqual(await readdir(cacheDirectory), []);
  await restored.stop();
});

test("fallback report variants provide brief, standard, and detailed content", () => {
  const variants = fallbackDailyReportVariants([completedTask()]);
  assert.deepEqual(Object.keys(variants), ["brief", "standard", "detailed"]);
  assert.doesNotMatch(variants.brief.projects[0].items[0], /透明 PNG/);
  assert.match(variants.standard.projects[0].items[0], /透明 PNG/);
  assert.match(variants.detailed.overview, /具体产出与结果/);
});
