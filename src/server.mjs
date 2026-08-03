import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STANDALONE_COLLECTOR_IDENTITY } from "./collector-service-identity.mjs";

const PUBLIC_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC_FILES = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.css", { name: "app.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  [
    "/compact-task-presentation.mjs",
    { name: "compact-task-presentation.mjs", type: "text/javascript; charset=utf-8" },
  ],
  ["/settings.html", { name: "settings.html", type: "text/html; charset=utf-8" }],
  ["/settings.css", { name: "settings.css", type: "text/css; charset=utf-8" }],
  ["/settings.js", { name: "settings.js", type: "text/javascript; charset=utf-8" }],
  [
    "/assets/community/qq-group-650561994.png",
    { name: "assets/community/qq-group-650561994.png", type: "image/png" },
  ],
  ["/daily-report.html", { name: "daily-report.html", type: "text/html; charset=utf-8" }],
  ["/daily-report.css", { name: "daily-report.css", type: "text/css; charset=utf-8" }],
  ["/daily-report.js", { name: "daily-report.js", type: "text/javascript; charset=utf-8" }],
  ["/speech.html", { name: "speech.html", type: "text/html; charset=utf-8" }],
  ["/speech.js", { name: "speech.js", type: "text/javascript; charset=utf-8" }],
  [
    "/companion-badge.html",
    { name: "companion-badge.html", type: "text/html; charset=utf-8" },
  ],
  [
    "/companion-badge.css",
    { name: "companion-badge.css", type: "text/css; charset=utf-8" },
  ],
  [
    "/companion-badge.js",
    { name: "companion-badge.js", type: "text/javascript; charset=utf-8" },
  ],
  [
    "/pet-renderer.js",
    { name: "pet-renderer.js", type: "text/javascript; charset=utf-8" },
  ],
]);

function sendJson(response, statusCode, body) {
  const content = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(content);
}

function writeSse(response, event, body) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function sendStatic(response, file) {
  try {
    const content = await readFile(path.join(PUBLIC_DIRECTORY, file.name));
    response.writeHead(200, {
      "Content-Type": file.type,
      "Content-Length": content.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; connect-src 'self'; img-src 'self' data: pet-asset:; media-src 'self' data: blob:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch (error) {
    sendJson(response, 500, { error: "ui_asset_unavailable", message: error.message });
  }
}

export function createCollectorServer(collector, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port ?? 43123);
  const serviceIdentity = options.serviceIdentity || STANDALONE_COLLECTOR_IDENTITY;
  const clients = new Set();

  const onSessionUpdated = (session) => {
    for (const client of clients) writeSse(client, "session.updated", session);
  };
  const broadcastTask = (event) => (task) => {
    if (task.threadSource === "subagent") return;
    for (const client of clients) writeSse(client, event, task);
  };
  const onTaskCreated = broadcastTask("task.created");
  const onTaskUpdated = broadcastTask("task.updated");
  const onTaskRemoved = broadcastTask("task.removed");
  collector.on("session.updated", onSessionUpdated);
  collector.on("task.created", onTaskCreated);
  collector.on("task.updated", onTaskUpdated);
  collector.on("task.removed", onTaskRemoved);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
      await sendStatic(response, STATIC_FILES.get(url.pathname));
      return;
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      response.end();
      return;
    }

    if (request.method === "GET" && ["/health", "/healthz"].includes(url.pathname)) {
      sendJson(response, 200, {
        ok: true,
        ...serviceIdentity,
        sessions: collector.sessions.size,
        tasks: collector.getTasks().length,
        historicalTasks: collector.getTasks({ scope: "all" }).length,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/tasks") {
      const includeSubagents = url.searchParams.get("includeSubagents") === "true";
      const requestedScope = url.searchParams.get("scope") || "current";
      const scope = ["current", "active", "all"].includes(requestedScope)
        ? requestedScope
        : "current";
      sendJson(response, 200, { scope, tasks: collector.getTasks({ includeSubagents, scope }) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/tasks/acknowledge-all") {
      const result = await collector.dismissAllTasks();
      if (!result.ok && result.reason === "state_persist_failed") {
        sendJson(response, 500, {
          error: result.reason,
          message: "Task read state could not be saved",
        });
      } else {
        sendJson(response, 200, {
          acknowledged: true,
          dismissed: true,
          count: result.tasks.length,
          taskIds: result.tasks.map((task) => task.taskId),
        });
      }
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (request.method === "GET" && taskMatch) {
      const task = collector.getTask(decodeURIComponent(taskMatch[1]));
      if (!task) sendJson(response, 404, { error: "task_not_found" });
      else sendJson(response, 200, { task });
      return;
    }

    const acknowledgeMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/(?:acknowledge|dismiss)$/,
    );
    if (request.method === "POST" && acknowledgeMatch) {
      const result = await collector.dismissTask(decodeURIComponent(acknowledgeMatch[1]));
      if (result.reason === "visible_task_not_found") {
        sendJson(response, 404, { error: result.reason });
      } else if (result.reason === "task_not_terminal") {
        sendJson(response, 409, {
          error: result.reason,
          status: result.task.status,
          message: "Only terminal tasks can be acknowledged and removed",
        });
      } else if (result.reason === "state_persist_failed") {
        sendJson(response, 500, {
          error: result.reason,
          message: "Task read state could not be saved",
        });
      } else {
        sendJson(response, 200, {
          acknowledged: true,
          dismissed: true,
          taskId: result.task.taskId,
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
      const includeSubagents = url.searchParams.get("includeSubagents") === "true";
      sendJson(response, 200, { sessions: collector.getSessions({ includeSubagents }) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      response.write("retry: 1000\n\n");
      writeSse(response, "snapshot", {
        tasks: collector.getTasks(),
        sessions: collector.getSessions(),
      });
      clients.add(response);
      const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
      request.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(response);
      });
      return;
    }

    const readMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/read$/);
    if (request.method === "POST" && readMatch) {
      const sessionId = decodeURIComponent(readMatch[1]);
      const session = collector.markRead(sessionId);
      if (!session) sendJson(response, 404, { error: "session_not_found" });
      else sendJson(response, 200, { session });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });

  return {
    host,
    port,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async stop() {
      collector.off("session.updated", onSessionUpdated);
      collector.off("task.created", onTaskCreated);
      collector.off("task.updated", onTaskUpdated);
      collector.off("task.removed", onTaskRemoved);
      for (const client of clients) client.end();
      clients.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
