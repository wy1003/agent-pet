import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_LEVELS = ["brief", "standard", "detailed"];
const MOBILE_PROVIDERS = ["weixin"];
const THEMES = ["system", "light", "dark"];
const TASK_EVENTS = ["needs_input", "completed", "failed", "interrupted", "unknown"];
const VOICE_ENGINES = ["windows", "gpt-sovits"];
const SPEECH_LANGUAGES = ["zh", "ja", "en", "ko", "yue", "auto"];
const VOICE_TONES = ["cute", "warm", "concise", "formal", "custom"];
const PET_RENDER_MODES = ["pixelated", "smooth"];
const PET_REDUCED_MOTION = ["system", "reduce", "full"];

export const DEFAULT_PREFERENCES = Object.freeze({
  version: 13,
  rules: {
    needs_input: true,
    completed: true,
    failed: true,
    interrupted: true,
    unknown: true,
  },
  notifications: {
    windows: {
      enabled: true,
      playSound: true,
      onlyWhenPanelHidden: false,
      openPanelOnClick: true,
    },
    voice: {
      enabled: false,
      engine: "windows",
      voiceId: "system",
      rate: 0,
      pitch: 1,
      volume: 100,
      contentLevel: "standard",
      style: {
        addressee: "",
        assistantName: "",
        tone: "cute",
        includeProjectName: true,
        customInstruction: "",
      },
      gptSovits: {
        baseUrl: "http://127.0.0.1:9880",
        autoStartService: false,
        selectedVoiceId: "",
        gptModelPath: "",
        sovitsModelPath: "",
        referenceAudioPath: "",
        promptText: "",
        promptLanguage: "zh",
        targetLanguage: "zh",
        speed: 1,
      },
    },
    mobile: {
      enabled: false,
      provider: "weixin",
      contentLevel: "standard",
    },
  },
  remoteControl: {
    enabled: false,
  },
  dailyReport: {
    contentLevel: "standard",
  },
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "08:00",
    allowUrgent: true,
  },
  appearance: {
    showPet: true,
    showBadge: true,
    alwaysOnTop: true,
    theme: "system",
    pet: {
      selectedPetId: "builtin-default",
      width: 112,
      renderMode: "smooth",
      hoverAnimation: true,
      lookAtCursor: true,
      reducedMotion: "system",
      flingEnabled: true,
      bounceEnabled: true,
    },
  },
  integrations: {
    petdex: {
      manifestUrl: "https://petdex.dev/api/manifest",
      installToCodexByDefault: false,
    },
  },
  startup: {
    openAtLogin: false,
  },
});

