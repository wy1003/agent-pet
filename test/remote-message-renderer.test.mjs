import test from "node:test";
import assert from "node:assert/strict";
import {
  renderRemoteMessage,
  summarizeRemoteResult,
} from "../desktop/remote-message-renderer.mjs";
import { buildRemoteRequest } from "../src/remote-request.mjs";

const task = {
  projectName: "Agent Pet",
  title: "接入微信远程通知",
  latestResponse: "已经完成扫码、绑定与消息发送链路。",
};

test("remote messages respect brief, standard and detailed levels", () => {
  assert.equal(renderRemoteMessage(task, "completed", "brief"), "Agent Pet · 任务已完成");
  assert.equal(
    renderRemoteMessage(task, "completed", "standard"),
    "Agent Pet · 任务已完成\n项目：Agent Pet\n任务：接入微信远程通知\n结果摘要：已经完成扫码、绑定与消息发送链路。",
  );
  assert.match(renderRemoteMessage(task, "completed", "detailed"), /结果摘要：已经完成扫码/);
});

test("remote messages clean whitespace and tolerate missing task fields", () => {
  assert.equal(renderRemoteMessage({}, "failed", "standard"), "Agent Pet · 任务执行失败");
  assert.doesNotMatch(
    renderRemoteMessage({ title: "很多   空格\n和换行" }, "unknown", "standard"),
    /\n和换行/,
  );
});

test("projectless chats are presented as ordinary conversations", () => {
  const text = renderRemoteMessage({
    projectName: "普通对话",
    projectKind: "projectless",
    title: "查询订阅价格",
    latestResponse: "已经完成查询。",
  }, "completed", "standard", { sessionCode: "S0003" });

  assert.match(text, /类型：普通对话/);
  assert.doesNotMatch(text, /项目：(?:普通对话|1-1)/);
  assert.match(text, /\/S0003 你的要求/);
});

test("remote messages carry stable project and session short codes at every content level", () => {
  const route = { projectCode: "P001", sessionCode: "S0007" };
  assert.equal(
    renderRemoteMessage(task, "completed", "brief", route),
    "Agent Pet · 任务已完成\n会话：/S0007",
  );
  const standard = renderRemoteMessage(task, "completed", "standard", route);
  assert.equal(
    standard,
    "Agent Pet · 任务已完成\n项目：Agent Pet\n任务：接入微信远程通知\n结果摘要：已经完成扫码、绑定与消息发送链路。\n\n继续处理此任务：\n/S0007 你的要求",
  );
  assert.equal((standard.match(/\/S0007/g) || []).length, 1);
  assert.doesNotMatch(standard, /会话指令|继续此会话/);
});

test("remote content never exposes the internal remote request envelope", () => {
  const wrapped = buildRemoteRequest("只回复收到");
  const text = renderRemoteMessage({
    projectName: "Agent Pet",
    title: wrapped,
    question: wrapped,
    latestResponse: "收到。",
  }, "completed", "standard", { sessionCode: "S0051" });

  assert.match(text, /任务：只回复收到/);
  assert.doesNotMatch(text, /远程入口提交|不得绕过权限审批|用户请求：/);
});

test("remote result summaries remove heavy formatting and stay phone-sized", () => {
  const summary = summarizeRemoteResult(`## 已完成\n\n- **服务**已经重启。\n- [健康检查](https://example.com)已经通过。\n\n\`\`\`text\nvery long log output\n\`\`\`\n${"后续说明".repeat(80)}`, 120);
  assert.match(summary, /^已完成 服务已经重启。健康检查已经通过。/);
  assert.ok(summary.length <= 121);
  assert.doesNotMatch(summary, /https:|long log|\*\*|```/);
});
