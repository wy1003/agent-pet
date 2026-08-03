import { mkdir } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";
import { PHRASE_POOL_EVENTS, normalizePhrasePool } from "./phrase-pool.mjs";

const TONE_LABELS = {
  cute: "可爱活泼",
  warm: "温柔陪伴",
  concise: "简洁直接",
  formal: "正式稳重",
  custom: "遵循自定义说明",
};

export const PHRASE_POOL_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.fromEntries(
    PHRASE_POOL_EVENTS.map((event) => [event, {
      type: "array",
      minItems: 6,
      maxItems: 10,
      items: { type: "string", minLength: 4, maxLength: 80 },
    }]),
  ),
  required: [...PHRASE_POOL_EVENTS],
  additionalProperties: false,
});

export function copywriterPrompt(style = {}) {
  const addressee = String(style.addressee || "").trim() || "未设置，不要使用{称呼}变量";
  const assistantName = String(style.assistantName || "").trim() || "未设置，不要使用{助手自称}变量";
  const tone = TONE_LABELS[style.tone] || TONE_LABELS.cute;
  const includeProjectName = style.includeProjectName !== false;
  const customInstruction = String(style.customInstruction || "").trim() || "无";
  return `你是 Agent Pet 的中文语音通知文案编辑。请生成一个本地文案池，仅返回符合 JSON Schema 的对象。

用户偏好：
- 对用户的称呼：${addressee}
- 助手自称：${assistantName}
- 语气：${tone}
- 是否提及项目：${includeProjectName ? "是" : "否"}
- 补充风格说明：${customInstruction}

生成要求：
1. 为 needs_input、completed、failed、interrupted、unknown 各生成 8 条简短、自然、适合直接朗读的中文句子。
2. 同一分类的表达要有明显变化，避免只是替换一两个词。
3. 每条尽量不超过 45 个汉字，不能使用 Markdown、编号、表情符号或舞台说明。
4. 只能使用这些可选变量：{称呼}、{助手自称}、{项目名}、{任务名}。
5. 称呼或自称适合出现时使用变量，不要把用户偏好中的实际称呼硬编码进句子。
6. ${includeProjectName ? "多数句子可以自然包含{项目名}，但不要每句都使用。" : "不要使用{项目名}变量。"}
7. 失败和中断文案要友善，不责怪用户；状态未知要表达需要检查，不能声称任务已经失败。
8. 不要生成色情、暴力、侮辱、歧视或令人不适的内容。`;
}

export class CodexCopywriter {
  constructor(options) {
    this.store = options.store;
    this.workingDirectory = options.workingDirectory;
    this.createCodex = options.createCodex || (() => new Codex());
    this.logger = options.logger || console;
    this.delayMs = Math.max(0, Number(options.delayMs ?? 1_500));
    this.retryMs = Math.max(10_000, Number(options.retryMs ?? 15 * 60 * 1000));
    this.timer = null;
    this.retryTimer = null;
    this.pendingStyle = null;
    this.running = null;
    this.abortController = null;
    this.stopped = false;
  }

  schedule(style, delayMs = this.delayMs) {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pendingStyle = structuredClone(style || {});
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#drain().catch((error) => this.logger.warn("[copywriter] generation failed", error));
    }, Math.max(0, Number(delayMs) || 0));
    this.timer.unref?.();
  }

  #scheduleRetry(style) {
    if (this.stopped || this.pendingStyle || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pendingStyle = structuredClone(style || {});
      this.#drain().catch((error) => this.logger.warn("[copywriter] retry failed", error));
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  async #drain() {
    if (this.running || this.stopped) return this.running;
    this.running = (async () => {
      while (this.pendingStyle && !this.stopped) {
        const style = this.pendingStyle;
        this.pendingStyle = null;
        if (await this.store.isFresh(style)) continue;
        try {
          await this.generate(style);
        } catch (error) {
          this.logger.warn("[copywriter] using built-in phrases; Codex will retry later", error);
          this.#scheduleRetry(style);
        }
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  async generate(style) {
    await mkdir(this.workingDirectory, { recursive: true });
    const codex = this.createCodex();
    const thread = codex.startThread({
      workingDirectory: this.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "low",
    });
    this.abortController = new AbortController();
    const timeout = setTimeout(() => this.abortController?.abort(), 10 * 60 * 1000);
    timeout.unref?.();
    try {
      const result = await thread.run(copywriterPrompt(style), {
        outputSchema: PHRASE_POOL_SCHEMA,
        signal: this.abortController.signal,
      });
      const phrases = normalizePhrasePool(JSON.parse(result.finalResponse), {
        minimumPerEvent: 6,
        maximumPerEvent: 10,
      });
      await this.store.saveCodexPool(style, phrases);
      return phrases;
    } finally {
      clearTimeout(timeout);
      this.abortController = null;
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    this.pendingStyle = null;
    this.abortController?.abort();
    await this.running?.catch(() => {});
  }
}
