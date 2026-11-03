import { toText } from "./text.mjs";

const INPUT_TOOL = /^(?:functions\.)?request_user_input(_async)?$/;

function json(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value; }
  catch { return null; }
}

export function registerInputRequest(session, payload) {
  const match = INPUT_TOOL.exec(payload.name || "");
  const callId = payload.call_id;
  if (!match || !callId || !session.activeTurnId) return false;
  if (session.inputRequests.has(callId)) return true;
  const args = json(payload.arguments ?? payload.input);
  if (!Array.isArray(args?.questions)) return false;
  const questions = new Map();
  args.questions.forEach((question, index) => {
    const title = question?.title ?? question?.question;
    if (typeof title === "string" && title.trim()) questions.set(index, title.trim());
  });
  if (!questions.size) return false;
  session.inputRequests.set(callId, {
    turnId: session.activeTurnId, async: Boolean(match[1]), questions,
  });
  return true;
}

export function resolveInputResult(session, payload) {
  const request = session.inputRequests.get(payload.call_id);
  if (!request) return;
  // The async tool only acknowledges posting the question; it is not an answer.
  if (request.async && json(payload.output)?.accepted === true) return;
  request.questions.clear();
}

export function resolveInputReplies(session, value) {
  return toText(value).replace(
    /<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/g,
    (wrapper, body) => {
      const replies = json(body);
      if (!Array.isArray(replies)) return wrapper;
      for (const reply of replies) {
        const id = json(reply?.questionItemId);
        if (!Array.isArray(id) || !INPUT_TOOL.test(id[0] || "")) continue;
        if (typeof id[1] !== "string" || !Number.isInteger(id[2]) || !Object.hasOwn(reply, "answer")) continue;
        session.inputRequests.get(id[1])?.questions.delete(id[2]);
      }
      return "";
    },
  );
}

export function pendingInputs(session, turnId) {
  const pending = [];
  for (const [callId, request] of session.inputRequests) {
    if (turnId !== undefined && request.turnId !== turnId) continue;
    for (const [index, question] of request.questions) {
      pending.push({ id: `${callId}:${index}`, question });
    }
  }
  return pending;
}

// A later independent user request supersedes old task questions. A reply
// envelope is handled separately, so partial answers can cross turn boundaries.
export function supersedeInputRequests(session, turnId) {
  for (const request of session.inputRequests.values()) {
    if (request.turnId !== turnId) request.questions.clear();
  }
}
