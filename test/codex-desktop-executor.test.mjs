import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { once } from "node:events";
import { CodexDesktopClient } from "../desktop/codex-desktop-client.mjs";
import { CodexDesktopExecutor } from "../desktop/codex-desktop-executor.mjs";
import { CodexRemoteExecutor } from "../desktop/codex-remote-executor.mjs";

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

async function desktopFixture(t, options = {}) {
  const requests = [];
  const sockets = new Set();
  let discoveryResponse;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        if (message.type === "client-discovery-response") {
          discoveryResponse = message;
          continue;
        }
        requests.push(message);
        const reply = (result, extra = {}) => {
          const bytes = frame({
            type: "response", requestId: message.requestId, method: message.method,
            handledByClientId: "desktop-owner", resultType: "success", result, ...extra,
          });
          // Exercise partial headers and multibyte payloads over a real socket.
          socket.write(bytes.subarray(0, 2));
          socket.write(bytes.subarray(2, 11));
          socket.write(bytes.subarray(11));
        };
        if (message.method === "initialize") {
          reply({ clientId: "pet-client" });
          socket.write(frame({
            type: "client-discovery-request", requestId: "discovery",
            request: { method: "thread-owner-discovery" },
          }));
        } else if (message.method === "thread-owner-discovery") {
          if (options.noOwner) reply(null, { resultType: "error", error: "no-client-found" });
          else reply({ supportsUntrustedAppInput: true });
        } else if (message.method === "thread-follower-start-turn") {
          // Desktop 26.1013 renders the unnormalized request immediately.
          // This continuation-marker check previously crashed on Weixin input.
          const hasContinuation = message.params.turnStart.request.input.some(
            (item) => item.type === "text"
              && item.text_elements.some(({ placeholder }) => placeholder === "aeon-continuation"),
          );
          assert.equal(hasContinuation, false);
          if (options.onStart) options.onStart({ message, socket, reply });
          else reply({ result: { turn: { id: "remote-turn", status: "inProgress" } } });
        } else if (message.method === "thread-follower-interrupt-turn") {
          reply({ ok: true, interruptedTurnId: message.params.expectedTurnId });
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const createClient = () => new CodexDesktopClient({
    endpoint: { host: "127.0.0.1", port: server.address().port },
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
  });
  return { requests, createClient, discoveryResponse: () => discoveryResponse };
}

function remoteValue(signal) {
  return { sessionId: "desktop-session", cwd: os.tmpdir(), prompt: "收到", signal };
}

function completedTask() {
  return { sessionId: "desktop-session", turnId: "remote-turn", status: "completed", latestResponse: "收到 ✓" };
}

test("owned Desktop chat uses the owner, safe turn settings, and only its exact completion", async (t) => {
  const fixture = await desktopFixture(t);
  const observed = [];
  const diagnostics = [];
  let calls = 0;
  const desktop = new CodexDesktopExecutor({
    createClient: fixture.createClient,
    pollMs: 1,
    getTask: async (taskId) => {
      observed.push(taskId);
      calls += 1;
      if (calls === 1) return { ...completedTask(), turnId: "unrelated-completed-turn" };
      if (calls === 2) return { ...completedTask(), status: "running" };
      return completedTask();
    },
  });
  const executor = new CodexRemoteExecutor({
    desktop, createCodex: () => assert.fail("must not launch another writer"),
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const result = await executor.resume(remoteValue());
  assert.equal(result.finalResponse, "收到 ✓");
  assert.equal(calls, 3);
  assert.deepEqual(new Set(observed), new Set(["codex:desktop-session:remote-turn"]));
  const [initialize, discover, start] = fixture.requests;
  assert.equal(initialize.params.clientType, "agent-pet");
  assert.equal(discover.sourceClientId, "pet-client");
  assert.equal(discover.version, 1);
  assert.equal(start.version, 2);
  assert.equal(start.targetClientId, "desktop-owner");
  assert.equal(start.hostId, undefined);
  const request = start.params.turnStart.request;
  assert.equal(request.threadId, "desktop-session");
  assert.match(request.input[0].text, /<agent-pet-remote-request version="1">/);
  assert.match(request.input[0].text, /用户请求：\n收到$/);
  assert.deepEqual(request.input[0].text_elements, []);
  assert.equal(request.approvalPolicy, "never");
  assert.equal(request.permissions, null);
  assert.equal(request.sandboxPolicy.type, "workspaceWrite");
  assert.equal(request.sandboxPolicy.networkAccess, false);
  assert.deepEqual(request.sandboxPolicy.writableRoots, [request.cwd]);
  assert.equal(request.model, undefined);
  assert.equal(fixture.discoveryResponse().response.canHandle, false);
  assert.equal(diagnostics.at(-1).stage, "submitted");
  assert.equal(diagnostics.at(-1).turnId, "remote-turn");
});

test("no Desktop owner falls back to SDK exactly once", async (t) => {
  const fixture = await desktopFixture(t, { noOwner: true });
  let resumed = 0;
  const executor = new CodexRemoteExecutor({
    desktop: new CodexDesktopExecutor({ createClient: fixture.createClient }),
    codex: {
      resumeThread(id) {
        resumed += 1;
        return {
          id,
          runStreamed: async () => ({
            events: (async function* () { yield { type: "turn.completed" }; }()),
          }),
        };
      },
    },
  });
  await executor.resume(remoteValue());
  assert.equal(resumed, 1);
  assert.equal(fixture.requests.some((request) => request.method.includes("start-turn")), false);
});

test("only a missing Desktop socket permits fallback; access and protocol errors do not", async () => {
  for (const code of ["ENOENT", "ECONNREFUSED", "EACCES", "codex_desktop_protocol"]) {
    let closed = false;
    const desktop = new CodexDesktopExecutor({
      createClient: () => ({
        connect: async () => { throw Object.assign(new Error(code), { code }); },
        close: () => { closed = true; },
      }),
    });
    if (["ENOENT", "ECONNREFUSED"].includes(code)) {
      assert.equal(await desktop.tryResume(remoteValue()), null);
    } else {
      await assert.rejects(desktop.tryResume(remoteValue()), { code });
    }
    assert.equal(closed, true);
  }
});

for (const failure of ["timeout", "disconnect", "version-mismatch", "missing-turn-id"]) {
  test(`Desktop ${failure} after submission never launches an SDK writer or retries`, async (t) => {
    const fixture = await desktopFixture(t, {
      requestTimeoutMs: 30,
      onStart: ({ socket, reply }) => {
        if (failure === "disconnect") socket.destroy();
        if (failure === "version-mismatch") reply(null, { resultType: "error", error: "request-version-mismatch" });
        if (failure === "missing-turn-id") reply({ result: {} });
      },
    });
    const executor = new CodexRemoteExecutor({
      desktop: new CodexDesktopExecutor({ createClient: fixture.createClient, getTask: async () => null }),
      createCodex: () => assert.fail("uncertain submission must not be duplicated"),
    });
    await assert.rejects(executor.resume(remoteValue()), { code: "codex_desktop_submission_unconfirmed" });
    assert.equal(fixture.requests.filter((request) => request.method.includes("start-turn")).length, 1);
  });
}

test("stop while awaiting acknowledgement interrupts only the newly returned turn", async (t) => {
  const controller = new AbortController();
  const fixture = await desktopFixture(t, {
    onStart: ({ reply }) => {
      controller.abort(new DOMException("User stop", "AbortError"));
      reply({ result: { turn: { id: "remote-turn", status: "inProgress" } } });
    },
  });
  const desktop = new CodexDesktopExecutor({
    createClient: fixture.createClient, getTask: async () => assert.fail("already aborted"),
  });
  await assert.rejects(desktop.tryResume({ ...remoteValue(controller.signal), input: "收到" }), { name: "AbortError" });
  const stop = fixture.requests.at(-1);
  assert.equal(stop.method, "thread-follower-interrupt-turn");
  assert.equal(stop.version, 4);
  assert.equal(stop.params.expectedTurnId, "remote-turn");
  assert.equal(stop.targetClientId, "desktop-owner");
});

test("aborted requests never connect or submit", async () => {
  const controller = new AbortController();
  controller.abort();
  const desktop = new CodexDesktopExecutor({ createClient: () => assert.fail("already aborted") });
  await assert.rejects(desktop.tryResume(remoteValue(controller.signal)), { name: "AbortError" });
});

test("missing collector result is unconfirmed, not a model failure or automatic retry", async (t) => {
  const fixture = await desktopFixture(t);
  const desktop = new CodexDesktopExecutor({
    createClient: fixture.createClient, pollMs: 1, observationTimeoutMs: 5,
    getTask: async () => null,
  });
  await assert.rejects(desktop.tryResume({ ...remoteValue(), input: "收到" }), {
    code: "codex_desktop_result_unconfirmed", turnStarted: true,
  });
  assert.equal(fixture.requests.length, 3);
});

test("collector reconnect recovers the exact result without resubmitting", async (t) => {
  const fixture = await desktopFixture(t);
  let observations = 0;
  const desktop = new CodexDesktopExecutor({
    createClient: fixture.createClient, pollMs: 1,
    getTask: async () => {
      if (++observations === 1) throw new Error("collector restarting");
      return completedTask();
    },
  });
  assert.equal((await desktop.tryResume({ ...remoteValue(), input: "收到" })).finalResponse, "收到 ✓");
  assert.equal(fixture.requests.filter((request) => request.method.includes("start-turn")).length, 1);
});

test("a failed Desktop turn is never returned as a successful completion", async (t) => {
  const fixture = await desktopFixture(t);
  const desktop = new CodexDesktopExecutor({
    createClient: fixture.createClient,
    getTask: async () => ({ ...completedTask(), status: "failed", latestResponse: "partial answer" }),
  });
  await assert.rejects(desktop.tryResume({ ...remoteValue(), input: "收到" }), {
    code: "codex_execution_failed", turnStarted: true,
  });
});

test("malformed Desktop frames reject pending requests and close the connection", async (t) => {
  const fixture = await desktopFixture(t, {
    onStart: ({ socket }) => {
      const oversized = Buffer.alloc(4);
      oversized.writeUInt32LE(256 * 1024 * 1024);
      socket.write(oversized);
    },
  });
  const client = fixture.createClient();
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request("thread-follower-start-turn", {
    turnStart: { request: { input: [{ type: "text", text: "收到", text_elements: [] }] } },
  }, { version: 2 }), {
    code: "codex_desktop_protocol",
  });
});
