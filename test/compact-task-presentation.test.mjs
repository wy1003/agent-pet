import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompactTaskPresentation,
  collapsedSessionTasks,
  compactTaskState,
  extractLeadingFileContext,
  normalizeCompactText,
} from "../public/compact-task-presentation.mjs";

test("compact presentation normalizes whitespace and separates a leading file", () => {
  const presentation = buildCompactTaskPresentation({
    status: "running",
    phase: "tool_running",
    question: "CODEX_PET_IMPLEMENTATION_GUIDE.md\n看一下这个文档，准备进行实现",
    latestResponse: "正在读取文档并梳理实现步骤。",
  });

  assert.equal(presentation.context, "CODEX_PET_IMPLEMENTATION_GUIDE.md");
  assert.equal(presentation.title, "看一下这个文档，准备进行实现");
  assert.equal(presentation.state, "正在使用工具");
  assert.equal(presentation.preview, "正在读取文档并梳理实现步骤。");
});

test("leading file extraction keeps only basenames and supports multiple files", () => {
  assert.deepEqual(
    extractLeadingFileContext("C:\\work\\交接文档.md：请先阅读"),
    {
      files: ["交接文档.md"],
      context: "交接文档.md",
      remainder: "请先阅读",
    },
  );
  assert.deepEqual(
    extractLeadingFileContext("`first.md`，second.js：请一起修改"),
    {
      files: ["first.md", "second.js"],
      context: "first.md +1",
      remainder: "请一起修改",
    },
  );
});

test("file extraction does not strip paths mentioned inside normal requests", () => {
  const request = "请修改 public/app.js，并保留原来的行为";
  assert.deepEqual(extractLeadingFileContext(request), {
    files: [],
    context: "",
    remainder: request,
  });
  assert.deepEqual(extractLeadingFileContext("查看 https://example.com/readme.md"), {
    files: [],
    context: "",
    remainder: "查看 https://example.com/readme.md",
  });
});

test("file-only tasks keep a useful title and terminal status is never hidden", () => {
  const presentation = buildCompactTaskPresentation({
    status: "failed",
    question: "voice-model.ckpt",
    errorMessage: "模型文件无法读取",
  });

  assert.equal(presentation.title, "查看 voice-model.ckpt");
  assert.equal(presentation.state, "失败");
  assert.equal(presentation.preview, "模型文件无法读取");
  assert.equal(compactTaskState({ status: "needs_input", phase: "waiting_approval" }), "需要批准");
  assert.equal(normalizeCompactText("  一段\n\n 文本  "), "一段 文本");
});

test("collapsed sessions keep every active and queued task visible", () => {
  const tasks = [
    { taskId: "queued", status: "queued" },
    { taskId: "running", status: "running" },
    { taskId: "completed-new", status: "completed" },
    { taskId: "completed-old", status: "completed" },
  ];

  assert.deepEqual(
    collapsedSessionTasks(tasks).map((task) => task.taskId),
    ["queued", "running"],
  );
  assert.deepEqual(
    collapsedSessionTasks(tasks.slice(2)).map((task) => task.taskId),
    ["completed-new"],
  );
});
