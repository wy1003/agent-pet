import path from "node:path";
import { cleanUserText, makePreview, makeTitle, normalizeMessageText } from "./text.mjs";

const PROJECT_NAME_ALIASES = new Map([
  ["codexactivitycompanion", "Agent Pet"],
  ["codex-task-companion", "Agent Pet"],
  ["agentpet", "Agent Pet"],
  ["agent-pet", "Agent Pet"],
]);

function sourceValue(source) {
  return typeof source === "string" ? source : "";
}

function normalizeThreadSource(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (value && typeof value === "object") {
    if (value.subagent) return "subagent";
    if (value.automation) return "automation";
  }
  return "";
}

function detectThreadSource(meta) {
  const explicit = normalizeThreadSource(meta?.thread_source);
  const source = normalizeThreadSource(meta?.source);
  if (explicit === "subagent" || source === "subagent") return "subagent";
  if (explicit === "automation" || source === "automation") return "automation";

  // Some Codex builds only expose the parent relationship through session_id.
  // A child rollout has its own id while session_id continues to reference the
  // root user thread. Treat that shape as a subagent even if thread_source was
  // omitted or incorrectly serialized as "user".
  const id = String(meta?.id || "");
  const rootId = String(meta?.session_id || "");
  if (id && rootId && id !== rootId) return "subagent";
  return explicit || source || "user";
}

function classifySource(meta) {
  const originator = String(meta.originator || "unknown");
  const source = sourceValue(meta.source);
  const threadSource = detectThreadSource(meta);

  if (threadSource === "subagent") {
    return {
      kind: "subagent",
      label: "Codex 子代理",
      confidence: "high",
    };
  }
  if (originator === "Codex Desktop") {
    return {
      kind: threadSource === "automation" ? "codex-automation" : "codex-desktop",
      label: threadSource === "automation" ? "Codex 自动任务" : "Codex Desktop",
      confidence: "high",
    };
  }
  if (originator === "codex_sdk_ts" && source === "exec") {
    return {
      kind: "cc-gui",
      label: "CC GUI",
      confidence: "inferred",
    };
  }
  if (originator === "codex_sdk_ts") {
    return {
      kind: "codex-sdk",
      label: "Codex SDK",
      confidence: "high",
    };
  }
  return {
    kind: "unknown-codex-client",
    label: originator === "unknown" ? "未知 Codex 客户端" : originator,
    confidence: "low",
  };
}

function parentSessionId(meta) {
  return (
    meta?.source?.subagent?.thread_spawn?.parent_thread_id ||
    meta?.source?.subagent?.parent_thread_id ||
    meta?.thread_source?.subagent?.thread_spawn?.parent_thread_id ||
    meta?.thread_source?.subagent?.parent_thread_id ||
    (meta?.id && meta?.session_id && meta.id !== meta.session_id ? meta.session_id : null) ||
    null
  );
}

function timestampFromValue(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return fallback || new Date().toISOString();
}

function createStatus() {
  return {
    petStatus: "idle",
    executionStatus: "unknown",
    phase: "unknown",
    waitingFor: null,
    unread: false,
    confidence: "high",
    lastActivityAt: null,
  };
}

export function createSession(meta, filePath, recordTimestamp) {
  // `id` is the actual rollout/thread id. For spawned subagents, `session_id`
  // can still point at the root session, so preferring it would collapse many
  // distinct child sessions into their parent.
  const sessionId = String(meta.id || meta.session_id || "");
  if (!sessionId) throw new Error(`session_meta in ${filePath} has no id`);
  const cwd = String(meta.cwd || "");
  const source = classifySource(meta);
  const threadSource = detectThreadSource(meta);
  const leafName = cwd ? path.basename(path.resolve(cwd)) : "未知项目";
  const projectName = PROJECT_NAME_ALIASES.get(leafName.toLowerCase()) || leafName;

  return {
    sessionId,
    sessionKey: `codex:${sessionId}`,
    rootSessionId: String(meta.session_id || sessionId),
    sourceKind: source.kind,
    sourceLabel: source.label,
    sourceConfidence: source.confidence,
    sourceRaw: {
      originator: meta.originator || null,
      source: meta.source ?? null,
      threadSource,
    },
    cwd,
    projectKey: cwd ? path.resolve(cwd).replace(/\\/g, "/").toLowerCase() : "",
    projectName,
    threadSource,
    parentSessionId: parentSessionId(meta),
    title: "未命名会话",
    titleSource: "fallback",
    latestUserText: "",
    latestAssistantText: "",
    status: createStatus(),
    activeTurnId: null,
    lastTurnId: null,
    turns: new Map(),
    filePath,
    createdAt: timestampFromValue(meta.timestamp, recordTimestamp),
    updatedAt: timestampFromValue(meta.timestamp, recordTimestamp),
    pendingTaskId: null,
    pendingTaskSequence: 0,
    userMessageContext: null,
  };
}

