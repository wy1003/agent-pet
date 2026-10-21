import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as presentation from "../public/compact-task-presentation.mjs";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
// Use the real presentation helpers with an inert DOM and event transport.
const source = appSource.replace(/^import\s*\{[^}]+\}\s*from\s*"\.\/compact-task-presentation\.mjs";\s*/, "");
assert.notEqual(source, appSource, "the app import must be replaced with the real helpers");

function fixture(companion = true) {
  class Element {
    constructor() {
      this.childNodes = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = new Map();
      this.className = "";
      this.textContent = "";
      this.hidden = false;
      this.disabled = false;
      this.classList = { add() {}, toggle() {} };
    }
    append(...nodes) { this.childNodes.push(...nodes); }
    replaceChildren(...nodes) { this.childNodes = nodes; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    click() { return this.listeners.get("click")?.(); }
    getBoundingClientRect() { return { height: 200 }; }
    querySelectorAll(selector) {
      return this.childNodes.flatMap(child => [
        ...(child.className.split(/\s+/).includes(selector.slice(1)) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
  }
  const elements = new Map([
    "#task-list", "#empty-state", "#task-count", "#connection", "#connection-label",
    "#reconnect-button", "#panel-close", "#panel-settings", "#compact-toolbar",
    "#acknowledge-all", "#toast", ".task-panel",
  ].map(selector => [selector, new Element()]));
  for (const selector of ["#empty-state", "#compact-toolbar", "#acknowledge-all", "#toast"]) elements.get(selector).hidden = true;
  const requests = [], sizes = [], timers = new Map();
  let transport, responder = () => ({ acknowledged: true }), nextTimer = 1;
  class EventSource {
    constructor() { this.listeners = new Map(); transport = this; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    close() {}
    emit(name, payload) { return this.raw(name, JSON.stringify(payload)); }
    raw(name, data) { return this.listeners.get(name)({ data }); }
  }
  const context = vm.createContext({
    ...presentation, URLSearchParams, console, EventSource,
    window: {
      location: { search: companion ? "?companion=1" : "" }, addEventListener() {},
      companion: { resizePanel: size => sizes.push(size), hidePanel() {} },
    },
    document: {
      body: new Element(), querySelector: selector => elements.get(selector),
      createElement: () => new Element(),
      createTextNode: text => Object.assign(new Element(), { textContent: text }),
    },
    setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {},
    fetch: async (url, options) => {
      requests.push({ url, method: options.method });
      const body = await responder(url);
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(source, context, { filename: "public/app.js" });
  return {
    el: selector => elements.get(selector), events: transport, requests, sizes,
    respond: handler => { responder = handler; },
  };
}

function task(taskId, status = "completed") {
  return { taskId, sessionId: taskId, status, question: "测试任务", canAcknowledge: status === "completed" };
}

function assertEmpty(ui) {
  assert.equal(ui.el("#task-list").childNodes.length, 0);
  assert.equal(ui.el("#empty-state").hidden, false);
  assert.equal(ui.el("#task-count").textContent, "0");
  assert.equal(ui.el("#compact-toolbar").hidden, true);
  assert.equal(ui.el("#acknowledge-all").hidden, true);
  assert.equal(ui.el("#toast").hidden, true, ui.el("#toast").textContent);
}

for (const companion of [false, true]) {
  test(`initial empty snapshot renders without a false update error (companion=${companion})`, () => {
    const ui = fixture(companion);
    ui.events.emit("snapshot", { tasks: [] });
    assertEmpty(ui);
    if (companion) assert.equal(ui.sizes.at(-1).itemCount, 0);
  });
}

for (const eventFirst of [false, true]) {
  test(`acknowledging the final task renders empty for either removal event order (eventFirst=${eventFirst})`, async () => {
    const ui = fixture();
    ui.events.emit("snapshot", { tasks: [task("last")] });
    assert.equal(ui.el("#task-count").textContent, "1");
    ui.respond(() => {
      if (eventFirst) ui.events.emit("task.removed", { taskId: "last" });
      return { acknowledged: true, taskId: "last" };
    });
    await ui.el("#task-list").querySelectorAll(".compact-acknowledge")[0].click();
    if (!eventFirst) ui.events.emit("task.removed", { taskId: "last" });
    assert.deepEqual(ui.requests, [{ url: "/api/v1/tasks/last/acknowledge", method: "POST" }]);
    assertEmpty(ui);
    assert.equal(ui.sizes.at(-1).itemCount, 0);
    ui.events.emit("task.created", task("next"));
    assert.equal(ui.el("#empty-state").hidden, true);
    assert.equal(ui.el("#task-count").textContent, "1");
    assert.equal(ui.el("#toast").hidden, true);
  });
}

test("acknowledge all keeps active tasks and handles the final completed task without a false error", async () => {
  const ui = fixture();
  ui.events.emit("snapshot", { tasks: [task("done"), task("active", "running")] });
  ui.respond(() => ({ taskIds: ["done"] }));
  await ui.el("#acknowledge-all").click();
  assert.equal(ui.el("#task-count").textContent, "1");
  assert.equal(ui.el("#empty-state").hidden, true);
  assert.equal(ui.el("#acknowledge-all").hidden, true);
  ui.events.emit("task.updated", task("active"));
  ui.respond(() => ({ taskIds: ["active"] }));
  await ui.el("#acknowledge-all").click();
  assertEmpty(ui);
  assert.equal(ui.el("#acknowledge-all").disabled, false);
});

test("malformed event JSON still displays the update error", () => {
  const ui = fixture();
  ui.events.raw("task.updated", "{broken json");
  assert.equal(ui.el("#toast").hidden, false);
  assert.equal(ui.el("#toast").textContent, "收到了一条无法识别的任务更新");
});
