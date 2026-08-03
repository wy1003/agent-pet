import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PHRASE_POOL_VERSION = 1;
export const PHRASE_POOL_EVENTS = Object.freeze([
  "needs_input",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);

const ALLOWED_PLACEHOLDERS = new Set(["称呼", "助手自称", "项目名", "任务名"]);

export const BUILTIN_PHRASE_POOL = Object.freeze({
  needs_input: Object.freeze([
    "{称呼}，{项目名}正在等你回答呢。",
    "快来看看吧，{项目名}需要你做个决定。",
    "{称呼}，任务暂时停住了，正在等你的指示。",
    "{项目名}有个问题想请你确认一下。",
  ]),
  completed: Object.freeze([
    "{称呼}，{项目名}的任务完成啦，快来看看吧。",
    "终于跑完{项目名}了，可以来看看结果啦。",
    "{项目名}已经顺利完成，可以来验收啦。",
    "{称呼}，这次任务也处理好啦。",
  ]),
  failed: Object.freeze([
    "{称呼}，{项目名}这次没有顺利完成，快来看看吧。",
    "{项目名}遇到了一点问题，需要你检查一下。",
    "任务没能跑完，来看看发生了什么吧。",
    "{称呼}，任务失败了，不过我们可以再试一次。",
  ]),
  interrupted: Object.freeze([
    "{称呼}，{项目名}的任务已经中断。",
    "任务停下来了，需要时可以重新开始。",
    "{项目名}没有继续运行，来确认一下吧。",
    "{称呼}，这次任务提前结束了。",
  ]),
  unknown: Object.freeze([
    "{称呼}，{项目名}的状态暂时无法确认。",
    "{项目名}很久没有更新了，建议检查一下。",
    "任务状态有些不明确，来看看发生了什么吧。",
    "{称呼}，{助手自称}暂时看不清这个任务的状态。",
  ]),
});

function cleanStyle(style = {}) {
  return {
    addressee: String(style.addressee || "").trim().slice(0, 24),
    assistantName: String(style.assistantName || "").trim().slice(0, 24),
    tone: ["cute", "warm", "concise", "formal", "custom"].includes(style.tone)
      ? style.tone
      : "cute",
    includeProjectName: style.includeProjectName !== false,
    customInstruction: String(style.customInstruction || "").trim().slice(0, 240),
  };
}

export function phraseStyleFingerprint(style) {
  return createHash("sha256").update(JSON.stringify(cleanStyle(style))).digest("hex");
}

function cleanPhrase(value) {
  const phrase = String(value || "")
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!phrase || phrase.length > 80) return "";
  for (const match of phrase.matchAll(/\{([^{}]+)\}/g)) {
    if (!ALLOWED_PLACEHOLDERS.has(match[1])) return "";
  }
  if (/[{}]/.test(phrase.replace(/\{(?:称呼|助手自称|项目名|任务名)\}/g, ""))) return "";
  return phrase;
}

export function normalizePhrasePool(value, options = {}) {
  const minimum = Math.max(1, Number(options.minimumPerEvent || 1));
  const maximum = Math.max(minimum, Number(options.maximumPerEvent || 12));
  const result = {};
  for (const event of PHRASE_POOL_EVENTS) {
    const unique = [];
    for (const candidate of Array.isArray(value?.[event]) ? value[event] : []) {
      const phrase = cleanPhrase(candidate);
      if (phrase && !unique.includes(phrase)) unique.push(phrase);
      if (unique.length >= maximum) break;
    }
    if (unique.length < minimum) {
      throw new Error(`文案池中的 ${event} 文案数量不足`);
    }
    result[event] = unique;
  }
  return result;
}

export function builtinPhrasePool() {
  return normalizePhrasePool(BUILTIN_PHRASE_POOL);
}

export class PhrasePoolStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async readRecord() {
    try {
      const record = JSON.parse(await readFile(this.filePath, "utf8"));
      if (record?.version !== PHRASE_POOL_VERSION || record?.source !== "codex") return null;
      return {
        version: PHRASE_POOL_VERSION,
        source: "codex",
        styleFingerprint: String(record.styleFingerprint || ""),
        generatedAt: String(record.generatedAt || ""),
        phrases: normalizePhrasePool(record.phrases),
      };
    } catch {
      return null;
    }
  }

  async isFresh(style) {
    const record = await this.readRecord();
    return Boolean(record && record.styleFingerprint === phraseStyleFingerprint(style));
  }

  async getPhrases(style) {
    const record = await this.readRecord();
    return record?.styleFingerprint === phraseStyleFingerprint(style)
      ? record.phrases
      : builtinPhrasePool();
  }

  async saveCodexPool(style, phrases) {
    const record = {
      version: PHRASE_POOL_VERSION,
      source: "codex",
      styleFingerprint: phraseStyleFingerprint(style),
      generatedAt: new Date().toISOString(),
      phrases: normalizePhrasePool(phrases, { minimumPerEvent: 4 }),
    };
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(directory, `.phrase-pool-${randomUUID()}.json`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await rm(this.filePath, { force: true });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return record;
  }
}
