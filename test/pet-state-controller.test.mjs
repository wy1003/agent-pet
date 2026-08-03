import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePetState, PetStateController } from "../desktop/pet/pet-state-controller.mjs";

test("pet state aggregation follows task priority", () => {
  assert.equal(aggregatePetState([]), "idle");
  assert.equal(aggregatePetState([{ status: "queued" }]), "waiting");
  assert.equal(aggregatePetState([{ status: "running", phase: "reasoning" }]), "running");
  assert.equal(aggregatePetState([{ status: "failed" }, { status: "running" }]), "failed");
  assert.equal(aggregatePetState([
    { status: "failed" },
    { status: "needs_input", phase: "waiting_approval" },
  ]), "review");
});

test("pet controller seeds silently and emits terminal feedback once", () => {
  const states = [];
  const controller = new PetStateController({ onState: (state) => states.push(state) });
  controller.handleEvent("snapshot", {
    tasks: [{ taskId: "task-1", status: "running", phase: "reasoning" }],
  });
  assert.equal(states.at(-1).state, "running");
  assert.equal(states.at(-1).oneShot, false);

  controller.handleEvent("task.updated", { taskId: "task-1", status: "completed" });
  assert.equal(states.at(-1).state, "waving");
  assert.equal(states.at(-1).oneShot, true);
  const generation = states.at(-1).generation;

  controller.handleEvent("task.updated", { taskId: "task-1", status: "completed" });
  assert.equal(states.at(-1).generation, generation);
  assert.equal(controller.acknowledgeAnimation(generation), true);
  assert.equal(states.at(-1).state, "idle");

  controller.handleEvent("task.updated", { taskId: "task-1", status: "running" });
  controller.handleEvent("task.updated", { taskId: "task-1", status: "completed" });
  assert.equal(states.at(-1).state, "idle");
  assert.equal(states.at(-1).generation, generation);
});
