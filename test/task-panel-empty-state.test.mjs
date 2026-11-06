import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as presentation from "../public/compact-task-presentation.mjs";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
// Execute the real renderer with its real presentation helpers, without Electron.
const script = source.replace(
  /import\s*\{([^}]+)\}\s*from "\.\/compact-task-presentation\.mjs";/,
  "const {$1} = presentation;",
);
assert.notEqual(script, source, "renderer import must be wired into the harness");

class Element {
  constructor() {
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.classList = { add() {}, toggle() {} };
  }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  getBoundingClientRect() { return { height: 100 }; }
  querySelectorAll(selector) {
    return this.childNodes.flatMap((child) => [
      ...(child.className.split(" ").includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

function createApp({ companion = true, fetchImpl } = {}) {
  const nodes = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map((match) => {
    const node = new Element();
    node.hidden = /\bhidden\b/.test(match[0]);
    return [`#${match[1]}`, node];
  }));
  nodes.set(".task-panel", new Element());
  const events = {};
  const requests = [];
  const resizes = [];
  const context = vm.createContext({
    presentation, URLSearchParams,
    document: {
      body: new Element(),
      querySelector: (selector) => nodes.get(selector) || null,
      createElement: () => new Element(),
      createTextNode: (text) => Object.assign(new Element(), { textContent: text }),
    },
    window: {
      location: { search: companion ? "?companion=1" : "" },
      addEventListener() {},
      companion: { resizePanel: (size) => resizes.push(size) },
    },
    EventSource: class {
      addEventListener(name, listener) { events[name] = listener; }
      close() {}
    },
    setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: (callback) => { callback(); return 1; },
    cancelAnimationFrame() {},
    fetch: async (...args) => {
      requests.push(args);
      return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ taskIds: ["one", "two"] }) };
    },
  });
  vm.runInContext(script, context, { filename: "public/app.js" });
  return {
    nodes, requests, resizes, companion,
    emit: (name, value) => events[name]({ data: JSON.stringify(value) }),
    emitRaw: (name, data) => events[name]({ data }),
  };
}

function task(taskId, extra = {}) {
  return { taskId, sessionId: taskId, status: "completed", question: "测试任务", canAcknowledge: true, ...extra };
}

function assertEmpty(app) {
  assert.equal(app.nodes.get("#toast").hidden, true, app.nodes.get("#toast").textContent);
  assert.equal(app.nodes.get("#task-list").childNodes.length, 0);
  assert.equal(app.nodes.get("#empty-state").hidden, false);
  assert.equal(app.nodes.get("#task-count").textContent, "0");
  assert.equal(app.nodes.get("#compact-toolbar").hidden, true);
  if (app.companion) assert.equal(app.nodes.get("#acknowledge-all").hidden, true);
}

for (const companion of [true, false]) {
  test(`empty initial snapshot renders without error (companion=${companion})`, () => {
    const app = createApp({ companion });
    app.emit("snapshot", { tasks: [] });
    assertEmpty(app);
  });
}

test("removing the last task via SSE renders empty state and permits a new task", () => {
  const app = createApp();
  app.emit("snapshot", { tasks: [task("one"), task("two")] });
  app.emit("task.removed", { taskId: "one" });
  assert.equal(app.nodes.get("#task-count").textContent, "1");
  assert.equal(app.nodes.get("#empty-state").hidden, true);
  app.emit("task.removed", { taskId: "two" });
  assertEmpty(app);
  assert.equal(app.resizes.at(-1).itemCount, 0);
  app.emit("task.created", task("three"));
  assert.equal(app.nodes.get("#task-count").textContent, "1");
  assert.equal(app.nodes.get("#empty-state").hidden, true);
  assert.equal(app.nodes.get("#compact-toolbar").hidden, false);
  assert.equal(app.nodes.get("#toast").hidden, true);
});

test("acknowledging the last task succeeds with HTTP and duplicate SSE removal", async () => {
  const app = createApp();
  app.emit("snapshot", { tasks: [task("one")] });
  const button = app.nodes.get("#task-list").querySelectorAll(".compact-acknowledge")[0];
  await button.listeners.click();
  assert.equal(app.requests[0][0], "/api/v1/tasks/one/acknowledge");
  assert.equal(app.requests[0][1].method, "POST");
  assertEmpty(app);
  app.emit("task.removed", { taskId: "one" });
  assertEmpty(app);
});

test("acknowledge all remains safe when SSE removes tasks before the HTTP response", async () => {
  const app = createApp({ fetchImpl: async () => {
    app.emit("task.removed", { taskId: "one" });
    app.emit("task.removed", { taskId: "two" });
    return { ok: true, json: async () => ({ taskIds: ["one", "two"] }) };
  } });
  app.emit("snapshot", { tasks: [task("one"), task("two")] });
  await app.nodes.get("#acknowledge-all").listeners.click();
  assert.equal(app.requests[0][0], "/api/v1/tasks/acknowledge-all");
  assert.equal(app.nodes.get("#acknowledge-all").disabled, false);
  assertEmpty(app);
});

test("an empty reconnect snapshot clears previous cards and count", () => {
  const app = createApp();
  app.emit("snapshot", { tasks: [task("one")] });
  app.emit("snapshot", { tasks: [] });
  assertEmpty(app);
});

test("genuinely invalid event JSON still shows an error", () => {
  const app = createApp();
  app.emitRaw("task.removed", "{invalid json");
  assert.equal(app.nodes.get("#toast").hidden, false);
  assert.equal(app.nodes.get("#toast").textContent, "收到了一条无法识别的任务更新");
});