function ensureTurn(session, turnId, timestamp) {
  const id = String(turnId || session.activeTurnId || `implicit:${session.sessionId}`);
  let turn = session.turns.get(id);
  if (!turn) {
    turn = {
      turnId: id,
      userText: "",
      assistantPreview: "",
      assistantFinal: "",
      executionStatus: "unknown",
      phase: "unknown",
      submittedAt: timestamp || null,
      startedAt: timestamp || null,
      completedAt: null,
      lastActivityAt: timestamp || null,
      error: null,
    };
    session.turns.set(id, turn);
  }
  return turn;
}

function createPendingTurn(session, text, timestamp) {
  const submittedAt = timestampFromValue(timestamp, session.updatedAt);
  const id = `pending:${++session.pendingTaskSequence}`;
  const turn = {
    turnId: id,
    userText: text,
    assistantPreview: "",
    assistantFinal: "",
    executionStatus: "submitted",
    phase: "waiting_start",
    submittedAt,
    startedAt: null,
    completedAt: null,
    lastActivityAt: submittedAt,
    error: null,
  };
  session.turns.set(id, turn);
  session.pendingTaskId = id;
  return turn;
}

function touch(session, timestamp) {
  const normalized = timestampFromValue(timestamp, session.updatedAt);
  session.updatedAt = normalized;
  session.status.lastActivityAt = normalized;
}

function setPhase(session, phase, timestamp) {
  const turn = ensureTurn(session, session.activeTurnId, timestamp);
  turn.phase = phase;
  turn.lastActivityAt = timestampFromValue(timestamp, turn.lastActivityAt);
  session.status.phase = phase;
  touch(session, timestamp);
}

function lifecycleStart(session, payload, timestamp) {
  const turnId = String(payload.turn_id || `implicit:${session.sessionId}`);
  const startedAt = timestampFromValue(payload.started_at, timestamp);
  if (session.activeTurnId && session.activeTurnId !== turnId) {
    const previous = session.turns.get(session.activeTurnId);
    if (previous && ["in_progress", "waiting_input"].includes(previous.executionStatus)) {
      previous.executionStatus = "unknown";
      previous.phase = "unknown";
      previous.lastActivityAt ||= startedAt;
    }
  }
  let turn;
  if (session.pendingTaskId && session.turns.has(session.pendingTaskId)) {
    turn = session.turns.get(session.pendingTaskId);
    session.turns.delete(session.pendingTaskId);
    turn.turnId = turnId;
    session.turns.set(turnId, turn);
    session.pendingTaskId = null;
  } else {
    turn = ensureTurn(session, turnId, startedAt);
  }
  turn.executionStatus = "in_progress";
  turn.phase = "reasoning";
  turn.submittedAt ||= startedAt;
  turn.startedAt ||= startedAt;
  turn.lastActivityAt = startedAt;
  turn.completedAt = null;
  turn.error = null;
  session.activeTurnId = turnId;
  session.userMessageContext = null;
  session.status = {
    ...session.status,
    petStatus: "running",
    executionStatus: "in_progress",
    phase: "reasoning",
    waitingFor: null,
    unread: false,
    confidence: "high",
    lastActivityAt: startedAt,
  };
  touch(session, startedAt);
}

