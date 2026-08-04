import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexActivityCollector } from "../src/collector.mjs";
import {
  CLI_COLLECTOR_IDENTITY,
  DESKTOP_COLLECTOR_IDENTITY,
  isCompatibleCollectorHealth,
} from "../src/collector-service-identity.mjs";
import { copywriterWorkingDirectory } from "../src/internal-projects.mjs";
import { createCollectorServer } from "../src/server.mjs";

function line(type, payload, timestamp) {
  return JSON.stringify({ timestamp, type, payload }) + "\n";
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-collector-test-"));
  const day = path.join(root, "sessions", "2026", "08", "01");
  await mkdir(day, { recursive: true });
  const file = path.join(day, "rollout-test-session-1.jsonl");
  await writeFile(
    file,
    line(
      "session_meta",
      {
        id: "session-1",
        session_id: "session-1",
        timestamp: "2026-08-01T13:11:17.000Z",
        cwd: "D:\\project\\LianYi\\v3",
        originator: "codex_sdk_ts",
        source: "exec",
        thread_source: "user",
      },
      "2026-08-01T13:11:17.000Z",
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "turn-1" },
        "2026-08-01T13:11:18.000Z",
      ) +
      line(
        "event_msg",
        {
          type: "user_message",
          message: "<agents-instructions>rules</agents-instructions>\n介绍一下你自己",
        },
        "2026-08-01T13:11:18.100Z",
      ),
    "utf8",
  );
  return { root, file };
}

test("collector health identity distinguishes the desktop service from other owners", () => {
  const desktopHealth = {
    ok: true,
    ...DESKTOP_COLLECTOR_IDENTITY,
    sessions: 1,
    tasks: 2,
  };

  assert.equal(isCompatibleCollectorHealth(desktopHealth), true);
  assert.equal(
    isCompatibleCollectorHealth({ ...desktopHealth, ...CLI_COLLECTOR_IDENTITY }),
    false,
  );
  assert.equal(
    isCompatibleCollectorHealth({ ...desktopHealth, stateNamespace: "another-state" }),
    false,
  );
  const { owner: _owner, ...missingOwner } = desktopHealth;
  assert.equal(isCompatibleCollectorHealth(missingOwner), false);
});

test("collector excludes the exact internal Codex copywriter project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-copywriter-filter-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "03");
  const internalProject = copywriterWorkingDirectory({
    localAppData: path.join(root, "local-app-data"),
  });
  await mkdir(day, { recursive: true });
  await writeFile(
    path.join(day, "rollout-copywriter.jsonl"),
    line("session_meta", {
      id: "copywriter-session",
      cwd: internalProject,
      originator: "codex_sdk_ts",
      source: "exec",
      thread_source: "user",
    }, "2026-08-03T10:00:00.000Z")
      + line("event_msg", { type: "task_started", turn_id: "turn-1" }, "2026-08-03T10:00:01.000Z")
      + line("event_msg", { type: "user_message", message: "生成文案池" }, "2026-08-03T10:00:02.000Z"),
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath: false,
    ignoredProjectPaths: [internalProject],
  });
  await collector.scanOnce();
  assert.deepEqual(collector.getSessions(), []);
  assert.deepEqual(collector.getTasks({ scope: "all" }), []);
});

test("collector incrementally tails complete JSONL lines", async (t) => {
  const { root, file } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = new CodexActivityCollector({
    codexHome: root,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });

  await collector.scanOnce();
  let session = collector.getSession("session-1");
  assert.equal(session.status.executionStatus, "in_progress");
  assert.equal(session.latestUserText, "介绍一下你自己");

  const partial = JSON.stringify({
    timestamp: "2026-08-01T13:12:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "正在生成回答", phase: "commentary" },
  });
  await appendFile(file, partial.slice(0, 40), "utf8");
  await collector.scanOnce();
  assert.equal(collector.getSession("session-1").latestAssistantText, "");

  await appendFile(file, partial.slice(40) + "\n", "utf8");
  await collector.scanOnce();
  session = collector.getSession("session-1");
  assert.equal(session.latestAssistantText, "正在生成回答");
  assert.equal(session.status.phase, "responding");

  await appendFile(
    file,
    line(
      "event_msg",
      { type: "task_complete", turn_id: "turn-1", last_agent_message: "你好，我是 Codex。" },
      "2026-08-01T13:13:47.000Z",
    ),
    "utf8",
  );
  await collector.scanOnce();
  session = collector.getSession("session-1");
  assert.equal(session.status.petStatus, "ready");
  assert.equal(session.latestAssistantText, "你好，我是 Codex。");
});

