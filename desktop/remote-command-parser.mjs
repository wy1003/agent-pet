import {
  normalizeProjectCode,
  normalizeSessionCode,
} from "./remote-task-registry.mjs";

// S is the public session prefix. C remains accepted as a legacy alias so
// commands copied from notifications sent before the migration still work.
const FULL_ROUTE_PATTERN = /(^|[^A-Za-z0-9])((?:\/|／)?\s*(P0*\d{1,6})[\/／]([SC]0*\d{1,8}))\b/i;
const SESSION_COMMAND_PATTERN = /(^|[^A-Za-z0-9])((?:\/|／)\s*([SC]0*\d{1,8}))\b/i;
const PROJECT_PATTERN = /(^|[^A-Za-z0-9])((?:\/|／)?\s*(P0*\d{1,6}))\b/i;

function text(value, limit = 4_000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

export function extractRemoteRoute(value) {
  const source = text(value);
  // Find the first route in textual order. Looking for any full route first
  // would skip an earlier /S command and hide ambiguous multi-route input.
  const patterns = [FULL_ROUTE_PATTERN, SESSION_COMMAND_PATTERN, PROJECT_PATTERN];
  const matches = patterns.map((pattern) => source.match(pattern)).filter(Boolean);
  matches.sort((left, right) => (left.index + left[1].length) - (right.index + right[1].length));
  const match = matches[0];
  if (!match) return null;
  if (match[4]) {
    return {
      projectCode: normalizeProjectCode(match[3]),
      sessionCode: normalizeSessionCode(match[4]),
      matchedText: match[2],
    };
  }
  if (/^[SC]/i.test(match[3])) {
    return {
      projectCode: "",
      sessionCode: normalizeSessionCode(match[3]),
      matchedText: match[2],
    };
  }
  return {
    projectCode: normalizeProjectCode(match[3]),
    sessionCode: "",
    matchedText: match[2],
  };
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
  const continuePattern = /^(?:继续|续问|接着)(?:任务)?(?=$|[\s:：，,])/i;

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
  if (!route?.sessionCode && newPattern.test(body)) {
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
