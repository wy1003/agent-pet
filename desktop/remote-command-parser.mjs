import {
  normalizeProjectCode,
  normalizeSessionCode,
} from "./remote-task-registry.mjs";

// S is the public session prefix. C remains accepted as a legacy alias so
// commands copied from notifications sent before the migration still work.
const FULL_ROUTE_PATTERN = /(^|[^A-Za-z0-9])((?:\/|／)?\s*(P0*\d{1,6})\s*[\/／]\s*([SC]0*\d{1,8}))\b/i;
const SESSION_COMMAND_PATTERN = /(^|[^A-Za-z0-9])((?:\/|／)\s*([SC]0*\d{1,8}))\b/i;
const PROJECT_PATTERN = /(^|[^A-Za-z0-9])((?:\/|／)?\s*(P0*\d{1,6}))\b/i;

function text(value, limit = 4_000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

export function extractRemoteRoute(value) {
  const source = text(value);
  const full = source.match(FULL_ROUTE_PATTERN);
  if (full) {
    return {
      projectCode: normalizeProjectCode(full[3]),
      sessionCode: normalizeSessionCode(full[4]),
      matchedText: full[2],
    };
  }
  const session = source.match(SESSION_COMMAND_PATTERN);
  if (session) {
    return {
      projectCode: "",
      sessionCode: normalizeSessionCode(session[3]),
      matchedText: session[2],
    };
  }
  const project = source.match(PROJECT_PATTERN);
  return project ? {
    projectCode: normalizeProjectCode(project[3]),
    sessionCode: "",
    matchedText: project[2],
  } : null;
}

function extractRemoteRoutes(value, limit = 3) {
  let source = text(value);
  const routes = [];
  while (source && routes.length < limit) {
    const route = extractRemoteRoute(source);
    if (!route?.matchedText) break;
    const index = source.indexOf(route.matchedText);
    if (index < 0) break;
    routes.push(route);
    source = source.slice(index + route.matchedText.length);
  }
  return routes;
}

function withoutRoute(value, route) {
  if (!route?.matchedText) return text(value);
  return text(value)
    .replace(route.matchedText, " ")
    .replace(/^[\s:：，,]+|[\s:：，,]+$/g, "");
}

function commandRemainder(value, pattern) {
  return text(value).replace(pattern, "").replace(/^[\s:：，,]+/, "").trim();
}

function parseCatalogCommand(input) {
  if (/^[\/／](?:help|帮助)$/i.test(input)) {
    return { action: "help", projectCode: "" };
  }
  if (/^[\/／](?:projects|项目)$/i.test(input)) {
    return { action: "projects", projectCode: "" };
  }
  const sessions = input.match(
    /^[\/／](?:sessions|会话)(?:\s+[\/／]?(P0*\d{1,6}))?$/i,
  );
  if (sessions) {
    return {
      action: "sessions",
      projectCode: normalizeProjectCode(sessions[1]),
    };
  }
  return null;
}

export function parseRemoteCommand(value = {}) {
  const input = text(value.text);
  const catalogCommand = parseCatalogCommand(input);
  if (catalogCommand) {
    return {
      ...catalogCommand,
      sessionCode: "",
      prompt: "",
      routeSource: "command",
    };
  }
  const referenceText = text(value.referenceText || value.reference?.text, 6_000);
  const inlineRoutes = extractRemoteRoutes(input);
  const inlineRoute = inlineRoutes[0] || null;
  const referenceRoute = extractRemoteRoute(referenceText);
  const route = inlineRoute || referenceRoute;
  const body = withoutRoute(input, inlineRoute);

  if (inlineRoutes.length > 1) {
    return {
      action: "invalid",
      reason: "multiple_routes",
      projectCode: "",
      sessionCode: "",
      prompt: "",
      routeSource: "explicit",
    };
  }

  const statusPattern = /^(?:状态|查询状态|查看状态)(?:任务|项目)?[。.!！?？]*$/i;
  const stopPattern = /^(?:停止|中止|取消)(?:任务|执行)?[。.!！?？]*$/i;
  const retryPattern = /^(?:重试|重新尝试|继续上次)(?:任务|请求)?[。.!！?？]*$/i;
  const newPattern = /^(?:新任务|新建任务|创建任务)/i;
  const continuePattern = /^(?:继续|续问|接着)(?:任务)?/i;

  if (statusPattern.test(body)) {
    return {
      action: "status",
      projectCode: route?.projectCode || "",
      sessionCode: route?.sessionCode || "",
      prompt: "",
      routeSource: inlineRoute ? "explicit" : (referenceRoute ? "reference" : "none"),
    };
  }
  if (stopPattern.test(body)) {
    return {
      action: "stop",
      projectCode: route?.projectCode || "",
      sessionCode: route?.sessionCode || "",
      prompt: "",
      routeSource: inlineRoute ? "explicit" : (referenceRoute ? "reference" : "none"),
    };
  }
  if (retryPattern.test(body)) {
    return {
      action: "retry",
      projectCode: route?.projectCode || "",
      sessionCode: route?.sessionCode || "",
      prompt: "",
      routeSource: inlineRoute ? "explicit" : (referenceRoute ? "reference" : "none"),
    };
  }
  if (newPattern.test(body)) {
    return {
      action: "new",
      projectCode: route?.projectCode || "",
      sessionCode: "",
      prompt: commandRemainder(body, newPattern),
      routeSource: inlineRoute ? "explicit" : (referenceRoute ? "reference" : "none"),
    };
  }
  if (route?.sessionCode) {
    const prompt = continuePattern.test(body)
      ? commandRemainder(body, continuePattern)
      : body;
    return {
      action: "continue",
      projectCode: route.projectCode,
      sessionCode: route.sessionCode,
      prompt,
      routeSource: inlineRoute ? "explicit" : "reference",
    };
  }
  return {
    action: "unscoped",
    projectCode: route?.projectCode || "",
    sessionCode: "",
    prompt: input,
    routeSource: inlineRoute ? "explicit" : (referenceRoute ? "reference" : "none"),
  };
}