function lifecycleComplete(session, payload, timestamp) {
  const turn = ensureTurn(session, payload.turn_id, timestamp);
  const completedAt = timestampFromValue(payload.completed_at, timestamp);
  const finalText = normalizeMessageText(payload.last_agent_message);
  turn.executionStatus = "completed";
  turn.phase = "finished";
  turn.completedAt = completedAt;
  turn.lastActivityAt = completedAt;
  if (finalText) {
    turn.assistantFinal = finalText;
    turn.assistantPreview = makePreview(finalText);
    session.latestAssistantText = finalText;
  }
  session.activeTurnId = null;
  session.userMessageContext = null;
  session.lastTurnId = turn.turnId;
  session.status = {
    ...session.status,
    petStatus: "ready",
    executionStatus: "completed",
    phase: "finished",
    waitingFor: null,
    unread: true,
    confidence: "high",
    lastActivityAt: completedAt,
  };
  touch(session, completedAt);
}

function lifecycleAbort(session, payload, timestamp) {
  const turn = ensureTurn(session, payload.turn_id, timestamp);
  const completedAt = timestampFromValue(payload.completed_at, timestamp);
  turn.executionStatus = "interrupted";
  turn.phase = "finished";
  turn.completedAt = completedAt;
  turn.lastActivityAt = completedAt;
  turn.error = payload.reason ? String(payload.reason) : null;
  session.activeTurnId = null;
  session.userMessageContext = null;
  session.lastTurnId = turn.turnId;
  session.status = {
    ...session.status,
    petStatus: "ready",
    executionStatus: "interrupted",
    phase: "finished",
    waitingFor: null,
    unread: true,
    confidence: "high",
    lastActivityAt: completedAt,
  };
  touch(session, completedAt);
}

function lifecycleFailure(session, payload, timestamp) {
  const turn = ensureTurn(session, payload.turn_id, timestamp);
  const completedAt = timestampFromValue(payload.completed_at, timestamp);
  turn.executionStatus = "failed";
  turn.phase = "finished";
  turn.completedAt = completedAt;
  turn.lastActivityAt = completedAt;
  turn.error = String(payload.message || payload.error?.message || payload.reason || "执行失败");
  session.activeTurnId = null;
  session.userMessageContext = null;
  session.lastTurnId = turn.turnId;
  session.status = {
    ...session.status,
    petStatus: "blocked",
    executionStatus: "failed",
    phase: "finished",
    waitingFor: null,
    unread: true,
    confidence: "high",
    lastActivityAt: completedAt,
  };
  touch(session, completedAt);
}

function userMessage(session, payload, timestamp) {
  const raw = payload.message ?? payload.text ?? payload.content;
  const text = cleanUserText(raw);
  if (!text) return;
  session.latestUserText = text;
  if (session.titleSource === "fallback") {
    session.title = makeTitle(text);
    session.titleSource = "derived-user-message";
  }
  if (session.activeTurnId) {
    const activeTurn = ensureTurn(session, session.activeTurnId, timestamp);
    const messageAt = Date.parse(timestampFromValue(timestamp, session.updatedAt));
    const contextAt = Date.parse(session.userMessageContext?.timestamp || "");
    const belongsToActiveTurn =
      session.userMessageContext?.turnId === session.activeTurnId &&
      !Number.isNaN(messageAt) &&
      !Number.isNaN(contextAt) &&
      messageAt >= contextAt &&
      messageAt - contextAt <= 30_000;
    session.userMessageContext = null;
    if (belongsToActiveTurn || !activeTurn.userText || activeTurn.userText === text) {
      activeTurn.userText = text;
      activeTurn.submittedAt ||= timestampFromValue(timestamp, session.updatedAt);
      activeTurn.lastActivityAt = timestampFromValue(timestamp, activeTurn.lastActivityAt);
    } else if (session.pendingTaskId && session.turns.has(session.pendingTaskId)) {
      const pendingTurn = session.turns.get(session.pendingTaskId);
      pendingTurn.userText = text;
      pendingTurn.lastActivityAt = timestampFromValue(timestamp, pendingTurn.lastActivityAt);
    } else {
      createPendingTurn(session, text, timestamp);
    }
  } else if (session.pendingTaskId && session.turns.has(session.pendingTaskId)) {
    const turn = session.turns.get(session.pendingTaskId);
    turn.userText = text;
    turn.lastActivityAt = timestampFromValue(timestamp, turn.lastActivityAt);
  } else {
    createPendingTurn(session, text, timestamp);
  }
  touch(session, timestamp);
}

function turnContext(session, payload, timestamp) {
  const turnId = String(payload.turn_id || "");
  if (!turnId || turnId !== session.activeTurnId) return;
  session.userMessageContext = {
    turnId,
    timestamp: timestampFromValue(timestamp, session.updatedAt),
  };
}

