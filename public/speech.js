const activeUtterances = new Map();
const activeAudio = new Map();

function clamp(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function availableVoices() {
  if (!("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices().map((voice) => ({
    voiceURI: voice.voiceURI,
    name: voice.name,
    lang: voice.lang,
    localService: voice.localService,
    default: voice.default,
  }));
}

function reportVoices() {
  window.speechHost?.reportVoices({
    supported: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
    voices: availableVoices(),
  });
}

function finish(id, result) {
  if (!activeUtterances.has(id) && !activeAudio.has(id)) return;
  activeUtterances.delete(id);
  activeAudio.delete(id);
  window.speechHost?.reportResult({ id, ...result });
}

function cancelAudio() {
  for (const [id, audio] of activeAudio) {
    audio.pause();
    finish(id, { ok: false, error: "cancelled" });
  }
}

window.speechHost?.onSpeak((request) => {
  const id = String(request?.id || "");
  const text = String(request?.text || "").trim().slice(0, 500);
  if (!id || !text || !("speechSynthesis" in window)) {
    window.speechHost?.reportResult({ id, ok: false, error: "speech_unavailable" });
    return;
  }

  if (request.cancelPrevious) {
    window.speechSynthesis.cancel();
    cancelAudio();
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const voiceId = String(request?.voiceId || "system");
  const voice = availableVoices().find((candidate) => candidate.voiceURI === voiceId);
  const browserVoice = window.speechSynthesis
    .getVoices()
    .find((candidate) => candidate.voiceURI === voice?.voiceURI);
  if (browserVoice) utterance.voice = browserVoice;
  utterance.lang = browserVoice?.lang || "zh-CN";
  utterance.rate = 2 ** (clamp(request?.rate, -5, 5, 0) / 10);
  utterance.pitch = clamp(request?.pitch, 0.5, 2, 1);
  utterance.volume = clamp(request?.volume, 0, 100, 100) / 100;
  utterance.addEventListener("end", () => finish(id, { ok: true }));
  utterance.addEventListener("error", (event) => {
    finish(id, { ok: false, error: event.error || "synthesis_failed" });
  });
  activeUtterances.set(id, utterance);
  window.speechSynthesis.speak(utterance);
});

window.speechHost?.onPlayAudio((request) => {
  const id = String(request?.id || "");
  const dataUrl = String(request?.dataUrl || "");
  if (!id || !dataUrl.startsWith("data:audio/")) {
    window.speechHost?.reportResult({ id, ok: false, error: "invalid_audio" });
    return;
  }

  if (request.cancelPrevious) {
    window.speechSynthesis?.cancel();
    cancelAudio();
  }

  const audio = new Audio(dataUrl);
  audio.volume = clamp(request?.volume, 0, 100, 100) / 100;
  audio.addEventListener("ended", () => finish(id, { ok: true }));
  audio.addEventListener("error", () => finish(id, { ok: false, error: "audio_playback_failed" }));
  activeAudio.set(id, audio);
  audio.play().catch((error) => {
    finish(id, { ok: false, error: error?.message || "audio_playback_failed" });
  });
});

if ("speechSynthesis" in window) {
  window.speechSynthesis.addEventListener("voiceschanged", reportVoices);
}
reportVoices();
setTimeout(reportVoices, 400);
setTimeout(reportVoices, 1_500);
