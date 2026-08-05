import {
  extractRemoteRoute,
  parseRemoteCommand,
} from "./remote-command-parser.mjs";
import { isCodexResponseTimeout } from "./codex-remote-executor.mjs";
import { normalizeProjectCode, normalizeSessionCode } from "./remote-task-registry.mjs";
import { summarizeRemoteResult } from "./remote-message-renderer.mjs";

const ACTIVE_STATUSES = new Set(["submitted", "queued", "running", "in_progress"]);
const RETRYABLE_STATUSES = new Set(["failed", "interrupted", "unknown"]);
const DEFAULT_MAX_REPLY_LENGTH = 1_800;
const RETRY_PROMPT = [
  "上一条从 Agent Pet 远程入口提交的用户请求在生成回复时中断。",
  "请读取本会话最后一条尚未完成的真实用户请求，并从中断处继续处理。",
  "本条仅用于恢复执行，不是新的业务要求；开始前先检查已有结果，避免重复产生副作用。",
].join("\n");
const HELP_KEYWORDS = new Set([
  "help",
  "帮助",
  "帮助信息",
  "指令",
  "指令集",
  "怎么用",
  "如何使用",
]);
const CONNECTION_EVENTS = new Set(["connected", "restored"]);
const SESSION_STATUS_LABELS = Object.freeze({
  submitted: "已提交",
  queued: "排队中",
  running: "进行中",
  in_progress: "进行中",
  needs_input: "等待确认",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  unknown: "状态未知",
});

