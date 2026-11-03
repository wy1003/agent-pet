import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotebookStore } from "../desktop/notebook/notebook-store.mjs";
import { createNotebookController } from "../desktop/notebook/notebook-controller.mjs";
import { createNotebookSource } from "../public/notebook-source.mjs";

const fields = (title = "完整计划") => ({ title, detail: "第一步\n第二步\n保留完整内容", important: false, deadline: "2026-11-05", deadlineTime: "18:30" });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pet-notebook-"));
  let clock = new Date("2026-11-03T10:00:00.000Z");
  const store = new NotebookStore(root, { now: () => new Date(clock), ...options });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, tick: () => { clock = new Date(clock.getTime() + 60_000); },
    add: async (value = fields()) => (await store.execute({ type: "create-plan", value })).result.id,
    plan: async id => (await store.snapshot()).plans.find(plan => plan.id === id),
    reopen: () => new NotebookStore(root) };
}

test("notebook starts empty, persists full plan and idea files, and reloads with no fake data", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.snapshot(), { plans: [], ideas: [], warnings: [] });
  const id = await f.add({ ...fields(), detail: "完整内容\n".repeat(1500) });
  await f.store.execute({ type: "create-idea", value: "第一行想法\n灵感正文" });
  const next = f.reopen();
  assert.deepEqual(await next.snapshot(), await f.store.snapshot());
  assert.equal((await f.plan(id)).detail, "完整内容\n".repeat(1500).trim());
  assert.equal((await fs.readdir(path.join(f.root, "plans"))).filter(name => name.endsWith(".json")).length, 1);
  assert.equal((await next.snapshot()).ideas[0].content, "第一行想法\n灵感正文");
});

test("completion snapshots survive edits, revocation, recompletion and process reload", async t => {
  const f = await fixture(t), id = await f.add();
  f.tick(); await f.store.execute({ type: "set-completed", id, done: true });
  let plan = await f.plan(id); const first = structuredClone(plan.completions[0]), createdAt = plan.createdAt;
  assert.equal(plan.archivedAt, "");
  f.tick(); await f.store.execute({ type: "edit-plan", id, revision: plan.revision, value: { title: "新的标题", detail: "新的正文", deadline: "", deadlineTime: "" } });
  assert.deepEqual((await f.plan(id)).completions[0], first);
  f.tick(); await f.store.execute({ type: "set-completed", id, done: false });
  plan = await f.plan(id); assert.ok(plan.completions[0].revokedAt); assert.equal(plan.completedAt, "");
  f.tick(); await f.store.execute({ type: "set-completed", id, done: true });
  plan = (await f.reopen().snapshot()).plans[0];
  assert.equal(plan.completions.length, 2); assert.equal(plan.completions[0].snapshot.title, first.snapshot.title);
  assert.equal(plan.completions[1].snapshot.detail, "新的正文"); assert.equal(plan.createdAt, createdAt);
  assert.notEqual(plan.completedAt, first.completedAt);
  assert.equal(plan.events.filter(e => e.type === "completion_revoked").length, 1);
  const count = plan.events.length;
  await f.store.execute({ type: "set-completed", id, done: true });
  assert.equal((await f.plan(id)).events.length, count, "duplicate completion requests are idempotent");
});

test("archive is explicit, only completed plans move, undo matches batch and restore retains completion", async t => {
  const f = await fixture(t), a = await f.add(), b = await f.add(fields("未完成"));
  await f.store.execute({ type: "set-completed", id: a, done: true });
  f.tick(); const result = (await f.store.execute({ type: "archive", ids: [a, b, a] })).result;
  assert.deepEqual(result.ids, [a]); assert.equal(result.failed.length, 1);
  const completed = (await f.plan(a)).completedAt;
  assert.ok((await f.plan(a)).archivedAt); assert.equal((await f.plan(b)).archivedAt, "");
  await assert.rejects(f.store.execute({ type: "edit-plan", id: a, revision: (await f.plan(a)).revision, value: fields() }), /移回/);
  const restored = (await f.store.execute({ type: "restore", ids: [a], batchId: result.batchId })).result;
  assert.deepEqual(restored.ids, [a]); assert.equal((await f.plan(a)).completedAt, completed); assert.ok((await f.plan(a)).done);
  await f.store.execute({ type: "archive", ids: [a] });
  const stale = (await f.store.execute({ type: "restore", ids: [a], batchId: result.batchId })).result;
  assert.equal(stale.ids.length, 0); assert.equal(stale.failed.length, 1);
  assert.ok((await f.reopen().snapshot()).plans.find(p => p.id === a).archivedAt);
});

