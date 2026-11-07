import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  safeStorage,
  screen,
  shell,
  Tray,
} from "electron";
import electronUpdater from "electron-updater";
import { mkdirSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createDesktopCollectors, createDesktopProviders, createDesktopExecutor, DUAL_COLLECTOR_IDENTITY,
  claudeSessionActivity, agentSelectionPatch } from "./agents/desktop-runtime.mjs";
import { installClaudeSettingsIpc, executableResourcePath } from "./agents/claude-settings.mjs";
import { createClaudeLifecycleController } from "./agents/claude-lifecycle.mjs";
import { resolveNodeExecutable, resolveClaudeConfigDirectory } from "./claude/runtime.mjs";
import {
  isCompatibleCollectorHealth,
} from "../src/collector-service-identity.mjs";
import {
  copywriterWorkingDirectory,
  defaultIgnoredProjectPaths,
} from "../src/internal-projects.mjs";
import { createCollectorServer } from "../src/server.mjs";
import { PhrasePoolGenerator } from "./phrase-generator.mjs";
import { AiTextService } from "./ai/text-service.mjs";
import { AiSettingsController, installAiSettingsIpc } from "./ai/settings-controller.mjs";
import { DailyReportGenerator } from "./daily-report.mjs";
import { NotificationOrchestrator } from "./notification-orchestrator.mjs";
import { NotificationHistoryStore } from "./notification-history.mjs";
import { NotebookStore } from "./notebook/notebook-store.mjs";
import { createDesktopBackgroundSource } from "./notebook/desktop-background-source.mjs";
import { createNotebookController } from "./notebook/notebook-controller.mjs";
import { createNotebookTools } from "./notebook/mcp/notebook-tools.mjs";
import { NotebookMcpBridge, notebookMcpConfig } from "./notebook/mcp/bridge-service.mjs";
import { NotebookCodexConnection, installNotebookConnectionIpc } from "./notebook/mcp/codex-connection.mjs";
import { NotebookClaudeConnection, installNotebookClaudeConnectionIpc } from "./notebook/mcp/claude-connection.mjs";
import { RemoteNotificationQueue } from "./remote-notification-queue.mjs";
import { RemoteChannelHub } from "./remote-channel-hub.mjs";
import { RemoteTaskRegistry } from "./remote-task-registry.mjs";
import { CodexRemoteExecutor } from "./codex-remote-executor.mjs";
import { CodexDesktopExecutor } from "./codex-desktop-executor.mjs";
import { RemoteControlController } from "./remote-control-controller.mjs";
import { SecureCredentials } from "./secure-credentials.mjs";
import { WeixinRemoteService } from "./weixin-remote-service.mjs";
import { createWeixinChannelAdapter } from "./remote-channels/weixin-channel.mjs";
import { PhrasePoolStore } from "./phrase-pool.mjs";
import { PreferenceStore } from "./preferences.mjs";
import { TaskEventClient } from "./task-event-client.mjs";
import { VoiceLibrary } from "./voice-library.mjs";
import { VoicePlaybackQueue } from "./voice-playback-queue.mjs";
import { GptSovitsServiceController } from "./gpt-sovits-service.mjs";
import {
  PetStateController,
  resolveAvailablePetState,
} from "./pet/pet-state-controller.mjs";
import { PetLibrary } from "./pet/pet-library.mjs";
import { PET_DOWNLOAD_URL, petConversionPrompt } from "./pet/pet-import-help.mjs";
import { PET_ANIMATION_PROFILE } from "./pet/pet-animation-profile.mjs";
import { PET_DRAG_PROFILE } from "./pet/pet-drag-profile.mjs";
import {
  BUILTIN_PET,
  BUILTIN_PET_ID,
  builtinPetAssetPath,
  builtinPetStateUrls,
} from "./pet/builtin-pet.mjs";
import {
  advanceInertia,
  appendVelocitySample,
  crossedDragThreshold,
  releaseVelocity,
} from "./pet/pet-drag-physics.mjs";
import {
  createPetWindowState,
  petWindowSize,
  restorePetWindowBounds,
} from "./pet/pet-window-state.mjs";
import {
  inspectGptSovits,
  loadGptSovitsVoice,
  synthesizeGptSovits,
} from "./gpt-sovits.mjs";
import {
  badgeBoundsForDrag,
  clampWindowBounds,
} from "./window-layout.mjs";
import {
  LEGACY_MANAGED_DATA_DIRECTORY,
  PRODUCT_APP_ID,
  PRODUCT_NAME,
  migrateLegacyUserData,
  productUserDataPath,
  resolveManagedDataRoot,
} from "./app-paths.mjs";
import {
  createStorageLocations,
  ensureStorageLocationDirectory,
  storageLocationById,
} from "./storage-locations.mjs";
import { agentPetIconPngBuffer } from "./app-icon.mjs";
import { AppUpdater } from "./app-updater.mjs";
import { resolveAppRuntime } from "./app-runtime.mjs";

import { PetWindowFacade } from "./windows/pet-window.mjs";
import { PetMenuWindowFacade } from "./windows/pet-menu-window.mjs";
import { PetMenuController, installPetMenuIpc } from "./windows/pet-menu-controller.mjs";
import { TaskWindowFacade } from "./windows/task-window.mjs";
import { UsageWindowFacade } from "./windows/usage-window.mjs";
import { NotebookWindowFacade } from "./windows/notebook-window.mjs";
import { NotebookWindowController, installNotebookWindowIpc } from "./windows/notebook-window-controller.mjs";
import { SettingsWindowFacade } from "./windows/settings-window.mjs";
import { DailyReportWindowFacade } from "./windows/daily-report-window.mjs";
import { SpeechWindowFacade } from "./windows/speech-window.mjs";
import { CompanionWindowCoordinator } from "./windows/companion-window-coordinator.mjs";

const { autoUpdater } = electronUpdater;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_VERSION = JSON.parse(
  readFileSync(path.resolve(HERE, "..", "package.json"), "utf8"),
).version;
const APP_RUNTIME = resolveAppRuntime({
  appIsPackaged: app.isPackaged,
  appVersion: app.getVersion(),
  packageVersion: PACKAGE_VERSION,
  defaultApp: process.defaultApp,
  explicitDevelopment: process.env.AGENT_PET_DEVELOPMENT === "1",
});

// A desktop process can outlive the terminal or launcher that created it.
// Unavailable stdout/stderr streams (notably EPIPE on Windows) must never crash the GUI.
for (const outputStream of [process.stdout, process.stderr]) {
  outputStream?.on?.("error", () => {});
}

const PRELOAD_PATH = path.join(HERE, "preload.cjs");
const BUILD_ICON_PATH = path.resolve(HERE, "..", "build", "icon.png");
const DEFAULT_SERVICE_URL = "http://127.0.0.1:43123";
const SPEECH_IDLE_RELEASE_MS = 60_000;
const GPT_SOVITS_IDLE_RELEASE_MS = 60_000;
const INITIAL_PET_REVEAL_TIMEOUT_MS = 6_000;
const INITIAL_USER_DATA_PATH = app.getPath("userData");
const PRODUCT_USER_DATA_PATH = productUserDataPath(app.getPath("appData"));
const LEGACY_USER_DATA_PATHS = [
  INITIAL_USER_DATA_PATH,
  path.join(app.getPath("appData"), "Codex Task Companion"),
  path.join(app.getPath("appData"), "codex-activity-collector"),
];