function agentMessage(session, payload, timestamp) {
  const text = normalizeMessageText(payload.message ?? payload.text ?? payload.content);
  if (!text) return;
  const turn = ensureTurn(session, payload.turn_id || session.activeTurnId, timestamp);
  turn.assistantPreview = makePreview(text);
  turn.lastActivityAt = timestampFromValue(timestamp, turn.lastActivityAt);
  if (payload.phase === "final_answer" || payload.phase === "final") {
    turn.assistantFinal = text;
  }
  session.latestAssistantText = text;
  if (session.activeTurnId) setPhase(session, "responding", timestamp);
  else touch(session, timestamp);
}

function waitingInput(session, payload, timestamp) {
  const waitingFor = payload.waiting_for || payload.kind || "user";
  const phase = /approval|permission/i.test(String(waitingFor))
    ? "waiting_approval"
    : "waiting_answer";
  const turn = ensureTurn(session, payload.turn_id || session.activeTurnId, timestamp);
  turn.executionStatus = "waiting_input";
  turn.phase = phase;
  turn.lastActivityAt = timestampFromValue(timestamp, turn.lastActivityAt);
  session.status = {
    ...session.status,
    petStatus: "needs_input",
    executionStatus: "waiting_input",
    phase,
    waitingFor: String(waitingFor),
    unread: true,
    confidence: "high",
  };
  touch(session, timestamp);
}

export function applyRecord(session, record) {
  const payload = record?.payload || {};
  const timestamp = timestampFromValue(record?.timestamp, session.updatedAt);

  if (record?.type === "turn_context") {
    turnContext(session, payload, timestamp);
  } else if (record?.type === "event_msg") {
    switch (payload.type) {
      case "task_started":
        lifecycleStart(session, payload, timestamp);
        break;
      case "task_complete":
        lifecycleComplete(session, payload, timestamp);
        break;
      case "turn_aborted":
        lifecycleAbort(session, payload, timestamp);
        break;
      case "user_message":
        userMessage(session, payload, timestamp);
        break;
      case "agent_message":
        agentMessage(session, payload, timestamp);
        break;
      case "agent_reasoning":
        if (session.activeTurnId) setPhase(session, "reasoning", timestamp);
        break;
      case "approval_request":
      case "permission_request":
      case "request_user_input":
        waitingInput(session, payload, timestamp);
        break;
      case "error":
      case "task_failed":
        lifecycleFailure(session, payload, timestamp);
        break;
      default:
        if (session.activeTurnId && /(?:tool|patch|web_search).*(?:start|begin)$/i.test(payload.type || "")) {
          setPhase(session, "tool_running", timestamp);
        }
        break;
    }
  } else if (record?.type === "response_item" && session.activeTurnId) {
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(payload.type)) {
      setPhase(session, "tool_running", timestamp);
    }
  }
}

export function applyIndexedTitle(session, title) {
  const normalized = String(title || "").trim();
  if (!normalized) return false;
  if (session.title === normalized && session.titleSource === "session-index") return false;
  session.title = normalized;
  session.titleSource = "session-index";
  return true;
}

export function markSessionRead(session, timestamp = new Date().toISOString()) {
  session.status.unread = false;
  if (!session.activeTurnId && ["ready", "blocked"].includes(session.status.petStatus)) {
    session.status.petStatus = "idle";
  }
  session.updatedAt = timestamp;
}

export function markSessionStale(session, now, staleAfterMs) {
  let changed = false;
  for (const turn of session.turns.values()) {
    if (!["in_progress", "waiting_input"].includes(turn.executionStatus)) continue;
    const last = Date.parse(
      turn.lastActivityAt || turn.startedAt || turn.submittedAt || session.createdAt,
    );
    if (Number.isNaN(last) || now - last < staleAfterMs) continue;
    turn.executionStatus = "unknown";
    turn.phase = "unknown";
    changed = true;
    if (session.activeTurnId === turn.turnId) {
      session.status = {
        ...session.status,
        petStatus: "unknown",
        executionStatus: "unknown",
        phase: "unknown",
        waitingFor: null,
        confidence: "low",
      };
    }
  }
  return changed;
}