test("serialized concurrent commands keep completion history and queue recovers after a rejected request", async t => {
  const f = await fixture(t), id = await f.add();
  await Promise.all([true, false, true, false, true].map(done => f.store.execute({ type: "set-completed", id, done })));
  assert.equal((await f.plan(id)).completions.length, 3); assert.equal((await f.plan(id)).done, true);
  await assert.rejects(f.store.execute({ type: "edit-plan", id, revision: 1, value: fields("过期编辑") }), /发生变化/);
  await f.store.execute({ type: "set-completed", id, done: false });
  assert.equal((await f.plan(id)).done, false);
});

test("invalid fields, unknown commands and path-like IDs cannot alter records or write outside the store", async t => {
  const f = await fixture(t), id = await f.add(), before = await f.store.snapshot();
  for (const patch of [{ title: " " }, { detail: "x".repeat(10001) }, { deadlineTime: "24:00" }, { deadline: false }, { important: "true" }]) {
    await assert.rejects(f.store.execute({ type: "edit-plan", id, revision: 1, value: patch }));
  }
  for (const id of ["../outside", "../../outside.json", "C:\\secret", {}, null]) await assert.rejects(f.store.execute({ type: "delete-plan", id }));
  await assert.rejects(f.store.execute({ type: "archive", ids: [id, "../outside"] }));
  await assert.rejects(f.store.execute({ type: "unknown" }));
  assert.deepEqual(await f.store.snapshot(), before);
});

test("failed primary rename preserves memory and valid disk data, and a later retry succeeds", async t => {
  let fail = false;
  const io = { ...fs, rename: async (from, to) => { if (fail && to.endsWith(".json")) throw Object.assign(new Error("full"), { code: "ENOSPC" }); return fs.rename(from, to); } };
  const f = await fixture(t, { io }), id = await f.add(), before = await f.plan(id);
  fail = true;
  await assert.rejects(f.store.execute({ type: "edit-plan", id, revision: 1, value: fields("不能提前成功") }), /full/);
  assert.deepEqual(await f.plan(id), before);
  assert.deepEqual((await f.reopen().snapshot()).plans[0], before);
  assert.equal((await fs.readdir(path.join(f.root, "plans"))).some(name => name.includes(".tmp-")), false);
  fail = false;
  await f.store.execute({ type: "edit-plan", id, revision: 1, value: fields("重试成功") });
  assert.equal((await f.plan(id)).title, "重试成功");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "plans", `${id}.json.bak`), "utf8")).title, before.title);
});

test("corrupt primary recovers a valid backup with visible warning and keeps damaged original", async t => {
  const f = await fixture(t), id = await f.add();
  await f.store.execute({ type: "set-completed", id, done: true });
  await fs.writeFile(path.join(f.root, "plans", `${id}.json`), "{partial");
  const snapshot = await f.reopen().snapshot();
  assert.equal(snapshot.plans.length, 1); assert.equal(snapshot.plans[0].done, false);
  assert.match(snapshot.warnings[0], /备份恢复/);
  assert.ok((await fs.readdir(path.join(f.root, "plans"))).some(name => name.includes(".damaged-")));
  assert.equal((await f.reopen().snapshot()).plans.length, 1);
});

test("unreadable or future records stay intact; one broken plan does not discard healthy plans", async t => {
  const f = await fixture(t), broken = await f.add(), healthy = await f.add(fields("正常"));
  await fs.writeFile(path.join(f.root, "plans", `${broken}.json`), "broken");
  let snapshot = await f.reopen().snapshot();
  assert.deepEqual(snapshot.plans.map(p => p.id), [healthy]); assert.equal(snapshot.warnings.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, "plans", `${broken}.json`), "utf8"), "broken");
  await f.store.execute({ type: "set-completed", id: healthy, done: true });
  const file = path.join(f.root, "plans", `${healthy}.json`), future = { ...await f.plan(healthy), version: 99 };
  await fs.writeFile(file, JSON.stringify(future)); snapshot = await f.reopen().snapshot();
  assert.equal(snapshot.plans.length, 0); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 99);
});

test("idea conversion is idempotent and all original content survives restart", async t => {
  const f = await fixture(t);
  const idea = (await f.store.execute({ type: "create-idea", value: "x".repeat(150) + "\n完整灵感" })).result.id;
  await Promise.all([1, 2, 3].map(() => f.store.execute({ type: "convert-idea", id: idea })));
  const state = await f.reopen().snapshot();
  assert.equal(state.plans.length, 1); assert.equal(state.ideas[0].planId, state.plans[0].id);
  assert.equal(state.plans[0].detail, state.ideas[0].content); assert.equal(state.plans[0].title.length, 120);
});