mkdirSync(PRODUCT_USER_DATA_PATH, { recursive: true });
app.setName(PRODUCT_NAME);
if (process.platform === "win32") app.setAppUserModelId(PRODUCT_APP_ID);
app.setPath("userData", PRODUCT_USER_DATA_PATH);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
protocol.registerSchemesAsPrivileged([{
  scheme: "pet-asset",
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let speechWindowPromise = null;
let speechIdleTimer = null;
let tray = null;
let serviceUrl = DEFAULT_SERVICE_URL;
let ownedCollector = null;
let desktopProviders = null;
let ownedServer = null;
let collectorReadyPromise = Promise.resolve();
let quitting = false;
let shutdownStarted = false;
let savePositionTimer = null;
let positionSaveQueue = Promise.resolve();
let desktopWindowsReady = false;
let loadedWindowState = {};
let badgeDrag = null;
let badgeInertiaTimer = null;
let badgeWindowSizeLock = null;
let correctingBadgeWindowSize = false;
let badgeInitialRevealPending = false;
let badgeInitialRevealTimer = null;
let petStateController = null;
let petLibrary = null;
let selectedPet = null;
let preferenceStore = null;
let claudeLifecycle = null;
let voiceLibrary = null;
let gptSovitsService = null;
let gptSovitsIdleTimer = null;
let phrasePoolStore = null;
let codexCopywriter = null;
let aiTextService = null;
let aiSettingsController = null;
let dailyReportGenerator = null;
let taskEventClient = null;
let notificationOrchestrator = null;
let notificationHistory = null;
let voicePlaybackQueue = null;
let remoteNotificationQueue = null;
let secureCredentials = null;
let weixinRemoteService = null;
let weixinChannelAdapter = null;
let remoteChannelHub = null;
let remoteTaskRegistry = null;
let remoteCodexExecutor = null;
let remoteControlController = null;
let appUpdater = null;
let usageProviderRegistry = null;
let agentProviderRegistry = null;
let loadedNotificationVoiceSignature = "";
let managedDataRoot = null;
let notebookStore = null;
let notebookMcpBridge = null;
let speechRequestSerial = 0;
let speechCapabilities = { supported: false, voices: [] };
let resolveSpeechReady = null;
const pendingSpeechRequests = new Map();

// Composition root: window modules own native windows; callers use their facades.
const windowDependencies = {
  createWindow: (options) => new BrowserWindow(options),
  preload: PRELOAD_PATH,
  getServiceUrl: () => serviceUrl,
  getPreferences: () => preferenceStore.get(),
  getWorkArea: () => badgeWindow.getBounds()
    ? workAreaForBounds(badgeWindow.getBounds()) : screen.getPrimaryDisplay().workArea,
  isQuitting: () => quitting,
  productName: PRODUCT_NAME,
  getIcon: () => createAgentPetIcon(256),
  isDark: () => nativeTheme.shouldUseDarkColors,
};
const badgeWindow = new PetWindowFacade({
  ...windowDependencies,
  getInitialBounds: () => restorePetWindowBounds(
    loadedWindowState, screen.getAllDisplays(), screen.getPrimaryDisplay(),
    petWindowSize(preferenceStore.get().appearance.pet.width, 4),
  ),
  onCreated: () => {
    badgeInitialRevealPending = true;
    captureBadgeWindowSizeLock();
  },
  onResize: () => {
    if (!correctingBadgeWindowSize) setImmediate(enforceBadgeWindowSizeLock);
  },
  onMoved: () => { companionWindows.position(); schedulePositionSave(); },
  onVisibilityChanged: rebuildTrayMenu,
});
const popoverDependencies = {
  ...windowDependencies,
  onBlur: () => companionWindows.hideWhenFocusLeaves(),
  onHide: () => companionWindows.hide(),
  onResize: () => companionWindows.position(),
};
const panelWindow = new TaskWindowFacade(popoverDependencies);
const usageWindow = new UsageWindowFacade(popoverDependencies);
const notebookBackgroundSource = createDesktopBackgroundSource();
const notebookWindow = new NotebookWindowFacade({
  ...windowDependencies,
  getWorkArea: () => screen.getPrimaryDisplay().workArea,
  onHide: () => setNotebookVisible(false).catch((error) => console.error("[notebook] hide failed", error)),
  onMoved: schedulePositionSave,
  onBlur: () => notebookWindows.finishDrag(true),
  getBackgroundSource: viewport => notebookBackgroundSource.get(viewport),
  toScreenRect: bounds => process.platform === "win32" ? screen.dipToScreenRect(null, bounds) : bounds,
});
const notebookWindows = new NotebookWindowController({
  window: notebookWindow,
  getPreferences: () => preferenceStore.get(),
  getSavedBounds: () => loadedWindowState.notebookBounds,
  getSavedState: () => loadedWindowState.notebookState,
  getCursorPoint: () => screen.getCursorScreenPoint(),
  onStateChanged: schedulePositionSave,
  getWorkArea: (bounds) => bounds ? workAreaForBounds({ width: 380, height: 460, ...bounds }) : screen.getPrimaryDisplay().workArea,
  isQuitting: () => quitting,
});
const companionWindows = new CompanionWindowCoordinator({
  ...windowDependencies, pet: badgeWindow, tasks: panelWindow, usage: usageWindow,
});
const settingsWindow = new SettingsWindowFacade({
  ...windowDependencies,
  showOpenDialog: (parent, options) => {
    const owner = parent || BrowserWindow.getFocusedWindow();
    return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
  },
});
const dailyReportWindow = new DailyReportWindowFacade(windowDependencies);
const petMenuWindow = new PetMenuWindowFacade({ ...windowDependencies, onDismiss: () => petMenuController.dismiss() });
const petMenuController = new PetMenuController({
  window: petMenuWindow, getPreferences: windowDependencies.getPreferences,
  getCursorPoint: () => screen.getCursorScreenPoint(),
  getWorkArea: point => screen.getDisplayNearestPoint(point).workArea,
  isQuitting: () => quitting,
  actions: { tasks: showTaskList, notebook: toggleNotebook, summary: showDailyReport, settings: showSettings,
    quit: () => { quitting = true; app.quit(); } },
});
const speechWindow = new SpeechWindowFacade({
  ...windowDependencies,
  onClosed: () => {
    cancelSpeechRelease();
    speechCapabilities = { supported: false, voices: [] };
    resolveSpeechReady?.(speechState());
    resolveSpeechReady = null;
    for (const [id, pending] of pendingSpeechRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "speech_window_closed" });
      pendingSpeechRequests.delete(id);
    }
  },
});
const windowFacades = [badgeWindow, petMenuWindow, panelWindow, usageWindow, notebookWindow, settingsWindow, dailyReportWindow, speechWindow];

function statePath() {
  return path.join(app.getPath("userData"), "companion-window.json");
}

function preferencesPath() {
  return path.join(app.getPath("userData"), "preferences.json");
}

function secureCredentialsPath() {
  return path.join(app.getPath("userData"), "secure-credentials.json");
}

function managedRootPath() {
  return managedDataRoot || path.join(app.getPath("userData"), "managed");
}

function voiceLibraryPath() {
  return path.join(managedRootPath(), "voices");
}

function petLibraryPath() {
  return path.join(managedRootPath(), "pets");
}

function gptSovitsEnginePath() {
  return path.join(managedRootPath(), "engines", "GPT-SoVITS");
}

function copywriterPath() {
  return copywriterWorkingDirectory({
    managedRoot: managedRootPath(),
    fallbackRoot: path.join(app.getPath("userData"), "copywriter"),
  });
}

function phrasePoolPath() {
  return path.join(managedRootPath(), "copywriter", "phrase-pool.json");
}

function dailyReportCachePath() {
  return path.join(managedRootPath(), "daily-reports");
}

function notificationAudioCachePath() {
  return path.join(managedRootPath(), "cache", "voice-notifications");
}

function notificationHistoryPath() {
  return path.join(managedRootPath(), "notification-history");
}

function remoteTaskRegistryPath() {
  return path.join(managedRootPath(), "remote-control", "task-registry.json");
}

function scheduleCopywriter(preferences, delayMs) {
  codexCopywriter?.schedule(preferences.notifications.voice.style, delayMs);
}

function settingsState() {
  return {
    preferences: preferenceStore.get(),
    aiStatus: aiTextService?.snapshot(),
    agentProviders: agentProviderRegistry?.snapshot() || {
      activeProviderId: "",
      providers: [],
    },
    capabilities: {
      openAtLogin: APP_RUNTIME.packaged,
      voiceDelivery: speechCapabilities.supported,
      mobileDelivery: true,
    },
  };
}

function activateAgentProvider(preferences = preferenceStore?.get()) {
  if (!agentProviderRegistry || !preferences) return null;
  let provider;
  try {
    provider = agentProviderRegistry.setActiveProvider(preferences.agent.activeProviderId);
  } catch {
    provider = agentProviderRegistry.setActiveProvider("codex");
  }
  // Resolve old single-source API preferences only; collection and desktop usage stay dual-source.
  usageProviderRegistry?.setActiveProvider(preferences.agent.usageProviderId === "active"
    ? provider.usageProviderId : preferences.agent.usageProviderId);
  sendPetState();
  if (usageWindow?.isVisible()) usageWindow.refresh();
  return provider;
}

function remoteControlState() {
  const fallback = preferenceStore?.get()?.remoteControl || {};
  const controller = remoteControlController?.status();
  return {
    available: Boolean(
      remoteControlController
      && remoteTaskRegistry
      && remoteChannelHub,
    ),
    enabled: controller?.enabled === true || (!controller && fallback.enabled === true),
    projectCount: controller?.projects?.length || remoteTaskRegistry?.listProjects().length || 0,
  };
}

function emitRemoteControlState() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.send("remote-control:changed", remoteControlState());
  }
}

function storageLocationsState() {
  return createStorageLocations({
    appDataPath: app.getPath("userData"),
    managedDataPath: managedRootPath(),
    notificationHistoryPath: notificationHistoryPath(),
  });
}

function captureBadgeWindowSizeLock() {
  if (!badgeWindow || badgeWindow.isDestroyed()) return null;
  const bounds = badgeWindow.getBounds();
  badgeWindowSizeLock = { width: bounds.width, height: bounds.height };
  return badgeWindowSizeLock;
}

function setBadgeWindowBoundsLocked(bounds, workArea) {
  if (!badgeWindow || badgeWindow.isDestroyed()) return;
  const currentBounds = badgeWindow.getBounds();
  const size = badgeWindowSizeLock || {
    width: currentBounds.width,
    height: currentBounds.height,
  };
  const nextBounds = {
    ...currentBounds,
    ...bounds,
    width: size.width,
    height: size.height,
  };
  correctingBadgeWindowSize = true;
  try {
    badgeWindow.setBounds(
      workArea ? clampWindowBounds(nextBounds, workArea) : nextBounds,
      false,
    );
  } finally {
    correctingBadgeWindowSize = false;
  }
}

function enforceBadgeWindowSizeLock() {
  if (!badgeWindow || badgeWindow.isDestroyed() || !badgeWindowSizeLock
    || correctingBadgeWindowSize) return;
  const bounds = badgeWindow.getBounds();
  if (bounds.width === badgeWindowSizeLock.width
    && bounds.height === badgeWindowSizeLock.height) return;
  setBadgeWindowBoundsLocked({ x: bounds.x, y: bounds.y }, workAreaForBounds(bounds));
}

function finishInitialPetReveal(reason) {
  if (!badgeInitialRevealPending) return false;
  badgeInitialRevealPending = false;
  clearTimeout(badgeInitialRevealTimer);
  badgeInitialRevealTimer = null;
  if (!badgeWindow || badgeWindow.isDestroyed()
    || !preferenceStore?.get().appearance.showPet) return false;
  // Recreate the Windows layered surface after the custom asset has rendered.
  // Doing this while the prewarmed window is fully transparent avoids a visible flash
  // and mirrors the hide/show cycle that previously made the pet appear manually.
  badgeWindow.hide();
  badgeWindow.setOpacity(1);
  sendPetState();
  badgeInitialRevealTimer = setTimeout(() => {
    badgeInitialRevealTimer = null;
    if (!badgeWindow || badgeWindow.isDestroyed()
      || !preferenceStore?.get().appearance.showPet) return;
    const bounds = badgeWindow.getBounds();
    badgeWindow.setBounds(bounds, false);
    sendPetState();
    badgeWindow.showInactive();
    badgeWindow.invalidate();
    console.log(`[companion] badge window visible (${reason})`);
  }, 100);
  return true;
}

function applyPreferences(preferences) {
  nativeTheme.themeSource = preferences.appearance.theme;
  activateAgentProvider(preferences);

  if (badgeWindow && !badgeWindow.isDestroyed()) {
    badgeWindow.setAlwaysOnTop(preferences.appearance.alwaysOnTop, "floating");
    const size = petWindowSize(preferences.appearance.pet.width, 4);
    const currentBounds = badgeWindow.getBounds();
    const workArea = workAreaForBounds(currentBounds);
    correctingBadgeWindowSize = true;
    try {
      badgeWindow.setBounds(clampWindowBounds({
        ...currentBounds,
        width: size.width,
        height: size.height,
      }, workArea), false);
      captureBadgeWindowSizeLock();
    } finally {
      correctingBadgeWindowSize = false;
    }
    sendPetState();
    schedulePositionSave();
    if (preferences.appearance.showPet) {
      badgeWindow.setOpacity(badgeInitialRevealPending ? 0 : 1);
      badgeWindow.showInactive();
    } else {
      badgeWindow.setOpacity(1);
      badgeWindow.hide();
    }
  }
  companionWindows.applyPreferences().catch((error) => {
    console.error("[companion] display preferences failed", error);
  });
  if (desktopWindowsReady) notebookWindows.applyPreferences().catch((error) => {
    console.error("[notebook] display preferences failed", error);
  });
  settingsWindow.send("notebook:visibility-changed", preferences.appearance.showNotebook);
  if (APP_RUNTIME.packaged) {
    app.setLoginItemSettings({ openAtLogin: preferences.startup.openAtLogin });
  }
  rebuildTrayMenu();
}

