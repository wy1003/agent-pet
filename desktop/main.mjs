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
import { CodexActivityCollector } from "../src/collector.mjs";
import {
  DESKTOP_COLLECTOR_IDENTITY,
  isCompatibleCollectorHealth,
} from "../src/collector-service-identity.mjs";
import {
  copywriterWorkingDirectory,
  defaultIgnoredProjectPaths,
} from "../src/internal-projects.mjs";
import { createCollectorServer } from "../src/server.mjs";
import { CodexCopywriter } from "./codex-copywriter.mjs";
import { DailyReportGenerator } from "./daily-report.mjs";
import { NotificationOrchestrator } from "./notification-orchestrator.mjs";
import { NotificationHistoryStore } from "./notification-history.mjs";
import { RemoteNotificationQueue } from "./remote-notification-queue.mjs";
import { RemoteChannelHub } from "./remote-channel-hub.mjs";
import { RemoteTaskRegistry } from "./remote-task-registry.mjs";
import { CodexRemoteExecutor } from "./codex-remote-executor.mjs";
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
  panelBoundsNearBadge,
  panelVerticalAlignment,
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
const PRELOAD_PATH = path.join(HERE, "preload.cjs");
const BUILD_ICON_PATH = path.resolve(HERE, "..", "build", "icon.png");
const DEFAULT_SERVICE_URL = "http://127.0.0.1:43123";
const PANEL_WIDTH = 350;
const PANEL_HEIGHT = 380;
const PANEL_MIN_HEIGHT = 58;
const SETTINGS_WIDTH = 620;
const SETTINGS_HEIGHT = 760;
const DAILY_REPORT_WIDTH = 500;
const DAILY_REPORT_HEIGHT = 560;
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

let badgeWindow = null;
let panelWindow = null;
let panelVisibleItemCount = 0;
let settingsWindow = null;
let dailyReportWindow = null;
let speechWindow = null;
let tray = null;
let serviceUrl = DEFAULT_SERVICE_URL;
let ownedCollector = null;
let ownedServer = null;
let quitting = false;
let shutdownStarted = false;
let savePositionTimer = null;
let loadedWindowState = {};
let badgeDrag = null;
let badgeInertiaTimer = null;
let badgeWindowSizeLock = null;
let correctingBadgeWindowSize = false;
let petStateController = null;
let petLibrary = null;
let selectedPet = null;
let preferenceStore = null;
let voiceLibrary = null;
let gptSovitsService = null;
let phrasePoolStore = null;
let codexCopywriter = null;
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
let loadedNotificationVoiceSignature = "";
let managedDataRoot = null;
let speechRequestSerial = 0;
let speechCapabilities = { supported: false, voices: [] };
let resolveSpeechReady = null;
const speechReady = new Promise((resolve) => {
  resolveSpeechReady = resolve;
});
const pendingSpeechRequests = new Map();

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
    capabilities: {
      openAtLogin: APP_RUNTIME.packaged,
      voiceDelivery: speechCapabilities.supported,
      mobileDelivery: true,
    },
  };
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
    settingsWindow.webContents.send("remote-control:changed", remoteControlState());
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

function applyPreferences(preferences) {
  nativeTheme.themeSource = preferences.appearance.theme;

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
    if (preferences.appearance.showPet) badgeWindow.showInactive();
    else badgeWindow.hide();
  }
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.setAlwaysOnTop(preferences.appearance.alwaysOnTop, "floating");
  }
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
  const targetPath = statePath();
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
  loadedWindowState = state;
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
  positionPanel();
  schedulePositionSave();
}

function installDisplayHandlers() {
  const restoreVisibility = () => keepPetOnVisibleDisplay();
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
  if (!badgeWindow || badgeWindow.isDestroyed() || badgeWindow.webContents.isLoading()) return;
  const payload = petStatePayload(state);
  if (overrideState) {
    const pet = selectedPet || BUILTIN_PET;
    const availableStates = availablePetStates(pet);
    payload.state = resolveAvailablePetState(overrideState, availableStates);
  }
  badgeWindow.webContents.send("pet:state", payload);
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
  positionPanel();
  schedulePositionSave();
  if (reopenPanel) showPanel();
}

