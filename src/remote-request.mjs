export const REMOTE_REQUEST_ORIGIN = "agent-pet-remote";
export const REMOTE_REQUEST_MARKER = '<agent-pet-remote-request version="1">';

const REMOTE_REQUEST_HEADER = "这是从 Agent Pet 远程入口提交的用户请求。";
const LEGACY_REMOTE_REQUEST_HEADERS = Object.freeze([
  "这是从 Agent Pet 已绑定微信的远程入口提交的用户请求。",
]);
const USER_REQUEST_LABEL = "用户请求：";

function text(value, limit = 4_000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

export function buildRemoteRequest(value) {
  const input = text(value);
  if (!input) throw new TypeError("远程任务内容不能为空");
  return [
    REMOTE_REQUEST_MARKER,
    REMOTE_REQUEST_HEADER,
    "仅在当前授权项目中工作，不得绕过权限审批，不得自行扩大任务范围。",
    "如果操作需要更高权限、外部发送、发布或不可逆修改，请停止该操作并在最终答复中说明需要用户回到电脑确认。",
    "",
    USER_REQUEST_LABEL,
    input,
  ].join("\n");
}

export function parseRemoteRequest(value) {
  const input = text(value, 8_000);
  const headers = [REMOTE_REQUEST_HEADER, ...LEGACY_REMOTE_REQUEST_HEADERS];
  const hasMarker = input.startsWith(REMOTE_REQUEST_MARKER);
  if (!hasMarker && !headers.some((header) => input.startsWith(header))) return null;
  const marker = `\n${USER_REQUEST_LABEL}\n`;
  const markerIndex = input.indexOf(marker);
  if (markerIndex < 0) return null;
  const request = input.slice(markerIndex + marker.length).trim();
  if (!request) return null;
  return { origin: REMOTE_REQUEST_ORIGIN, request };
}

export function isRemoteRequestTask(task) {
  if (task?.requestOrigin === REMOTE_REQUEST_ORIGIN) return true;
  return Boolean(parseRemoteRequest(task?.question || task?.title));
}

export { REMOTE_REQUEST_HEADER };