test("HTTP snapshot, health identity and read endpoints expose collector state", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = new CodexActivityCollector({
    codexHome: root,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();
  const api = createCollectorServer(collector, {
    host: "127.0.0.1",
    port: 0,
    serviceIdentity: DESKTOP_COLLECTOR_IDENTITY,
  });
  const address = await api.start();
  t.after(() => api.stop());

  const base = `http://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`${base}/healthz`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(isCompatibleCollectorHealth(health), true);
  assert.deepEqual(
    {
      service: health.service,
      protocolVersion: health.protocolVersion,
      owner: health.owner,
      stateNamespace: health.stateNamespace,
    },
    DESKTOP_COLLECTOR_IDENTITY,
  );

  const response = await fetch(`${base}/api/v1/sessions`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].sourceLabel, "CC GUI");

  const readResponse = await fetch(`${base}/api/v1/sessions/session-1/read`, { method: "POST" });
  assert.equal(readResponse.status, 200);
  assert.equal((await readResponse.json()).session.status.unread, false);
});

test("HTTP server provides the local task list UI", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = new CodexActivityCollector({ codexHome: root, statePath: false });
  await collector.scanOnce();
  const api = createCollectorServer(collector, { host: "127.0.0.1", port: 0 });
  const address = await api.start();
  t.after(() => api.stop());
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /任务收件箱/);

  const stylesheet = await fetch(`${base}/app.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /text\/css/);
  const stylesheetText = await stylesheet.text();
  assert.match(stylesheetText, /\.card-content\s*\{[^}]*min-width:\s*0/s);
  assert.match(stylesheetText, /\.companion-mode \.compact-task\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(stylesheetText, /\.companion-mode \.panel-header[^}]*display:\s*none/s);
  assert.match(stylesheetText, /\.companion-mode \.acknowledge-all/);
  assert.match(stylesheetText, /session-header/);
  assert.match(stylesheetText, /data-stack-depth/);
  assert.match(stylesheetText, /\.session-history-toggle/);

  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  const appScript = await script.text();
  assert.match(appScript, /task\.created/);
  assert.match(appScript, /createCompactTaskCard/);
  assert.match(appScript, /buildCompactTaskPresentation/);
  assert.match(appScript, /createSessionHeader/);
  assert.match(appScript, /expandedSessionIds/);
  assert.match(appScript, /groupTasksBySession/);
  assert.match(appScript, /scheduleEmptyPanelClose/);
  assert.match(appScript, /acknowledgeAllTasks/);
  assert.match(appScript, /resizePanel\(\{[\s\S]*?itemCount:\s*visiblePanelItemCount[\s\S]*?\}\)/);
  assert.match(appScript, /\/api\/v1\/tasks\/acknowledge-all/);

  const presentationScript = await fetch(`${base}/compact-task-presentation.mjs`);
  assert.equal(presentationScript.status, 200);
  const presentationSource = await presentationScript.text();
  assert.match(presentationSource, /正在处理中/);
  assert.match(presentationSource, /extractLeadingFileContext/);

  const badge = await fetch(`${base}/companion-badge.html`);
  assert.equal(badge.status, 200);
  assert.match(await badge.text(), /Agent Pet/);

  const badgeScript = await fetch(`${base}/companion-badge.js`);
  assert.equal(badgeScript.status, 200);
  assert.match(await badgeScript.text(), /showBadgeMenu/);
  const petRenderer = await fetch(`${base}/pet-renderer.js`);
  assert.equal(petRenderer.status, 200);
  assert.match(await petRenderer.text(), /class PetRenderer/);

  const dailyReport = await fetch(`${base}/daily-report.html`);
  assert.equal(dailyReport.status, 200);
  const dailyReportPage = await dailyReport.text();
  assert.match(dailyReportPage, /今日工作日报/);
  assert.doesNotMatch(dailyReportPage, /class="report-heading"/);
  assert.match(dailyReportPage, /data-report-level="brief"/);
  assert.match(dailyReportPage, /data-report-level="standard"/);
  assert.match(dailyReportPage, /data-report-level="detailed"/);
  assert.match(dailyReportPage, /id="update-report"/);

  const dailyReportScript = await fetch(`${base}/daily-report.js`);
  assert.equal(dailyReportScript.status, 200);
  const dailyReportScriptText = await dailyReportScript.text();
  assert.match(dailyReportScriptText, /getDailyReport/);
  assert.match(dailyReportScriptText, /updateDailyReport/);
  assert.doesNotMatch(dailyReportScriptText, /generateDailyReport/);

  const dailyReportStyles = await fetch(`${base}/daily-report.css`);
  assert.equal(dailyReportStyles.status, 200);
  assert.match(await dailyReportStyles.text(), /\[hidden\]\s*\{\s*display:\s*none\s*!important/);

  const settings = await fetch(`${base}/settings.html`);
  assert.equal(settings.status, 200);
  const settingsPage = await settings.text();
  assert.match(settingsPage, /语音播报/);
  assert.match(settingsPage, /GPT-SoVITS/);
  assert.match(settingsPage, /remove-gpt-sovits-service/);
  assert.match(settingsPage, /data-pick-voice-file="gpt"/);
  assert.match(settingsPage, /id="gpt-sovits-voice"/);
  assert.match(settingsPage, /id="voice-editor"/);
  assert.match(settingsPage, /placeholder="例如：自定义女声 01"/);
  assert.match(settingsPage, /<details class="advanced-settings">/);
  assert.match(settingsPage, /id="manage-gpt-sovits-service"/);
  assert.match(settingsPage, /id="gpt-sovits-service-status"/);
  assert.match(settingsPage, /id="stop-gpt-sovits-service"/);
  assert.match(settingsPage, /notifications\.voice\.gptSovits\.autoStartService/);
  assert.match(settingsPage, /id="gpt-sovits-runtime-device"/);
  assert.match(settingsPage, /id="reconfigure-gpt-sovits-device"/);
  assert.match(settingsPage, /data-voice-engine-option="windows"/);
  assert.match(settingsPage, /data-voice-engine-option="gpt-sovits"/);
  assert.match(settingsPage, /notifications\.voice\.style\.addressee/);
  assert.match(settingsPage, /notifications\.voice\.style\.includeProjectName/);
  assert.match(settingsPage, /Codex 自动生成/);
  assert.match(settingsPage, /id="save-voice-style"/);
  assert.match(settingsPage, /id="test-notification"/);
  assert.match(settingsPage, /data-page="general"/);
  assert.match(settingsPage, /data-settings-page="general"/);
  assert.match(settingsPage, /id="notification-history-path"/);
  assert.match(settingsPage, /id="app-version"/);
  assert.match(settingsPage, /id="app-update-status"/);
  assert.match(settingsPage, /id="app-update-action"/);
  assert.doesNotMatch(settingsPage, /data-page="history"/);
  assert.doesNotMatch(settingsPage, /id="notification-history-list"/);
  assert.match(settingsPage, /data-settings-page="rules"/);
  assert.match(settingsPage, /aria-selected="true"/);
  assert.match(settingsPage, /id="weixin-bind-stage"[^>]*hidden/);
  assert.match(settingsPage, /binding-icon binding-icon-pending/);
  assert.match(settingsPage, /id="weixin-connected-stage"[^>]*hidden/);
  assert.match(settingsPage, /id="weixin-degraded-stage"[^>]*hidden/);
  assert.match(settingsPage, /data-page="community"/);
  assert.match(settingsPage, /data-settings-page="community"/);
  assert.match(settingsPage, /id="copy-community-group"/);
  assert.match(settingsPage, /650561994/);
  assert.doesNotMatch(settingsPage, /community-topics/);
  assert.doesNotMatch(settingsPage, /认识同样喜欢桌面宠物/);

  const communityQr = await fetch(`${base}/assets/community/qq-group-650561994.png`);
  assert.equal(communityQr.status, 200);
  assert.equal(communityQr.headers.get("content-type"), "image/png");
  assert.ok((await communityQr.arrayBuffer()).byteLength > 100_000);

  const settingsStyles = await fetch(`${base}/settings.css`);
  assert.equal(settingsStyles.status, 200);
  const settingsStylesText = await settingsStyles.text();
  assert.match(
    settingsStylesText,
    /\.storage-path-button\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s,
  );
  assert.match(
    settingsStylesText,
    /\.storage-location-status\s*\{[^}]*overflow-wrap:\s*anywhere/s,
  );
  assert.match(
    settingsStylesText,
    /\.weixin-connect-stage\[hidden\]\s*\{[^}]*display:\s*none/s,
  );

  const settingsScript = await fetch(`${base}/settings.js`);
  assert.equal(settingsScript.status, 200);
  const settingsScriptText = await settingsScript.text();
  assert.match(settingsScriptText, /updateSettings/);
  assert.match(settingsScriptText, /manageGptSovitsService/);
  assert.match(settingsScriptText, /getGptSovitsServiceStatus/);
  assert.match(settingsScriptText, /getGptSovitsRuntimeOptions/);
  assert.match(settingsScriptText, /sendTestNotification/);
  assert.match(settingsScriptText, /getStorageLocations/);
  assert.match(settingsScriptText, /openStorageLocation/);
  assert.match(settingsScriptText, /getAppUpdateStatus/);
  assert.match(settingsScriptText, /checkForAppUpdate/);
  assert.match(settingsScriptText, /downloadAppUpdate/);
  assert.match(settingsScriptText, /installAppUpdate/);
  assert.match(settingsScriptText, /weixinBindStage\.hidden = state !== "waiting_bind"/);
  assert.match(settingsScriptText, /weixinConnectedStage\.hidden = !connectionConfirmed/);
  assert.match(settingsScriptText, /deliveryState === "degraded"/);
  assert.match(settingsScriptText, /COMMUNITY_GROUP_NUMBER = "650561994"/);
  assert.match(settingsScriptText, /copyCommunityGroupButton/);
  assert.doesNotMatch(settingsScriptText, /getNotificationHistory/);
  assert.doesNotMatch(settingsScriptText, /renderNotificationHistory/);
  assert.doesNotMatch(settingsScriptText, /clearNotificationHistory/);

  const speechHost = await fetch(`${base}/speech.html`);
  assert.equal(speechHost.status, 200);
  assert.match(speechHost.headers.get("content-security-policy"), /media-src 'self' data: blob:/);
  assert.match(await speechHost.text(), /Agent Pet Speech Host/);

  const speechScript = await fetch(`${base}/speech.js`);
  assert.equal(speechScript.status, 200);
  assert.match(await speechScript.text(), /SpeechSynthesisUtterance/);
});

test("SSE starts with a complete snapshot", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = new CodexActivityCollector({
    codexHome: root,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();
  const api = createCollectorServer(collector, { host: "127.0.0.1", port: 0 });
  const address = await api.start();
  t.after(() => api.stop());

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, {
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  const text = new TextDecoder().decode(value);
  assert.match(text, /event: snapshot/);
  assert.match(text, /session-1/);
  assert.match(text, /"tasks"/);
});

test("task API retains completed turns while a newer turn is running", async (t) => {
  const { root, file } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = new CodexActivityCollector({
    codexHome: root,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();

  await appendFile(
    file,
    line(
      "event_msg",
      { type: "task_complete", turn_id: "turn-1", last_agent_message: "answer one" },
      "2026-08-01T13:12:00.000Z",
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "turn-2" },
        "2026-08-01T13:13:00.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "second question" },
        "2026-08-01T13:13:00.100Z",
      ),
    "utf8",
  );
  await collector.scanOnce();
  assert.deepEqual(
    collector.getTasks().map((task) => task.status).sort(),
    ["completed", "running"],
  );

  const api = createCollectorServer(collector, { host: "127.0.0.1", port: 0 });
  const address = await api.start();
  t.after(() => api.stop());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tasks`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tasks.length, 2);
  assert.equal(body.tasks.some((task) => task.status === "idle"), false);

  const taskResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/tasks/${encodeURIComponent(body.tasks[0].taskId)}`,
  );
  assert.equal(taskResponse.status, 200);
  assert.equal((await taskResponse.json()).task.taskId, body.tasks[0].taskId);

  const completed = body.tasks.find((task) => task.status === "completed");
  const dismissResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/tasks/${encodeURIComponent(completed.taskId)}/dismiss`,
    { method: "POST" },
  );
  assert.equal(dismissResponse.status, 200);
  const afterDismiss = await (
    await fetch(`http://127.0.0.1:${address.port}/api/v1/tasks`)
  ).json();
  assert.deepEqual(afterDismiss.tasks.map((task) => task.status), ["running"]);

  const history = await (
    await fetch(`http://127.0.0.1:${address.port}/api/v1/tasks?scope=all`)
  ).json();
  assert.equal(history.tasks.length, 2);
});

test("historical terminal tasks are hidden from the default working set", async (t) => {
  const { root, file } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendFile(
    file,
    line(
      "event_msg",
      { type: "task_complete", turn_id: "turn-1", last_agent_message: "old answer" },
      "2026-08-01T13:12:00.000Z",
    ),
    "utf8",
  );
  const collector = new CodexActivityCollector({ codexHome: root });
  await collector.scanOnce();
  assert.equal(collector.getTasks().length, 0);
  assert.equal(collector.getTasks({ scope: "active" }).length, 0);
  assert.equal(collector.getTasks({ scope: "all" }).length, 1);
});

test("collector drops an old orphaned queued message during startup replay", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-stale-queued-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "07", "01");
  const file = path.join(day, "rollout-stale-queued.jsonl");
  const statePath = path.join(root, "collector-state.json");
  await mkdir(day, { recursive: true });
  await writeFile(
    file,
    line(
      "session_meta",
      {
        id: "stale-queued-session",
        cwd: "D:\\project\\SchoolAnalysis",
        originator: "codex_sdk_ts",
        source: "exec",
        thread_source: "user",
      },
      "2026-07-01T07:00:00.000Z",
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "turn-completed" },
        "2026-07-01T07:00:01.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "completed question" },
        "2026-07-01T07:00:02.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "orphaned queued question" },
        "2026-07-01T07:00:03.000Z",
      ) +
      line(
        "event_msg",
        { type: "task_complete", turn_id: "turn-completed", last_agent_message: "done" },
        "2026-07-01T07:00:04.000Z",
      ),
    "utf8",
  );
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-07-01T07:00:05.000Z",
      unacknowledgedTaskIds: ["codex:stale-queued-session:pending:1"],
    })}\n`,
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath,
    pendingExpiryMs: 15 * 60 * 1000,
    queuedAfterMs: 0,
  });
  await collector.scanOnce();

  assert.deepEqual(collector.getTasks(), []);
  assert.deepEqual(collector.getTasks({ scope: "active" }), []);
  assert.deepEqual(
    collector.getTasks({ scope: "all" }).map((task) => [task.question, task.status]),
    [["completed question", "completed"]],
  );
  const persistedState = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(persistedState.unacknowledgedTaskIds, []);
});

test("turn_context prevents a previous pending message from shifting later task text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-turn-context-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "03");
  const file = path.join(day, "rollout-turn-context.jsonl");
  await mkdir(day, { recursive: true });
  await writeFile(
    file,
    line(
      "session_meta",
      {
        id: "turn-context-session",
        cwd: "D:\\project\\SchoolAnalysis",
        originator: "codex_sdk_ts",
        source: "exec",
        thread_source: "user",
      },
      "2026-08-03T10:00:00.000Z",
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "turn-a" },
        "2026-08-03T10:00:01.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "first canonical question" },
        "2026-08-03T10:00:02.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "message tentatively treated as pending" },
        "2026-08-03T10:00:03.000Z",
      ) +
      line(
        "event_msg",
        { type: "task_complete", turn_id: "turn-a", last_agent_message: "first answer" },
        "2026-08-03T10:00:04.000Z",
      ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "turn-b" },
        "2026-08-03T10:00:05.000Z",
      ) +
      line(
        "turn_context",
        { turn_id: "turn-b" },
        "2026-08-03T10:00:06.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "second canonical question" },
        "2026-08-03T10:00:06.010Z",
      ) +
      line(
        "event_msg",
        { type: "task_complete", turn_id: "turn-b", last_agent_message: "second answer" },
        "2026-08-03T10:00:07.000Z",
      ),
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath: false,
    pendingExpiryMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();

  assert.deepEqual(
    collector.getTasks({ scope: "all" }).map((task) => [task.turnId, task.question, task.status]),
    [
      ["turn-b", "second canonical question", "completed"],
      ["turn-a", "first canonical question", "completed"],
    ],
  );
});

test("collector keeps a recent queued message visible during startup replay", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-recent-queued-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "03");
  const file = path.join(day, "rollout-recent-queued.jsonl");
  const now = Date.now();
  const timestamp = (offset) => new Date(now + offset).toISOString();
  await mkdir(day, { recursive: true });
  await writeFile(
    file,
    line(
      "session_meta",
      {
        id: "recent-queued-session",
        cwd: "D:\\project\\RecentProject",
        originator: "Codex Desktop",
        thread_source: "user",
      },
      timestamp(-3_000),
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "turn-running" },
        timestamp(-2_500),
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "currently running" },
        timestamp(-2_000),
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "recent queued question" },
        timestamp(-1_500),
      ),
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath: false,
    staleAfterMs: 15 * 60 * 1000,
    pendingExpiryMs: 24 * 60 * 60 * 1000,
    queuedAfterMs: 0,
  });
  await collector.scanOnce();

  assert.deepEqual(
    collector.getTasks({ scope: "active" }).map((task) => [task.question, task.status]),
    [
      ["currently running", "running"],
      ["recent queued question", "queued"],
    ],
  );
  assert.equal(collector.getTasks().length, 2);
});

test("running tasks cannot be acknowledged or removed", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath: path.join(root, "collector-state.json"),
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();
  const running = collector.getTasks()[0];
  assert.equal(running.canAcknowledge, false);
  const result = await collector.dismissTask(running.taskId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "task_not_terminal");
  assert.equal(collector.getTasks().length, 1);

  const api = createCollectorServer(collector, { host: "127.0.0.1", port: 0 });
  const address = await api.start();
  t.after(() => api.stop());
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/tasks/${encodeURIComponent(running.taskId)}/acknowledge`,
    { method: "POST" },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "task_not_terminal");
});

