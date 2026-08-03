import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  inspectGptSovits,
  loadGptSovitsVoice,
  normalizeGptSovitsBaseUrl,
  synthesizeGptSovits,
} from "../desktop/gpt-sovits.mjs";

test("GPT-SoVITS base URL normalization accepts HTTP services only", () => {
  assert.equal(normalizeGptSovitsBaseUrl("http://127.0.0.1:9880/"), "http://127.0.0.1:9880");
  assert.throws(() => normalizeGptSovitsBaseUrl("file:///tmp/voice"), /http/);
  assert.throws(() => normalizeGptSovitsBaseUrl("http://user:pass@localhost"), /账号或密码/);
});

test("GPT-SoVITS adapter inspects, loads and synthesizes through the official endpoints", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.url);
    if (request.url === "/openapi.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ paths: { "/tts": { post: {} } } }));
      return;
    }
    if (request.url.startsWith("/set_gpt_weights") || request.url.startsWith("/set_sovits_weights")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "success" }));
      return;
    }
    if (request.url === "/tts" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      assert.equal(payload.text, "任务已经完成");
      assert.equal(payload.prompt_lang, "ja");
      assert.equal(payload.prompt_text, "");
      response.setHeader("content-type", "audio/wav");
      response.end(Buffer.from("RIFF-test-audio"));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config = {
    baseUrl,
    gptModelPath: "D:\\voices\\character.ckpt",
    sovitsModelPath: "D:\\voices\\character.pth",
    referenceAudioPath: "D:\\voices\\reference.wav",
    promptText: "",
    promptLanguage: "ja",
    targetLanguage: "zh",
    speed: 1,
  };

  assert.equal((await inspectGptSovits(baseUrl)).ok, true);
  assert.equal((await loadGptSovitsVoice(config)).ok, true);
  const result = await synthesizeGptSovits("任务已经完成", config);
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.audio.toString(), "RIFF-test-audio");
  assert.equal(requests.length, 4);
});
