import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotificationHistoryStore } from "../desktop/notification-history.mjs";

test("notification history is retained by month and returns only the latest snapshot per record", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notification-history-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new NotificationHistoryStore(root);

  await store.append({
    id: "notice-old",
    createdAt: "2026-07-31T10:00:00.000Z",
    updatedAt: "2026-07-31T10:00:00.000Z",
    taskTitle: "旧任务",
    result: "success",
  });
  await store.append({
    id: "notice-new",
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    taskTitle: "新任务",
    result: "pending",
    voice: "queued",
  });
  await store.append({
    id: "notice-new",
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:02.000Z",
    taskTitle: "新任务",
    result: "success",
    voice: "played",
    remote: "sent",
    remoteProvider: "weixin",
    remoteAttempts: 2,
  });

  assert.deepEqual((await readdir(root)).sort(), ["2026-07.jsonl", "2026-08.jsonl"]);
  const records = await store.list({ limit: 100 });
  assert.equal(records.length, 2);
  assert.equal(records[0].id, "notice-new");
  assert.equal(records[0].voice, "played");
  assert.equal(records[0].remote, "sent");
  assert.equal(records[0].remoteProvider, "weixin");
  assert.equal(records[0].remoteAttempts, 2);
  assert.equal(records[1].id, "notice-old");
});

test("notification history is removed only through explicit clear", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notification-history-clear-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new NotificationHistoryStore(root);
  await store.append({ id: "notice-1", result: "success" });
  assert.equal((await store.list()).length, 1);
  await store.clear();
  assert.equal((await store.list()).length, 0);
});
