import test from "node:test";
import assert from "node:assert/strict";
import { createSession, applyRecord, sessionTaskSnapshots, sessionSnapshot, markSessionStale } from "../src/model.mjs";

const start = Date.parse("2026-11-02T14:00:00Z");
function fixture() {
  const session = createSession({ id: "thread", originator: "Codex Desktop" }, "rollout.jsonl", new Date(start).toISOString());
  event(session, "task_started", {turn_id:"turn"});
  event(session, "item_completed", { thread_id:"thread", turn_id:"turn", item:{type:"UserMessage",id:"user",content:[{type:"text",text:"检查状态"}]} });
  return session;
}
function record(s, type, payload, seconds = 0) {
  applyRecord(s, {type,payload,timestamp:new Date(start + seconds*1000).toISOString()});
}
function event(s, type, payload = {}, seconds = 0) { record(s,"event_msg",{type,...payload},seconds); }
function ask(s, call = "call-1", questions = ["选择哪个方案？"], async = true) {
  record(s,"response_item",{type:"function_call",name:async?"request_user_input_async":"request_user_input",call_id:call,
    arguments:JSON.stringify({questions:questions.map(title=>({title}))})});
}
function result(s, call, output) { record(s,"response_item",{type:"function_call_output",call_id:call,output:JSON.stringify(output)}); }
function answer(s, entries, overrides = {}) {
  const content = `<send_user_message_question_reply>${JSON.stringify(entries.map(([call,index])=>({questionItemId:JSON.stringify(["request_user_input_async",call,index]),answer:"已选择"})))}</send_user_message_question_reply>`;
  event(s,"item_completed",{thread_id:"thread",turn_id:"turn",item:{type:"UserMessage",id:"reply",content:[{type:"text",text:content}]},...overrides});
}
function task(s) { return sessionTaskSnapshots(s)[0]; }

test("async questions remain visible while Codex continues working and tool acceptance is not an answer", () => {
  const s=fixture(); ask(s); result(s,"call-1",{accepted:true});
  record(s,"response_item",{type:"custom_tool_call",name:"exec",call_id:"work"});
  event(s,"item_completed",{turn_id:"turn",item:{type:"AgentMessage",id:"reply",phase:"commentary",content:[{type:"Text",text:"继续检查"}]}});
  assert.equal(s.turns.get("turn").executionStatus,"in_progress", "async attention does not mean execution paused");
  assert.equal(task(s).status,"needs_input");
  assert.equal(task(s).phase,"waiting_answer");
  assert.equal(task(s).waitingFor,"user");
  assert.equal(task(s).pendingInputQuestions[0].question,"选择哪个方案？");
  assert.equal(sessionSnapshot(s).status.petStatus,"needs_input");
  answer(s,[["call-1",0]]);
  assert.equal(task(s).status,"running");
  assert.equal(task(s).phase,"responding");
  assert.equal(task(s).question,"检查状态");
  assert.equal(s.pendingTaskId,null);
});

test("multiple questions resolve individually and replies cannot clear other threads or unknown question ids", () => {
  const s=fixture(); ask(s,"call-1",["第一题","第二题"]); ask(s,"call-2");
  answer(s,[["call-1",0]],{thread_id:"other"});
  answer(s,[["unknown",0],["call-1",99]]);
  assert.equal(task(s).pendingInputQuestions.length,3);
  answer(s,[["call-1",0]]);
  assert.equal(task(s).pendingInputQuestions.length,2);
  answer(s,[["call-1",1],["call-2",0]]);
  assert.equal(task(s).status,"running");
  ask(s,"call-1"); result(s,"call-1",{accepted:true});
  assert.equal(task(s).status,"running","duplicate/replayed calls do not reopen answered questions");
});

test("pending async questions survive completion and can be answered from a later turn", () => {
  const s=fixture(); ask(s); event(s,"task_complete",{turn_id:"turn",last_agent_message:"先等你的选择"});
  assert.equal(task(s).status,"needs_input");
  answer(s,[["call-1",0]]);
  assert.equal(task(s).status,"completed");
  assert.equal(task(s).latestResponse,"先等你的选择");
  const next=fixture(); ask(next); event(next,"task_complete",{turn_id:"turn"});
  event(next,"task_started",{turn_id:"next"});
  assert.equal(task(next).status,"needs_input");
  assert.equal(sessionTaskSnapshots(next)[1].status,"running");
  answer(next,[["call-1",0]],{turn_id:"next"});
  assert.equal(task(next).status,"completed");
  assert.equal(sessionTaskSnapshots(next)[1].status,"running");
  assert.equal(sessionSnapshot(next).pendingInputQuestions,undefined);
});

