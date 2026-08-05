import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteRequest,
  isRemoteRequestTask,
  parseRemoteRequest,
  REMOTE_REQUEST_ORIGIN,
} from "../src/remote-request.mjs";

test("builds a channel-neutral remote request envelope and extracts the user request", () => {
  const wrapped = buildRemoteRequest("继续检查连接\n并修复问题");
  const parsed = parseRemoteRequest(wrapped);

  assert.doesNotMatch(wrapped, /微信|QQ|飞书/);
  assert.deepEqual(parsed, {
    origin: REMOTE_REQUEST_ORIGIN,
    request: "继续检查连接\n并修复问题",
  });
  assert.equal(isRemoteRequestTask({ question: wrapped }), true);
});

test("recognizes the legacy Weixin envelope", () => {
  const legacy = [
    "这是从 Agent Pet 已绑定微信的远程入口提交的用户请求。",
    "仅在当前授权项目中工作，不得绕过权限审批，不得自行扩大任务范围。",
    "",
    "用户请求：",
    "收到",
  ].join("\n");

  assert.equal(parseRemoteRequest(legacy)?.request, "收到");
});
