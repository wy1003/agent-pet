import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRemoteRoute,
  parseRemoteCommand,
} from "../desktop/remote-command-parser.mjs";

test("remote command parser resolves explicit and referenced routes", () => {
  assert.deepEqual(extractRemoteRoute("编号：P1/S22"), {
    projectCode: "P001",
    sessionCode: "S0022",
    matchedText: "P1/S22",
  });
  assert.deepEqual(extractRemoteRoute("会话指令：/S22"), {
    projectCode: "",
    sessionCode: "S0022",
    matchedText: "/S22",
  });
  assert.deepEqual(parseRemoteCommand({ text: "/S0007 继续：把测试补上" }), {
    action: "continue",
    projectCode: "",
    sessionCode: "S0007",
    prompt: "把测试补上",
    routeSource: "explicit",
  });
  assert.deepEqual(parseRemoteCommand({
    text: "再检查一下错误处理",
    referenceText: "Agent Pet · 任务已完成\n编号：P002/S0012",
  }), {
    action: "continue",
    projectCode: "P002",
    sessionCode: "S0012",
    prompt: "再检查一下错误处理",
    routeSource: "reference",
  });
});

test("remote command parser normalizes legacy C session routes to S", () => {
  assert.deepEqual(extractRemoteRoute("旧通知：P1/C22"), {
    projectCode: "P001",
    sessionCode: "S0022",
    matchedText: "P1/C22",
  });
  assert.deepEqual(parseRemoteCommand({ text: "/C7 继续旧会话" }), {
    action: "continue",
    projectCode: "",
    sessionCode: "S0007",
    prompt: "旧会话",
    routeSource: "explicit",
  });
});

test("remote command parser supports slash new, status, stop and unscoped input", () => {
  assert.deepEqual(parseRemoteCommand({ text: "/P003 新任务：检查发布流程" }), {
    action: "new",
    projectCode: "P003",
    sessionCode: "",
    prompt: "检查发布流程",
    routeSource: "explicit",
  });
  assert.equal(parseRemoteCommand({ text: "/S2 状态" }).action, "status");
  assert.equal(parseRemoteCommand({ text: "/S2 停止任务" }).action, "stop");
  assert.equal(parseRemoteCommand({ text: "/S2 重试" }).action, "retry");
  assert.deepEqual(
    parseRemoteCommand({ text: "/S2 状态页面需要优化" }),
    {
      action: "continue",
      projectCode: "",
      sessionCode: "S0002",
      prompt: "状态页面需要优化",
      routeSource: "explicit",
    },
  );
  assert.equal(parseRemoteCommand({ text: "/S2 停止按钮样式有问题" }).action, "continue");
  assert.equal(parseRemoteCommand({ text: "/S2" }).prompt, "");
  assert.equal(parseRemoteCommand({ text: "/S2 /S3 修复页面" }).reason, "multiple_routes");
  assert.equal(parseRemoteCommand({ text: "P1/S2 继续处理" }).action, "continue");
  assert.equal(parseRemoteCommand({ text: "帮我检查一下" }).action, "unscoped");
});

test("remote command parser accepts any channel-neutral envelope shape", () => {
  const command = parseRemoteCommand({
    text: "继续优化设置页",
    reference: {
      messageId: "outbound-1",
      text: "Agent Pet · 任务完成\n编号：P001/S0009",
    },
  });
  assert.equal(command.action, "continue");
  assert.equal(command.projectCode, "P001");
  assert.equal(command.sessionCode, "S0009");
});

test("remote command parser recognizes the channel-neutral catalog commands", () => {
  assert.deepEqual(parseRemoteCommand({ text: "/help" }), {
    action: "help",
    projectCode: "",
    sessionCode: "",
    prompt: "",
    routeSource: "command",
  });
  assert.equal(parseRemoteCommand({ text: "/项目" }).action, "projects");
  assert.equal(parseRemoteCommand({ text: "/sessions" }).action, "sessions");
  assert.equal(parseRemoteCommand({ text: "/会话 /P1" }).projectCode, "P001");
});