test("unacknowledged terminal tasks survive restart and acknowledged tasks stay hidden", async (t) => {
  const { root, file } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "collector-state.json");
  const options = {
    codexHome: root,
    statePath,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  };

  const first = new CodexActivityCollector(options);
  await first.scanOnce();
  const taskId = first.getTasks()[0].taskId;
  await appendFile(
    file,
    line(
      "event_msg",
      { type: "task_complete", turn_id: "turn-1", last_agent_message: "finished answer" },
      "2026-08-01T13:12:00.000Z",
    ),
    "utf8",
  );
  await first.scanOnce();
  assert.equal(first.getTasks()[0].status, "completed");
  assert.equal(first.getTasks()[0].canAcknowledge, true);

  const restarted = new CodexActivityCollector(options);
  await restarted.scanOnce();
  assert.equal(restarted.getTasks().length, 1);
  assert.equal(restarted.getTasks()[0].taskId, taskId);
  assert.equal(restarted.getTasks()[0].status, "completed");

  const result = await restarted.dismissTask(taskId);
  assert.equal(result.ok, true);
  assert.equal(restarted.getTasks().length, 0);

  const restartedAgain = new CodexActivityCollector(options);
  await restartedAgain.scanOnce();
  assert.equal(restartedAgain.getTasks().length, 0);
  assert.equal(restartedAgain.getTasks({ scope: "all" }).length, 1);
});