export function markPendingTaskQueued(session, now, queuedAfterMs) {
  if (!session.pendingTaskId) return false;
  const turn = session.turns.get(session.pendingTaskId);
  if (!turn || turn.executionStatus !== "submitted") return false;
  const submitted = Date.parse(turn.submittedAt || turn.lastActivityAt || session.updatedAt);
  if (Number.isNaN(submitted) || now - submitted < queuedAfterMs) return false;
  turn.executionStatus = "queued";
  turn.phase = "waiting_start";
  return true;
}

export function expireStalePendingTask(session, now, staleAfterMs) {
  if (!session.pendingTaskId) return false;
  const turn = session.turns.get(session.pendingTaskId);
  if (!turn || !["submitted", "queued"].includes(turn.executionStatus)) return false;
  const taskActivity = Date.parse(turn.lastActivityAt || turn.submittedAt || "");
  const sessionActivity = Date.parse(session.status.lastActivityAt || session.createdAt || "");
  const lastActivity = Math.max(
    Number.isNaN(taskActivity) ? 0 : taskActivity,
    Number.isNaN(sessionActivity) ? 0 : sessionActivity,
  );
  if (!lastActivity || now - lastActivity < staleAfterMs) return false;
  session.turns.delete(session.pendingTaskId);
  session.pendingTaskId = null;
  return true;
}

function publicTurn(turn) {
  if (!turn) return null;
  return {
    turnId: turn.turnId,
    userText: turn.userText,
    assistantPreview: turn.assistantPreview,
    assistantFinal: turn.assistantFinal,
    executionStatus: turn.executionStatus,
    phase: turn.phase,
    submittedAt: turn.submittedAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    lastActivityAt: turn.lastActivityAt,
    error: turn.error,
  };
}

function taskStatus(executionStatus) {
  if (executionStatus === "in_progress") return "running";
  if (executionStatus === "waiting_input") return "needs_input";
  return ["submitted", "queued", "completed", "failed", "interrupted", "unknown"].includes(
    executionStatus,
  )
    ? executionStatus
    : "unknown";
}

export function taskSnapshot(session, turn) {
  if (!turn) return null;
  const status = taskStatus(turn.executionStatus);
  return {
    taskId: `codex:${session.sessionId}:${turn.turnId}`,
    sessionId: session.sessionId,
    turnId: turn.turnId,
    rootSessionId: session.rootSessionId,
    sourceKind: session.sourceKind,
    sourceLabel: session.sourceLabel,
    sourceConfidence: session.sourceConfidence,
    projectName: session.projectName,
    projectKey: session.projectKey,
    cwd: session.cwd,
    threadSource: session.threadSource,
    parentSessionId: session.parentSessionId,
    // A lifecycle-only execution has no independent user request. Never reuse
    // the session's first title here: doing so makes internal executions look
    // like duplicate user questions in the task list.
    title: turn.userText ? makeTitle(turn.userText) : "未命名任务",
    question: turn.userText,
    latestResponse: turn.assistantFinal || turn.assistantPreview,
    status,
    canAcknowledge: ["completed", "failed", "interrupted", "unknown"].includes(status),
    phase: turn.phase,
    waitingFor:
      status === "needs_input" && session.activeTurnId === turn.turnId
        ? session.status.waitingFor
        : null,
    submittedAt: turn.submittedAt || turn.startedAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    lastActivityAt:
      turn.lastActivityAt || turn.completedAt || turn.startedAt || turn.submittedAt,
    error: turn.error,
  };
}

export function sessionTaskSnapshots(session) {
  return [...session.turns.values()].map((turn) => taskSnapshot(session, turn));
}

export function sessionSnapshot(session) {
  return {
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    rootSessionId: session.rootSessionId,
    sourceKind: session.sourceKind,
    sourceLabel: session.sourceLabel,
    sourceConfidence: session.sourceConfidence,
    sourceRaw: session.sourceRaw,
    projectName: session.projectName,
    projectKey: session.projectKey,
    cwd: session.cwd,
    threadSource: session.threadSource,
    parentSessionId: session.parentSessionId,
    title: session.title,
    latestUserText: session.latestUserText,
    latestAssistantText: session.latestAssistantText,
    status: { ...session.status },
    activeTurn: publicTurn(session.turns.get(session.activeTurnId)),
    lastTurn: publicTurn(session.turns.get(session.lastTurnId)),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
