import test from "node:test";
import assert from "node:assert/strict";
import { parseEventBlock } from "../desktop/task-event-client.mjs";

test("task event client parses named SSE events and multiline JSON data", () => {
  const message = parseEventBlock([
    "event: task.updated",
    "data: {\"taskId\":\"task-1\",",
    "data: \"status\":\"completed\"}",
  ].join("\r\n"));
  assert.deepEqual(message, {
    event: "task.updated",
    data: { taskId: "task-1", status: "completed" },
  });
});
