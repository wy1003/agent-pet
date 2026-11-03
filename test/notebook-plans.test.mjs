import test from "node:test";
import assert from "node:assert/strict";
import { createNotebookDemoSource } from "../public/notebook-demo-source.mjs";

function fixture() {
  let instant = new Date("2026-11-03T10:24:00+08:00");
  const source = createNotebookDemoSource({ now: () => new Date(instant) });
  return { source, advance: () => { instant = new Date(instant.getTime() + 60_000); },
    plans: () => source.getSnapshot().plans };
}

test("plans sort important first, then newest written time, without completion groups", () => {
  const { source, plans } = fixture();
  assert.deepEqual(plans().map(plan => plan.id), ["plan-2", "plan-4", "plan-1", "plan-3"]);
  source.toggleImportance("plan-1");
  assert.deepEqual(plans().map(plan => plan.id), ["plan-1", "plan-2", "plan-4", "plan-3"]);
  source.toggleImportance("plan-2");
  source.toggleImportance("plan-1");
  const chronological = ["plan-4", "plan-1", "plan-2", "plan-3"];
  assert.deepEqual(plans().map(plan => plan.id), chronological);
  source.togglePlan("plan-4");
  assert.deepEqual(plans().map(plan => plan.id), chronological);
});

test("editing details and deadline preserves original written time and identity", () => {
  const { source, plans, advance } = fixture();
  const original = plans().find(plan => plan.id === "plan-3");
  advance();
  const detail = "具体步骤\n".repeat(1000);
  assert.equal(source.updatePlan(original.id, { title: " 新标题 ", detail,
    deadline: "2028-02-29", createdAt: new Date().toISOString(), id: "replacement", done: false }), true);
  const edited = plans().find(plan => plan.id === original.id);
  assert.equal(edited.title, "新标题");
  assert.equal(edited.detail, detail.trim());
  assert.equal(edited.createdAt, original.createdAt);
  assert.equal(edited.done, original.done);
  assert.equal(edited.deadline, "2028-02-29");
  assert.equal(source.updatePlan(original.id, { deadline: "" }), true);
  assert.equal(plans().find(plan => plan.id === original.id).deadline, "");
});

test("invalid dates or blank titles do not partially mutate or create plans", () => {
  const { source, plans } = fixture();
  const before = plans();
  for (const deadline of ["2026-02-29", "2026-13-01", "2026-04-31", "0000-01-01", "2026-1-2", "2026-11-03T12:00:00Z"]) {
    assert.equal(source.updatePlan("plan-1", { title: "must not change", deadline }), false);
    assert.equal(source.add("plans", { title: "invalid", deadline }), false);
  }
  assert.equal(source.updatePlan("plan-1", { title: "  \n" }), false);
  assert.equal(source.add("plans", { title: " " }), false);
  assert.equal(source.updatePlan("missing", { title: "unknown" }), false);
  assert.deepEqual(plans(), before);
});

test("new plans record insertion time, order ties consistently and keep snapshots isolated", () => {
  const { source, plans, advance } = fixture();
  const first = source.add("plans", { title: "first", important: true });
  const second = source.add("plans", { title: "second", important: true });
  assert.deepEqual(plans().slice(0, 2).map(plan => plan.id), [second, first]);
  advance();
  const third = source.add("plans", { title: "third", important: true, deadline: "2027-01-01" });
  assert.equal(plans()[0].id, third);
  assert.ok(plans()[0].createdAt > plans()[1].createdAt);
  const snapshot = plans();
  snapshot[0].title = "external mutation";
  assert.equal(plans()[0].title, "third");
});

test("converting an idea records a new plan time and full content only once", () => {
  const { source, plans, advance } = fixture();
  const idea = source.getSnapshot().ideas[0];
  advance();
  assert.equal(source.convertIdea(idea.id), true);
  const convertedIdea = source.getSnapshot().ideas[0];
  const plan = plans().find(plan => plan.id === convertedIdea.planId);
  assert.equal(plan.title, idea.title);
  assert.equal(plan.detail, idea.text);
  assert.equal(plan.createdAt, "2026-11-03T02:25:00.000Z");
  assert.equal(plan.important, false);
  assert.equal(plan.deadline, "");
  assert.equal(source.convertIdea(idea.id), false);
  assert.equal(plans().length, 5);
});

test("deadline time edits preserve creation time and sorting, and can be cleared separately", () => {
  const { source, plans, advance } = fixture();
  const original = plans().find(plan => plan.id === "plan-1");
  const order = plans().map(plan => plan.id);
  advance();
  assert.equal(source.updatePlan(original.id, { deadline: "2026-11-05", deadlineTime: "00:00" }), true);
  assert.equal(source.updatePlan(original.id, { title: "保留截止时刻", deadline: "2026-11-06" }), true);
  let plan = plans().find(plan => plan.id === original.id);
  assert.equal(plan.deadlineTime, "00:00");
  assert.equal(plan.createdAt, original.createdAt);
  assert.deepEqual(plans().map(plan => plan.id), order);
  assert.equal(source.updatePlan(original.id, { deadlineTime: "" }), true);
  plan = plans().find(plan => plan.id === original.id);
  assert.equal(plan.deadline, "2026-11-06");
  assert.equal(plan.deadlineTime, "");
  assert.equal(source.updatePlan(original.id, { deadlineTime: "23:59" }), true);
  assert.equal(source.updatePlan(original.id, { deadline: "" }), true);
  plan = plans().find(plan => plan.id === original.id);
  assert.equal(plan.deadline, "");
  assert.equal(plan.deadlineTime, "");
});

test("invalid times and time without a date are rejected atomically on create and edit", () => {
  const { source, plans } = fixture();
  const before = plans();
  for (const fields of [{ deadline: "2026-11-05", deadlineTime: "24:00" }, { deadlineTime: "18:30" },
    { deadline: "2026-11-05", deadlineTime: "09:60" }]) {
    assert.equal(source.add("plans", { title: "无效时刻", ...fields }), false);
    assert.equal(source.updatePlan("plan-3", { title: "不能部分修改", ...fields }), false);
  }
  assert.deepEqual(plans(), before);
  const id = source.add("plans", { title: "有截止时刻", deadline: "2026-11-05", deadlineTime: "18:30" });
  assert.equal(plans().find(plan => plan.id === id).deadlineTime, "18:30");
});