test("acknowledge-all removes terminal tasks atomically and persists across restart", async (t) => {
  const { root, file } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "collector-state.json");
  const options = {
    codexHome: root,
    statePath,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  };
  const collector = new CodexActivityCollector(options);
  await collector.scanOnce();
  await appendFile(
    file,
    line(
      "event_msg",
      { type: "task_complete", turn_id: "turn-1", last_agent_message: "first answer" },
      "2026-08-01T13:12:00.000Z",
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "turn-2" },
        "2026-08-01T13:13:00.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "second question" },
        "2026-08-01T13:13:00.100Z",
      ),
    "utf8",
  );
  await collector.scanOnce();
  const completed = collector.getTasks().find((task) => task.status === "completed");
  const running = collector.getTasks().find((task) => task.status === "running");
  assert.ok(completed);
  assert.ok(running);

  const api = createCollectorServer(collector, { host: "127.0.0.1", port: 0 });
  const address = await api.start();
  t.after(() => api.stop());
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/tasks/acknowledge-all`,
    { method: "POST" },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.deepEqual(body.taskIds, [completed.taskId]);
  assert.deepEqual(collector.getTasks().map((task) => task.taskId), [running.taskId]);
  assert.deepEqual(
    JSON.parse(await readFile(statePath, "utf8")).unacknowledgedTaskIds,
    [running.taskId],
  );

  const restarted = new CodexActivityCollector(options);
  await restarted.scanOnce();
  assert.deepEqual(restarted.getTasks().map((task) => task.taskId), [running.taskId]);
  assert.equal(restarted.getTasks({ scope: "all" }).length, 2);
});

test("acknowledge-all rolls visibility back and returns 500 when state cannot be saved", async (t) => {
  const { root, file } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath: path.join(root, "collector-state.json"),
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();
  await appendFile(
    file,
    line(
      "event_msg",
      { type: "task_complete", turn_id: "turn-1", last_agent_message: "finished answer" },
      "2026-08-01T13:12:00.000Z",
    ),
    "utf8",
  );
  await collector.scanOnce();
  const completed = collector.getTasks()[0];
  assert.equal(completed.status, "completed");

  const blockedParent = path.join(root, "blocked-parent");
  await writeFile(blockedParent, "not a directory", "utf8");
  collector.statePath = path.join(blockedParent, "collector-state.json");
  const removed = [];
  collector.on("task.removed", (event) => removed.push(event));

  const api = createCollectorServer(collector, { host: "127.0.0.1", port: 0 });
  const address = await api.start();
  t.after(() => api.stop());
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/tasks/acknowledge-all`,
    { method: "POST" },
  );
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "state_persist_failed");
  assert.deepEqual(collector.getTasks().map((task) => task.taskId), [completed.taskId]);
  assert.deepEqual(removed, []);
});