async function readWindowState() {
  try {
    return JSON.parse(await readFile(statePath(), "utf8"));
  } catch {
    return {};
  }
}

async function saveWindowState() {
  if (!badgeWindow || badgeWindow.isDestroyed()) return;
  const bounds = badgeWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const state = createPetWindowState(
    loadedWindowState,
    bounds,
    display,
    preferenceStore.get().appearance.pet,
  );
  state.notebookState = notebookWindows.getState();
  state.notebookBounds = state.notebookState.expandedBounds || loadedWindowState.notebookBounds;
  const targetPath = statePath();
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  const operation = positionSaveQueue.then(async () => {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, targetPath);
    loadedWindowState = state;
  });
  positionSaveQueue = operation.catch(() => {});
  await operation;
}

function schedulePositionSave() {
  clearTimeout(savePositionTimer);
  savePositionTimer = setTimeout(() => {
    saveWindowState().catch(() => {});
  }, 250);
}

function keepPetOnVisibleDisplay() {
  if (!badgeWindow || badgeWindow.isDestroyed()) return;
  stopBadgeDrag();
  const currentBounds = badgeWindow.getBounds();
  const displays = screen.getAllDisplays();
  const matchingDisplay = displays.find((display) => {
    const area = display.workArea;
    const centerX = currentBounds.x + currentBounds.width / 2;
    const centerY = currentBounds.y + currentBounds.height / 2;
    return centerX >= area.x && centerX <= area.x + area.width
      && centerY >= area.y && centerY <= area.y + area.height;
  });
  const targetDisplay = matchingDisplay || screen.getDisplayNearestPoint({
    x: currentBounds.x + Math.round(currentBounds.width / 2),
    y: currentBounds.y + Math.round(currentBounds.height / 2),
  });
  setBadgeWindowBoundsLocked(currentBounds, targetDisplay.workArea);
  companionWindows.position();
  schedulePositionSave();
}

function installDisplayHandlers() {
  const restoreVisibility = () => { keepPetOnVisibleDisplay(); notebookWindows.keepOnScreen(); };
  screen.on("display-added", restoreVisibility);
  screen.on("display-removed", restoreVisibility);
  screen.on("display-metrics-changed", restoreVisibility);
}

function availablePetStates(pet = selectedPet || BUILTIN_PET) {
  return pet.format === "state-gifs" ? Object.keys(pet.states) : null;
}

function petStatePayload(state = petStateController?.snapshot()) {
  const preferences = preferenceStore?.get()?.appearance?.pet || {};
  const pet = selectedPet || BUILTIN_PET;
  const availableStates = availablePetStates(pet);
  const requestedState = state || { state: "idle", generation: 0, oneShot: false, count: 0 };
  const stateUrls = pet.format !== "state-gifs"
    ? {}
    : pet.id === BUILTIN_PET_ID
      ? builtinPetStateUrls()
      : Object.fromEntries(Object.entries(pet.states).map(([name, fileName]) => [
        name,
        `pet-asset://library/${encodeURIComponent(pet.id)}/${encodeURIComponent(fileName)}`,
      ]));
  const spriteUrl = pet.format === "spritesheet"
    ? `pet-asset://library/${encodeURIComponent(pet.id)}/${encodeURIComponent(pet.spritesheetPath)}`
    : "";
  return {
    ...requestedState,
    state: resolveAvailablePetState(requestedState.state, availableStates),
    animationProfile: PET_ANIMATION_PROFILE,
    agent: {
      providerId: "multi-agent",
      displayName: "Codex + Claude Code",
    },
    pet: {
      id: pet.id,
      format: pet.format,
      spriteUrl,
      stateUrls,
      spriteVersionNumber: pet.spriteVersionNumber || 1,
      width: preferences.width || 112,
      renderMode: preferences.renderMode || "smooth",
      reducedMotion: preferences.reducedMotion || "system",
    },
  };
}

async function refreshSelectedPet(selectedPetId = preferenceStore.get().appearance.pet.selectedPetId) {
  if (!selectedPetId || selectedPetId === "builtin-default") {
    selectedPet = null;
    return null;
  }
  try {
    selectedPet = await petLibrary.get(selectedPetId);
  } catch {
    selectedPet = null;
  }
  return selectedPet;
}

async function petLibraryState() {
  return {
    rootPath: petLibrary.rootPath,
    selectedPetId: selectedPet?.id || "builtin-default",
    pets: await petLibrary.list(),
  };
}

function sendPetState(state = petStateController?.snapshot(), overrideState = "") {
  if (!badgeWindow || badgeWindow.isDestroyed() || badgeWindow.isLoading()) return;
  const payload = petStatePayload(state);
  if (overrideState) {
    const pet = selectedPet || BUILTIN_PET;
    const availableStates = availablePetStates(pet);
    payload.state = resolveAvailablePetState(overrideState, availableStates);
  }
  badgeWindow.updateState(payload);
}

function restorePetAnimation() {
  sendPetState();
}

function stopPetInertia(options = {}) {
  if (badgeInertiaTimer) clearInterval(badgeInertiaTimer);
  badgeInertiaTimer = null;
  if (options.restore !== false) restorePetAnimation();
}

function finishPetMotion(reopenPanel = false) {
  stopPetInertia();
  enforceBadgeWindowSizeLock();
  companionWindows.position();
  schedulePositionSave();
  if (reopenPanel) companionWindows.resume().catch((error) => console.error("[companion] resume failed", error));
}

function stopBadgeDrag() {
  const reopenPanel = Boolean(badgeDrag?.panelWasVisible);
  badgeDrag = null;
  stopPetInertia();
  enforceBadgeWindowSizeLock();
  companionWindows.position();
  schedulePositionSave();
  if (reopenPanel) companionWindows.resume().catch((error) => console.error("[companion] resume failed", error));
}

function pointerValue(value) {
  const pointerId = Number(value?.pointerId);
  const x = Number(value?.screenX);
  const y = Number(value?.screenY);
  const time = Number(value?.time);
  if (!Number.isFinite(pointerId) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { pointerId, x, y, time: Number.isFinite(time) ? time : Date.now() };
}

function startPetPointer(value) {
  if (!badgeWindow || badgeWindow.isDestroyed()) return;
  const pointer = pointerValue(value);
  if (!pointer) return;
  stopPetInertia({ restore: false });
  enforceBadgeWindowSizeLock();
  badgeDrag = {
    pointerId: pointer.pointerId,
    initialBounds: badgeWindow.getBounds(),
    initialCursor: { x: pointer.x, y: pointer.y },
    dragging: false,
    direction: "right",
    samples: [{ x: pointer.x, y: pointer.y, time: pointer.time }],
    panelWasVisible: false,
  };
}

function movePetPointer(value) {
  const pointer = pointerValue(value);
  if (!pointer || !badgeDrag || pointer.pointerId !== badgeDrag.pointerId
    || !badgeWindow || badgeWindow.isDestroyed()) return;
  const current = { x: pointer.x, y: pointer.y };
  if (!badgeDrag.dragging) {
    if (!crossedDragThreshold(badgeDrag.initialCursor, current)) return;
    badgeDrag.dragging = true;
    badgeDrag.panelWasVisible = companionWindows.isOpen();
    companionWindows.hide();
  }
  const horizontalDelta = current.x - (badgeDrag.lastCursor?.x ?? badgeDrag.initialCursor.x);
  if (Math.abs(horizontalDelta) >= 1) badgeDrag.direction = horizontalDelta > 0 ? "right" : "left";
  badgeDrag.lastCursor = current;
  badgeDrag.samples = appendVelocitySample(badgeDrag.samples, {
    x: pointer.x,
    y: pointer.y,
    time: pointer.time,
  });
  const workArea = screen.getDisplayNearestPoint(current).workArea;
  const nextBounds = badgeBoundsForDrag(
    badgeDrag.initialBounds,
    badgeDrag.initialCursor,
    current,
    workArea,
  );
  setBadgeWindowBoundsLocked(
    { x: Math.round(nextBounds.x), y: Math.round(nextBounds.y) },
    workArea,
  );
  sendPetState(undefined, `running-${badgeDrag.direction}`);
}

function startPetInertia(velocity, reopenPanel) {
  if (!badgeWindow || badgeWindow.isDestroyed()) return;
  const bounds = badgeWindow.getBounds();
  let motion = {
    x: bounds.x,
    y: bounds.y,
    velocityX: velocity.x,
    velocityY: velocity.y,
    durationMs: 0,
  };
  let previousTime = Date.now();
  const preferences = preferenceStore.get().appearance.pet;
  const profile = preferences.bounceEnabled
    ? PET_DRAG_PROFILE
    : { ...PET_DRAG_PROFILE, bounceFactor: 0 };
  badgeInertiaTimer = setInterval(() => {
    if (!badgeWindow || badgeWindow.isDestroyed() || !badgeWindow.isVisible()) {
      finishPetMotion(false);
      return;
    }
    const now = Date.now();
    const currentBounds = badgeWindow.getBounds();
    const display = screen.getDisplayMatching(currentBounds);
    motion = advanceInertia(
      motion,
      now - previousTime,
      display.workArea,
      currentBounds,
      profile,
    );
    previousTime = now;
    setBadgeWindowBoundsLocked(
      { x: Math.round(motion.x), y: Math.round(motion.y) },
      display.workArea,
    );
    sendPetState(undefined, `running-${motion.velocityX < 0 ? "left" : "right"}`);
    if (motion.done) finishPetMotion(reopenPanel);
  }, PET_DRAG_PROFILE.frameMs);
}

function endPetPointer(value, cancelled = false) {
  const pointer = pointerValue(value);
  if (!badgeDrag || (pointer && pointer.pointerId !== badgeDrag.pointerId)) return;
  const drag = badgeDrag;
  badgeDrag = null;
  if (!drag.dragging) {
    restorePetAnimation();
    if (!cancelled) togglePanel();
    return;
  }
  if (pointer) {
    drag.samples = appendVelocitySample(drag.samples, {
      x: pointer.x,
      y: pointer.y,
      time: pointer.time,
    });
  }
  const preferences = preferenceStore.get().appearance.pet;
  const velocity = cancelled || !preferences.flingEnabled
    ? { x: 0, y: 0, speed: 0 }
    : releaseVelocity(drag.samples);
  if (velocity.speed > 0) startPetInertia(velocity, drag.panelWasVisible);
  else finishPetMotion(drag.panelWasVisible);
}

async function collectorServiceHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_200) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function ensureCollectorService() {
  const existingHealth = await collectorServiceHealth(DEFAULT_SERVICE_URL);
  if (isCompatibleCollectorHealth(existingHealth, DUAL_COLLECTOR_IDENTITY)) {
    collectorReadyPromise = Promise.resolve();
    console.log(`[companion] attached to ${DEFAULT_SERVICE_URL}`);
    return DEFAULT_SERVICE_URL;
  }
  if (existingHealth) {
    console.log("[companion] port 43123 belongs to another collector; using an isolated port");
  }

  console.log("[companion] starting the embedded collector");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const { collector } = createDesktopCollectors({
    codexHome,
    userData: app.getPath("userData"),
    claudeRoot: path.join(managedRootPath(), "claude"),
    ignoredProjectPaths: defaultIgnoredProjectPaths({
      managedRoot: managedRootPath(),
      localAppData: process.env.LOCALAPPDATA,
      fallbackRoot: path.join(app.getPath("userData"), "copywriter"),
    }),
  });

  let api = createCollectorServer(collector, {
    host: "127.0.0.1",
    port: existingHealth ? 0 : 43123,
    serviceIdentity: DUAL_COLLECTOR_IDENTITY,
  });
  try {
    await api.start();
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    await api.stop();
    const racedHealth = await collectorServiceHealth(DEFAULT_SERVICE_URL);
    if (isCompatibleCollectorHealth(racedHealth, DUAL_COLLECTOR_IDENTITY)) {
      collectorReadyPromise = Promise.resolve();
      return DEFAULT_SERVICE_URL;
    }
    api = createCollectorServer(collector, {
      host: "127.0.0.1",
      port: 0,
      serviceIdentity: DUAL_COLLECTOR_IDENTITY,
    });
    await api.start();
  }

  const address = api.server.address();
  ownedCollector = collector;
  ownedServer = api;
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`[companion] embedded collector ready at ${url}`);
  collectorReadyPromise = collector.start();
  collectorReadyPromise
    .then(() => console.log("[companion] collector initial scan complete"))
    .catch((error) => {
      console.error("[companion] collector initial scan failed", error);
    });
  return url;
}