function stopBadgeDrag() {
  const reopenPanel = Boolean(badgeDrag?.panelWasVisible);
  badgeDrag = null;
  stopPetInertia();
  enforceBadgeWindowSizeLock();
  positionPanel();
  schedulePositionSave();
  if (reopenPanel) showPanel();
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
    badgeDrag.panelWasVisible = Boolean(panelWindow?.isVisible());
    panelWindow?.hide();
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
  if (isCompatibleCollectorHealth(existingHealth, DESKTOP_COLLECTOR_IDENTITY)) {
    console.log(`[companion] attached to ${DEFAULT_SERVICE_URL}`);
    return DEFAULT_SERVICE_URL;
  }
  if (existingHealth) {
    console.log("[companion] port 43123 belongs to another collector; using an isolated port");
  }

  console.log("[companion] starting the embedded collector");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const collector = new CodexActivityCollector({
    codexHome,
    statePath: path.join(app.getPath("userData"), "collector-state.json"),
    ignoredProjectPaths: defaultIgnoredProjectPaths({
      managedRoot: managedRootPath(),
      localAppData: process.env.LOCALAPPDATA,
      fallbackRoot: path.join(app.getPath("userData"), "copywriter"),
    }),
  });
  await collector.start();

  let api = createCollectorServer(collector, {
    host: "127.0.0.1",
    port: existingHealth ? 0 : 43123,
    serviceIdentity: DESKTOP_COLLECTOR_IDENTITY,
  });
  try {
    await api.start();
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    await api.stop();
    const racedHealth = await collectorServiceHealth(DEFAULT_SERVICE_URL);
    if (isCompatibleCollectorHealth(racedHealth, DESKTOP_COLLECTOR_IDENTITY)) {
      await collector.stop();
      return DEFAULT_SERVICE_URL;
    }
    api = createCollectorServer(collector, {
      host: "127.0.0.1",
      port: 0,
      serviceIdentity: DESKTOP_COLLECTOR_IDENTITY,
    });
    await api.start();
  }

  const address = api.server.address();
  ownedCollector = collector;
  ownedServer = api;
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`[companion] embedded collector ready at ${url}`);
  return url;
}

function workAreaForBounds(bounds) {
  const point = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  };
  return screen.getDisplayNearestPoint(point).workArea;
}

function positionPanel() {
  if (!badgeWindow || !panelWindow) return;
  const badgeBounds = badgeWindow.getBounds();
  const workArea = workAreaForBounds(badgeBounds);
  const currentBounds = panelWindow.getBounds();
  const width = Math.min(PANEL_WIDTH, workArea.width - 24);
  const height = Math.min(currentBounds.height, workArea.height - 24);
  const verticalAlignment = panelVerticalAlignment(
    panelVisibleItemCount,
    height,
    badgeBounds.height,
  );
  panelWindow.setBounds(
    panelBoundsNearBadge(badgeBounds, { width, height }, workArea, 12, verticalAlignment),
    false,
  );
}

function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  positionPanel();
  panelWindow.show();
  panelWindow.focus();
  panelWindow.webContents.send("companion:panel-shown");
}

function togglePanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return false;
  if (panelWindow.isVisible()) panelWindow.hide();
  else showPanel();
  return panelWindow.isVisible();
}

function showBadgeMenu() {
  if (!badgeWindow || badgeWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: "打开任务列表", click: showPanel },
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
  menu.popup({ window: badgeWindow });
}

async function showDailyReport() {
  if (dailyReportWindow && !dailyReportWindow.isDestroyed()) {
    if (dailyReportWindow.isMinimized()) dailyReportWindow.restore();
    dailyReportWindow.show();
    dailyReportWindow.focus();
    return;
  }

  dailyReportWindow = new BrowserWindow({
    width: DAILY_REPORT_WIDTH,
    height: DAILY_REPORT_HEIGHT,
    minWidth: 400,
    minHeight: 420,
    show: false,
    title: `今日工作日报 · ${PRODUCT_NAME}`,
    icon: createAgentPetIcon(256),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e221f" : "#f3f2ed",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dailyReportWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  dailyReportWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== new URL(serviceUrl).origin) event.preventDefault();
  });
  dailyReportWindow.on("closed", () => {
    dailyReportWindow = null;
  });
  dailyReportWindow.once("ready-to-show", () => {
    dailyReportWindow?.show();
    dailyReportWindow?.focus();
  });
  await dailyReportWindow.loadURL(`${serviceUrl}/daily-report.html`);
}

async function showSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    minWidth: 520,
    minHeight: 620,
    show: false,
    title: `设置 · ${PRODUCT_NAME}`,
    icon: createAgentPetIcon(256),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e221f" : "#f3f2ed",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== new URL(serviceUrl).origin) event.preventDefault();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
    settingsWindow?.focus();
  });
  await settingsWindow.loadURL(`${serviceUrl}/settings.html`);
}

function speechState() {
  return {
    supported: speechCapabilities.supported,
    voices: speechCapabilities.voices.map((voice) => ({ ...voice })),
  };
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
}