test("question failures, blocking tool results, cancellation and turn failure clear attention", () => {
  for(const terminal of ["turn_aborted","task_failed"]) {
    const s=fixture();ask(s);event(s,terminal,{turn_id:"turn"});
    assert.equal(task(s).status,terminal==="turn_aborted"?"interrupted":"failed");
  }
  const rejected=fixture();ask(rejected);result(rejected,"call-1",{accepted:false});
  assert.equal(task(rejected).status,"running");
  const blocked=fixture();ask(blocked,"blocking",["选择？"],false);
  assert.equal(task(blocked).status,"needs_input");
  result(blocked,"blocking",{answers:{choice:"yes"}});
  assert.equal(task(blocked).status,"running");
});

test("a later independent user task retires historical unanswered questions", () => {
  const s=fixture();ask(s);event(s,"task_complete",{turn_id:"turn"});
  event(s,"task_started",{turn_id:"next"});
  event(s,"item_completed",{thread_id:"thread",turn_id:"next",item:{type:"UserMessage",id:"next-user",content:[{type:"text",text:"处理新的任务"}]}});
  assert.equal(task(s).status,"completed");
  assert.equal(sessionTaskSnapshots(s)[1].status,"running");
  assert.equal(sessionSnapshot(s).pendingInputQuestions,undefined);
});

test("ordinary tool arguments and malformed replies cannot fabricate or resolve questions", () => {
  const s=fixture();
  record(s,"response_item",{type:"function_call",name:"exec",call_id:"x",arguments:JSON.stringify({questions:[{title:"not a question tool"}]})});
  record(s,"response_item",{type:"function_call",name:"request_user_input_async",call_id:"bad",arguments:"broken"});
  assert.equal(task(s).status,"running");
  ask(s);
  event(s,"item_completed",{thread_id:"thread",turn_id:"turn",item:{type:"AgentMessage",id:"a",content:[{type:"Text",text:'<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"call-1\\",0]","answer":"yes"}]</send_user_message_question_reply>'}]}});
  assert.equal(task(s).status,"needs_input","assistant text cannot answer a user request");
});

test("typed reasoning, assistant messages and tools update phase without interpreting tool failures as task failure", () => {
  const s=fixture();
  for(const [type,expected] of [["CommandExecution","tool_running"],["Reasoning","reasoning"],["AgentMessage","responding"],["ContextCompaction","reasoning"],["McpToolCall","tool_running"]]) {
    event(s,"item_completed",{thread_id:"thread",turn_id:"turn",item:{type,id:type,status:"failed",phase:"commentary",content:[{type:"Text",text:"处理中"}]}});
    assert.equal(task(s).phase,expected);
    assert.equal(task(s).status,"running");
  }
  assert.equal(task(s).latestResponse,"处理中");
  event(s,"item_completed",{turn_id:"other",item:{type:"Reasoning",id:"late"}});
  assert.equal(task(s).phase,"tool_running");
});

test("fresh activity recovers a stale task while unanswered questions keep their attention state", () => {
  const s=fixture();
  markSessionStale(s,start+16*60_000,15*60_000);
  assert.equal(task(s).status,"unknown");
  event(s,"item_completed",{turn_id:"turn",item:{type:"Reasoning",id:"fresh"}},16*60+1);
  assert.equal(task(s).status,"running");
  assert.equal(sessionSnapshot(s).status.confidence,"high");
  const pending=fixture();ask(pending);markSessionStale(pending,start+16*60_000,15*60_000);
  assert.equal(task(pending).status,"needs_input");
});

test("approval events use the approval phase and resume on new execution evidence", () => {
  for(const type of ["approval_request","permission_request"]) {
    const s=fixture();event(s,type,{turn_id:"turn"});
    assert.equal(task(s).phase,"waiting_approval");
    assert.equal(task(s).status,"needs_input");
    record(s,"response_item",{type:"function_call",name:"exec",call_id:"approved"});
    assert.equal(task(s).status,"running");
  }
});