function clone(value) {
  return structuredClone(value);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function numberInRange(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function oneOf(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

function time(value, fallback) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value
    : fallback;
}

function mergeObjects(base, patch) {
  const result = clone(object(base));
  for (const [key, value] of Object.entries(object(patch))) {
    result[key] = object(value) && object(result[key]) === result[key]
      ? mergeObjects(result[key], value)
      : value;
  }
  return result;
}

export function createDefaultPreferences() {
  return clone(DEFAULT_PREFERENCES);
}

export function normalizePreferences(value) {
  const defaults = createDefaultPreferences();
  const input = object(value);
  const inputRules = object(input.rules);
  const rules = {};

  for (const event of TASK_EVENTS) {
    const source = inputRules[event];
    rules[event] = typeof source === "boolean"
      ? source
      : boolean(object(source).windows, defaults.rules[event]);
  }

  const inputNotifications = object(input.notifications);
  const windows = object(inputNotifications.windows);
  const voice = object(inputNotifications.voice);
  const voiceStyle = object(voice.style);
  const resetLegacyStyleNames = Number(input.version || 0) < 8;
  const gptSovits = object(voice.gptSovits);
  const mobile = object(inputNotifications.mobile);
  const remoteControl = object(input.remoteControl);
  const legacyRemoteControlWeixin = object(remoteControl.weixin);
  const dailyReport = object(input.dailyReport);
  const quietHours = object(input.quietHours);
  const appearance = object(input.appearance);
  const pet = object(appearance.pet);
  const migrateBuiltinPetToSmoothRendering = Number(input.version || 0) < 11
    && (!pet.selectedPetId || pet.selectedPetId === "builtin-default")
    && pet.renderMode === "pixelated";
  const integrations = object(input.integrations);
  const petdex = object(integrations.petdex);
  const startup = object(input.startup);
  const showPet = boolean(
    appearance.showPet,
    boolean(appearance.showBadge, defaults.appearance.showPet),
  );

  return {
    version: 13,
    rules,
    notifications: {
      windows: {
        enabled: boolean(windows.enabled, defaults.notifications.windows.enabled),
        playSound: boolean(windows.playSound, defaults.notifications.windows.playSound),
        onlyWhenPanelHidden: boolean(
          windows.onlyWhenPanelHidden,
          defaults.notifications.windows.onlyWhenPanelHidden,
        ),
        openPanelOnClick: boolean(
          windows.openPanelOnClick,
          defaults.notifications.windows.openPanelOnClick,
        ),
      },
      voice: {
        enabled: boolean(voice.enabled, defaults.notifications.voice.enabled),
        engine: oneOf(voice.engine, VOICE_ENGINES, defaults.notifications.voice.engine),
        voiceId: typeof voice.voiceId === "string" && voice.voiceId
          ? voice.voiceId.slice(0, 200)
          : defaults.notifications.voice.voiceId,
        rate: numberInRange(voice.rate, defaults.notifications.voice.rate, -5, 5),
        pitch: numberInRange(voice.pitch, defaults.notifications.voice.pitch, 0.5, 2),
        volume: numberInRange(voice.volume, defaults.notifications.voice.volume, 0, 100),
        contentLevel: oneOf(
          voice.contentLevel,
          CONTENT_LEVELS,
          defaults.notifications.voice.contentLevel,
        ),
        style: {
          addressee: !resetLegacyStyleNames && typeof voiceStyle.addressee === "string"
            ? voiceStyle.addressee.trim().slice(0, 24)
            : defaults.notifications.voice.style.addressee,
          assistantName: !resetLegacyStyleNames && typeof voiceStyle.assistantName === "string"
            ? voiceStyle.assistantName.trim().slice(0, 24)
            : defaults.notifications.voice.style.assistantName,
          tone: oneOf(
            voiceStyle.tone,
            VOICE_TONES,
            defaults.notifications.voice.style.tone,
          ),
          includeProjectName: boolean(
            voiceStyle.includeProjectName,
            defaults.notifications.voice.style.includeProjectName,
          ),
          customInstruction: typeof voiceStyle.customInstruction === "string"
            ? voiceStyle.customInstruction.trim().slice(0, 240)
            : defaults.notifications.voice.style.customInstruction,
        },
        gptSovits: {
          baseUrl: typeof gptSovits.baseUrl === "string" && gptSovits.baseUrl.trim()
            ? gptSovits.baseUrl.trim().slice(0, 1000)
            : defaults.notifications.voice.gptSovits.baseUrl,
          autoStartService: boolean(
            gptSovits.autoStartService,
            defaults.notifications.voice.gptSovits.autoStartService,
          ),
          selectedVoiceId: typeof gptSovits.selectedVoiceId === "string"
            && /^voice-[0-9a-f-]{36}$/i.test(gptSovits.selectedVoiceId)
            ? gptSovits.selectedVoiceId
            : defaults.notifications.voice.gptSovits.selectedVoiceId,
          gptModelPath: typeof gptSovits.gptModelPath === "string"
            ? gptSovits.gptModelPath.slice(0, 2000)
            : defaults.notifications.voice.gptSovits.gptModelPath,
          sovitsModelPath: typeof gptSovits.sovitsModelPath === "string"
            ? gptSovits.sovitsModelPath.slice(0, 2000)
            : defaults.notifications.voice.gptSovits.sovitsModelPath,
          referenceAudioPath: typeof gptSovits.referenceAudioPath === "string"
            ? gptSovits.referenceAudioPath.slice(0, 2000)
            : defaults.notifications.voice.gptSovits.referenceAudioPath,
          promptText: typeof gptSovits.promptText === "string"
            ? gptSovits.promptText.slice(0, 500)
            : defaults.notifications.voice.gptSovits.promptText,
          promptLanguage: oneOf(
            gptSovits.promptLanguage,
            SPEECH_LANGUAGES,
            defaults.notifications.voice.gptSovits.promptLanguage,
          ),
          targetLanguage: oneOf(
            gptSovits.targetLanguage,
            SPEECH_LANGUAGES,
            defaults.notifications.voice.gptSovits.targetLanguage,
          ),
          speed: numberInRange(
            gptSovits.speed,
            defaults.notifications.voice.gptSovits.speed,
            0.5,
            2,
          ),
        },
      },
      mobile: {
        enabled: boolean(mobile.enabled, defaults.notifications.mobile.enabled),
        provider: oneOf(
          mobile.provider,
          MOBILE_PROVIDERS,
          defaults.notifications.mobile.provider,
        ),
        contentLevel: oneOf(
          mobile.contentLevel,
          CONTENT_LEVELS,
          defaults.notifications.mobile.contentLevel,
        ),
      },
    },
    remoteControl: {
      enabled: boolean(
        remoteControl.enabled,
        Number(input.version || 0) < 13
          ? boolean(legacyRemoteControlWeixin.enabled, defaults.remoteControl.enabled)
          : defaults.remoteControl.enabled,
      ),
    },
    dailyReport: {
      contentLevel: oneOf(
        dailyReport.contentLevel,
        CONTENT_LEVELS,
        defaults.dailyReport.contentLevel,
      ),
    },
    quietHours: {
      enabled: boolean(quietHours.enabled, defaults.quietHours.enabled),
      start: time(quietHours.start, defaults.quietHours.start),
      end: time(quietHours.end, defaults.quietHours.end),
      allowUrgent: boolean(quietHours.allowUrgent, defaults.quietHours.allowUrgent),
    },
    appearance: {
      showPet,
      showBadge: showPet,
      alwaysOnTop: boolean(appearance.alwaysOnTop, defaults.appearance.alwaysOnTop),
      theme: oneOf(appearance.theme, THEMES, defaults.appearance.theme),
      pet: {
        selectedPetId: typeof pet.selectedPetId === "string"
          && /^[a-z0-9_-]{1,64}$/i.test(pet.selectedPetId)
          ? pet.selectedPetId
          : defaults.appearance.pet.selectedPetId,
        width: numberInRange(pet.width, defaults.appearance.pet.width, 80, 224),
        renderMode: migrateBuiltinPetToSmoothRendering
          ? "smooth"
          : oneOf(
            pet.renderMode,
            PET_RENDER_MODES,
            defaults.appearance.pet.renderMode,
          ),
        hoverAnimation: boolean(pet.hoverAnimation, defaults.appearance.pet.hoverAnimation),
        lookAtCursor: boolean(pet.lookAtCursor, defaults.appearance.pet.lookAtCursor),
        reducedMotion: oneOf(
          pet.reducedMotion,
          PET_REDUCED_MOTION,
          defaults.appearance.pet.reducedMotion,
        ),
        flingEnabled: boolean(pet.flingEnabled, defaults.appearance.pet.flingEnabled),
        bounceEnabled: boolean(pet.bounceEnabled, defaults.appearance.pet.bounceEnabled),
      },
    },
    integrations: {
      petdex: {
        manifestUrl: typeof petdex.manifestUrl === "string" && petdex.manifestUrl.trim()
          ? petdex.manifestUrl.trim().slice(0, 1000)
          : defaults.integrations.petdex.manifestUrl,
        installToCodexByDefault: boolean(
          petdex.installToCodexByDefault,
          defaults.integrations.petdex.installToCodexByDefault,
        ),
      },
    },
    startup: {
      openAtLogin: boolean(startup.openAtLogin, defaults.startup.openAtLogin),
    },
  };
}

export class PreferenceStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.preferences = createDefaultPreferences();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      this.preferences = normalizePreferences(stored);
      if (stored?.version !== this.preferences.version) await this.save();
    } catch {
      this.preferences = createDefaultPreferences();
    }
    return this.get();
  }

  get() {
    return clone(this.preferences);
  }

  update(patch) {
    const operation = this.queue.then(async () => {
      this.preferences = normalizePreferences(mergeObjects(this.preferences, patch));
      await this.save();
      return this.get();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  reset() {
    const operation = this.queue.then(async () => {
      this.preferences = createDefaultPreferences();
      await this.save();
      return this.get();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.preferences, null, 2)}\n`, "utf8");
  }
}