function requestSpeech(text, options = {}) {
  if (!speechCapabilities.supported || !speechWindow || speechWindow.isDestroyed()) {
    return Promise.resolve({ ok: false, error: "speech_unavailable" });
  }
  const id = `speech-${Date.now()}-${++speechRequestSerial}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSpeechRequests.delete(id);
      resolve({ ok: false, error: "speech_timeout" });
    }, 30_000);
    pendingSpeechRequests.set(id, { resolve, timer });
    speechWindow.webContents.send("speech:speak", {
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

function requestAudioPlayback(audio, mimeType = "audio/wav", options = {}) {
  if (!speechWindow || speechWindow.isDestroyed()) {
    return Promise.resolve({ ok: false, error: "speech_window_unavailable" });
  }
  const id = `audio-${Date.now()}-${++speechRequestSerial}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSpeechRequests.delete(id);
      resolve({ ok: false, error: "audio_playback_timeout" });
    }, 60_000);
    pendingSpeechRequests.set(id, { resolve, timer });
    speechWindow.webContents.send("speech:play-audio", {
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
  return synthesizeGptSovits(text, config);
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
  if (preferences.notifications.windows.openPanelOnClick) notification.on("click", showPanel);
  notification.show();
  return { ok: true, status: "sent" };
}

function createNotificationServices() {
  voicePlaybackQueue = new VoicePlaybackQueue({
    cacheDirectory: notificationAudioCachePath(),
    getPreferences: () => preferenceStore.get(),
    synthesizeAudio: (text) => synthesizeNotificationAudio(text),
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
  speechWindow = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  speechWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  speechWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== new URL(serviceUrl).origin) event.preventDefault();
  });
  speechWindow.on("closed", () => {
    speechWindow = null;
    speechCapabilities = { supported: false, voices: [] };
    for (const [id, pending] of pendingSpeechRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "speech_window_closed" });
      pendingSpeechRequests.delete(id);
    }
  });
  await speechWindow.loadURL(`${serviceUrl}/speech.html`);
  await Promise.race([
    speechReady,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
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
      { label: "打开任务列表", click: showPanel },
      {
        label: "总结今日工作",
        click: () => showDailyReport().catch((error) => console.error("[daily-report] window failed", error)),
      },
      {
        label: "设置",
        click: () => showSettings().catch((error) => console.error("[companion] settings failed", error)),
      },
      {
        label: "显示任务徽标",
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
  tray.on("click", togglePanel);
  rebuildTrayMenu();
}

async function createWindows() {
  const saved = await readWindowState();
  loadedWindowState = saved;
  const preferences = preferenceStore.get();
  const primaryDisplay = screen.getPrimaryDisplay();
  const primaryWorkArea = primaryDisplay.workArea;
  const petSize = petWindowSize(preferences.appearance.pet.width, 4);
  const badgeBounds = restorePetWindowBounds(
    saved,
    screen.getAllDisplays(),
    primaryDisplay,
    petSize,
  );

  badgeWindow = new BrowserWindow({
    ...badgeBounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: preferences.appearance.alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  captureBadgeWindowSizeLock();
  badgeWindow.on("resize", () => {
    if (correctingBadgeWindowSize) return;
    setImmediate(enforceBadgeWindowSizeLock);
  });
  badgeWindow.setAlwaysOnTop(preferences.appearance.alwaysOnTop, "floating");
  badgeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  badgeWindow.on("moved", () => {
    positionPanel();
    schedulePositionSave();
  });
  badgeWindow.on("show", rebuildTrayMenu);
  badgeWindow.on("hide", rebuildTrayMenu);
  console.log("[companion] loading task badge");
  await badgeWindow.loadURL(`${serviceUrl}/companion-badge.html`);
  console.log("[companion] task badge loaded");

  const panelHeight = Math.min(PANEL_HEIGHT, primaryWorkArea.height - 24);
  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: panelHeight,
    show: false,
    frame: false,
    hasShadow: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: preferences.appearance.alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    minWidth: 300,
    minHeight: PANEL_MIN_HEIGHT,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelWindow.setAlwaysOnTop(preferences.appearance.alwaysOnTop, "floating");
  panelWindow.on("blur", () => {
    setTimeout(() => {
      if (!quitting && panelWindow && !panelWindow.isDestroyed() && !panelWindow.isFocused()) {
        panelWindow.hide();
      }
    }, 120);
  });
  panelWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    panelWindow.hide();
  });
  console.log("[companion] loading task panel");
  await panelWindow.loadURL(`${serviceUrl}/?companion=1`);
  console.log("[companion] task panel loaded");
  positionPanel();
  if (preferences.appearance.showPet) {
    badgeWindow.showInactive();
    console.log("[companion] badge window visible");
  }
  schedulePositionSave();
}

function isTrustedSender(event) {
  return [badgeWindow, panelWindow, settingsWindow, dailyReportWindow, speechWindow].some(
    (window) => window && !window.isDestroyed() && event.sender === window.webContents,
  );
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error("Untrusted settings request");
}

function requireSettingsMainFrame(event) {
  const webContents = settingsWindow?.webContents;
  if (!settingsWindow || settingsWindow.isDestroyed()
    || !webContents || webContents.isDestroyed()
    || event.sender !== webContents
    || event.senderFrame !== webContents.mainFrame) {
    throw new Error("Untrusted storage request");
  }
}

function installIpcHandlers() {
  ipcMain.handle("companion:toggle-panel", () => togglePanel());
  ipcMain.handle("companion:hide-panel", () => {
    if (!panelWindow || panelWindow.isDestroyed()) return false;
    panelWindow.hide();
    return false;
  });
  ipcMain.handle("companion:show-badge-menu", (event) => {
    if (!badgeWindow || badgeWindow.isDestroyed() || event.sender !== badgeWindow.webContents) {
      throw new Error("Untrusted badge menu request");
    }
    showBadgeMenu();
    return true;
  });
  ipcMain.handle("companion:open-settings", (event) => {
    requireTrustedSender(event);
    showSettings().catch((error) => console.error("[companion] settings failed", error));
    return true;
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
  ipcMain.handle("settings:update", async (event, patch) => {
    requireTrustedSender(event);
    if (patch && Object.prototype.hasOwnProperty.call(patch, "remoteControl")) {
      throw new Error("Remote-control permissions require the dedicated settings API");
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
  ipcMain.handle("speech:get-voices", (event) => {
    requireTrustedSender(event);
    return speechState();
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
    const result = await dialog.showOpenDialog(settingsWindow || BrowserWindow.getFocusedWindow(), {
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
  ipcMain.handle("pet-library:select-zip", async (event) => {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog(settingsWindow || BrowserWindow.getFocusedWindow(), {
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
    if (!speechWindow || speechWindow.isDestroyed() || event.sender !== speechWindow.webContents) return;
    updateSpeechCapabilities(value);
  });
  ipcMain.on("speech:result", (event, value) => {
    if (!speechWindow || speechWindow.isDestroyed() || event.sender !== speechWindow.webContents) return;
    settleSpeechRequest(value);
  });
  ipcMain.on("pet-window:pointer-down", (event, value) => {
    if (badgeWindow && event.sender === badgeWindow.webContents) startPetPointer(value);
  });
  ipcMain.on("pet-window:pointer-move", (event, value) => {
    if (badgeWindow && event.sender === badgeWindow.webContents) movePetPointer(value);
  });
  ipcMain.on("pet-window:pointer-up", (event, value) => {
    if (badgeWindow && event.sender === badgeWindow.webContents) endPetPointer(value, false);
  });
  ipcMain.on("pet-window:pointer-cancel", (event, value) => {
    if (badgeWindow && event.sender === badgeWindow.webContents) endPetPointer(value, true);
  });
  ipcMain.on("pet-renderer:animation-end", (event, value) => {
    if (badgeWindow && event.sender === badgeWindow.webContents) {
      petStateController?.acknowledgeAnimation(value?.generation);
    }
  });
  ipcMain.on("companion:start-badge-drag", (event) => {
    if (badgeWindow && event.sender === badgeWindow.webContents) {
      const cursor = screen.getCursorScreenPoint();
      startPetPointer({ pointerId: -1, screenX: cursor.x, screenY: cursor.y, time: Date.now() });
    }
  });
  ipcMain.on("companion:stop-badge-drag", (event) => {
    if (badgeWindow && event.sender === badgeWindow.webContents) {
      const cursor = screen.getCursorScreenPoint();
      endPetPointer({ pointerId: -1, screenX: cursor.x, screenY: cursor.y, time: Date.now() }, true);
    }
  });
  ipcMain.on("companion:resize-panel", (event, value) => {
    if (!panelWindow || panelWindow.isDestroyed() || event.sender !== panelWindow.webContents) return;
    const badgeBounds = badgeWindow?.getBounds() || panelWindow.getBounds();
    const workArea = workAreaForBounds(badgeBounds);
    const maximumHeight = Math.min(PANEL_HEIGHT, workArea.height - 24);
    const requestedHeight = Math.round(Number(value?.height) || 0);
    const height = Math.max(PANEL_MIN_HEIGHT, Math.min(maximumHeight, requestedHeight));
    const currentBounds = panelWindow.getBounds();
    const previousAlignment = panelVerticalAlignment(
      panelVisibleItemCount,
      currentBounds.height,
      badgeBounds.height,
    );
    const requestedItemCount = Math.round(Number(value?.itemCount));
    panelVisibleItemCount = Number.isFinite(requestedItemCount)
      ? Math.max(0, Math.min(999, requestedItemCount))
      : 0;
    const nextAlignment = panelVerticalAlignment(
      panelVisibleItemCount,
      height,
      badgeBounds.height,
    );
    if (Math.abs(currentBounds.height - height) < 2 && previousAlignment === nextAlignment) return;
    const width = Math.min(PANEL_WIDTH, workArea.width - 24);
    panelWindow.setBounds({ ...currentBounds, width, height }, false);
    positionPanel();
  });
  ipcMain.on("companion:update-summary", (_event, value) => {
    const count = Math.max(0, Math.min(999, Number(value?.count) || 0));
    const state = typeof value?.state === "string" ? value.state : "idle";
    tray?.setToolTip(count ? `${PRODUCT_NAME} · ${count} 项待处理` : PRODUCT_NAME);
    badgeWindow?.setTitle(`${PRODUCT_NAME} · ${state}`);
  });
}

async function shutdownOwnedService() {
  appUpdater?.stop();
  if (remoteControlController) await remoteControlController.stop();
  remoteChannelHub?.stop();
  if (taskEventClient) await taskEventClient.stop();
  if (notificationOrchestrator) await notificationOrchestrator.stop();
  if (weixinRemoteService) await weixinRemoteService.stop();
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
    if (preferenceStore?.get().appearance.showPet) badgeWindow?.showInactive();
    showPanel();
  });

  app.on("before-quit", (event) => {
    quitting = true;
    stopBadgeDrag();
    const hasManagedVoiceService = gptSovitsService?.hasManagedProcess();
    if ((!ownedServer && !ownedCollector && !hasManagedVoiceService && !codexCopywriter
      && !taskEventClient && !notificationOrchestrator && !weixinRemoteService) || shutdownStarted) return;
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
      remoteTaskRegistry = new RemoteTaskRegistry(remoteTaskRegistryPath());
      await remoteTaskRegistry.load();
      voiceLibrary = new VoiceLibrary(voiceLibraryPath());
      petLibrary = new PetLibrary(petLibraryPath());
      installPetAssetProtocol();
      gptSovitsService = new GptSovitsServiceController(gptSovitsEnginePath());
      phrasePoolStore = new PhrasePoolStore(phrasePoolPath());
      notificationHistory = new NotificationHistoryStore(notificationHistoryPath());
      secureCredentials = new SecureCredentials(secureCredentialsPath(), safeStorage);
      weixinRemoteService = new WeixinRemoteService({
        loadCredentials: () => secureCredentials.load("weixin"),
        saveCredentials: (value) => secureCredentials.save("weixin", value),
        clearCredentials: () => secureCredentials.clear("weixin"),
        onStatus: (status) => {
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send("weixin:status-changed", status);
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
            settingsWindow.webContents.send("app:update-status-changed", status);
          }
        },
      });
      codexCopywriter = new CodexCopywriter({
        store: phrasePoolStore,
        workingDirectory: copywriterPath(),
      });
      dailyReportGenerator = new DailyReportGenerator({
        workingDirectory: copywriterPath(),
        cacheDirectory: dailyReportCachePath(),
      });
      const preferences = await preferenceStore.load();
      remoteCodexExecutor = new CodexRemoteExecutor();
      remoteChannelHub = new RemoteChannelHub();
      weixinChannelAdapter = createWeixinChannelAdapter({
        service: weixinRemoteService,
        accountId: "primary",
      });
      remoteChannelHub.register(weixinChannelAdapter);
      remoteControlController = new RemoteControlController({
        registry: remoteTaskRegistry,
        executor: remoteCodexExecutor,
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
      await createSpeechWindow();
      await createWindows();
      installDisplayHandlers();
      createTray();
      appUpdater.start();
      await weixinRemoteService.start();
      createNotificationServices();
      scheduleCopywriter(preferences, 3_000);
      if (preferences.notifications.voice.gptSovits.autoStartService) {
        gptSovitsService.start().catch((error) => {
          console.error("[companion] GPT-SoVITS auto-start failed", error);
        });
      }
      console.log("[companion] tray ready");
    })
    .catch((error) => {
      console.error("[companion] startup failed", error);
      quitting = true;
      app.quit();
    });
}