test("desktop collector prunes subagent task IDs from persisted visible state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-subagent-state-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "03");
  const statePath = path.join(root, "collector-state.json");
  const userTaskId = "codex:user-session:user-turn";
  const subagentTaskId = "codex:child-session:child-turn";
  await mkdir(day, { recursive: true });
  await writeFile(
    path.join(day, "rollout-user.jsonl"),
    line(
      "session_meta",
      {
        id: "user-session",
        session_id: "user-session",
        cwd: "D:\\project\\UserProject",
        originator: "Codex Desktop",
        thread_source: "user",
      },
      "2026-08-03T10:00:00.000Z",
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "user-turn" },
        "2026-08-03T10:00:01.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "top-level question" },
        "2026-08-03T10:00:02.000Z",
      ) +
      line(
        "event_msg",
        { type: "task_complete", turn_id: "user-turn", last_agent_message: "done" },
        "2026-08-03T10:00:03.000Z",
      ),
    "utf8",
  );
  await writeFile(
    path.join(day, "rollout-subagent.jsonl"),
    line(
      "session_meta",
      {
        id: "child-session",
        session_id: "user-session",
        cwd: "D:\\project\\UserProject",
        originator: "Codex Desktop",
        thread_source: "subagent",
        source: { subagent: { parent_thread_id: "user-session" } },
      },
      "2026-08-03T10:01:00.000Z",
    ) +
      line(
        "event_msg",
        { type: "task_started", turn_id: "child-turn" },
        "2026-08-03T10:01:01.000Z",
      ) +
      line(
        "event_msg",
        { type: "user_message", message: "subagent question" },
        "2026-08-03T10:01:02.000Z",
      ),
    "utf8",
  );
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-08-03T10:02:00.000Z",
      unacknowledgedTaskIds: [userTaskId, subagentTaskId],
    })}\n`,
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();

  assert.deepEqual(collector.getTasks().map((task) => task.taskId), [userTaskId]);
  assert.deepEqual(
    collector.getTasks({ includeSubagents: true }).map((task) => task.taskId),
    [userTaskId],
  );
  assert.deepEqual(
    new Set(
      collector.getTasks({ includeSubagents: true, scope: "all" })
        .map((task) => task.taskId),
    ),
    new Set([userTaskId, subagentTaskId]),
  );
  assert.deepEqual(
    JSON.parse(await readFile(statePath, "utf8")).unacknowledgedTaskIds,
    [userTaskId],
  );
});

test("collector ignores lifecycle-only executions that have no independent user question", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-lifecycle-only-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "04");
  const statePath = path.join(root, "collector-state.json");
  await mkdir(day, { recursive: true });

  let records = line(
    "session_meta",
    {
      id: "root-session",
      session_id: "root-session",
      cwd: "D:\\project\\UserProject",
      originator: "Codex Desktop",
      source: "vscode",
      thread_source: "user",
    },
    "2026-08-04T10:00:00.000Z",
  );
  const phantomTaskIds = [];
  for (let index = 1; index <= 6; index += 1) {
    const turnId = `internal-${index}`;
    phantomTaskIds.push(`codex:root-session:${turnId}`);
    records += line(
      "event_msg",
      { type: "task_started", turn_id: turnId },
      `2026-08-04T10:0${index}:00.000Z`,
    );
    records += line(
      "event_msg",
      { type: "task_complete", turn_id: turnId, last_agent_message: "internal result" },
      `2026-08-04T10:0${index}:01.000Z`,
    );
  }
  records += line(
    "event_msg",
    { type: "task_started", turn_id: "current-turn" },
    "2026-08-04T10:07:00.000Z",
  );
  records += line(
    "event_msg",
    { type: "user_message", message: "真正的当前任务" },
    "2026-08-04T10:07:01.000Z",
  );
  await writeFile(path.join(day, "rollout-root.jsonl"), records, "utf8");
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-08-04T10:08:00.000Z",
      unacknowledgedTaskIds: phantomTaskIds,
    })}\n`,
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();

  const visible = collector.getTasks();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].question, "真正的当前任务");
  assert.equal(visible[0].status, "running");
  assert.equal(visible[0].canAcknowledge, false);
  assert.deepEqual(
    collector.getTasks({ scope: "all" }).map((task) => task.question),
    ["真正的当前任务"],
  );
  assert.deepEqual(
    JSON.parse(await readFile(statePath, "utf8")).unacknowledgedTaskIds,
    ["codex:root-session:current-turn"],
  );
});