test("deletion requires archive, removes current file and backup, and cannot resurrect on restart", async t => {
  const f = await fixture(t), id = await f.add();
  await assert.rejects(f.store.execute({ type: "delete-plan", id }), /归档/);
  await f.store.execute({ type: "set-completed", id, done: true });
  await f.store.execute({ type: "archive", ids: [id] });
  await f.store.execute({ type: "delete-plan", id });
  assert.equal((await f.reopen().snapshot()).plans.length, 0);
  assert.equal((await fs.readdir(path.join(f.root, "plans"))).length, 0);
});

test("batch archive reports individual write failures without claiming all records were archived", async t => {
  let failingId;
  const f = await fixture(t, { io: { ...fs, rename: async (from, to) => { if (failingId && to.endsWith(`${failingId}.json`)) throw new Error("blocked"); return fs.rename(from, to); } } });
  const a = await f.add(), b = await f.add();
  for (const id of [a, b]) await f.store.execute({ type: "set-completed", id, done: true });
  failingId = b; const { result } = await f.store.execute({ type: "archive", ids: [a, b] });
  assert.deepEqual(result.ids, [a]); assert.equal(result.failed[0].id, b);
  assert.ok((await f.plan(a)).archivedAt); assert.equal((await f.plan(b)).archivedAt, "");
});

test("interrupted deletion retains the primary and retry removes recovery copies without resurrection", async t => {
  let blockDeletion = false;
  const f = await fixture(t, { io: { ...fs, rm: async (file, ...args) => {
    if (blockDeletion && file.endsWith(".json")) throw new Error("file busy");
    return fs.rm(file, ...args);
  } } });
  const id = await f.add();
  await f.store.execute({ type: "set-completed", id, done: true });
  await f.store.execute({ type: "archive", ids: [id] });
  const file = path.join(f.root, "plans", `${id}.json`);
  await fs.copyFile(file, `${file}.damaged-00000000-0000-0000-0000-000000000000`);
  blockDeletion = true;
  await assert.rejects(f.store.execute({ type: "delete-plan", id }), /file busy/);
  assert.ok((await f.plan(id)).archivedAt);
  assert.equal((await f.reopen().snapshot()).plans[0].id, id);
  blockDeletion = false;
  await f.store.execute({ type: "delete-plan", id });
  assert.equal((await f.reopen().snapshot()).plans.length, 0);
  assert.deepEqual(await fs.readdir(path.dirname(file)), []);
});

test("close waits for accepted writes and rejects new operations while draining", async t => {
  let release, started, blocked = false;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { io: { ...fs, rename: async (from, to) => {
    if (blocked && to.endsWith(".json")) { started(); await gate; }
    return fs.rename(from, to);
  } } });
  const id = await f.add(); blocked = true;
  const writing = f.store.execute({ type: "set-completed", id, done: true });
  await entered;
  let closed = false;
  const closing = f.store.close().then(() => { closed = true; });
  try {
    await assert.rejects(f.store.execute({ type: "set-completed", id, done: false }), /关闭/);
    assert.equal(closed, false);
  } finally { release(); await writing; await closing; }
  assert.equal((await f.reopen().snapshot()).plans[0].done, true);
});

test("controller authorizes the owning main frame; renderer cache only changes after successful file write", async t => {
  let fail = false;
  const f = await fixture(t, { io: { ...fs, rename: async (...args) => { if (fail) throw new Error("denied"); return fs.rename(...args); } } });
  const owner = {}, controller = createNotebookController({ getStore: () => f.store, ownsMainFrame: event => event === owner });
  await assert.rejects(controller.command({}, { type: "create-plan", value: fields() }), /Untrusted/);
  await assert.rejects(controller.snapshot({}), /Untrusted/);
  const source = createNotebookSource({ getNotebook: () => controller.snapshot(owner), updateNotebook: command => controller.command(owner, command) });
  await source.load(); const { id } = await source.add("plans", fields()); const before = source.getSnapshot();
  fail = true; await assert.rejects(source.setCompleted(id, true), /文件读写失败/); assert.deepEqual(source.getSnapshot(), before);
  fail = false; await source.setCompleted(id, true); assert.equal(source.getSnapshot().plans[0].done, true);
  await f.store.close(); await assert.rejects(source.setCompleted(id, false), /关闭/);
});