function workAreaForBounds(bounds) {
  const point = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  };
  return screen.getDisplayNearestPoint(point).workArea;
}

async function showPanel(options) {
  try {
    return await companionWindows.show(options);
  } catch (error) {
    console.error("[companion] task panel failed", error);
    return false;
  }
}

function showTaskList() { return showPanel({ forceTasks: true }); }
async function setNotebookVisible(visible) {
  if (quitting) return false;
  const preferences = await preferenceStore.update({ appearance: { showNotebook: visible } });
  settingsWindow.send("notebook:visibility-changed", preferences.appearance.showNotebook);
  rebuildTrayMenu();
  return notebookWindows.applyPreferences({ focus: visible });
}
function toggleNotebook() {
  return setNotebookVisible(!preferenceStore.get().appearance.showNotebook)
    .catch((error) => console.error("[notebook] visibility failed", error));
}

async function togglePanel() {
  try {
    return await companionWindows.toggle();
  } catch (error) {
    console.error("[companion] popovers failed", error);
    return false;
  }
}

async function showBadgeMenu() {
  if (badgeWindow.isDestroyed() || quitting) return false;
  try { return await petMenuController.open(); }
  catch (error) {
    console.error("[companion] custom pet menu failed", error);
    showNativeBadgeMenu();
    return false;
  }
}

function showNativeBadgeMenu() {
  if (!badgeWindow || badgeWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: "打开任务列表", click: showTaskList },
    { label: preferenceStore.get().appearance.showNotebook ? "隐藏记事板" : "打开记事板", click: toggleNotebook },
    {
      label: "总结今日工作",
      click: () => showDailyReport().catch((error) => console.error("[daily-report] window failed", error)),
    },
    {
      label: "设置",
      click: () => showSettings().catch((error) => console.error("[companion] settings failed", error)),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  badgeWindow.popupMenu(menu);
}

function showDailyReport() { return dailyReportWindow.show(); }

function showSettings() { return settingsWindow.show(); }

function speechState() {
  return {
    supported: speechCapabilities.supported,
    voices: speechCapabilities.voices.map((voice) => ({ ...voice })),
  };
}

function cancelSpeechRelease() {
  if (speechIdleTimer) clearTimeout(speechIdleTimer);
  speechIdleTimer = null;
}

function scheduleSpeechRelease() {
  if (pendingSpeechRequests.size) return;
  cancelSpeechRelease();
  speechIdleTimer = setTimeout(() => {
    speechIdleTimer = null;
    if (pendingSpeechRequests.size) return;
    if (speechWindow && !speechWindow.isDestroyed()) speechWindow.destroy();
  }, SPEECH_IDLE_RELEASE_MS);
  speechIdleTimer.unref?.();
}

function updateSpeechCapabilities(value) {
  const previousSignature = `${speechCapabilities.supported}:${speechCapabilities.voices.map((voice) => voice.voiceURI).join("|")}`;
  const voices = Array.isArray(value?.voices)
    ? value.voices.slice(0, 100).map((voice) => ({
      voiceURI: String(voice?.voiceURI || "").slice(0, 500),
      name: String(voice?.name || "").slice(0, 200),
      lang: String(voice?.lang || "").slice(0, 40),
      localService: Boolean(voice?.localService),
      default: Boolean(voice?.default),
    })).filter((voice) => voice.voiceURI && voice.name)
    : [];
  speechCapabilities = {
    supported: Boolean(value?.supported),
    voices,
  };
  const nextSignature = `${speechCapabilities.supported}:${voices.map((voice) => voice.voiceURI).join("|")}`;
  if (nextSignature !== previousSignature) {
    console.log(
      `[companion] speech ${speechCapabilities.supported ? "ready" : "unavailable"} (${voices.length} voices)`,
    );
  }
  resolveSpeechReady?.(speechState());
  resolveSpeechReady = null;
}

function settleSpeechRequest(value) {
  const id = String(value?.id || "");
  const pending = pendingSpeechRequests.get(id);
  if (!pending) return;
  pendingSpeechRequests.delete(id);
  clearTimeout(pending.timer);
  pending.resolve({
    ok: Boolean(value?.ok),
    error: value?.ok ? null : String(value?.error || "synthesis_failed"),
  });
  scheduleSpeechRelease();
}

async function requestSpeech(text, options = {}) {
  cancelSpeechRelease();
  await ensureSpeechWindow();
  if (!speechCapabilities.supported || !speechWindow || speechWindow.isDestroyed()) {
    scheduleSpeechRelease();
    return { ok: false, error: "speech_unavailable" };
  }
  const id = `speech-${Date.now()}-${++speechRequestSerial}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSpeechRequests.delete(id);
      resolve({ ok: false, error: "speech_timeout" });
      scheduleSpeechRelease();
    }, 30_000);
    pendingSpeechRequests.set(id, { resolve, timer });
    speechWindow.send("speech:speak", {
      id,
      text: String(text || "").trim().slice(0, 500),
      voiceId: String(options.voiceId || "system"),
      rate: Number(options.rate) || 0,
      pitch: Number(options.pitch) || 1,
      volume: Number.isFinite(Number(options.volume)) ? Number(options.volume) : 100,
      cancelPrevious: options.cancelPrevious !== false,
    });
  });
}

async function requestAudioPlayback(audio, mimeType = "audio/wav", options = {}) {
  cancelSpeechRelease();
  await ensureSpeechWindow();
  if (!speechWindow || speechWindow.isDestroyed()) {
    scheduleSpeechRelease();
    return { ok: false, error: "speech_window_unavailable" };
  }
  const id = `audio-${Date.now()}-${++speechRequestSerial}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSpeechRequests.delete(id);
      resolve({ ok: false, error: "audio_playback_timeout" });
      scheduleSpeechRelease();
    }, 60_000);
    pendingSpeechRequests.set(id, { resolve, timer });
    speechWindow.send("speech:play-audio", {
      id,
      dataUrl: `data:${mimeType};base64,${audio.toString("base64")}`,
      volume: Number.isFinite(Number(options.volume)) ? Number(options.volume) : 100,
      cancelPrevious: options.cancelPrevious !== false,
    });
  });
}

function gptSovitsPreferences() {
  return preferenceStore.get().notifications.voice.gptSovits;
}

function cancelGptSovitsRelease() {
  if (gptSovitsIdleTimer) clearTimeout(gptSovitsIdleTimer);
  gptSovitsIdleTimer = null;
}

function scheduleGptSovitsRelease() {
  cancelGptSovitsRelease();
  if (!gptSovitsService?.hasManagedProcess()) return;
  gptSovitsIdleTimer = setTimeout(() => {
    gptSovitsIdleTimer = null;
    gptSovitsService.stop().catch((error) => {
      console.error("[companion] GPT-SoVITS idle stop failed", error);
    });
  }, GPT_SOVITS_IDLE_RELEASE_MS);
  gptSovitsIdleTimer.unref?.();
}

async function selectedGptSovitsConfig() {
  const preferences = gptSovitsPreferences();
  if (preferences.selectedVoiceId) {
    const voice = await voiceLibrary.get(preferences.selectedVoiceId);
    if (!voice.valid) throw new Error("当前音色文件不完整，请重新添加音色");
    return {
      ...preferences,
      gptModelPath: voice.gptModelPath,
      sovitsModelPath: voice.sovitsModelPath,
      referenceAudioPath: voice.referenceAudioPath,
      promptText: voice.promptText,
      promptLanguage: voice.promptLanguage,
    };
  }
  if (preferences.gptModelPath && preferences.sovitsModelPath && preferences.referenceAudioPath) {
    return preferences;
  }
  throw new Error("请先添加并选择一个 GPT-SoVITS 音色");
}

function isManagedGptSovitsUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "9880";
  } catch {
    return false;
  }
}