test("collector keeps a top-level active turn visible until its user message arrives", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-active-without-question-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "04");
  const file = path.join(day, "rollout-root.jsonl");
  await mkdir(day, { recursive: true });
  await writeFile(
    file,
    line(
      "session_meta",
      {
        id: "root-session",
        session_id: "root-session",
        cwd: "D:\\project\\UserProject",
        originator: "Codex Desktop",
        source: "vscode",
        thread_source: "user",
      },
      "2026-08-04T11:00:00.000Z",
    ) + line(
      "event_msg",
      { type: "task_started", turn_id: "current-turn" },
      "2026-08-04T11:00:01.000Z",
    ),
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath: false,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  await collector.scanOnce();
  assert.deepEqual(
    collector.getTasks().map((task) => [task.status, task.question, task.title]),
    [["running", "", "未命名任务"]],
  );

  await appendFile(
    file,
    line(
      "event_msg",
      { type: "task_complete", turn_id: "current-turn" },
      "2026-08-04T11:00:02.000Z",
    ),
    "utf8",
  );
  await collector.scanOnce();
  assert.deepEqual(collector.getTasks(), []);
  assert.deepEqual(collector.getTasks({ scope: "all" }), []);
});

test("three child rollouts cannot inflate one running user task into seven records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-real-subagent-shape-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "04");
  const statePath = path.join(root, "collector-state.json");
  await mkdir(day, { recursive: true });

  await writeFile(
    path.join(day, "rollout-root.jsonl"),
    line(
      "session_meta",
      {
        id: "root-session",
        session_id: "root-session",
        cwd: "D:\\project\\UserProject",
        originator: "Codex Desktop",
        source: "vscode",
        thread_source: "user",
      },
      "2026-08-04T12:00:00.000Z",
    ) + line(
      "event_msg",
      { type: "task_started", turn_id: "root-turn" },
      "2026-08-04T12:00:01.000Z",
    ) + line(
      "event_msg",
      { type: "user_message", message: "真正的当前任务" },
      "2026-08-04T12:00:02.000Z",
    ),
    "utf8",
  );

  const childRecords = (index) => line(
    "session_meta",
    {
      id: `child-${index}`,
      session_id: "root-session",
      cwd: "D:\\project\\UserProject",
      originator: "Codex Desktop",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "root-session",
            depth: 1,
            agent_path: `/root/child_${index}`,
          },
        },
      },
      thread_source: "subagent",
    },
    `2026-08-04T12:0${index}:00.000Z`,
  ) + line(
    // Forked Codex rollouts repeat the root metadata immediately after the
    // child owner metadata. This second record must not take ownership.
    "session_meta",
    {
      id: "root-session",
      session_id: "root-session",
      cwd: "D:\\project\\UserProject",
      originator: "Codex Desktop",
      source: "vscode",
      thread_source: "user",
    },
    "2026-08-04T12:00:00.000Z",
  ) + line(
    "event_msg",
    { type: "task_started", turn_id: "root-turn" },
    `2026-08-04T12:0${index}:01.000Z`,
  ) + line(
    "event_msg",
    { type: "user_message", message: "真正的当前任务" },
    `2026-08-04T12:0${index}:02.000Z`,
  ) + line(
    "event_msg",
    { type: "task_started", turn_id: `child-turn-${index}` },
    `2026-08-04T12:0${index}:03.000Z`,
  ) + line(
    "event_msg",
    { type: "task_complete", turn_id: `child-turn-${index}`, last_agent_message: "done" },
    `2026-08-04T12:0${index}:04.000Z`,
  );

  const childTaskIds = [];
  for (let index = 1; index <= 3; index += 1) {
    await writeFile(
      path.join(day, `rollout-child-${index}.jsonl`),
      childRecords(index),
      "utf8",
    );
    childTaskIds.push(
      `codex:child-${index}:root-turn`,
      `codex:child-${index}:child-turn-${index}`,
    );
  }
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-08-04T12:04:00.000Z",
      unacknowledgedTaskIds: childTaskIds,
    })}\n`,
    "utf8",
  );

  const collector = new CodexActivityCollector({
    codexHome: root,
    statePath,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  const taskEvents = [];
  collector.on("task.created", (task) => taskEvents.push(["created", task.taskId]));
  collector.on("task.updated", (task) => taskEvents.push(["updated", task.taskId]));
  await collector.scanOnce();

  assert.deepEqual(collector.getSessions().map((session) => session.sessionId), ["root-session"]);
  assert.deepEqual(
    collector.getTasks().map((task) => [task.question, task.status, task.canAcknowledge]),
    [["真正的当前任务", "running", false]],
  );
  assert.deepEqual(
    collector.getTasks({ scope: "all" }).map((task) => task.taskId),
    ["codex:root-session:root-turn"],
  );
  assert.equal(collector.getTasks().filter((task) => task.canAcknowledge).length, 0);
  assert.equal(taskEvents.every(([, taskId]) => taskId === "codex:root-session:root-turn"), true);
  assert.deepEqual(
    JSON.parse(await readFile(statePath, "utf8")).unacknowledgedTaskIds,
    ["codex:root-session:root-turn"],
  );

  taskEvents.length = 0;
  await writeFile(
    path.join(day, "rollout-child-4.jsonl"),
    childRecords(4),
    "utf8",
  );
  await collector.scanOnce();
  assert.deepEqual(taskEvents, []);
  assert.deepEqual(collector.getTasks().map((task) => task.taskId), [
    "codex:root-session:root-turn",
  ]);
});
