const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export function normalizeGptSovitsBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("服务地址必须使用 http 或 https");
  }
  if (url.username || url.password) {
    throw new Error("服务地址中不能包含账号或密码");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function responseError(response, fallback) {
  const detail = String(await response.text()).trim().slice(0, 500);
  return new Error(detail || `${fallback}（HTTP ${response.status}）`);
}

async function request(url, options = {}, timeoutMs = 8_000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function inspectGptSovits(baseUrl) {
  const normalized = normalizeGptSovitsBaseUrl(baseUrl);
  const response = await request(`${normalized}/openapi.json`);
  if (!response.ok) throw await responseError(response, "无法读取 GPT-SoVITS 接口");
  const schema = await response.json();
  if (!schema?.paths?.["/tts"]) throw new Error("目标服务没有提供 GPT-SoVITS /tts 接口");
  return { ok: true, baseUrl: normalized };
}

export async function loadGptSovitsVoice(config) {
  const baseUrl = normalizeGptSovitsBaseUrl(config.baseUrl);
  const gptModelPath = String(config.gptModelPath || "").trim();
  const sovitsModelPath = String(config.sovitsModelPath || "").trim();
  if (!gptModelPath) throw new Error("请先选择 GPT 模型（.ckpt）");
  if (!sovitsModelPath) throw new Error("请先选择 SoVITS 模型（.pth）");

  const gptQuery = new URLSearchParams({ weights_path: gptModelPath });
  const gptResponse = await request(`${baseUrl}/set_gpt_weights?${gptQuery}`, {}, 30_000);
  if (!gptResponse.ok) throw await responseError(gptResponse, "GPT 模型加载失败");

  const sovitsQuery = new URLSearchParams({ weights_path: sovitsModelPath });
  const sovitsResponse = await request(`${baseUrl}/set_sovits_weights?${sovitsQuery}`, {}, 30_000);
  if (!sovitsResponse.ok) throw await responseError(sovitsResponse, "SoVITS 模型加载失败");

  return { ok: true };
}

export async function synthesizeGptSovits(text, config) {
  const baseUrl = normalizeGptSovitsBaseUrl(config.baseUrl);
  const referenceAudioPath = String(config.referenceAudioPath || "").trim();
  const promptText = String(config.promptText || "").trim();
  const input = String(text || "").trim().slice(0, 500);
  if (!referenceAudioPath) throw new Error("请先选择参考音频（.wav）");
  if (!input) throw new Error("试听文本不能为空");

  const response = await request(`${baseUrl}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: input,
      text_lang: config.targetLanguage || "zh",
      ref_audio_path: referenceAudioPath,
      prompt_text: promptText,
      prompt_lang: config.promptLanguage || "ja",
      speed_factor: Number(config.speed) || 1,
      media_type: "wav",
      streaming_mode: false,
    }),
  }, 90_000);
  if (!response.ok) throw await responseError(response, "语音生成失败");

  const declaredLength = Number(response.headers.get("content-length")) || 0;
  if (declaredLength > MAX_AUDIO_BYTES) throw new Error("生成的语音文件过大");
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error("GPT-SoVITS 返回了空音频");
  if (audio.length > MAX_AUDIO_BYTES) throw new Error("生成的语音文件过大");
  return {
    audio,
    mimeType: response.headers.get("content-type")?.split(";")[0] || "audio/wav",
  };
}