async function waitForGptSovitsReady(baseUrl, timeoutMs = 3 * 60 * 1000) {
  cancelGptSovitsRelease();
  const preferences = gptSovitsPreferences();
  if (isManagedGptSovitsUrl(baseUrl)) {
    const status = await gptSovitsService.status();
    if (!status.installed) throw new Error("GPT-SoVITS 尚未安装完成");
    if (!preferences.autoStartService) return inspectGptSovits(baseUrl);
    if (status.state !== "running") await gptSovitsService.start();
  } else {
    return inspectGptSovits(baseUrl);
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      return await inspectGptSovits(baseUrl);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw lastError || new Error("GPT-SoVITS 服务未就绪");
}

async function synthesizeNotificationAudio(text) {
  const config = await selectedGptSovitsConfig();
  try {
    await waitForGptSovitsReady(config.baseUrl);
    const signature = JSON.stringify({
      baseUrl: config.baseUrl,
      gptModelPath: config.gptModelPath,
      sovitsModelPath: config.sovitsModelPath,
    });
    if (loadedNotificationVoiceSignature !== signature) {
      await loadGptSovitsVoice(config);
      loadedNotificationVoiceSignature = signature;
    }
    return await synthesizeGptSovits(text, config);
  } finally {
    scheduleGptSovitsRelease();
  }
}

function showTaskWindowsNotification({ task, event, text, preferences }) {
  if (!Notification.isSupported()) {
    return { ok: false, status: "failed", reason: "windows_notifications_unsupported" };
  }
  if (preferences.notifications.windows.onlyWhenPanelHidden && panelWindow?.isVisible()) {
    return { ok: false, status: "skipped", reason: "panel_visible" };
  }
  const titles = {
    needs_input: "任务正在等待你",
    completed: "任务已完成",
    failed: "任务运行失败",
    interrupted: "任务已中断",
    unknown: "任务状态需要检查",
  };
  const notification = new Notification({
    title: titles[event] || "任务状态已更新",
    body: String(text || task?.title || "任务状态已更新").slice(0, 180),
    silent: !preferences.notifications.windows.playSound,
  });
  if (preferences.notifications.windows.openPanelOnClick) notification.on("click", showTaskList);
  notification.show();
  return { ok: true, status: "sent" };
}

function createNotificationServices() {
  voicePlaybackQueue = new VoicePlaybackQueue({
    cacheDirectory: notificationAudioCachePath(),
    getPreferences: () => preferenceStore.get(),
    synthesizeAudio: (text) => synthesizeNotificationAudio(text),
    allowPreGeneration: () => gptSovitsService?.hasManagedProcess() === true,
    playAudio: (audio, mimeType, preferences) => requestAudioPlayback(audio, mimeType, {
      volume: preferences.notifications.voice.volume,
      cancelPrevious: false,
    }),
    speakText: (text, preferences) => requestSpeech(text, {
      voiceId: preferences.notifications.voice.voiceId,
      rate: preferences.notifications.voice.rate,
      pitch: preferences.notifications.voice.pitch,
      volume: preferences.notifications.voice.volume,
      cancelPrevious: false,
    }),
    onDelivery: (delivery) => notificationOrchestrator?.handleVoiceDelivery(delivery),
  });
  remoteNotificationQueue = new RemoteNotificationQueue({
    sendMessage: (item, options) => {
      const target = remoteChannelHub.getDefaultTarget(item.channelId, item.accountId);
      if (!target.conversationId) {
        const error = new Error("远程渠道尚未绑定可接收通知的会话");
        error.code = "remote_not_bound";
        error.transient = false;
        throw error;
      }
      return remoteChannelHub.send({
        ...target,
        text: item.text,
        clientId: item.providerClientId,
        signal: options.signal,
      });
    },
    onDelivery: async (delivery) => {
      if (delivery.status === "sent") await remoteTaskRegistry?.recordDelivery(delivery);
      await notificationOrchestrator?.handleRemoteDelivery(delivery);
    },
    maxAttempts: 5,
    retryDelays: [0, 2_000, 5_000, 10_000, 20_000],
  });
  notificationOrchestrator = new NotificationOrchestrator({
    getPreferences: () => preferenceStore.get(),
    phraseStore: phrasePoolStore,
    voiceQueue: voicePlaybackQueue,
    remoteQueue: remoteNotificationQueue,
    resolveRemoteRoute: (task) => remoteTaskRegistry?.observeTask(task),
    showWindowsNotification: showTaskWindowsNotification,
    recordHistory: (record) => notificationHistory.append(record),
  });
  petStateController = new PetStateController({
    availableStates: availablePetStates(),
    onState: (state) => sendPetState(state),
  });
  sendPetState(petStateController.snapshot());
  taskEventClient = new TaskEventClient(serviceUrl, {
    onEvent: (event, value) => {
      const observation = event === "snapshot"
        ? remoteTaskRegistry?.observeSnapshot(value)
        : event === "session.updated"
          ? remoteTaskRegistry?.observeSession(value)
          : (event === "task.created" || event === "task.updated")
            ? remoteTaskRegistry?.observeTask(value)
            : null;
      observation?.then(emitRemoteControlState).catch((error) => {
        console.warn("[remote-control] unable to update task registry", error);
      });
      notificationOrchestrator.handleEvent(event, value);
      petStateController.handleEvent(event, value);
    },
  });
  taskEventClient.start().catch((error) => {
    console.error("[notifications] task event client stopped", error);
  });
}

async function voiceLibraryState() {
  const preferences = gptSovitsPreferences();
  return {
    rootPath: voiceLibrary.rootPath,
    selectedVoiceId: preferences.selectedVoiceId,
    voices: await voiceLibrary.list(),
  };
}

function helperScriptPath(fileName) {
  const root = APP_RUNTIME.packaged ? process.resourcesPath : path.resolve(HERE, "..");
  return path.join(root, fileName);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function installPetAssetProtocol() {
  protocol.handle("pet-asset", async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      let assetPath;
      if (url.hostname === BUILTIN_PET_ID && parts.length === 1) {
        assetPath = builtinPetAssetPath(parts[0]);
      } else if (url.hostname === "library" && parts.length === 2) {
        assetPath = petLibrary.assetPath(parts[0], parts[1]);
      } else {
        return new Response("Not found", { status: 404 });
      }
      const content = await readFile(assetPath);
      const contentTypes = {
        ".gif": "image/gif",
        ".png": "image/png",
        ".webp": "image/webp",
      };
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": contentTypes[path.extname(assetPath).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

async function manageGptSovitsService() {
  const status = await gptSovitsService.status();
  if (status.installed) {
    return { ok: true, action: "start", status: await gptSovitsService.start() };
  }

  const scriptPath = helperScriptPath("setup-gpt-sovits.cmd");
  if (!(await fileExists(scriptPath))) throw new Error("找不到 GPT-SoVITS 安装脚本");
  const openError = await shell.openPath(scriptPath);
  if (openError) throw new Error(openError);
  return { ok: true, action: "setup", status };
}

async function stopGptSovitsService() {
  return gptSovitsService.stop();
}

async function openGptSovitsServiceLog() {
  const logPath = gptSovitsService.paths.log;
  if (!(await fileExists(logPath))) throw new Error("尚未生成服务日志");
  const openError = await shell.openPath(logPath);
  if (openError) throw new Error(openError);
  return { ok: true, logPath };
}

function normalizeGpuVendorId(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim().toLowerCase();
  return text.startsWith("0x") ? Number.parseInt(text.slice(2), 16) : Number(text);
}

async function gptSovitsRuntimeOptions() {
  const gpuInfo = await app.getGPUInfo("basic").catch(() => ({}));
  const gpuDevices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : [];
  const vendors = gpuDevices.map((device) => normalizeGpuVendorId(device.vendorId));
  const hasNvidia = vendors.includes(0x10de);
  const hasAmd = vendors.includes(0x1002);
  return {
    status: await gptSovitsService.status(),
    hardware: {
      vendor: hasNvidia ? "nvidia" : hasAmd ? "amd" : "other",
      devices: gpuDevices.map((device) => ({
        name: String(device.deviceString || device.driverVendor || "GPU"),
        active: Boolean(device.active),
      })),
      availableDevices: hasNvidia ? ["CPU", "CU126", "CU128"] : ["CPU"],
    },
  };
}

async function reconfigureGptSovitsDevice(deviceValue) {
  const device = String(deviceValue || "");
  const options = await gptSovitsRuntimeOptions();
  if (!options.status.installed) throw new Error("请先安装 GPT-SoVITS 本地运行环境");
  if (!options.hardware.availableDevices.includes(device)) {
    throw new Error("当前显卡不支持所选的 CUDA 运行模式");
  }
  await gptSovitsService.stop();
  const scriptPath = helperScriptPath("setup-gpt-sovits.cmd");
  if (!(await fileExists(scriptPath))) throw new Error("找不到 GPT-SoVITS 安装脚本");
  const source = options.status.installation?.source || "ModelScope";
  const child = spawn(
    "cmd.exe",
    [
      "/c",
      scriptPath,
      "-Device",
      device,
      "-Source",
      source,
      "-DataRoot",
      managedRootPath(),
      "-Yes",
    ],
    {
      cwd: path.dirname(scriptPath),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );
  child.unref();
  return { ok: true, device, source };
}

async function removeGptSovitsService() {
  await gptSovitsService.stop();
  const scriptPath = helperScriptPath("remove-gpt-sovits.cmd");
  if (!(await fileExists(scriptPath))) {
    throw new Error("找不到 GPT-SoVITS 清理脚本");
  }
  const openError = await shell.openPath(scriptPath);
  if (openError) throw new Error(openError);
  return { ok: true };
}

async function createSpeechWindow() {
  cancelSpeechRelease();
  const ready = new Promise((resolve) => { resolveSpeechReady = resolve; });
  await speechWindow.ensureCreated();
  let timeout;
  await Promise.race([
    ready,
    new Promise((resolve) => { timeout = setTimeout(resolve, 2_000); }),
  ]);
  clearTimeout(timeout);
  return speechState();
}

async function ensureSpeechWindow() {
  cancelSpeechRelease();
  if (speechWindowPromise) return speechWindowPromise;
  if (!speechWindow.isDestroyed()) return speechState();
  if (!speechWindowPromise) {
    speechWindowPromise = createSpeechWindow()
      .catch((error) => {
        if (speechWindow && !speechWindow.isDestroyed()) speechWindow.destroy();
        throw error;
      })
      .finally(() => {
        speechWindowPromise = null;
      });
  }
  return speechWindowPromise;
}

function createAgentPetIcon(size = 32) {
  const buildIcon = nativeImage.createFromPath(BUILD_ICON_PATH);
  const source = buildIcon.isEmpty()
    ? nativeImage.createFromBuffer(agentPetIconPngBuffer(), { scaleFactor: 1 })
    : buildIcon;
  if (source.isEmpty()) throw new Error("Agent Pet icon could not be decoded");
  if (size === 32) return source;
  const resized = source.resize({ width: size, height: size, quality: "best" });
  if (resized.isEmpty()) throw new Error("Agent Pet icon could not be resized");
  return resized;
}

function createTrayIcon() {
  return createAgentPetIcon(16);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const preferences = preferenceStore.get();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开任务列表", click: showTaskList },
      { label: preferences.appearance.showNotebook ? "隐藏记事板" : "打开记事板", click: toggleNotebook },
      {
        label: "总结今日工作",
        click: () => showDailyReport().catch((error) => console.error("[daily-report] window failed", error)),
      },
      {
        label: "设置",
        click: () => showSettings().catch((error) => console.error("[companion] settings failed", error)),
      },
      {
        label: "显示桌面宠物",
        type: "checkbox",
        checked: preferences.appearance.showPet,
        click: (item) => {
          preferenceStore
            .update({ appearance: { showPet: item.checked, showBadge: item.checked } })
            .then(applyPreferences)
            .catch(() => rebuildTrayMenu());
        },
      },
      { type: "separator" },
      {
        label: "开机启动",
        type: "checkbox",
        checked: preferences.startup.openAtLogin,
        enabled: APP_RUNTIME.packaged,
        click: (item) => {
          preferenceStore
            .update({ startup: { openAtLogin: item.checked } })
            .then(applyPreferences)
            .catch(() => rebuildTrayMenu());
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(PRODUCT_NAME);
  tray.on("click", () => togglePanel());
  rebuildTrayMenu();
}

async function createWindows() {
  loadedWindowState = await readWindowState();
  const preferences = preferenceStore.get();
  await badgeWindow.ensureCreated();
  companionWindows.position();
  if (preferences.appearance.showPet) {
    // Keep the layered surface participating in rendering before the first asset ACK.
    badgeWindow.setOpacity(0);
    badgeWindow.showInactive();
  }
  badgeInitialRevealTimer = setTimeout(() => {
    finishInitialPetReveal("render timeout fallback");
  }, INITIAL_PET_REVEAL_TIMEOUT_MS);
  schedulePositionSave();
}

function isTrustedSender(event) {
  return windowFacades.some((window) => window.ownsSender(event));
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error("Untrusted settings request");
}

function requireSettingsMainFrame(event) {
  if (!settingsWindow.ownsMainFrame(event)) throw new Error("Untrusted storage request");
}

function installIpcHandlers() {
  installPetMenuIpc({ ipcMain, window: petMenuWindow, controller: petMenuController });
  const getNotebookMcpConfig = () => {
    if (!notebookMcpBridge?.ready) throw new Error("记事板连接尚未就绪，请重新启动应用。");
    return notebookMcpConfig({ executable: process.execPath,
      entry: executableResourcePath(path.join(HERE, "notebook", "mcp", "stdio.mjs")),
      connectionFile: path.join(app.getPath("userData"), "notebook-mcp-connection.json") });
  };
  installClaudeSettingsIpc({
    ipcMain, requireSettingsMainFrame,
    getPreferences: () => preferenceStore.get(),
    savePreferences: patch => preferenceStore.update(patch),
    lifecycleStatus: () => claudeLifecycle?.status(),
    getStatusOptions: () => ({}),
    onSaved: async (preferences, patch) => {
      applyPreferences(preferences);
      if (patch.claude?.executablePath !== undefined) aiTextService?.configurationChanged();
      if (patch.claude?.autoLifecycleHooks !== undefined || patch.claude?.nodePath !== undefined) await claudeLifecycle?.sync();
    },
    getOptions: async () => {
      const preferences = preferenceStore.get().claude;
      return {
        nodePath: await resolveNodeExecutable(preferences.nodePath).catch(() => ""),
        bridgePath: executableResourcePath(path.join(HERE, "claude", "hook-bridge.mjs")),
        statuslineBridgePath: executableResourcePath(path.join(HERE, "claude", "statusline-bridge.mjs")),
        eventsDir: path.join(managedRootPath(), "claude", "events"),
        usagePath: path.join(managedRootPath(), "claude", "usage.json"),
        enableStatusline: preferences.enableStatusline,
        mcpConfig: getNotebookMcpConfig(),
      };
    },
    confirm: async (action, preview) => {
      const result = await dialog.showMessageBox({ type: "question", buttons: ["取消", action === "install" ? "安装接入" : "移除接入"],
        defaultId: 0, cancelId: 0, title: "Claude Code 接入",
        message: action === "install" ? "向当前 Claude 配置安装 Agent Pet Hook / MCP？" : "移除 Agent Pet 接入并恢复原状态栏？",
        detail: `${action === "install" ? "仅添加 Agent Pet 管理项；不修改权限或认证。" : "只撤销未被用户改写的管理项，冲突不会覆盖。"}\n${JSON.stringify(preview.paths || {}, null, 2)}\n完成后请重启 CLI / 重新加载 VS Code。` });
      return result.response === 1;
    },
  });
  const notebookCodexConnection = new NotebookCodexConnection({ getConfig: getNotebookMcpConfig, workingDirectory: app.getPath("userData") });
  installNotebookConnectionIpc({ ipcMain, requireSettingsMainFrame, getConnection: () => notebookCodexConnection });
  const notebookClaudeConnection = new NotebookClaudeConnection({ getConfig: getNotebookMcpConfig });
  installNotebookClaudeConnectionIpc({
    ipcMain, requireSettingsMainFrame, getConnection: () => notebookClaudeConnection,
  });
  installNotebookWindowIpc({ ipcMain, window: notebookWindow, controller: notebookWindows });
  const notebookController = createNotebookController({ getStore: () => notebookStore,
    ownsMainFrame: event => notebookWindow.ownsMainFrame(event) });
  ipcMain.handle("notebook:snapshot", notebookController.snapshot);
  ipcMain.handle("notebook:command", notebookController.command);
  ipcMain.handle("notebook:mcp-config", async event => {
    requireSettingsMainFrame(event);
    const config = getNotebookMcpConfig();
    clipboard.writeText(JSON.stringify(config, null, 2));
    return { ok: true };
  });
  ipcMain.handle("notebook:appearance", (event) => {
    if (!notebookWindow.ownsMainFrame(event)) throw new Error("Untrusted notebook appearance request");
    return notebookWindow.getAppearance();
  });
  ipcMain.handle("notebook:background", (event) => {
    if (!notebookWindow.ownsMainFrame(event)) throw new Error("Untrusted notebook background request");
    return notebookWindow.getBackground();
  });
  ipcMain.handle("companion:toggle-panel", (event) => {
    requireTrustedSender(event);
    return togglePanel();
  });
  ipcMain.handle("companion:hide-panel", (event) => {
    if (!panelWindow.ownsSender(event) || !panelWindow.isVisible()) return false;
    companionWindows.hideEmptyTasks();
    return false;
  });
  ipcMain.handle("notebook:hide", (event) => {
    if (!notebookWindow.ownsMainFrame(event)) return false;
    return setNotebookVisible(false);
  });
  ipcMain.handle("companion:show-badge-menu", (event) => {
    if (!badgeWindow.ownsMainFrame(event)) {
      throw new Error("Untrusted badge menu request");
    }
    return showBadgeMenu();
  });
  ipcMain.handle("companion:open-settings", (event) => {
    requireTrustedSender(event);
    showSettings().catch((error) => console.error("[companion] settings failed", error));
    return true;
  });
  ipcMain.handle("usage:get", async (event, options) => {
    requireTrustedSender(event);
    if (!usageProviderRegistry) throw new Error("Usage providers are not ready");
    return usageProviderRegistry.getCurrentUsage({ force: options?.force === true });
  });
  ipcMain.handle("usage:get-all", async (event, options) => {
    requireTrustedSender(event);
    if (!usageProviderRegistry) throw new Error("Usage providers are not ready");
    return usageProviderRegistry.getAllUsage({ force: options?.force === true });
  });
  ipcMain.on("usage:resize-card", (event, value) => {
    if (usageWindow.ownsSender(event)) usageWindow.resize(value);
  });
  async function readDailyReportTasks() {
    const tasksUrl = new URL("/api/v1/tasks", serviceUrl);
    tasksUrl.searchParams.set("scope", "all");
    const response = await fetch(tasksUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`读取任务历史失败（${response.status}）`);
    return (await response.json()).tasks;
  }
  ipcMain.handle("daily-report:get", async (event) => {
    requireTrustedSender(event);
    if (!dailyReportGenerator) throw new Error("日报生成服务尚未就绪");
    return dailyReportGenerator.generate(await readDailyReportTasks());
  });
  ipcMain.handle("daily-report:update", async (event) => {
    requireTrustedSender(event);
    if (!dailyReportGenerator) throw new Error("日报生成服务尚未就绪");
    return dailyReportGenerator.generate(await readDailyReportTasks(), { force: true });
  });
  ipcMain.handle("daily-report:copy", (event, value) => {
    requireTrustedSender(event);
    const text = String(value || "").slice(0, 200_000);
    if (!text.trim()) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle("settings:get", (event) => {
    requireTrustedSender(event);
    return settingsState();
  });
  ipcMain.handle("agent-providers:select", async (event, id) => {
    requireSettingsMainFrame(event);
    const provider = agentProviderRegistry?.setActiveProvider(id);
    if (!provider) throw new Error("智能体连接服务尚未就绪");
    const preferences = await preferenceStore.update(agentSelectionPatch(preferenceStore.get(), provider.id));
    applyPreferences(preferences);
    aiTextService?.configurationChanged();
    return settingsState();
  });
  ipcMain.handle("remote-control:get", (event) => {
    requireSettingsMainFrame(event);
    return remoteControlState();
  });
  ipcMain.handle("remote-control:update", async (event, value) => {
    requireSettingsMainFrame(event);
    if (!value || typeof value !== "object" || typeof value.enabled !== "boolean") {
      throw new TypeError("Invalid remote-control settings");
    }
    await preferenceStore.update({
      remoteControl: {
        enabled: value.enabled,
      },
    });
    emitRemoteControlState();
    return remoteControlState();
  });
  ipcMain.handle("app:update-status", (event) => {
    requireSettingsMainFrame(event);
    return appUpdater?.status() || {
      state: "unavailable",
      currentVersion: APP_RUNTIME.version,
      nextVersion: "",
      progress: 0,
      message: "更新服务尚未就绪",
      packaged: APP_RUNTIME.packaged,
    };
  });
  ipcMain.handle("app:check-update", async (event) => {
    requireSettingsMainFrame(event);
    return appUpdater?.checkForUpdates();
  });
  ipcMain.handle("app:download-update", async (event) => {
    requireSettingsMainFrame(event);
    return appUpdater?.downloadUpdate();
  });
  ipcMain.handle("app:install-update", async (event) => {
    requireSettingsMainFrame(event);
    if (appUpdater?.status().state !== "downloaded") return false;
    shutdownStarted = true;
    await shutdownOwnedService();
    return appUpdater.installUpdate();
  });
  installAiSettingsIpc({
    ipcMain, requireSettingsMainFrame, controller: aiSettingsController, service: aiTextService,
  });
  ipcMain.handle("settings:update", async (event, patch) => {
    requireTrustedSender(event);
    if (patch && (Object.prototype.hasOwnProperty.call(patch, "remoteControl")
      || Object.prototype.hasOwnProperty.call(patch, "agent")
      || Object.prototype.hasOwnProperty.call(patch, "claude")
      || Object.prototype.hasOwnProperty.call(patch, "ai"))) {
      throw new Error("Agent and remote-control changes require their dedicated settings APIs");
    }
    const preferences = await preferenceStore.update(patch);
    applyPreferences(preferences);
    scheduleCopywriter(preferences);
    loadedNotificationVoiceSignature = "";
    notificationOrchestrator?.preferencesChanged();
    emitRemoteControlState();
    return settingsState();
  });
  ipcMain.handle("settings:reset", async (event) => {
    requireTrustedSender(event);
    const preferences = await preferenceStore.reset();
    await claudeLifecycle?.sync();
    aiTextService?.configurationChanged();
    void aiTextService?.check();
    await refreshSelectedPet(preferences.appearance.pet.selectedPetId);
    applyPreferences(preferences);
    scheduleCopywriter(preferences);
    loadedNotificationVoiceSignature = "";
    notificationOrchestrator?.preferencesChanged();
    emitRemoteControlState();
    return settingsState();
  });
  ipcMain.handle("settings:storage:get", (event) => {
    requireSettingsMainFrame(event);
    return storageLocationsState();
  });
  ipcMain.handle("settings:storage:open", async (event, id) => {
    requireSettingsMainFrame(event);
    const location = storageLocationById(storageLocationsState(), id);
    const directoryPath = await ensureStorageLocationDirectory(location);
    const openError = await shell.openPath(directoryPath);
    if (openError) throw new Error(openError);
    return { ok: true, ...location };
  });
  ipcMain.handle("notifications:test", async (event) => {
    requireTrustedSender(event);
    if (!notificationOrchestrator) throw new Error("通知服务尚未就绪");
    return notificationOrchestrator.sendTestReminder("completed");
  });
  ipcMain.handle("weixin:status", (event) => {
    requireSettingsMainFrame(event);
    return weixinRemoteService?.status() || {
      state: "disconnected",
      connected: false,
      bound: false,
      sendAvailable: false,
      deliveryState: "unavailable",
      qrCodeUrl: "",
      lastError: "",
      lastSendError: "",
      contextUpdatedAt: "",
      replyContextInvalid: false,
      accountLabel: "",
    };
  });
  ipcMain.handle("weixin:connect", async (event) => {
    requireSettingsMainFrame(event);
    if (!weixinRemoteService) throw new Error("微信连接服务尚未就绪");
    return weixinRemoteService.beginConnection();
  });
  ipcMain.handle("weixin:verify", async (event, code) => {
    requireSettingsMainFrame(event);
    if (!weixinRemoteService) throw new Error("微信连接服务尚未就绪");
    return weixinRemoteService.submitVerifyCode(code);
  });
  ipcMain.handle("weixin:disconnect", async (event) => {
    requireSettingsMainFrame(event);
    if (!weixinRemoteService) throw new Error("微信连接服务尚未就绪");
    return weixinRemoteService.disconnect();
  });
  ipcMain.handle("weixin:test", async (event) => {
    requireSettingsMainFrame(event);
    if (!weixinRemoteService) throw new Error("微信连接服务尚未就绪");
    return weixinRemoteService.sendText(
      "Agent Pet 微信通知测试成功。后续任务状态会按提醒规则发送到这里。",
    );
  });
  ipcMain.handle("speech:get-voices", async (event) => {
    requireTrustedSender(event);
    await ensureSpeechWindow();
    const state = speechState();
    scheduleSpeechRelease();
    return state;
  });
  ipcMain.handle("speech:test", async (event, value) => {
    requireTrustedSender(event);
    const preferences = preferenceStore.get().notifications.voice;
    const text = String(value?.text || "任务已经完成。").trim().slice(0, 120);
    if (preferences.engine === "gpt-sovits") {
      const config = await selectedGptSovitsConfig();
      await loadGptSovitsVoice(config);
      const result = await synthesizeGptSovits(text || "任务已经完成。", config);
      return requestAudioPlayback(result.audio, result.mimeType, {
        volume: preferences.volume,
        cancelPrevious: true,
      });
    }
    return requestSpeech(text || "任务已经完成。", {
      voiceId: preferences.voiceId,
      rate: preferences.rate,
      pitch: preferences.pitch,
      volume: preferences.volume,
      cancelPrevious: true,
    });
  });
  ipcMain.handle("speech:select-file", async (event, kind) => {
    requireTrustedSender(event);
    const options = {
      gpt: { title: "选择 GPT 模型", filters: [{ name: "GPT 模型", extensions: ["ckpt"] }] },
      sovits: { title: "选择 SoVITS 模型", filters: [{ name: "SoVITS 模型", extensions: ["pth"] }] },
      reference: {
        title: "选择参考音频",
        filters: [{ name: "音频文件", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }],
      },
    }[String(kind || "")];
    if (!options) throw new Error("不支持的语音文件类型");
    const result = await settingsWindow.openFileDialog({
      ...options,
      properties: ["openFile"],
    });
    return { canceled: result.canceled, path: result.filePaths[0] || "" };
  });
  ipcMain.handle("gpt-sovits:test-connection", async (event) => {
    requireTrustedSender(event);
    return inspectGptSovits(gptSovitsPreferences().baseUrl);
  });
  ipcMain.handle("gpt-sovits:load-voice", async (event) => {
    requireTrustedSender(event);
    return loadGptSovitsVoice(await selectedGptSovitsConfig());
  });
  ipcMain.handle("gpt-sovits:manage-service", async (event) => {
    requireTrustedSender(event);
    return manageGptSovitsService();
  });
  ipcMain.handle("gpt-sovits:service-status", async (event) => {
    requireTrustedSender(event);
    return gptSovitsService.status();
  });
  ipcMain.handle("gpt-sovits:stop-service", async (event) => {
    requireTrustedSender(event);
    return stopGptSovitsService();
  });
  ipcMain.handle("gpt-sovits:open-service-log", async (event) => {
    requireTrustedSender(event);
    return openGptSovitsServiceLog();
  });
  ipcMain.handle("gpt-sovits:runtime-options", async (event) => {
    requireTrustedSender(event);
    return gptSovitsRuntimeOptions();
  });
  ipcMain.handle("gpt-sovits:reconfigure-device", async (event, device) => {
    requireTrustedSender(event);
    return reconfigureGptSovitsDevice(device);
  });
  ipcMain.handle("gpt-sovits:remove-service", async (event) => {
    requireTrustedSender(event);
    return removeGptSovitsService();
  });
  ipcMain.handle("voice-library:list", async (event) => {
    requireTrustedSender(event);
    return voiceLibraryState();
  });
  ipcMain.handle("voice-library:import", async (event, value) => {
    requireTrustedSender(event);
    const voice = await voiceLibrary.importVoice(value);
    await preferenceStore.update({
      notifications: { voice: { gptSovits: { selectedVoiceId: voice.id } } },
    });
    return voiceLibraryState();
  });
  ipcMain.handle("voice-library:update", async (event, value) => {
    requireTrustedSender(event);
    await voiceLibrary.updateVoice(value?.id, value);
    return voiceLibraryState();
  });
  ipcMain.handle("voice-library:remove", async (event, id) => {
    requireTrustedSender(event);
    await voiceLibrary.removeVoice(id);
    const remaining = await voiceLibrary.list();
    const selectedVoiceId = gptSovitsPreferences().selectedVoiceId;
    if (selectedVoiceId === id) {
      await preferenceStore.update({
        notifications: { voice: { gptSovits: { selectedVoiceId: remaining[0]?.id || "" } } },
      });
    }
    return voiceLibraryState();
  });
  ipcMain.handle("pet-library:list", async (event) => {
    requireTrustedSender(event);
    return petLibraryState();
  });
  ipcMain.handle("pet-library:open-downloads", async (event) => {
    requireSettingsMainFrame(event);
    await shell.openExternal(PET_DOWNLOAD_URL);
    return { ok: true };
  });
  ipcMain.handle("pet-library:copy-conversion-prompt", (event) => {
    requireSettingsMainFrame(event);
    clipboard.writeText(petConversionPrompt());
    return { ok: true };
  });
  ipcMain.handle("pet-library:select-zip", async (event) => {
    requireTrustedSender(event);
    const result = await settingsWindow.openFileDialog({
      title: "选择宠物 ZIP 压缩包",
      filters: [{ name: "宠物压缩包", extensions: ["zip"] }],
      properties: ["openFile"],
    });
    return { canceled: result.canceled, path: result.filePaths[0] || "" };
  });
  ipcMain.handle("pet-library:import-zip", async (event, zipPath) => {
    requireTrustedSender(event);
    const pet = await petLibrary.importZip(zipPath);
    selectedPet = pet;
    petStateController?.setAvailableStates(availablePetStates(pet));
    const preferences = await preferenceStore.update({
      appearance: { pet: { selectedPetId: pet.id } },
    });
    applyPreferences(preferences);
    sendPetState();
    return petLibraryState();
  });
  ipcMain.handle("pet-library:select", async (event, value) => {
    requireTrustedSender(event);
    const id = String(value || "");
    selectedPet = id === "builtin-default" ? null : await petLibrary.get(id);
    petStateController?.setAvailableStates(availablePetStates());
    const preferences = await preferenceStore.update({
      appearance: { pet: { selectedPetId: selectedPet?.id || "builtin-default" } },
    });
    applyPreferences(preferences);
    sendPetState();
    return petLibraryState();
  });
  ipcMain.handle("pet-library:remove", async (event, value) => {
    requireTrustedSender(event);
    const id = String(value || "");
    if (!id || id === "builtin-default") throw new Error("不能删除内置默认宠物");
    await petLibrary.remove(id);
    if (selectedPet?.id === id) {
      selectedPet = null;
      petStateController?.setAvailableStates(Object.keys(BUILTIN_PET.states));
      const preferences = await preferenceStore.update({
        appearance: { pet: { selectedPetId: "builtin-default" } },
      });
      applyPreferences(preferences);
      sendPetState();
    }
    return petLibraryState();
  });
  ipcMain.handle("pet-library:open", async (event) => {
    requireTrustedSender(event);
    const rootPath = await petLibrary.ensureDirectory();
    const openError = await shell.openPath(rootPath);
    if (openError) throw new Error(openError);
    return { ok: true, rootPath };
  });
  ipcMain.on("speech:voices", (event, value) => {
    if (!speechWindow.ownsSender(event)) return;
    updateSpeechCapabilities(value);
  });
  ipcMain.on("speech:result", (event, value) => {
    if (!speechWindow.ownsSender(event)) return;
    settleSpeechRequest(value);
  });
  ipcMain.on("pet-window:pointer-down", (event, value) => {
    if (badgeWindow.ownsSender(event)) startPetPointer(value);
  });
  ipcMain.on("pet-window:pointer-move", (event, value) => {
    if (badgeWindow.ownsSender(event)) movePetPointer(value);
  });
  ipcMain.on("pet-window:pointer-up", (event, value) => {
    if (badgeWindow.ownsSender(event)) endPetPointer(value, false);
  });
  ipcMain.on("pet-window:pointer-cancel", (event, value) => {
    if (badgeWindow.ownsSender(event)) endPetPointer(value, true);
  });
  ipcMain.on("pet-renderer:animation-end", (event, value) => {
    if (badgeWindow.ownsSender(event)) {
      petStateController?.acknowledgeAnimation(value?.generation);
    }
  });
  ipcMain.on("pet-renderer:ready", (event) => {
    if (badgeWindow.ownsSender(event)) {
      finishInitialPetReveal("first pet frame ready");
    }
  });
  ipcMain.on("companion:start-badge-drag", (event) => {
    if (badgeWindow.ownsSender(event)) {
      const cursor = screen.getCursorScreenPoint();
      startPetPointer({ pointerId: -1, screenX: cursor.x, screenY: cursor.y, time: Date.now() });
    }
  });
  ipcMain.on("companion:stop-badge-drag", (event) => {
    if (badgeWindow.ownsSender(event)) {
      const cursor = screen.getCursorScreenPoint();
      endPetPointer({ pointerId: -1, screenX: cursor.x, screenY: cursor.y, time: Date.now() }, true);
    }
  });
  ipcMain.on("companion:resize-panel", (event, value) => {
    if (panelWindow.ownsSender(event)) panelWindow.resize(value);
  });
  ipcMain.on("companion:update-summary", (event, value) => {
    if (!badgeWindow.ownsSender(event)) return;
    const count = Math.max(0, Math.min(999, Number(value?.count) || 0));
    const state = typeof value?.state === "string" ? value.state : "idle";
    tray?.setToolTip(count ? `${PRODUCT_NAME} · ${count} 项待处理` : PRODUCT_NAME);
    badgeWindow?.setTitle(`${PRODUCT_NAME} · ${state}`);
  });
}

async function shutdownOwnedService() {
  await claudeLifecycle?.close();
  await positionSaveQueue;
  await notebookMcpBridge?.stop();
  await notebookStore?.close();
  appUpdater?.stop();
  if (remoteControlController) await remoteControlController.stop();
  remoteChannelHub?.stop();
  if (taskEventClient) await taskEventClient.stop();
  if (notificationOrchestrator) await notificationOrchestrator.stop();
  if (weixinRemoteService) await weixinRemoteService.stop();
  aiTextService?.stop();
  if (codexCopywriter) await codexCopywriter.stop();
  if (dailyReportGenerator) await dailyReportGenerator.stop();
  if (gptSovitsService) await gptSovitsService.stop();
  if (ownedServer) await ownedServer.stop();
  if (ownedCollector) await ownedCollector.stop();
  ownedServer = null;
  ownedCollector = null;
  taskEventClient = null;
  notificationOrchestrator = null;
  dailyReportGenerator = null;
  petStateController = null;
  voicePlaybackQueue = null;
  remoteNotificationQueue = null;
  remoteControlController = null;
  remoteChannelHub = null;
  weixinChannelAdapter = null;
  remoteCodexExecutor = null;
  remoteTaskRegistry = null;
  weixinRemoteService = null;
  secureCredentials = null;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (preferenceStore?.get().appearance.showPet && !badgeInitialRevealPending) {
      badgeWindow?.showInactive();
    }
    showPanel();
  });

  app.on("before-quit", (event) => {
    quitting = true;
    clearTimeout(savePositionTimer);
    saveWindowState().catch((error) => console.error("[companion] window position save failed", error));
    notebookWindows.dispose();
    companionWindows.dispose();
    petMenuController.dispose();
    stopBadgeDrag();
    const hasManagedVoiceService = gptSovitsService?.hasManagedProcess();
    if ((!ownedServer && !ownedCollector && !hasManagedVoiceService && !codexCopywriter
      && !taskEventClient && !notificationOrchestrator && !weixinRemoteService && !notebookStore) || shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    shutdownOwnedService().finally(() => app.quit());
  });

  app.on("window-all-closed", () => {});

  app.whenReady()
    .then(async () => {
      console.log("[companion] Electron ready");
      const migratedFiles = await migrateLegacyUserData({
        targetRoot: app.getPath("userData"),
        legacyRoots: LEGACY_USER_DATA_PATHS,
      });
      if (migratedFiles.length) {
        console.log(`[agent-pet] migrated user data: ${migratedFiles.join(", ")}`);
      }
      managedDataRoot = await resolveManagedDataRoot({
        localAppData: process.env.LOCALAPPDATA,
        userDataPath: app.getPath("userData"),
      });
      if (path.basename(managedDataRoot) === LEGACY_MANAGED_DATA_DIRECTORY) {
        console.log(`[agent-pet] using compatible managed data root: ${managedDataRoot}`);
      }
      preferenceStore = new PreferenceStore(preferencesPath());
      desktopProviders = createDesktopProviders({
        codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        workingDirectory: copywriterPath(),
        usagePath: path.join(managedRootPath(), "claude", "usage.json"),
        getPreferences: () => preferenceStore.get(),
        loadKey: (connectionId) => secureCredentials.load(`ai.${connectionId}`),
      });
      agentProviderRegistry = desktopProviders.agents;
      usageProviderRegistry = desktopProviders.usage;
      remoteTaskRegistry = new RemoteTaskRegistry(remoteTaskRegistryPath());
      await remoteTaskRegistry.load();
      voiceLibrary = new VoiceLibrary(voiceLibraryPath());
      petLibrary = new PetLibrary(petLibraryPath());
      installPetAssetProtocol();
      gptSovitsService = new GptSovitsServiceController(gptSovitsEnginePath());
      phrasePoolStore = new PhrasePoolStore(phrasePoolPath());
      notificationHistory = new NotificationHistoryStore(notificationHistoryPath());
      notebookStore = new NotebookStore(path.join(managedRootPath(), "notebook"), {
        onChange: () => notebookWindow.send("notebook:changed"),
      });
      notebookMcpBridge = new NotebookMcpBridge({
        connectionFile: path.join(app.getPath("userData"), "notebook-mcp-connection.json"), tools: createNotebookTools(notebookStore),
      });
      await notebookMcpBridge.start().catch(error => console.error("[notebook] MCP bridge unavailable", error.message));
      secureCredentials = new SecureCredentials(secureCredentialsPath(), safeStorage);
      weixinRemoteService = new WeixinRemoteService({
        loadCredentials: () => secureCredentials.load("weixin"),
        saveCredentials: (value) => secureCredentials.save("weixin", value),
        clearCredentials: () => secureCredentials.clear("weixin"),
        onStatus: (status) => {
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.send("weixin:status-changed", status);
          }
          emitRemoteControlState();
        },
        onInbound: (message, metadata) => {
          const inbound = weixinChannelAdapter?.normalizeInbound(message, metadata);
          return inbound ? remoteChannelHub?.handleInbound(inbound) : undefined;
        },
      });
      appUpdater = new AppUpdater({
        autoUpdater,
        currentVersion: APP_RUNTIME.version,
        isPackaged: APP_RUNTIME.packaged,
        onStatus: (status) => {
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.send("app:update-status-changed", status);
          }
        },
      });
      aiTextService = new AiTextService({
        getPreferences: () => preferenceStore.get(),
        providers: desktopProviders.text,
        onStatus: (status) => settingsWindow?.send("ai:status", status),
      });
      aiSettingsController = new AiSettingsController({
        preferences: preferenceStore, credentials: secureCredentials, service: aiTextService,
        onSaved: (preferences) => {
          scheduleCopywriter(preferences);
          void aiTextService.check();
        },
      });
      codexCopywriter = new PhrasePoolGenerator({
        store: phrasePoolStore,
        textService: aiTextService,
      });
      dailyReportGenerator = new DailyReportGenerator({
        textService: aiTextService,
        workingDirectory: copywriterPath(),
        cacheDirectory: dailyReportCachePath(),
      });
      const preferences = await preferenceStore.load();
      claudeLifecycle = createClaudeLifecycleController({
        getPreferences: () => preferenceStore.get(),
        getOptions: () => ({
          configDir: resolveClaudeConfigDirectory(),
          bridgePath: executableResourcePath(path.join(HERE, "claude", "hook-bridge.mjs")),
          eventsDir: path.join(managedRootPath(), "claude", "events"),
        }),
      });
      activateAgentProvider(preferences);
      remoteCodexExecutor = new CodexRemoteExecutor({
        desktop: process.platform === "win32" ? new CodexDesktopExecutor({
          getTask: async (taskId, signal) => {
            const response = await fetch(`${serviceUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
              signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(5_000)]),
            });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`读取 Codex 轮次失败：${response.status}`);
            return (await response.json()).task;
          },
        }) : null,
        onDiagnostic: async (entry) => {
          const diagnosticPath = path.join(managedRootPath(), "remote-control", "last-execution-diagnostic.json");
          await mkdir(path.dirname(diagnosticPath), { recursive: true });
          await writeFile(diagnosticPath, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }, null, 2), "utf8");
        },
      });
      remoteChannelHub = new RemoteChannelHub();
      weixinChannelAdapter = createWeixinChannelAdapter({
        service: weixinRemoteService,
        accountId: "primary",
      });
      remoteChannelHub.register(weixinChannelAdapter);
      remoteControlController = new RemoteControlController({
        registry: remoteTaskRegistry,
        executor: createDesktopExecutor({
          codex: remoteCodexExecutor,
          getPreferences: () => preferenceStore.get(),
          eventsDir: path.join(managedRootPath(), "claude", "events"),
          isSessionActive: id => claudeSessionActivity({ owned: Boolean(ownedCollector), claude: ownedCollector }, id),
          onUsage: event => desktopProviders.claudeUsage.recordRateLimit(event),
        }),
        getDefaultProvider: () => preferenceStore.get().remoteControl.defaultProviderId,
        getPolicy: () => preferenceStore.get().remoteControl || {},
        authorizeInbound: (inbound) => remoteChannelHub.isAuthorized(inbound),
        getChannelCapabilities: (channelId, inbound) => (
          remoteChannelHub.getCapabilities(channelId, inbound?.accountId)
        ),
        reply: (inbound, message) => remoteChannelHub.reply(message, { inbound }),
      });
      remoteChannelHub.setController(remoteControlController);
      await refreshSelectedPet(preferences.appearance.pet.selectedPetId);
      applyPreferences(preferences);
      installIpcHandlers();
      serviceUrl = await ensureCollectorService();
      await claudeLifecycle.sync();
      await createWindows();
      desktopWindowsReady = true;
      await notebookWindows.applyPreferences();
      installDisplayHandlers();
      createTray();
      appUpdater.start();
      await weixinRemoteService.start();
      collectorReadyPromise
        .then(() => {
          if (!quitting && !notificationOrchestrator) createNotificationServices();
        })
        .catch((error) => {
          console.error("[notifications] waiting for collector failed", error);
        });
      scheduleCopywriter(preferences, 3_000);
      void aiTextService.check();
      console.log("[companion] tray ready");
    })
    .catch((error) => {
      console.error("[companion] startup failed", error);
      quitting = true;
      app.quit();
    });
}
