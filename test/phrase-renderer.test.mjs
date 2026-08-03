import test from "node:test";
import assert from "node:assert/strict";
import { PhraseComposer, renderPhrase } from "../desktop/phrase-renderer.mjs";

test("phrase renderer removes unset personal placeholders without awkward punctuation", () => {
  const text = renderPhrase(
    "{称呼}，累坏{助手自称}了，{项目名}的任务完成啦。",
    { projectName: "示例项目", title: "构建设置页" },
    { addressee: "", assistantName: "", includeProjectName: true },
    "standard",
    "completed",
  );
  assert.equal(text, "累坏了，示例项目的任务完成啦。");
});

test("phrase composer avoids immediately repeating a phrase", () => {
  const composer = new PhraseComposer({ random: () => 0 });
  const pool = { completed: ["第一句。", "第二句。"] };
  const preferences = {
    notifications: { voice: { style: {}, contentLevel: "brief" } },
  };
  assert.equal(composer.compose(pool, "completed", {}, preferences), "第一句。");
  assert.equal(composer.compose(pool, "completed", {}, preferences), "第二句。");
});