function compact(value, limit = 4_000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const abort = () => {
      finish(reject, signal?.reason || new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function isAbortError(error) {
  return error?.name === "AbortError"
    || error?.code === "ABORT_ERR"
    || /aborted|aborterror/i.test(String(error?.message || ""));
}

export function assessRemotePromptRisk(value) {
  const input = compact(value).toLowerCase();
  const rules = [
    [/(?:\bgit\s+push\b|推送(?:代码|提交)?(?:到)?(?:远程|github|gitlab)|(?:创建|发布)(?:\s+|.{0,8})(?:release|版本|部署))/i, "外部发布或推送"],
    [/(?:发送|发出|回复).{0,12}(?:邮件|消息|微信|短信|通知)|(?:send|post).{0,12}(?:email|message)/i, "代表用户对外发送信息"],
    [/(?:安装|卸载).{0,20}(?:软件|程序|依赖|驱动|服务)|\b(?:npm|pnpm|pip|winget|choco)\s+(?:install|uninstall)\b/i, "安装或卸载软件"],
    [/(?:格式化|清空|彻底删除|永久删除|删除).{0,20}(?:磁盘|目录|文件夹|数据|数据库)|\brm\s+-rf\b|\bdel\s+\/s\b/i, "不可逆删除"],
    [/(?:git\s+reset\s+--hard|强制重置|修改注册表|reg(?:\.exe)?\s+(?:add|delete))/i, "高风险系统或版本库修改"],
    [/(?:绕过|跳过|关闭).{0,12}(?:审批|权限|安全检查|杀毒|防火墙)|(?:提权|管理员权限|runas\b|sudo\b)/i, "权限提升或绕过安全边界"],
  ];
  const match = rules.find(([pattern]) => pattern.test(input));
  return match ? { risky: true, reason: match[1] } : { risky: false, reason: "" };
}

function normalizedPolicy(value = {}) {
  return {
    enabled: value?.enabled === true,
  };
}

function chunks(value, limit = DEFAULT_MAX_REPLY_LENGTH, continuationHeader = "") {
  const remaining = compact(value, 12_000);
  if (!remaining) return [];
  const maximum = Math.max(300, Math.min(12_000, Number(limit) || DEFAULT_MAX_REPLY_LENGTH));
  const output = [];
  let source = remaining;
  while (source.length > maximum) {
    let boundary = source.lastIndexOf("\n", maximum);
    if (boundary < maximum / 2) boundary = maximum;
    output.push(source.slice(0, boundary).trim());
    source = source.slice(boundary).trim();
    if (continuationHeader && !source.startsWith(continuationHeader)) {
      source = `${continuationHeader}\n${source}`;
    }
  }
  if (source) output.push(source);
  return output;
}

function normalizedInbound(value = {}) {
  const channelId = compact(value.channelId, 40).toLowerCase();
  const messageId = compact(value.messageId, 200);
  const senderId = compact(value.senderId || value.sender?.id, 200);
  const conversationId = compact(value.conversationId || value.conversation?.id, 200);
  const conversationType = compact(
    value.conversationType || value.conversation?.type || "private",
    40,
  ).toLowerCase();
  const text = compact(value.text, 6_000);
  const connectionEvent = compact(value.connectionEvent, 40).toLowerCase();
  if (!channelId || !senderId || !text) return null;
  const reference = value.reference && typeof value.reference === "object"
    ? {
      messageId: compact(value.reference.messageId, 200),
      text: compact(value.reference.text, 6_000),
    }
    : { messageId: "", text: "" };
  return {
    ...value,
    channelId,
    accountId: compact(value.accountId, 200),
    messageId,
    dedupeKey: compact(value.dedupeKey, 300) || `${channelId}:${messageId}`,
    senderId,
    conversationId,
    conversationType,
    text,
    connectionEvent: CONNECTION_EVENTS.has(connectionEvent) ? connectionEvent : "",
    reference,
  };
}

function ordinaryMessageAction(value) {
  const input = compact(value, 200);
  const keyword = input.replace(/[。！？!?]+$/g, "").trim().toLowerCase();
  if (HELP_KEYWORDS.has(keyword)) return "help";
  if (/^(?:[psc])0*\d{1,6}(?:\b|\s|[：:])/i.test(input)
    || /^(?:projects|sessions)(?:\s|$)/i.test(input)) {
    return "missing_slash";
  }
  return "";
}

function routeCandidate(value = {}) {
  const projectCode = normalizeProjectCode(value?.projectCode);
  const sessionCode = normalizeSessionCode(value?.sessionCode);
  return projectCode || sessionCode ? { projectCode, sessionCode } : null;
}

function routesConflict(left, right) {
  if (!left || !right) return false;
  if (left.projectCode && right.projectCode && left.projectCode !== right.projectCode) return true;
  return Boolean(left.sessionCode && right.sessionCode && left.sessionCode !== right.sessionCode);
}

function routeLine(value = {}) {
  const route = routeCandidate(value);
  if (!route) return "";
  return route.sessionCode
    ? `会话：/${route.sessionCode}`
    : `项目指令：/${route.projectCode}`;
}

function continuationHint(sessionCode) {
  const code = normalizeSessionCode(sessionCode);
  return code ? `继续处理此任务：\n/${code} 你的要求` : "";
}

function sessionStatusLabel(value) {
  const status = compact(value, 40).toLowerCase();
  return SESSION_STATUS_LABELS[status] || status || SESSION_STATUS_LABELS.unknown;
}

function remoteReply(title, route = {}, lines = []) {
  const content = lines.filter(Boolean);
  const hasContinuation = content.some((line) => compact(line).startsWith("继续处理此任务："));
  return [
    `Agent Pet · ${title}`,
    hasContinuation ? "" : routeLine(route),
    ...content.map((line) => (
      compact(line).startsWith("继续处理此任务：") ? `\n${line}` : line
    )),
  ].filter(Boolean).join("\n");
}

export class RemoteControlController {
  constructor(options = {}) {
    if (!options.registry) throw new TypeError("RemoteControlController requires registry");
    if (!options.executor) throw new TypeError("RemoteControlController requires executor");
    if (typeof options.reply !== "function" && typeof options.sendReply !== "function") {
      throw new TypeError("RemoteControlController requires reply");
    }
    this.registry = options.registry;
    this.executor = options.executor;
    this.reply = options.reply || (async (inbound, message) => options.sendReply(message.text, {
      inbound,
      ...message,
    }));
    this.getPolicy = options.getPolicy
      || options.getChannelPolicy
      || options.getConfig
      || (() => ({}));
    this.authorizeInbound = options.authorizeInbound || (async (inbound) => (
      options.isAuthorizedSender ? options.isAuthorizedSender(inbound.senderId, inbound) : true
    ));
    this.getChannelCapabilities = options.getChannelCapabilities || (() => ({}));
    this.logger = options.logger || console;
    this.now = options.now || (() => new Date());
    this.pollMs = Math.max(10, Number(options.pollMs || 500));
    this.lanes = new Map();
    this.activeJobs = new Map();
    this.stopped = false;
    this.stopPromise = null;
  }

  status() {
    const config = normalizedPolicy(this.getPolicy());
    return {
      enabled: config.enabled,
      projects: this.registry.listProjects().map((project) => ({
        code: project.code,
        name: project.name,
      })),
      active: [...this.activeJobs].map(([sessionCode, value]) => ({
        projectCode: value.job.projectCode,
        sessionCode,
        state: value.job.state,
      })),
    };
  }

  async handleInbound(value) {
    if (this.stopped) return { ok: false, reason: "controller_stopped" };
    const inbound = normalizedInbound(value);
    if (!inbound) return { ok: false, reason: "unsupported_message" };
    if (!await this.authorizeInbound(inbound)) {
      return { ok: false, reason: "sender_not_authorized" };
    }
    if (inbound.conversationType !== "private") {
      return { ok: false, reason: "conversation_not_supported" };
    }

    const slashCommand = inbound.text.startsWith("/");
    const ordinaryAction = slashCommand ? "" : ordinaryMessageAction(inbound.text);
    const showConnectionGuide = !slashCommand
      && !ordinaryAction
      && CONNECTION_EVENTS.has(inbound.connectionEvent);
    if (!slashCommand && !ordinaryAction && !showConnectionGuide) {
      return {
        ok: true,
        action: "connection_refresh",
        ignored: true,
      };
    }

    const claimed = await this.registry.claimInboundMessage(inbound.dedupeKey, {
      receivedAt: this.now().toISOString(),
    });
    if (!claimed) return { ok: false, reason: "duplicate_message" };

    const config = normalizedPolicy(this.getPolicy(inbound));
    if (ordinaryAction === "help") return this.#help(inbound, config);
    if (ordinaryAction === "missing_slash") {
      await this.#reply([
        "Agent Pet · 指令格式",
        "这条消息看起来像远程指令，但开头缺少半角 /。",
        "例如：/S0001 你的要求",
        "发送 /help 查看全部指令。",
      ].join("\n"), inbound, { kind: "command.missing_slash" });
      return { ok: false, reason: "missing_command_slash" };
    }
    if (showConnectionGuide) {
      await this.#reply([
        "Agent Pet 已连接。",
        "",
        "/projects 查看项目",
        "/sessions 查看会话",
        "/help 查看全部指令",
        "",
        "普通消息不会执行任务。",
      ].join("\n"), inbound, { kind: "connection.guide" });
      return { ok: true, action: "connection_guide" };
    }

    const resolved = this.#resolveCommand(inbound);
    if (!resolved.conflict && resolved.command?.action === "help") {
      return this.#help(inbound, config);
    }
    if (!config.enabled) {
      await this.#reply(remoteReply(
        "指令操作未开启",
        {},
        ["请先在电脑端 Agent Pet 设置中开启“指令操作”。"],
      ), inbound, { kind: "policy.denied" });
      return { ok: false, reason: "remote_control_disabled" };
    }

    if (resolved.conflict) {
      await this.#reply(remoteReply(
        "无法确认目标会话",
        {},
        ["会话指令与被引用消息对应的会话不一致。为避免串到其他项目，本次操作未执行。"],
      ), inbound, { kind: "route.conflict" });
      return { ok: false, reason: "route_conflict" };
    }
    const command = resolved.command;
    if (command.action === "invalid") {
      await this.#reply(remoteReply(
        "会话指令不明确",
        {},
        [
          "一条消息只能包含一个 /Sxxxx 或 /Pxxx 指令，请修改后重试。",
          "发送 /help 查看全部指令。",
        ],
      ), inbound, { kind: "command.invalid" });
      return { ok: false, reason: command.reason || "invalid_command" };
    }
    if (command.action === "help") return this.#help(inbound, config);
    if (command.action === "projects") return this.#projects(inbound);
    if (command.action === "sessions") return this.#sessions(command, inbound);
    if (command.action === "unscoped") {
      await this.#reply([
        "Agent Pet · 无法确定目标会话",
        "暂时无法确定要操作的项目或会话。",
        "继续：/S0001 你的要求",
        "新建任务：/P001 新任务：你的要求",
        "发送 /help 查看全部指令。",
      ].join("\n"), inbound, { kind: "route.required" });
      return { ok: false, reason: "route_required" };
    }

    let projectCode = normalizeProjectCode(command.projectCode);
    const sessionCode = normalizeSessionCode(command.sessionCode);
    if (!projectCode && sessionCode) {
      projectCode = this.registry.resolveSession(sessionCode)?.projectCode || "";
    }
    if (!projectCode) {
      await this.#reply(remoteReply(
        "缺少项目编号",
        {},
        ["新建任务请使用“/P001 新任务：具体要求”。"],
      ), inbound, { kind: "route.required" });
      return { ok: false, reason: "project_required" };
    }
    const route = this.registry.resolveRoute(projectCode, sessionCode);
    if (!route || (sessionCode && !route.session)) {
      await this.#reply(remoteReply(
        "编号不存在",
        { projectCode, sessionCode },
        ["请使用最新任务通知中的会话指令后重试。"],
      ), inbound, { kind: "route.not_found", projectCode, sessionCode });
      return { ok: false, reason: "route_not_found" };
    }

    if (command.action === "status") return this.#status(route, inbound);
    if (command.action === "stop") return this.#stop(route, inbound);
    if (command.action === "retry" && route.session) {
      if (!RETRYABLE_STATUSES.has(route.session.status || "unknown")) {
        await this.#reply(remoteReply(
          "当前任务无需重试",
          { projectCode, sessionCode },
          [
            `当前状态：${sessionStatusLabel(route.session.status)}`,
            `继续提出新要求：/${sessionCode} 你的要求`,
          ],
        ), inbound, {
          kind: "turn.retry_not_needed",
          projectCode,
          sessionCode,
        });
        return { ok: false, reason: "retry_not_available" };
      }
      return this.#enqueue({
        kind: "retry",
        projectCode,
        sessionCode,
        project: route.project,
        session: route.session,
        prompt: RETRY_PROMPT,
        inbound,
      });
    }
    if (command.action === "new") {
      if (!command.prompt) {
        await this.#reply(remoteReply(
          "缺少任务要求",
          { projectCode },
          [`请使用“${projectCode} 新任务：具体要求”。`],
        ), inbound, { kind: "command.invalid", projectCode });
        return { ok: false, reason: "prompt_required" };
      }
      const risk = assessRemotePromptRisk(command.prompt);
      if (risk.risky) {
        await this.#reply(remoteReply(
          "需要电脑端确认",
          { projectCode },
          [`该请求涉及${risk.reason}，请回到电脑端确认后执行。`],
        ), inbound, { kind: "policy.approval_required", projectCode });
        return { ok: false, reason: "desktop_approval_required" };
      }
      return this.#enqueue({
        kind: "new",
        projectCode,
        sessionCode: "",
        project: route.project,
        prompt: command.prompt,
        inbound,
      });
    }
    if (command.action === "continue" && route.session) {
      if (!command.prompt) {
        await this.#reply(remoteReply(
          "缺少任务要求",
          { projectCode, sessionCode },
          [`请使用“/${sessionCode} 你的具体要求”。`],
        ), inbound, { kind: "command.invalid", projectCode, sessionCode });
        return { ok: false, reason: "prompt_required" };
      }
      const risk = assessRemotePromptRisk(command.prompt);
      if (risk.risky) {
        await this.#reply(remoteReply(
          "需要电脑端确认",
          { projectCode, sessionCode },
          [`该请求涉及${risk.reason}，请回到电脑端确认后执行。`],
        ), inbound, { kind: "policy.approval_required", projectCode, sessionCode });
        return { ok: false, reason: "desktop_approval_required" };
      }
      return this.#enqueue({
        kind: "continue",
        projectCode,
        sessionCode,
        project: route.project,
        session: route.session,
        prompt: command.prompt,
        inbound,
      });
    }
    await this.#reply(remoteReply(
      "无法识别指令",
      { projectCode, sessionCode },
      [sessionCode
        ? `请使用“/${sessionCode} 你的要求”重新描述。`
        : `请使用“/${projectCode} 新任务：具体要求”重新描述。`,
      "发送 /help 查看全部指令。"],
    ), inbound, { kind: "command.invalid", projectCode, sessionCode });
    return { ok: false, reason: "unsupported_command" };
  }

  #resolveCommand(inbound) {
    let parsed = parseRemoteCommand({
      text: inbound.text,
      referenceText: inbound.reference?.text,
    });
    if (["help", "projects", "sessions", "invalid"].includes(parsed.action)) {
      return { conflict: false, command: parsed };
    }
    const explicit = routeCandidate(extractRemoteRoute(inbound.text));
    const quotedText = routeCandidate(extractRemoteRoute(inbound.reference?.text));
    const mappedRecord = inbound.reference?.messageId
      ? (this.registry.findDeliveryRoute?.({
        channelId: inbound.channelId,
        accountId: inbound.accountId,
        conversationId: inbound.conversationId,
        remoteMessageId: inbound.reference.messageId,
      }) || this.registry.findDelivery?.({
        channelId: inbound.channelId,
        accountId: inbound.accountId,
        conversationId: inbound.conversationId,
        remoteMessageId: inbound.reference.messageId,
      }))
      : null;
    const mapped = routeCandidate(mappedRecord);
    const candidates = [explicit, mapped, quotedText].filter(Boolean);
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        if (routesConflict(candidates[left], candidates[right])) {
          return { conflict: true, command: null };
        }
      }
    }

    const chosen = explicit || mapped || quotedText;
    if (!chosen) return { conflict: false, command: parsed };
    if (parsed.action === "unscoped" && chosen.sessionCode) {
      parsed = parseRemoteCommand({
        text: `${chosen.projectCode}/${chosen.sessionCode} ${inbound.text}`,
      });
    }
    let action = parsed.action;
    if (action === "unscoped" && chosen.sessionCode) action = "continue";
    return {
      conflict: false,
      command: {
        ...parsed,
        action,
        projectCode: chosen.projectCode,
        sessionCode: action === "new" ? "" : chosen.sessionCode,
        routeSource: explicit
          ? "explicit"
          : mapped
            ? "reply_message_id"
            : "quoted_token",
      },
    };
  }

  async #help(inbound, config = normalizedPolicy(this.getPolicy(inbound))) {
    await this.#reply([
      "Agent Pet · 远程指令",
      config.enabled
        ? "指令操作：已开启"
        : "指令操作：未开启，请先在电脑端设置中开启。",
      "/help · 查看这份帮助",
      "/projects · 查看已识别项目",
      "/sessions [P001] · 查看最近会话",
      "/P001 新任务：你的要求",
      "/S0001 你的要求",
      "/S0001 状态",
      "/S0001 停止",
      "/S0001 重试 · 恢复超时或中断的上一条请求",
    ].join("\n"), inbound, { kind: "catalog.help" });
    return { ok: true, action: "help" };
  }

  async #projects(inbound) {
    const projects = this.registry.listProjects();
    const lines = projects.slice(0, 25).map((project) => (
      `/${project.code} · ${compact(project.name, 80) || "未命名项目"}`
    ));
    await this.#reply(remoteReply("已识别项目", {}, [
      ...(lines.length ? lines : ["电脑端暂未识别到可操作的项目。"]),
      projects.length > lines.length ? `另有 ${projects.length - lines.length} 个项目未显示。` : "",
      lines.length
        ? `新建任务：/${projects[0].code} 新任务：你的要求`
        : "请先在电脑端打开一个支持的 Agent 项目。",
    ]), inbound, { kind: "catalog.projects" });
    return { ok: true, action: "projects", count: projects.length };
  }

  async #sessions(command, inbound) {
    const requestedProjectCode = normalizeProjectCode(command.projectCode);
    const sessions = this.registry.listSessions(requestedProjectCode);
    const visible = sessions.slice(0, 10);
    const lines = visible.map((session) => [
      `/${session.code}`,
      sessionStatusLabel(session.status),
      compact(session.projectName, 50),
      compact(session.title, 80),
    ].filter(Boolean).join(" · "));
    await this.#reply(remoteReply("最近会话", requestedProjectCode
      ? { projectCode: requestedProjectCode }
      : {}, [
      ...(lines.length ? lines : ["当前还没有可用会话。"]),
      sessions.length > visible.length ? `另有 ${sessions.length - visible.length} 个较早会话未显示。` : "",
      lines.length
        ? `继续：/${visible[0].code} 你的要求`
        : "发送 /projects 查看已识别项目。",
    ]), inbound, {
      kind: "catalog.sessions",
      projectCode: requestedProjectCode,
    });
    return { ok: true, action: "sessions", count: sessions.length };
  }

  async #status(route, inbound) {
    if (route.session) {
      const active = this.activeJobs.get(route.session.code);
      const lane = this.lanes.get(`session:${route.session.code}`);
      const state = active?.job.state
        || lane?.running?.job?.state
        || route.session.status
        || "unknown";
      const queued = lane?.items.length || 0;
      await this.#reply(remoteReply("任务状态", {
        projectCode: route.project.code,
        sessionCode: route.session.code,
      }, [
        `状态：${state}`,
        queued ? `等待队列：${queued}` : "",
      ]), inbound, {
        kind: "status.session",
        projectCode: route.project.code,
        sessionCode: route.session.code,
      });
      return { ok: true, action: "status", state };
    }
    const sessions = this.registry.listSessions(route.project.code).slice(0, 5);
    await this.#reply(remoteReply("项目状态", { projectCode: route.project.code }, [
      `项目：${route.project.name}`,
      ...sessions.map((session) => `${session.code} · ${session.status || "unknown"} · ${session.title}`),
    ]), inbound, { kind: "status.project", projectCode: route.project.code });
    return { ok: true, action: "status" };
  }

  async #stop(route, inbound) {
    if (!route.session) {
      const lane = this.lanes.get(`project:${route.project.code}`);
      const queued = lane?.items.splice(0).length || 0;
      const running = lane?.running;
      if (!running && queued === 0) {
        await this.#reply(remoteReply("没有可停止的任务", {
          projectCode: route.project.code,
        }, ["当前没有由远程渠道发起的新任务。"]), inbound, {
          kind: "stop.not_found",
          projectCode: route.project.code,
        });
        return { ok: false, reason: "remote_job_not_found" };
      }
      if (running) {
        running.job.stopAcknowledged = true;
        running.controller.abort(new DOMException("用户从远程渠道停止任务", "AbortError"));
      }
      await this.#reply(remoteReply("已停止远程任务", {
        projectCode: route.project.code,
      }, [`已取消 ${queued} 条等待指令。`]), inbound, {
        kind: "stop.accepted",
        projectCode: route.project.code,
      });
      return { ok: true, action: "stop", queuedCancelled: queued };
    }

    const active = this.activeJobs.get(route.session.code);
    const lane = this.lanes.get(`session:${route.session.code}`);
    const queued = lane?.items.splice(0).length || 0;
    const running = lane?.running;
    const remoteControllers = new Set();
    if (active) {
      active.job.stopAcknowledged = true;
      remoteControllers.add(active.controller);
    }
    if (running) {
      running.job.stopAcknowledged = true;
      remoteControllers.add(running.controller);
    }
    if (remoteControllers.size || queued) {
      for (const controller of remoteControllers) {
        controller.abort(new DOMException("用户从远程渠道停止任务", "AbortError"));
      }
      await this.#reply(remoteReply("已请求停止任务", {
        projectCode: route.project.code,
        sessionCode: route.session.code,
      }, [`已取消 ${queued} 条等待指令。`]), inbound, {
        kind: "stop.accepted",
        projectCode: route.project.code,
        sessionCode: route.session.code,
      });
      return { ok: true, action: "stop", queuedCancelled: queued };
    }
    if (ACTIVE_STATUSES.has(route.session.status)) {
      await this.#reply(remoteReply("需要电脑端处理", {
        projectCode: route.project.code,
        sessionCode: route.session.code,
      }, ["该任务由 Codex 桌面端启动，当前不能从远程渠道强制停止。"]), inbound, {
        kind: "stop.desktop_required",
        projectCode: route.project.code,
        sessionCode: route.session.code,
      });
      return { ok: false, reason: "desktop_stop_required" };
    }
    await this.#reply(remoteReply("没有可停止的任务", {
      projectCode: route.project.code,
      sessionCode: route.session.code,
    }, ["当前没有可停止的远程任务。"]), inbound, {
      kind: "stop.not_found",
      projectCode: route.project.code,
      sessionCode: route.session.code,
    });
    return { ok: false, reason: "remote_job_not_found" };
  }

  async #enqueue(job) {
    const risk = assessRemotePromptRisk(job.prompt);
    if (risk.risky) {
      await this.#reply(remoteReply("需要电脑端确认", job, [
        `该请求涉及${risk.reason}，请回到电脑端确认后执行。`,
      ]), job.inbound, {
        kind: "policy.approval_required",
        projectCode: job.projectCode,
        sessionCode: job.sessionCode,
      });
      return { ok: false, reason: "desktop_approval_required" };
    }
    const laneKey = job.kind === "new"
      ? `project:${job.projectCode}`
      : `session:${job.sessionCode}`;
    const lane = this.#lane(laneKey);
    job.state = "queued";
    job.queuedAt = this.now().toISOString();
    lane.items.push(job);
    const position = lane.items.length + (lane.running ? 1 : 0);
    await this.#reply(remoteReply(
      job.kind === "new"
        ? "新任务已提交"
        : job.kind === "retry"
          ? "恢复请求已提交"
          : "已提交",
      job,
      [
      position > 1 ? `当前排队位置：${position}` : "",
      ],
    ), job.inbound, {
      kind: job.kind === "new"
        ? "task.queued"
        : job.kind === "retry"
          ? "turn.retry_queued"
          : "turn.queued",
      projectCode: job.projectCode,
      sessionCode: job.sessionCode,
    });
    this.#startDrain(laneKey, lane);
    return { ok: true, action: job.kind, queued: true, position };
  }

  #lane(key) {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { key, items: [], running: null, draining: false, drainPromise: null };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  #startDrain(key, lane) {
    if (lane.drainPromise || this.stopped) return lane.drainPromise;
    const run = Promise.resolve().then(() => this.#drain(key, lane));
    lane.drainPromise = run
      .catch((error) => {
        this.logger.warn?.("[remote-control] queue drain failed", error);
      })
      .finally(() => {
        lane.drainPromise = null;
        if (!this.stopped && lane.items.length) {
          this.#startDrain(key, lane);
        } else if (!lane.items.length && !lane.running && this.lanes.get(key) === lane) {
          this.lanes.delete(key);
        }
      });
    return lane.drainPromise;
  }

  async #drain(key, lane) {
    if (lane.draining || this.stopped) return;
    lane.draining = true;
    try {
      while (!this.stopped && lane.items.length) {
        const job = lane.items.shift();
        const controller = new AbortController();
        lane.running = { job, controller };
        job.state = "waiting";
        try {
          await this.#execute(job, controller, lane);
        } catch (error) {
          const responseTimedOut = isCodexResponseTimeout(error);
          const terminalStatus = isAbortError(error) || responseTimedOut
            ? "interrupted"
            : "failed";
          await this.#persistSessionStatus(job, terminalStatus).catch((statusError) => {
            this.logger.warn?.("[remote-control] unable to persist terminal status", statusError);
          });
          if (isAbortError(error)) {
            if (!this.stopped && !job.stopAcknowledged) {
              await this.#reply(remoteReply("任务已停止", job), job.inbound, {
                kind: "task.interrupted",
                projectCode: job.projectCode,
                sessionCode: job.sessionCode,
              });
            }
          } else if (responseTimedOut) {
            this.logger.warn?.("[remote-control] Codex response timed out", error);
            await this.#reply(remoteReply("Codex 回复超时", job, [
              error?.turnStarted
                ? "你的消息已经写入 Codex 会话，但本次模型连接超时，未生成回复。"
                : "连接 Codex 时超时，本次请求未确认完成。",
              "电脑端若暂时看不到，请重新打开该会话。",
              job.sessionCode ? `重试：/${job.sessionCode} 重试` : "",
            ]), job.inbound, {
              kind: "task.response_timeout",
              projectCode: job.projectCode,
              sessionCode: job.sessionCode,
            });
          } else {
            this.logger.warn?.("[remote-control] Codex job failed", error);
            await this.#reply(remoteReply("远程任务执行失败", job, [
              `原因：${compact(error?.message || "未知错误", 500)}`,
            ]), job.inbound, {
              kind: "task.failed",
              projectCode: job.projectCode,
              sessionCode: job.sessionCode,
            });
          }
        } finally {
          this.#clearActive(job);
          lane.running = null;
        }
      }
    } finally {
      lane.draining = false;
    }
  }

  async #execute(job, controller, lane) {
    if (job.kind === "continue" || job.kind === "retry") {
      await this.#waitForSession(job, controller.signal);
      job.state = "running";
      await this.#persistSessionStatus(job, "running");
      this.#setActive(job, controller, lane);
      const result = await this.executor.resume({
        sessionId: job.session.sessionId,
        cwd: job.project.cwd,
        prompt: job.prompt,
        signal: controller.signal,
      });
      await this.#persistSessionStatus(job, "completed");
      const resultSummary = summarizeRemoteResult(result.finalResponse, 220)
        || "任务已完成，请回到电脑端查看详细结果。";
      await this.#reply(remoteReply("已完成", job, [
        `结果摘要：${resultSummary}`,
        continuationHint(job.sessionCode),
      ]), job.inbound, {
        kind: "task.completed",
        projectCode: job.projectCode,
        sessionCode: job.sessionCode,
      });
      return;
    }

    job.state = "running";
    const result = await this.executor.start({
      cwd: job.project.cwd,
      prompt: job.prompt,
      signal: controller.signal,
      onThreadStarted: async (sessionId) => {
        const session = await this.registry.registerRemoteSession({
          sessionId,
          projectKey: job.project.projectKey,
          projectName: job.project.name,
          projectKind: job.project.kind,
          cwd: job.project.cwd,
          title: job.prompt,
          status: { state: "running" },
        });
        job.sessionCode = session.code;
        job.session = session;
        this.#setActive(job, controller, lane);
        await this.#reply(remoteReply("任务已创建", {
          projectCode: job.projectCode,
          sessionCode: session.code,
        }, [continuationHint(session.code)]), job.inbound, {
          kind: "task.created",
          projectCode: job.projectCode,
          sessionCode: session.code,
        });
      },
    });
    if (!job.session) {
      throw new Error("Codex 新会话未在 thread.started 阶段完成登记");
    }
    if (result.sessionId && result.sessionId !== job.session.sessionId) {
      throw new Error("Codex 返回的会话 ID 与已登记会话不一致");
    }
    const session = await this.#persistSessionStatus(job, "completed");
    const resultSummary = summarizeRemoteResult(result.finalResponse, 220)
      || "任务已完成，请回到电脑端查看详细结果。";
    await this.#reply(remoteReply("已完成", {
      projectCode: job.projectCode,
      sessionCode: session.code,
    }, [
      `结果摘要：${resultSummary}`,
      continuationHint(session.code),
    ]), job.inbound, {
      kind: "task.completed",
      projectCode: job.projectCode,
      sessionCode: session.code,
    });
  }

  async #waitForSession(job, signal) {
    if (signal.aborted) {
      throw signal.reason || new DOMException("Aborted", "AbortError");
    }
    while (!signal.aborted) {
      const active = this.activeJobs.get(job.sessionCode);
      const session = this.registry.resolveSession(job.sessionCode);
      if (!active && (!session || !ACTIVE_STATUSES.has(session.status))) return;
      await delay(this.pollMs, signal);
    }
    throw signal.reason || new DOMException("Aborted", "AbortError");
  }

  #setActive(job, controller, lane) {
    if (!job.sessionCode) return;
    const existing = this.activeJobs.get(job.sessionCode);
    if (existing && existing.job !== job) {
      throw new Error(`会话 ${job.sessionCode} 已有远程任务正在执行`);
    }
    this.activeJobs.set(job.sessionCode, { job, controller, lane });
  }

  #clearActive(job) {
    if (!job.sessionCode) return;
    const active = this.activeJobs.get(job.sessionCode);
    if (active?.job === job) this.activeJobs.delete(job.sessionCode);
  }

  async #persistSessionStatus(job, status) {
    const sessionId = job.session?.sessionId;
    if (!sessionId) return null;
    const session = await this.registry.registerRemoteSession({
      sessionId,
      projectKey: job.project.projectKey,
      projectName: job.project.name,
      projectKind: job.project.kind,
      cwd: job.project.cwd,
      title: job.session?.title || job.prompt,
      status: { state: status },
    });
    job.session = session;
    job.sessionCode = session.code;
    return session;
  }

  async #reply(value, inbound, metadata = {}) {
    const capabilities = this.getChannelCapabilities(inbound.channelId, inbound) || {};
    const continuationHeader = routeLine(metadata);
    for (const part of chunks(value, capabilities.maxTextLength, continuationHeader)) {
      try {
        const delivery = await this.reply(inbound, {
          kind: metadata.kind || "remote.reply",
          text: part,
          route: routeCandidate(metadata),
        });
        const remoteMessageId = compact(delivery?.messageId || delivery?.clientId, 200);
        if (remoteMessageId && (metadata.projectCode || metadata.sessionCode)) {
          await this.registry.recordDelivery({
            channelId: inbound.channelId,
            accountId: inbound.accountId,
            conversationId: inbound.conversationId,
            remoteMessageId,
            projectCode: metadata.projectCode,
            sessionCode: metadata.sessionCode,
            sentAt: this.now().toISOString(),
          });
        }
      } catch (error) {
        this.logger.warn?.("[remote-control] unable to send channel reply", error);
      }
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = (async () => {
      const drains = [];
      for (const lane of this.lanes.values()) {
        lane.items.splice(0);
        lane.running?.controller.abort(new DOMException("Agent Pet 正在退出", "AbortError"));
        if (lane.drainPromise) drains.push(lane.drainPromise);
      }
      await Promise.allSettled(drains);
      this.activeJobs.clear();
    })();
    return this.stopPromise;
  }
}

export { normalizedPolicy };
