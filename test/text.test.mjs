import test from "node:test";
import assert from "node:assert/strict";
import { cleanUserText, makePreview, makeTitle, toText } from "../src/text.mjs";

test("cleanUserText removes injected project instructions", () => {
  const input = `<agents-instructions>
# Project Instructions
Never use direct timestamps.
</agents-instructions>

介绍一下你自己`;
  assert.equal(cleanUserText(input), "介绍一下你自己");
});

test("cleanUserText removes multiple known context blocks", () => {
  const input = `<environment_context><cwd>D:\\project</cwd></environment_context>
<permissions instructions>private details</permissions instructions>
真正的问题是什么？`;
  assert.equal(cleanUserText(input), "真正的问题是什么？");
});

test("cleanUserText keeps only the explicit request after desktop attachment metadata", () => {
  const input = `<in-app-browser-context source="ambient-ui-state">
Current URL: http://127.0.0.1
</in-app-browser-context>

# Files mentioned by the user:

## screenshot.png

## My request for Codex:
现在我在两个客户端都问了问题，你看看`;
  assert.equal(cleanUserText(input), "现在我在两个客户端都问了问题，你看看");
});

test("toText supports message content arrays", () => {
  assert.equal(toText([{ type: "text", text: "第一段" }, { text: "第二段" }]), "第一段\n第二段");
});

test("title and preview are compact and bounded", () => {
  assert.equal(makeTitle("第一行\n第二行", 20), "第一行 第二行");
  assert.equal(makePreview("123456789", 5), "1234…");
});
