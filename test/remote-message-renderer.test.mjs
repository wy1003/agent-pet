import test from "node:test";
import assert from "node:assert/strict";
import { renderRemoteMessage } from "../desktop/remote-message-renderer.mjs";

const task = {
  projectName: "Agent Pet",
  title: "接入微信远程通知",
  latestResponse: "已经完成扫码、绑定与消息发送链路。",
};

test("remote messages respect brief, standard and detailed levels", () => {
  assert.equal(renderRemoteMessage(task, "completed", "brief"), "任务已完成");
  assert.equal(
    renderRemoteMessage(task, "completed", "standard"),
    "Agent Pet · 任务已完成\n项目：Agent Pet\n任务：接入微信远程通知",
  );
  assert.match(renderRemoteMessage(task, "completed", "detailed"), /结果：已经完成扫码/);
});

test("remote messages clean whitespace and tolerate missing task fields", () => {
  assert.equal(renderRemoteMessage({}, "failed", "standard"), "Agent Pet · 任务执行失败");
  assert.doesNotMatch(
    renderRemoteMessage({ title: "很多   空格\n和换行" }, "unknown", "standard"),
    /\n和换行/,
  );
});
