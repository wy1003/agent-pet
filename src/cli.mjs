#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { CodexActivityCollector } from "./collector.mjs";
import { CLI_COLLECTOR_IDENTITY } from "./collector-service-identity.mjs";
import { createCollectorServer } from "./server.mjs";
import { makePreview } from "./text.mjs";

function parseArgs(argv) {
  const options = {
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    host: "127.0.0.1",
    port: 43123,
    pollIntervalMs: 750,
    staleAfterMs: 15 * 60 * 1000,
    queuedAfterMs: 1_000,
    statePath: path.join(process.cwd(), ".data", "collector-state.json"),
    includeSubagents: false,
    console: true,
    once: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => argv[++index];
    if (value === "--codex-home") options.codexHome = next();
    else if (value === "--host") options.host = next();
    else if (value === "--port") options.port = Number(next());
    else if (value === "--poll-ms") options.pollIntervalMs = Number(next());
    else if (value === "--stale-ms") options.staleAfterMs = Number(next());
    else if (value === "--queued-ms") options.queuedAfterMs = Number(next());
    else if (value === "--state-file") options.statePath = path.resolve(next());
    else if (value === "--include-subagents") options.includeSubagents = true;
    else if (value === "--no-console") options.console = false;
    else if (value === "--once") options.once = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function help() {
  return `Agent Pet Codex Collector

Usage:
  node src/cli.mjs [options]

Options:
  --codex-home PATH       Codex home (default: CODEX_HOME or ~/.codex)
  --host HOST             HTTP bind host (default: 127.0.0.1)
  --port PORT             HTTP port (default: 43123)
  --poll-ms MS            Filesystem scan interval (default: 750)
  --stale-ms MS           Mark unmatched inactive tasks unknown (default: 900000)
  --queued-ms MS          Show submitted task as queued after delay (default: 1000)
  --state-file PATH       Persist unacknowledged task IDs (default: .data/collector-state.json)
  --include-subagents     Include subagent tasks
  --no-console            Disable console task updates
  --once                  Scan once, print JSON, and exit
  -h, --help              Show this help
`;
}

function statusText(task) {
  const phase = {
    waiting_start: "等待开始",
    reasoning: "正在思考",
    tool_running: "正在执行工具",
    responding: "正在回复",
    waiting_approval: "等待批准",
    waiting_answer: "等待回答",
    finished: "已结束",
    unknown: "状态未知",
  }[task.phase];
  return `${task.status} · ${phase || task.phase}`;
}

function logTask(task, includeSubagents) {
  if (!includeSubagents && task.threadSource === "subagent") return;
  const time = task.lastActivityAt
    ? new Date(task.lastActivityAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "--:--:--";
  const reply = makePreview(task.latestResponse, 100);
  console.log(
    `[${time}] [${task.sourceLabel}] [${task.projectName}] ${statusText(task)}\n` +
      `  ${task.question || task.title}${reply ? `\n  ${reply}` : ""}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(help());
    return;
  }

  const collector = new CodexActivityCollector(options);
  collector.on("diagnostic", (diagnostic) => {
    const method = diagnostic.level === "error" ? "error" : "warn";
    console[method](`[collector] ${diagnostic.message || diagnostic.error?.message || "diagnostic"}`);
  });
  if (options.console && !options.once) {
    collector.on("task.created", (task) => logTask(task, options.includeSubagents));
    collector.on("task.updated", (task) => logTask(task, options.includeSubagents));
  }

  await collector.scanOnce();
  if (options.once) {
    console.log(
      JSON.stringify(
        {
          tasks: collector.getTasks({ includeSubagents: options.includeSubagents }),
          historicalTasks: collector.getTasks({
            includeSubagents: options.includeSubagents,
            scope: "all",
          }),
          sessions: collector.getSessions({ includeSubagents: options.includeSubagents }),
        },
        null,
        2,
      ),
    );
    return;
  }

  await collector.start();
  const api = createCollectorServer(collector, {
    ...options,
    serviceIdentity: CLI_COLLECTOR_IDENTITY,
  });
  await api.start();
  console.log(`Agent Pet Codex Collector listening on http://${options.host}:${options.port}`);
  console.log(`Watching ${collector.sessionsDir}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await api.stop();
    await collector.stop();
  };
  process.once("SIGINT", () => stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => stop().finally(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
