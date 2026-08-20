const controls = [...document.querySelectorAll("[data-path]")];
const saveStatus = document.querySelector("#save-status");
const appVersion = document.querySelector("#app-version");
const appUpdateStatus = document.querySelector("#app-update-status");
const appUpdateAction = document.querySelector("#app-update-action");
const unavailable = document.querySelector("#unavailable");
const layout = document.querySelector(".settings-layout");
const resetButton = document.querySelector("#reset-settings");
const openAtLoginHelp = document.querySelector("#open-at-login-help");
const testNotificationButton = document.querySelector("#test-notification");
const testNotificationResult = document.querySelector("#test-notification-result");
const notificationHistoryPathButton = document.querySelector("#notification-history-path");
const notificationHistoryLocationStatus = document.querySelector("#notification-history-location-status");
const agentProviderList = document.querySelector("#agent-provider-list");
const agentProviderStatus = document.querySelector("#agent-provider-status");
const navigationItems = [...document.querySelectorAll(".nav-item[data-page]")];
const settingsPages = [...document.querySelectorAll("[data-settings-page]")];
const voiceSelect = document.querySelector('[data-path="notifications.voice.voiceId"]');
const voiceCapability = document.querySelector("#voice-capability");
const voiceHelp = document.querySelector("#voice-help");
const voicePreviewText = document.querySelector("#voice-preview-text");
const testVoiceButton = document.querySelector("#test-voice");
const voiceEngine = document.querySelector("#voice-engine");
const voiceEngineOptions = [...document.querySelectorAll("[data-voice-engine-option]")];
const voiceEnginePanels = [...document.querySelectorAll("[data-voice-engine-panel]")];
const voiceStyleForm = document.querySelector("#voice-style-form");
const voiceStyleControls = [...voiceStyleForm.querySelectorAll("[data-path]")];
const voiceStyleControlSet = new Set(voiceStyleControls);
const saveVoiceStyleButton = document.querySelector("#save-voice-style");
const testGptSovitsConnectionButton = document.querySelector("#test-gpt-sovits-connection");
const manageGptSovitsServiceButton = document.querySelector("#manage-gpt-sovits-service");
const stopGptSovitsServiceButton = document.querySelector("#stop-gpt-sovits-service");
const openGptSovitsLogButton = document.querySelector("#open-gpt-sovits-log");
const removeGptSovitsServiceButton = document.querySelector("#remove-gpt-sovits-service");
const gptSovitsServiceStatus = document.querySelector("#gpt-sovits-service-status");
const gptSovitsServiceDescription = document.querySelector("#gpt-sovits-service-description");
const gptSovitsRuntimeSummary = document.querySelector("#gpt-sovits-runtime-summary");
const gptSovitsRuntimeDevice = document.querySelector("#gpt-sovits-runtime-device");
const gptSovitsRuntimeHelp = document.querySelector("#gpt-sovits-runtime-help");
const reconfigureGptSovitsDeviceButton = document.querySelector("#reconfigure-gpt-sovits-device");
const gptSovitsHelp = document.querySelector("#gpt-sovits-help");
const gptSovitsVoice = document.querySelector("#gpt-sovits-voice");
const voiceLibraryHelp = document.querySelector("#voice-library-help");
const addGptSovitsVoiceButton = document.querySelector("#add-gpt-sovits-voice");
const editGptSovitsVoiceButton = document.querySelector("#edit-gpt-sovits-voice");
const removeGptSovitsVoiceButton = document.querySelector("#remove-gpt-sovits-voice");
const voiceEditor = document.querySelector("#voice-editor");
const voiceEditorForm = document.querySelector("#voice-editor-form");
const voiceEditorTitle = document.querySelector("#voice-editor-title");
const voiceName = document.querySelector("#voice-name");
const voiceGptFile = document.querySelector("#voice-gpt-file");
const voiceSovitsFile = document.querySelector("#voice-sovits-file");
const voiceReferenceFile = document.querySelector("#voice-reference-file");
const voicePromptText = document.querySelector("#voice-prompt-text");
const voicePromptLanguage = document.querySelector("#voice-prompt-language");
const voiceEditorHelp = document.querySelector("#voice-editor-help");
const saveVoiceEditorButton = document.querySelector("#save-voice-editor");
const voiceFileButtons = [...document.querySelectorAll("[data-pick-voice-file]")];
const closeVoiceEditorButtons = [
  document.querySelector("#close-voice-editor"),
  document.querySelector("#cancel-voice-editor"),
];
const petLibrarySelect = document.querySelector("#pet-library-select");
const petZipDrop = document.querySelector("#pet-zip-drop");
const importPetZipButton = document.querySelector("#import-pet-zip");
const removePetButton = document.querySelector("#remove-pet");
const openPetLibraryButton = document.querySelector("#open-pet-library");
const petLibraryStatus = document.querySelector("#pet-library-status");
const weixinServiceCard = document.querySelector("#weixin-service-card");
const weixinConnectionStatus = document.querySelector("#weixin-connection-status");
const weixinConnectionDescription = document.querySelector("#weixin-connection-description");
const weixinAccountLabel = document.querySelector("#weixin-account-label");
const weixinConnectButton = document.querySelector("#weixin-connect");
const weixinContinueButton = document.querySelector("#weixin-continue");
const weixinReconnectButton = document.querySelector("#weixin-reconnect");
const weixinTestButton = document.querySelector("#weixin-test");
const weixinDisconnectButton = document.querySelector("#weixin-disconnect");
const weixinActionResult = document.querySelector("#weixin-action-result");
const remoteControlCard = document.querySelector("#remote-control");
const remoteControlEnabled = document.querySelector("#remote-control-enabled");
const remoteControlStatus = document.querySelector("#remote-control-status");
const weixinConnectDialog = document.querySelector("#weixin-connect-dialog");
const closeWeixinDialogButton = document.querySelector("#close-weixin-dialog");
const dismissWeixinDialogButton = document.querySelector("#dismiss-weixin-dialog");
const retryWeixinConnectionButton = document.querySelector("#retry-weixin-connection");
const weixinQrStage = document.querySelector("#weixin-qr-stage");
const weixinQrCode = document.querySelector("#weixin-qr-code");
const weixinQrLoading = document.querySelector("#weixin-qr-loading");
const weixinQrTitle = document.querySelector("#weixin-qr-title");
const weixinQrHelp = document.querySelector("#weixin-qr-help");
const weixinVerificationForm = document.querySelector("#weixin-verification-form");
const weixinVerificationCode = document.querySelector("#weixin-verification-code");
const submitWeixinVerificationButton = document.querySelector("#submit-weixin-verification");
const weixinBindStage = document.querySelector("#weixin-bind-stage");
const weixinReconnectingStage = document.querySelector("#weixin-reconnecting-stage");
const weixinConnectedStage = document.querySelector("#weixin-connected-stage");
const weixinConnectedAccount = document.querySelector("#weixin-connected-account");
const weixinDegradedStage = document.querySelector("#weixin-degraded-stage");
const weixinDegradedError = document.querySelector("#weixin-degraded-error");
const weixinErrorStage = document.querySelector("#weixin-error-stage");
const weixinDialogError = document.querySelector("#weixin-dialog-error");
const weixinDialogStatus = document.querySelector("#weixin-dialog-status");
const copyCommunityGroupButton = document.querySelector("#copy-community-group");
const communityCopyStatus = document.querySelector("#community-copy-status");

const COMMUNITY_GROUP_NUMBER = "650561994";

let settingsState = null;
let systemSpeechState = { supported: false, voices: [] };
let saveQueue = Promise.resolve();
let saveRevision = 0;
let customVoiceState = { rootPath: "", selectedVoiceId: "", voices: [] };
let voiceEditorMode = "add";
let editingVoiceId = "";
let pendingVoiceFiles = { gpt: "", sovits: "", reference: "" };
let serviceStatusRefreshing = false;
let runtimeOptionsState = null;
let voiceStyleDirty = false;
let managedPetState = { rootPath: "", selectedPetId: "builtin-default", pets: [] };
let petImportBusy = false;
let notificationHistoryLocationId = "";
let weixinState = {
  state: "disconnected",
  connected: false,
  bound: false,
  qrCodeUrl: "",
  lastError: "",
  accountLabel: "",
};
let weixinActionBusy = false;
let remoteControlState = {
  available: false,
  enabled: false,
  busy: false,
};
let removeWeixinStatusListener = null;
let removeRemoteControlListener = null;
let removeAppUpdateStatusListener = null;
let appUpdateState = { state: "unavailable", currentVersion: "" };

function showPage(page) {
  const selectedItem = navigationItems.find((item) => item.dataset.page === page);
  if (!selectedItem) return;
  for (const item of navigationItems) {
    item.setAttribute("aria-selected", String(item === selectedItem));
  }
  for (const section of settingsPages) {
    section.hidden = section.dataset.settingsPage !== page;
  }
  window.scrollTo({ top: 0 });
}

function setPetLibraryStatus(state, message) {
  petLibraryStatus.dataset.state = state || "";
  petLibraryStatus.textContent = message;
}

function renderPetLibrary(state) {
  managedPetState = state || { rootPath: "", selectedPetId: "builtin-default", pets: [] };
  const builtin = document.createElement("option");
  builtin.value = "builtin-default";
  builtin.textContent = "小团（内置默认）";
  const options = (managedPetState.pets || []).map((pet) => {
    const option = document.createElement("option");
    option.value = pet.id;
    option.textContent = pet.displayName || pet.id;
    return option;
  });
  petLibrarySelect.replaceChildren(builtin, ...options);
  petLibrarySelect.value = managedPetState.selectedPetId || "builtin-default";
  removePetButton.disabled = petLibrarySelect.value === "builtin-default" || petImportBusy;
  petLibraryStatus.title = managedPetState.rootPath || "";
}

async function loadPetLibrary() {
  if (!window.companion?.getPetLibrary) return;
  renderPetLibrary(await window.companion.getPetLibrary());
  setPetLibraryStatus("", managedPetState.pets.length
    ? `已导入 ${managedPetState.pets.length} 个宠物。`
    : "尚未导入宠物，可把完整 ZIP 压缩包拖到上方。"
  );
}

async function importPetArchive(filePath) {
  const archivePath = String(filePath || "");
  if (!archivePath.toLowerCase().endsWith(".zip")) {
    setPetLibraryStatus("error", "请选择完整的 ZIP 宠物压缩包。");
    return;
  }
  petImportBusy = true;
  importPetZipButton.disabled = true;
  petLibrarySelect.disabled = true;
  removePetButton.disabled = true;
  setPetLibraryStatus("", "正在校验并复制宠物文件…");
  try {
    renderPetLibrary(await window.companion.importPetZip(archivePath));
    setPetLibraryStatus("success", `“${petLibrarySelect.selectedOptions[0]?.textContent || "宠物"}”已导入并启用。`);
  } catch (error) {
    setPetLibraryStatus("error", `导入失败：${error.message || "压缩包格式不正确"}`);
  } finally {
    petImportBusy = false;
    importPetZipButton.disabled = false;
    petLibrarySelect.disabled = false;
    removePetButton.disabled = petLibrarySelect.value === "builtin-default";
  }
}

function setStatus(state, label) {
  saveStatus.dataset.state = state;
  saveStatus.textContent = label;
}

function valueAtPath(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

function patchAtPath(path, value) {
  const root = {};
  const parts = path.split(".");
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor[parts[index]] = {};
    cursor = cursor[parts[index]];
  }
  cursor[parts.at(-1)] = value;
  return root;
}

function controlValue(control) {
  if (control.type === "checkbox") return control.checked;
  if (control.type === "range") return Number(control.value);
  return control.value;
}

function updateRangeOutput(control) {
  if (control.type !== "range") return;
  const output = document.querySelector(`[data-output-for="${control.dataset.path}"]`);
  if (output) output.value = control.value;
}

function render(state) {
  settingsState = state;
  renderAgentProviders(state.agentProviders);
  for (const control of controls) {
    if (voiceStyleDirty && voiceStyleControlSet.has(control)) continue;
    const value = valueAtPath(state.preferences, control.dataset.path);
    if (control.type === "checkbox") control.checked = Boolean(value);
    else if (value !== undefined) control.value = String(value);
    updateRangeOutput(control);
  }

  const openAtLogin = controls.find((control) => control.dataset.path === "startup.openAtLogin");
  if (openAtLogin) openAtLogin.disabled = !state.capabilities.openAtLogin;
  openAtLoginHelp.textContent = state.capabilities.openAtLogin
    ? "伴生层会在 Windows 登录后自动运行。"
    : "安装正式版本后可用。";
  updateVoiceEngineUI();
}

function renderAgentProviders(connectionState) {
  const activeProviderId = String(connectionState?.activeProviderId || "");
  const providers = Array.isArray(connectionState?.providers) ? connectionState.providers : [];
  if (!providers.length) {
    const empty = document.createElement("div");
    empty.className = "agent-provider-placeholder";
    empty.textContent = "当前版本没有可连接的智能体。";
    agentProviderList.replaceChildren(empty);
    return;
  }
  const cards = providers.map((provider) => {
    const selected = provider.id === activeProviderId || provider.selected === true;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "agent-provider-card";
    card.dataset.providerId = provider.id;
    card.setAttribute("aria-pressed", String(selected));

    const icon = document.createElement("span");
    icon.className = "agent-provider-icon";
    if (provider.iconUrl) {
      const image = document.createElement("img");
      image.src = provider.iconUrl;
      image.alt = "";
      image.setAttribute("aria-hidden", "true");
      icon.append(image);
    } else {
      icon.classList.add("is-fallback");
      icon.textContent = provider.badge || provider.displayName.slice(0, 1).toUpperCase();
    }
    const copy = document.createElement("span");
    copy.className = "agent-provider-copy";
    const name = document.createElement("strong");
    name.textContent = provider.displayName;
    const description = document.createElement("small");
    description.textContent = provider.description || "连接后由该智能体提供任务状态。";
    copy.append(name, description);
    const status = document.createElement("span");
    status.className = "agent-provider-state";
    status.textContent = selected ? "已连接" : "连接";
    card.append(icon, copy, status);
    return card;
  });
  agentProviderList.replaceChildren(...cards);
  const selected = providers.find((provider) => provider.id === activeProviderId);
  agentProviderStatus.dataset.state = "";
  agentProviderStatus.textContent = selected
    ? `当前宠物已连接到 ${selected.displayName}。`
    : "请选择一个智能体建立连接。";
}

async function loadStorageLocations() {
  notificationHistoryLocationStatus.textContent = "";
  try {
    const locations = await window.companion.getStorageLocations();
    const location = locations?.notificationHistory;
    const locationPath = String(location?.path || "");
    notificationHistoryLocationId = String(location?.id || "");
    notificationHistoryPathButton.textContent = locationPath || "通知记录目录不可用";
    notificationHistoryPathButton.title = locationPath;
    notificationHistoryPathButton.setAttribute(
      "aria-label",
      locationPath ? `打开通知记录目录：${locationPath}` : "通知记录目录不可用",
    );
    notificationHistoryPathButton.disabled = !notificationHistoryLocationId || !locationPath;
  } catch (error) {
    console.error("Unable to load storage locations", error);
    notificationHistoryLocationId = "";
    notificationHistoryPathButton.textContent = "通知记录目录不可用";
    notificationHistoryPathButton.title = "";
    notificationHistoryPathButton.setAttribute("aria-label", "通知记录目录不可用");
    notificationHistoryPathButton.disabled = true;
    notificationHistoryLocationStatus.textContent = `读取位置失败：${error.message || "未知错误"}`;
  }
}

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function selectedCustomVoice() {
  return customVoiceState.voices.find((voice) => voice.id === customVoiceState.selectedVoiceId) || null;
}

function renderVoiceLibrary(state) {
  customVoiceState = state || { rootPath: "", selectedVoiceId: "", voices: [] };
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = customVoiceState.voices.length ? "请选择音色" : "尚未添加音色";
  const options = customVoiceState.voices.map((voice) => {
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.valid ? voice.name : `${voice.name}（文件不完整）`;
    return option;
  });
  gptSovitsVoice.replaceChildren(emptyOption, ...options);
  gptSovitsVoice.value = customVoiceState.voices.some(
    (voice) => voice.id === customVoiceState.selectedVoiceId,
  ) ? customVoiceState.selectedVoiceId : "";

  const selected = selectedCustomVoice();
  editGptSovitsVoiceButton.disabled = !selected;
  removeGptSovitsVoiceButton.disabled = !selected;
  if (!customVoiceState.voices.length) {
    voiceLibraryHelp.textContent = "尚未添加音色。点击“添加”导入一个音色包。";
  } else if (selected) {
    voiceLibraryHelp.textContent = selected.valid
      ? `${selected.originalFiles.gpt} + ${selected.originalFiles.sovits} · ${formatFileSize(selected.sizeBytes)}`
      : "这个音色的库内文件不完整，请删除后重新添加。";
  } else {
    voiceLibraryHelp.textContent = `已添加 ${customVoiceState.voices.length} 个音色，请选择一个。`;
  }
  voiceLibraryHelp.title = customVoiceState.rootPath || "";
  updateVoiceEngineUI();
}

async function loadVoiceLibrary() {
  if (!window.companion?.getVoiceLibrary) return;
  try {
    renderVoiceLibrary(await window.companion.getVoiceLibrary());
  } catch (error) {
    console.error("Unable to load voice library", error);
    setGptSovitsHelp("error", `无法读取音色库：${error.message || "未知错误"}`);
  }
}

function updateVoiceEngineUI() {
  const engine = voiceEngine?.value || "windows";
  for (const option of voiceEngineOptions) {
    option.setAttribute("aria-pressed", String(option.dataset.voiceEngineOption === engine));
  }
  for (const panel of voiceEnginePanels) {
    panel.hidden = panel.dataset.voiceEnginePanel !== engine;
  }

  if (engine === "gpt-sovits") {
    const selected = selectedCustomVoice();
    voiceCapability.dataset.state = selected?.valid ? "available" : "error";
    voiceCapability.textContent = selected?.valid ? "音色可用" : "待添加音色";
    testVoiceButton.disabled = !selected?.valid;
    return;
  }

  if (systemSpeechState.supported) {
    voiceCapability.dataset.state = "available";
    voiceCapability.textContent = "本地可用";
    testVoiceButton.disabled = false;
  } else {
    voiceCapability.dataset.state = "error";
    voiceCapability.textContent = "不可用";
    testVoiceButton.disabled = true;
  }
}

function populateVoices(speech) {
  systemSpeechState = speech;
  const selectedVoice = settingsState?.preferences.notifications.voice.voiceId || "system";
  const defaultOption = document.createElement("option");
  defaultOption.value = "system";
  defaultOption.textContent = "跟随系统默认语音";
  const voices = [...(speech.voices || [])].sort((left, right) => {
    const leftChinese = left.lang.toLowerCase().startsWith("zh") ? 0 : 1;
    const rightChinese = right.lang.toLowerCase().startsWith("zh") ? 0 : 1;
    return leftChinese - rightChinese || left.name.localeCompare(right.name, "zh-CN");
  });
  const options = voices.map((voice) => {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    const compactName = voice.name.length > 32
      ? voice.name.split(" - ")[0]
      : voice.name;
    option.textContent = `${compactName} · ${voice.lang}${voice.default ? " · 默认" : ""}`;
    option.title = `${voice.name} · ${voice.lang}`;
    return option;
  });
  voiceSelect.replaceChildren(defaultOption, ...options);
  voiceSelect.value = voices.some((voice) => voice.voiceURI === selectedVoice)
    ? selectedVoice
    : "system";

  if (speech.supported) {
    voiceHelp.textContent = voices.length
      ? `已读取 ${voices.length} 个系统音色，中文音色会优先显示。`
      : "语音引擎可用，但暂未返回音色列表，将使用系统默认语音。";
  } else {
    voiceHelp.textContent = "当前 Electron 环境没有可用的本地语音引擎。";
  }
  updateVoiceEngineUI();
}

function setGptSovitsHelp(state, message) {
  gptSovitsHelp.dataset.state = state;
  gptSovitsHelp.textContent = message;
}

function renderGptSovitsServiceStatus(status) {
  const state = status?.state || "error";
  const labels = {
    "not-installed": "未安装",
    stopped: "已停止",
    starting: "启动中",
    running: "运行中",
    error: "启动失败",
  };
  gptSovitsServiceStatus.dataset.state = state;
  gptSovitsServiceStatus.textContent = labels[state] || "状态未知";

  if (state === "not-installed") {
    gptSovitsServiceDescription.textContent = "尚未安装本地运行环境，安装时会显示下载进度窗口。";
    manageGptSovitsServiceButton.textContent = "安装";
  } else if (state === "stopped") {
    gptSovitsServiceDescription.textContent = "运行环境已经安装，可以在后台启动，不会显示 CMD 窗口。";
    manageGptSovitsServiceButton.textContent = "后台启动";
  } else if (state === "starting") {
    gptSovitsServiceDescription.textContent = "正在后台加载模型，CPU 模式可能需要一些时间。";
    manageGptSovitsServiceButton.textContent = "启动中…";
  } else if (state === "running" && status.managed) {
    gptSovitsServiceDescription.textContent = "服务由 Agent Pet 在后台管理。";
    manageGptSovitsServiceButton.textContent = "运行中";
  } else if (state === "running") {
    gptSovitsServiceDescription.textContent = "检测到外部启动的服务；关闭原有 CMD 后可改由应用后台管理。";
    manageGptSovitsServiceButton.textContent = "外部运行中";
  } else {
    gptSovitsServiceDescription.textContent = status?.error || "服务未能正常启动，请查看日志。";
    manageGptSovitsServiceButton.textContent = "重新启动";
  }

  const busy = state === "starting" || state === "running";
  manageGptSovitsServiceButton.disabled = busy;
  stopGptSovitsServiceButton.hidden = !(status?.managed && busy);
  stopGptSovitsServiceButton.disabled = false;
  removeGptSovitsServiceButton.disabled = busy;
  const autoStart = controls.find(
    (control) => control.dataset.path === "notifications.voice.gptSovits.autoStartService",
  );
  if (autoStart) autoStart.disabled = !status?.installed;
}

function runtimeDeviceLabel(device) {
  return {
    CPU: "CPU（兼容模式）",
    CU126: "NVIDIA CUDA 12.6",
    CU128: "NVIDIA CUDA 12.8",
  }[device] || "尚未配置";
}

function renderGptSovitsRuntimeOptions(options) {
  runtimeOptionsState = options;
  const installedDevice = options?.status?.installation?.device || "";
  const availableDevices = options?.hardware?.availableDevices || ["CPU"];
  const selectableDevices = [...new Set([installedDevice, ...availableDevices].filter(Boolean))];
  const deviceOptions = selectableDevices.map((device) => {
    const option = document.createElement("option");
    option.value = device;
    option.textContent = runtimeDeviceLabel(device);
    option.disabled = !availableDevices.includes(device);
    return option;
  });
  gptSovitsRuntimeDevice.replaceChildren(...deviceOptions);
  gptSovitsRuntimeDevice.value = installedDevice || availableDevices[0] || "CPU";
  gptSovitsRuntimeSummary.textContent = options?.status?.installed
    ? `当前：${runtimeDeviceLabel(installedDevice)}`
    : "安装时选择计算设备";

  const names = (options?.hardware?.devices || []).map((device) => device.name).join("、");
  if (options?.hardware?.vendor === "nvidia") {
    gptSovitsRuntimeHelp.textContent = `${names || "已检测到 NVIDIA 显卡"}。可选择 CUDA 12.6 或 12.8；更改后需要重新下载对应的 PyTorch 组件。`;
  } else if (options?.hardware?.vendor === "amd") {
    gptSovitsRuntimeHelp.textContent = `${names || "已检测到 AMD 显卡"}。当前 GPT-SoVITS Windows 安装方案不提供 AMD GPU 加速，因此使用 CPU 模式。`;
  } else {
    gptSovitsRuntimeHelp.textContent = "未检测到支持 CUDA 的 NVIDIA 显卡，当前使用 CPU 兼容模式。";
  }
  reconfigureGptSovitsDeviceButton.disabled = !options?.status?.installed
    || !availableDevices.includes(gptSovitsRuntimeDevice.value)
    || gptSovitsRuntimeDevice.value === installedDevice;
}

async function refreshGptSovitsRuntimeOptions() {
  if (!window.companion?.getGptSovitsRuntimeOptions) return;
  try {
    renderGptSovitsRuntimeOptions(await window.companion.getGptSovitsRuntimeOptions());
  } catch (error) {
    gptSovitsRuntimeSummary.textContent = "无法读取运行环境";
    gptSovitsRuntimeHelp.textContent = error.message || "设备检测失败";
    reconfigureGptSovitsDeviceButton.disabled = true;
  }
}

async function refreshGptSovitsServiceStatus() {
  if (serviceStatusRefreshing || !window.companion?.getGptSovitsServiceStatus) return;
  serviceStatusRefreshing = true;
  try {
    renderGptSovitsServiceStatus(await window.companion.getGptSovitsServiceStatus());
  } catch (error) {
    renderGptSovitsServiceStatus({ state: "error", error: error.message || "状态检测失败" });
  } finally {
    serviceStatusRefreshing = false;
  }
}

async function loadVoices() {
  if (!window.companion?.getSpeechVoices) return;
  try {
    populateVoices(await window.companion.getSpeechVoices());
  } catch (error) {
    console.error("Unable to load speech voices", error);
    populateVoices({ supported: false, voices: [] });
  }
}

function queueSave(path, value) {
  const revision = ++saveRevision;
  setStatus("saving", "正在保存…");
  saveQueue = saveQueue
    .then(() => window.companion.updateSettings(patchAtPath(path, value)))
    .then((state) => {
      settingsState = state;
      if (revision === saveRevision) {
        render(state);
        setStatus("saved", "已保存");
      }
    })
    .catch((error) => {
      console.error("Unable to save settings", error);
      if (revision === saveRevision) setStatus("error", "保存失败");
    });
}

const WEIXIN_STATES = new Set([
  "disconnected",
  "waiting_scan",
  "scanned",
  "verification_required",
  "waiting_bind",
  "reconnecting",
  "connected",
  "degraded",
  "error",
]);

const WEIXIN_ACTIVE_STATES = new Set([
  "waiting_scan",
  "scanned",
  "verification_required",
  "waiting_bind",
  "reconnecting",
]);

function normalizeWeixinStatus(result) {
  const source = result?.status && typeof result.status === "object" ? result.status : (result || {});
  let state = WEIXIN_STATES.has(source.state) ? source.state : "disconnected";
  let connected = Boolean(source.connected);
  const bound = Boolean(source.bound);
  const deliveryState = String(source.deliveryState || "");
  const replyContextInvalid = Boolean(source.replyContextInvalid)
    || deliveryState === "reply_context_invalid";
  if (!bound) connected = false;
  if (state === "connected" && !(connected && bound)) state = "waiting_bind";
  if (connected && bound) {
    state = ["degraded", "reply_context_invalid"].includes(deliveryState)
      ? "degraded"
      : "connected";
  }
  return {
    state,
    connected,
    bound,
    sendAvailable: Boolean(source.sendAvailable),
    deliveryState,
    qrCodeUrl: String(source.qrCodeUrl || ""),
    lastError: String(source.lastError || source.error || ""),
    lastSendError: String(source.lastSendError || ""),
    contextUpdatedAt: String(source.contextUpdatedAt || ""),
    replyContextInvalid,
    accountLabel: String(source.accountLabel || ""),
  };
}

function hasWeixinConnectionApi() {
  return Boolean(
    window.companion?.getWeixinStatus
    && window.companion?.startWeixinConnection
    && window.companion?.disconnectWeixin,
  );
}

function hasRemoteControlApi() {
  return Boolean(
    window.companion?.getRemoteControlSettings
    && window.companion?.updateRemoteControlSettings,
  );
}

function normalizeRemoteControlSettings(value = {}) {
  const source = value?.remoteControl && typeof value.remoteControl === "object"
    ? value.remoteControl
    : (value?.settings?.remoteControl && typeof value.settings.remoteControl === "object"
      ? value.settings.remoteControl
      : (value?.settings && typeof value.settings === "object" ? value.settings : value));
  return {
    available: hasRemoteControlApi() && value?.available !== false,
    enabled: Boolean(source?.enabled),
    busy: false,
  };
}

function renderRemoteControlSettings(state, message = "", messageState = "") {
  remoteControlState = state;
  const unavailable = !state.available;
  remoteControlCard.dataset.state = unavailable
    ? "unavailable"
    : (state.enabled ? "enabled" : "disabled");
  remoteControlEnabled.checked = !unavailable && state.enabled;
  remoteControlEnabled.disabled = unavailable || state.busy;

  let status = message;
  let statusState = messageState;
  if (!status && unavailable) {
    status = "指令操作后端不可用，功能已按安全默认值关闭。";
    statusState = "error";
  } else if (!status && state.enabled) {
    status = "指令操作已开启。所有已连接且受信任的远程服务可使用同一套指令。";
    statusState = "success";
  } else if (!status) {
    status = "指令操作已关闭。普通消息仍可用于刷新远程连接。";
  }
  remoteControlStatus.dataset.state = statusState;
  remoteControlStatus.textContent = status;
}

async function loadRemoteControlSettings() {
  if (!hasRemoteControlApi()) {
    renderRemoteControlSettings(normalizeRemoteControlSettings());
    return;
  }
  try {
    renderRemoteControlSettings(normalizeRemoteControlSettings(
      await window.companion.getRemoteControlSettings(),
    ));
  } catch (error) {
    console.error("Unable to load remote control settings", error);
    renderRemoteControlSettings(
      normalizeRemoteControlSettings(),
      `无法读取指令操作设置，功能保持关闭：${error.message || "未知错误"}`,
      "error",
    );
  }
}

async function saveRemoteControlSettings(next) {
  if (!hasRemoteControlApi() || remoteControlState.busy) return;
  const previous = remoteControlState;
  const pending = {
    ...previous,
    enabled: Boolean(next.enabled),
    busy: true,
  };
  renderRemoteControlSettings(pending, "正在保存指令操作设置…");
  try {
    const result = await window.companion.updateRemoteControlSettings({
      enabled: pending.enabled,
    });
    renderRemoteControlSettings(
      normalizeRemoteControlSettings(result),
      "指令操作设置已保存。",
      "success",
    );
  } catch (error) {
    console.error("Unable to save remote control settings", error);
    renderRemoteControlSettings(
      { ...previous, busy: false },
      `保存失败，设置未更改：${error.message || "未知错误"}`,
      "error",
    );
  }
}

function setWeixinActionResult(state, message) {
  weixinActionResult.dataset.state = state || "";
  weixinActionResult.textContent = message || "";
}

function showWeixinDialog() {
  if (weixinConnectDialog.open) return;
  if (typeof weixinConnectDialog.showModal === "function") weixinConnectDialog.showModal();
  else weixinConnectDialog.setAttribute("open", "");
}

function closeWeixinDialog() {
  if (!weixinConnectDialog.open && !weixinConnectDialog.hasAttribute("open")) return;
  if (typeof weixinConnectDialog.close === "function") weixinConnectDialog.close();
  else weixinConnectDialog.removeAttribute("open");
}

function renderWeixinDialog(status) {
  const state = status.state;
  const connectionConfirmed = state === "connected" && status.connected && status.bound;
  const qrVisible = state === "waiting_scan" || state === "scanned" || state === "disconnected";
  weixinQrStage.hidden = !qrVisible;
  weixinVerificationForm.hidden = state !== "verification_required";
  weixinBindStage.hidden = state !== "waiting_bind";
  weixinReconnectingStage.hidden = state !== "reconnecting";
  weixinConnectedStage.hidden = !connectionConfirmed;
  weixinDegradedStage.hidden = state !== "degraded";
  weixinErrorStage.hidden = state !== "error";

  if (qrVisible) {
    const hasQrCode = Boolean(status.qrCodeUrl);
    if (hasQrCode && weixinQrCode.src !== status.qrCodeUrl) weixinQrCode.src = status.qrCodeUrl;
    weixinQrCode.hidden = !hasQrCode;
    weixinQrLoading.hidden = hasQrCode;
    if (state === "scanned") {
      weixinQrTitle.textContent = "二维码已扫描";
      weixinQrHelp.textContent = "请在手机微信中完成确认，不要关闭此窗口。";
    } else if (hasQrCode) {
      weixinQrTitle.textContent = "使用微信扫码";
      weixinQrHelp.textContent = "请使用手机微信扫描二维码，并按手机上的提示继续。";
    } else {
      weixinQrTitle.textContent = state === "disconnected" ? "连接尚未开始" : "正在准备二维码…";
      weixinQrHelp.textContent = "二维码生成后，请使用手机微信扫码。";
    }
  }

  if (state === "verification_required" && weixinConnectDialog.open) {
    requestAnimationFrame(() => weixinVerificationCode.focus());
  }
  weixinConnectedAccount.textContent = status.accountLabel
    ? `${status.accountLabel} 已连接，现在可以接收远程通知。`
    : "现在可以接收 Agent Pet 的远程通知。";
  weixinDegradedError.textContent = status.lastSendError
    || "接收连接仍在线，但最近一次微信通知发送失败。";
  weixinDialogError.textContent = status.lastError || "连接已中止，请重新尝试。";

  const dialogLabels = {
    reconnecting: "微信通道暂时中断，正在自动重连。",
    disconnected: "连接过程在本机完成。",
    waiting_scan: "正在等待微信扫码。",
    scanned: "已扫码，正在等待手机确认。",
    verification_required: "微信要求额外验证，提交验证码后将继续连接。",
    waiting_bind: "扫码已确认，正在等待微信消息以完成连接。",
    connected: "已收到绑定消息，连接信息已安全保存在本机。",
    degraded: "微信接收通道在线，但发送能力需要恢复。",
    error: "连接没有完成。",
  };
  weixinDialogStatus.textContent = dialogLabels[state] || dialogLabels.disconnected;
}

function renderWeixinStatus(result) {
  weixinState = normalizeWeixinStatus(result);
  const {
    state,
    accountLabel,
    lastError,
    replyContextInvalid,
  } = weixinState;
  const labels = {
    reconnecting: "正在重连",
    disconnected: "未连接",
    waiting_scan: "等待扫码",
    scanned: "已扫码",
    verification_required: "等待验证",
    waiting_bind: "等待绑定",
    connected: "已连接",
    degraded: replyContextInvalid ? "待微信消息" : "发送异常",
    error: "连接异常",
  };
  const descriptions = {
    reconnecting: lastError || "微信长连接暂时中断，任务通知会在恢复后自动重试。",
    disconnected: "扫码连接后，可将任务结果发送到微信。",
    waiting_scan: "二维码已准备，请使用手机微信扫码。",
    scanned: "已扫描二维码，请在手机微信中完成确认。",
    verification_required: "微信要求额外验证，请输入手机微信中显示的验证码。",
    waiting_bind: "扫码已确认，请在微信中向 Agent Pet 发送任意一条消息。",
    connected: "已收到绑定消息，任务通知可以发送到该微信。",
    degraded: replyContextInvalid
      ? "微信回复状态暂时失效，请在微信中向 Agent Pet 发送任意消息恢复任务通知。"
      : (weixinState.lastSendError || "微信接收连接在线，但最近一次通知发送失败。"),
    error: lastError || "连接发生异常，请重新连接。",
  };

  weixinServiceCard.dataset.state = state;
  weixinConnectionStatus.dataset.state = state;
  weixinConnectionStatus.textContent = labels[state] || labels.disconnected;
  weixinConnectionDescription.textContent = descriptions[state] || descriptions.disconnected;
  weixinAccountLabel.hidden = !accountLabel;
  weixinAccountLabel.textContent = accountLabel ? `当前账号：${accountLabel}` : "";

  const active = WEIXIN_ACTIVE_STATES.has(state);
  const ready = ["connected", "degraded"].includes(state)
    && weixinState.connected && weixinState.bound;
  const apiAvailable = hasWeixinConnectionApi();
  weixinConnectButton.hidden = state !== "disconnected";
  weixinContinueButton.hidden = !active;
  weixinReconnectButton.hidden = replyContextInvalid
    || !(["connected", "degraded", "reconnecting", "error"].includes(state));
  weixinDisconnectButton.hidden = state === "disconnected";
  weixinConnectButton.disabled = weixinActionBusy || !apiAvailable;
  weixinContinueButton.disabled = weixinActionBusy;
  weixinReconnectButton.disabled = weixinActionBusy || !apiAvailable;
  weixinDisconnectButton.disabled = weixinActionBusy || !apiAvailable;
  weixinTestButton.disabled = weixinActionBusy
    || !ready
    || replyContextInvalid
    || !window.companion?.testWeixinNotification;

  if (!apiAvailable) {
    weixinServiceCard.dataset.state = "error";
    weixinConnectionStatus.dataset.state = "error";
    weixinConnectionStatus.textContent = "不可用";
    weixinConnectionDescription.textContent = "当前桌面端版本尚未提供微信连接能力。";
  }
  renderWeixinDialog(weixinState);
}

function setWeixinBusy(busy) {
  weixinActionBusy = busy;
  renderWeixinStatus(weixinState);
}

async function refreshWeixinStatus() {
  if (!window.companion?.getWeixinStatus) {
    renderWeixinStatus({ state: "disconnected" });
    return;
  }
  try {
    renderWeixinStatus(await window.companion.getWeixinStatus());
  } catch (error) {
    renderWeixinStatus({ state: "error", lastError: error.message || "无法读取微信连接状态" });
  }
}

async function beginWeixinConnection({ reset = false } = {}) {
  if (weixinActionBusy || !hasWeixinConnectionApi()) return;
  setWeixinActionResult("", "");
  setWeixinBusy(true);
  renderWeixinStatus({ state: "waiting_scan" });
  showWeixinDialog();
  try {
    if (reset) await window.companion.disconnectWeixin();
    const result = await window.companion.startWeixinConnection();
    if (result) renderWeixinStatus(result);
    else await refreshWeixinStatus();
  } catch (error) {
    renderWeixinStatus({ state: "error", lastError: error.message || "微信连接启动失败" });
    setWeixinActionResult("error", `连接失败：${error.message || "请稍后重试"}`);
  } finally {
    setWeixinBusy(false);
  }
}

function subscribeWeixinStatus() {
  if (!window.companion?.onWeixinStatus || removeWeixinStatusListener) return;
  const removeListener = window.companion.onWeixinStatus((status) => {
    renderWeixinStatus(status);
  });
  if (typeof removeListener === "function") removeWeixinStatusListener = removeListener;
}

function subscribeRemoteControlSettings() {
  if (!window.companion?.onRemoteControlSettings || removeRemoteControlListener) return;
  const removeListener = window.companion.onRemoteControlSettings((value) => {
    renderRemoteControlSettings(normalizeRemoteControlSettings(value));
  });
  if (typeof removeListener === "function") removeRemoteControlListener = removeListener;
}

function renderAppUpdateStatus(value = {}) {
  appUpdateState = {
    state: String(value.state || "unavailable"),
    currentVersion: String(value.currentVersion || ""),
    nextVersion: String(value.nextVersion || ""),
    progress: Math.max(0, Math.min(100, Number(value.progress) || 0)),
    message: String(value.message || ""),
    packaged: Boolean(value.packaged),
  };
  const { state, currentVersion, nextVersion, progress, message, packaged } = appUpdateState;
  appVersion.textContent = currentVersion ? `v${currentVersion}` : "v—";
  appUpdateStatus.dataset.state = state;

  const labels = {
    idle: "可检查 GitHub 新版本",
    checking: "正在检查新版本…",
    up_to_date: "当前已是最新版本",
    available: nextVersion ? `发现 v${nextVersion}` : "发现新版本",
    downloading: `正在下载 ${Math.round(progress)}%`,
    downloaded: nextVersion ? `v${nextVersion} 已下载` : "更新已下载",
    error: message || "检查更新失败",
    unavailable: packaged ? (message || "更新服务不可用") : "开发模式",
  };
  appUpdateStatus.textContent = labels[state] || message || "";
  appUpdateAction.hidden = state === "unavailable";
  appUpdateAction.disabled = state === "checking" || state === "downloading";
  appUpdateAction.textContent = state === "available"
    ? "下载更新"
    : state === "downloaded"
      ? "重启更新"
      : state === "downloading"
        ? `${Math.round(progress)}%`
        : state === "checking"
          ? "检查中…"
          : "检查更新";
}

function subscribeAppUpdateStatus() {
  if (!window.companion?.onAppUpdateStatus || removeAppUpdateStatusListener) return;
  const removeListener = window.companion.onAppUpdateStatus(renderAppUpdateStatus);
  if (typeof removeListener === "function") removeAppUpdateStatusListener = removeListener;
}

async function loadAppUpdateStatus() {
  if (!window.companion?.getAppUpdateStatus) return renderAppUpdateStatus();
  try {
    renderAppUpdateStatus(await window.companion.getAppUpdateStatus());
  } catch (error) {
    renderAppUpdateStatus({ state: "error", message: error.message });
  }
}

async function initialize() {
  if (!window.companion?.getSettings) {
    unavailable.hidden = false;
    layout.hidden = true;
    setStatus("error", "桌面端不可用");
    return;
  }

  try {
    subscribeWeixinStatus();
    subscribeRemoteControlSettings();
    subscribeAppUpdateStatus();
    render(await window.companion.getSettings());
    await Promise.all([
      loadStorageLocations(),
      loadVoices(),
      loadVoiceLibrary(),
      loadPetLibrary(),
      refreshGptSovitsServiceStatus(),
      refreshGptSovitsRuntimeOptions(),
      refreshWeixinStatus(),
      loadRemoteControlSettings(),
      loadAppUpdateStatus(),
    ]);
    setStatus("saved", "已保存");
  } catch (error) {
    console.error("Unable to load settings", error);
    unavailable.hidden = false;
    unavailable.textContent = "暂时无法读取设置，请关闭窗口后重试。";
    setStatus("error", "读取失败");
  }
}

importPetZipButton.addEventListener("click", async (event) => {
  event.stopPropagation();
  if (petImportBusy) return;
  try {
    const result = await window.companion.selectPetZip();
    if (!result?.canceled && result?.path) await importPetArchive(result.path);
  } catch (error) {
    setPetLibraryStatus("error", `无法选择压缩包：${error.message || "未知错误"}`);
  }
});

petZipDrop.addEventListener("click", () => importPetZipButton.click());
petZipDrop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    importPetZipButton.click();
  }
});
for (const eventName of ["dragenter", "dragover"]) {
  petZipDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    petZipDrop.dataset.dragging = "true";
  });
}
for (const eventName of ["dragleave", "dragend"]) {
  petZipDrop.addEventListener(eventName, () => {
    delete petZipDrop.dataset.dragging;
  });
}
petZipDrop.addEventListener("drop", async (event) => {
  event.preventDefault();
  delete petZipDrop.dataset.dragging;
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length !== 1) {
    setPetLibraryStatus("error", "一次请只拖入一个完整的 ZIP 压缩包。");
    return;
  }
  const filePath = window.companion.getPathForFile(files[0]);
  await importPetArchive(filePath);
});

petLibrarySelect.addEventListener("change", async () => {
  petLibrarySelect.disabled = true;
  removePetButton.disabled = true;
  setPetLibraryStatus("", "正在切换宠物…");
  try {
    renderPetLibrary(await window.companion.selectPet(petLibrarySelect.value));
    setPetLibraryStatus("success", "当前宠物已切换。");
  } catch (error) {
    setPetLibraryStatus("error", `切换失败：${error.message || "宠物文件不可用"}`);
    await loadPetLibrary();
  } finally {
    petLibrarySelect.disabled = false;
    removePetButton.disabled = petLibrarySelect.value === "builtin-default";
  }
});

removePetButton.addEventListener("click", async () => {
  const id = petLibrarySelect.value;
  const name = petLibrarySelect.selectedOptions[0]?.textContent || id;
  if (id === "builtin-default" || !window.confirm(`确定从应用宠物库删除“${name}”吗？\n\n只会删除应用管理的副本，不会删除原压缩包。`)) return;
  removePetButton.disabled = true;
  try {
    renderPetLibrary(await window.companion.removePet(id));
    setPetLibraryStatus("success", "宠物已从应用宠物库删除，当前已恢复为内置默认宠物。");
  } catch (error) {
    setPetLibraryStatus("error", `删除失败：${error.message || "未知错误"}`);
    removePetButton.disabled = false;
  }
});

openPetLibraryButton.addEventListener("click", async () => {
  openPetLibraryButton.disabled = true;
  try {
    await window.companion.openPetLibrary();
  } catch (error) {
    setPetLibraryStatus("error", `无法打开宠物库：${error.message || "未知错误"}`);
  } finally {
    openPetLibraryButton.disabled = false;
  }
});

weixinConnectButton.addEventListener("click", () => beginWeixinConnection());
weixinContinueButton.addEventListener("click", showWeixinDialog);
weixinReconnectButton.addEventListener("click", () => beginWeixinConnection({ reset: true }));
retryWeixinConnectionButton.addEventListener("click", () => beginWeixinConnection({ reset: true }));

weixinDisconnectButton.addEventListener("click", async () => {
  if (weixinActionBusy || !hasWeixinConnectionApi()) return;
  if (!window.confirm("确定解除当前微信绑定吗？\n\n解除后，需要重新扫码才能接收远程通知。")) return;
  setWeixinBusy(true);
  setWeixinActionResult("", "正在解除微信绑定…");
  try {
    const result = await window.companion.disconnectWeixin();
    renderWeixinStatus(result?.status || { state: "disconnected" });
    weixinVerificationCode.value = "";
    closeWeixinDialog();
    setWeixinActionResult("success", "微信绑定已解除。保存在本机的连接信息已清除。");
  } catch (error) {
    setWeixinActionResult("error", `解除绑定失败：${error.message || "请稍后重试"}`);
    await refreshWeixinStatus();
  } finally {
    setWeixinBusy(false);
  }
});

weixinTestButton.addEventListener("click", async () => {
  if (weixinActionBusy || weixinTestButton.disabled || !window.companion?.testWeixinNotification) return;
  setWeixinBusy(true);
  setWeixinActionResult("", "正在发送微信测试通知…");
  try {
    const result = await window.companion.testWeixinNotification();
    if (result?.ok === false) throw new Error(result.error || "测试通知发送失败");
    setWeixinActionResult("success", "测试通知已发送，请在微信中查看。");
  } catch (error) {
    setWeixinActionResult("error", `发送失败：${error.message || "微信暂时无法接收消息"}`);
    await refreshWeixinStatus();
  } finally {
    setWeixinBusy(false);
  }
});

remoteControlEnabled.addEventListener("change", () => {
  saveRemoteControlSettings({
    enabled: remoteControlEnabled.checked,
  });
});

weixinVerificationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (weixinActionBusy || !window.companion?.submitWeixinVerificationCode) return;
  const code = weixinVerificationCode.value.trim();
  if (!/^\d+$/.test(code)) {
    weixinVerificationCode.setCustomValidity("请输入手机微信中显示的数字验证码");
    weixinVerificationCode.reportValidity();
    return;
  }
  weixinVerificationCode.setCustomValidity("");
  setWeixinBusy(true);
  submitWeixinVerificationButton.textContent = "正在验证…";
  weixinDialogStatus.textContent = "正在提交数字验证码。";
  let verificationError = "";
  try {
    const result = await window.companion.submitWeixinVerificationCode(code);
    weixinVerificationCode.value = "";
    if (result) renderWeixinStatus(result);
    else await refreshWeixinStatus();
  } catch (error) {
    renderWeixinStatus({
      ...weixinState,
      state: "verification_required",
      lastError: error.message || "验证码验证失败",
    });
    verificationError = `验证失败：${error.message || "请检查验证码后重试"}`;
    weixinVerificationCode.focus();
    weixinVerificationCode.select();
  } finally {
    submitWeixinVerificationButton.textContent = "继续连接";
    setWeixinBusy(false);
    if (verificationError) weixinDialogStatus.textContent = verificationError;
  }
});

weixinVerificationCode.addEventListener("input", () => {
  weixinVerificationCode.value = weixinVerificationCode.value.replace(/\D/g, "");
  weixinVerificationCode.setCustomValidity("");
});

for (const button of [closeWeixinDialogButton, dismissWeixinDialogButton]) {
  button.addEventListener("click", closeWeixinDialog);
}
weixinConnectDialog.addEventListener("click", (event) => {
  if (event.target === weixinConnectDialog) closeWeixinDialog();
});

window.addEventListener("beforeunload", () => {
  if (typeof removeWeixinStatusListener === "function") removeWeixinStatusListener();
  removeWeixinStatusListener = null;
  if (typeof removeAppUpdateStatusListener === "function") removeAppUpdateStatusListener();
  removeAppUpdateStatusListener = null;
});

appUpdateAction.addEventListener("click", async () => {
  if (appUpdateAction.disabled) return;
  appUpdateAction.disabled = true;
  try {
    if (appUpdateState.state === "available") {
      renderAppUpdateStatus(await window.companion.downloadAppUpdate());
    } else if (appUpdateState.state === "downloaded") {
      if (window.confirm("更新已经下载完成。现在重启 Agent Pet 并安装新版本吗？")) {
        await window.companion.installAppUpdate();
      }
    } else {
      renderAppUpdateStatus(await window.companion.checkForAppUpdate());
    }
  } catch (error) {
    renderAppUpdateStatus({
      ...appUpdateState,
      state: "error",
      message: error.message || "更新操作失败",
    });
  } finally {
    appUpdateAction.disabled = appUpdateState.state === "checking"
      || appUpdateState.state === "downloading";
  }
});

for (const control of controls) {
  if (voiceStyleControlSet.has(control)) continue;
  if (control.type === "range") {
    control.addEventListener("input", () => updateRangeOutput(control));
  }
  control.addEventListener("change", () => {
    if (control === voiceEngine) updateVoiceEngineUI();
    queueSave(control.dataset.path, controlValue(control));
  });
}

function markVoiceStyleDirty() {
  voiceStyleDirty = true;
  saveVoiceStyleButton.disabled = false;
  setStatus("saving", "有未保存更改");
}

for (const control of voiceStyleControls) {
  control.addEventListener(control.type === "text" ? "input" : "change", markVoiceStyleDirty);
}

voiceStyleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!voiceStyleDirty || saveVoiceStyleButton.disabled) return;
  const revision = ++saveRevision;
  const style = Object.fromEntries(
    voiceStyleControls.map((control) => [control.dataset.path.split(".").at(-1), controlValue(control)]),
  );
  saveVoiceStyleButton.disabled = true;
  saveVoiceStyleButton.textContent = "正在保存…";
  setStatus("saving", "正在保存…");
  saveQueue = saveQueue
    .then(() => window.companion.updateSettings({ notifications: { voice: { style } } }))
    .then((state) => {
      voiceStyleDirty = false;
      settingsState = state;
      render(state);
      if (revision === saveRevision) setStatus("saved", "已保存");
    })
    .catch((error) => {
      console.error("Unable to save voice style", error);
      voiceStyleDirty = true;
      saveVoiceStyleButton.disabled = false;
      if (revision === saveRevision) setStatus("error", "保存失败");
    })
    .finally(() => {
      saveVoiceStyleButton.textContent = "保存设置";
      saveVoiceStyleButton.disabled = !voiceStyleDirty;
    });
});

for (const option of voiceEngineOptions) {
  option.addEventListener("click", () => {
    const engine = option.dataset.voiceEngineOption;
    if (!engine || engine === voiceEngine.value) return;
    voiceEngine.value = engine;
    updateVoiceEngineUI();
    queueSave(voiceEngine.dataset.path, engine);
  });
}

function closeVoiceEditor() {
  if (voiceEditor.open) voiceEditor.close();
}

function openVoiceEditor(mode) {
  voiceEditorMode = mode;
  voiceEditor.dataset.mode = mode;
  voiceEditorHelp.dataset.state = "";
  voiceEditorHelp.textContent = "";
  pendingVoiceFiles = { gpt: "", sovits: "", reference: "" };
  if (mode === "edit") {
    const voice = selectedCustomVoice();
    if (!voice) return;
    editingVoiceId = voice.id;
    voiceEditorTitle.textContent = "编辑音色";
    voiceName.value = voice.name;
    voicePromptText.value = voice.promptText;
    voicePromptLanguage.value = voice.promptLanguage;
    saveVoiceEditorButton.textContent = "保存修改";
  } else {
    editingVoiceId = "";
    voiceEditorTitle.textContent = "添加音色";
    voiceName.value = "";
    voiceGptFile.value = "";
    voiceSovitsFile.value = "";
    voiceReferenceFile.value = "";
    voicePromptText.value = "";
    voicePromptLanguage.value = "zh";
    saveVoiceEditorButton.textContent = "保存音色";
  }
  voiceEditor.showModal();
  voiceName.focus();
}

async function loadSelectedCustomVoice(successMessage) {
  const selected = selectedCustomVoice();
  if (!selected?.valid) return;
  setGptSovitsHelp("", "正在加载所选音色……");
  try {
    await window.companion.loadGptSovitsVoice();
    setGptSovitsHelp("available", successMessage || `已加载音色：${selected.name}`);
  } catch (error) {
    setGptSovitsHelp("error", `音色已选中，但加载失败：${error.message || "请检查本地服务"}`);
  }
}

for (const button of voiceFileButtons) {
  button.addEventListener("click", async () => {
    const kind = button.dataset.pickVoiceFile;
    const input = kind === "gpt" ? voiceGptFile : kind === "sovits" ? voiceSovitsFile : voiceReferenceFile;
    button.disabled = true;
    try {
      const result = await window.companion.selectSpeechFile(kind);
      if (result?.canceled || !result?.path) return;
      pendingVoiceFiles[kind] = result.path;
      input.value = result.path;
      voiceEditorHelp.textContent = "";
    } catch (error) {
      voiceEditorHelp.dataset.state = "error";
      voiceEditorHelp.textContent = `选择文件失败：${error.message || "未知错误"}`;
    } finally {
      button.disabled = false;
    }
  });
}

voiceEditorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (voiceEditorMode === "add" && (!pendingVoiceFiles.gpt
    || !pendingVoiceFiles.sovits || !pendingVoiceFiles.reference)) {
    voiceEditorHelp.dataset.state = "error";
    voiceEditorHelp.textContent = "请完整选择 .ckpt、.pth 和参考音频。";
    return;
  }
  saveVoiceEditorButton.disabled = true;
  voiceEditorHelp.dataset.state = "";
  voiceEditorHelp.textContent = voiceEditorMode === "add"
    ? "正在复制音色文件，请勿关闭应用……"
    : "正在保存修改……";
  try {
    const value = {
      id: editingVoiceId,
      name: voiceName.value,
      promptText: voicePromptText.value,
      promptLanguage: voicePromptLanguage.value,
      gptModelPath: pendingVoiceFiles.gpt,
      sovitsModelPath: pendingVoiceFiles.sovits,
      referenceAudioPath: pendingVoiceFiles.reference,
    };
    const state = voiceEditorMode === "add"
      ? await window.companion.importVoice(value)
      : await window.companion.updateVoice(value);
    renderVoiceLibrary(state);
    render(await window.companion.getSettings());
    closeVoiceEditor();
    if (voiceEditorMode === "add") {
      await loadSelectedCustomVoice(`音色“${selectedCustomVoice()?.name || ""}”已添加并加载。`);
    } else {
      setGptSovitsHelp("available", "音色信息已更新。");
    }
  } catch (error) {
    voiceEditorHelp.dataset.state = "error";
    voiceEditorHelp.textContent = `保存失败：${error.message || "未知错误"}`;
  } finally {
    saveVoiceEditorButton.disabled = false;
  }
});

for (const button of closeVoiceEditorButtons) button.addEventListener("click", closeVoiceEditor);
voiceEditor.addEventListener("click", (event) => {
  if (event.target === voiceEditor) closeVoiceEditor();
});

addGptSovitsVoiceButton.addEventListener("click", () => openVoiceEditor("add"));
editGptSovitsVoiceButton.addEventListener("click", () => openVoiceEditor("edit"));
removeGptSovitsVoiceButton.addEventListener("click", async () => {
  const voice = selectedCustomVoice();
  if (!voice || !window.confirm(`确定删除音色“${voice.name}”吗？\n\n将删除应用音色库中的模型副本，不影响原始文件。`)) return;
  removeGptSovitsVoiceButton.disabled = true;
  try {
    const state = await window.companion.removeVoice(voice.id);
    renderVoiceLibrary(state);
    render(await window.companion.getSettings());
    setGptSovitsHelp("", "音色已从应用音色库中删除。");
  } catch (error) {
    setGptSovitsHelp("error", `删除失败：${error.message || "未知错误"}`);
  } finally {
    removeGptSovitsVoiceButton.disabled = !selectedCustomVoice();
  }
});

gptSovitsVoice.addEventListener("change", async () => {
  customVoiceState = { ...customVoiceState, selectedVoiceId: gptSovitsVoice.value };
  renderVoiceLibrary(customVoiceState);
  queueSave("notifications.voice.gptSovits.selectedVoiceId", gptSovitsVoice.value);
  await saveQueue;
  await loadSelectedCustomVoice();
});

testGptSovitsConnectionButton.addEventListener("click", async () => {
  testGptSovitsConnectionButton.disabled = true;
  testGptSovitsConnectionButton.textContent = "正在连接…";
  setGptSovitsHelp("", "正在检查 GPT-SoVITS 服务及 /tts 接口…");
  try {
    await saveQueue;
    const result = await window.companion.testGptSovitsConnection();
    setGptSovitsHelp("available", `连接成功：${result.baseUrl}`);
  } catch (error) {
    setGptSovitsHelp("error", `连接失败：${error.message || "服务没有响应"}`);
  } finally {
    testGptSovitsConnectionButton.disabled = false;
    testGptSovitsConnectionButton.textContent = "测试连接";
  }
});

manageGptSovitsServiceButton.addEventListener("click", async () => {
  manageGptSovitsServiceButton.disabled = true;
  try {
    const result = await window.companion.manageGptSovitsService();
    if (result?.action === "start") {
      setGptSovitsHelp("", "已在后台启动 GPT-SoVITS；模型加载完成后状态会自动变为“运行中”。");
    } else {
      setGptSovitsHelp("", "已打开按需安装窗口；请确认设备、下载源和安装内容后继续。");
    }
    await refreshGptSovitsServiceStatus();
  } catch (error) {
    setGptSovitsHelp("error", `无法打开本地服务工具：${error.message || "未知错误"}`);
  } finally {
    manageGptSovitsServiceButton.disabled = false;
  }
});

stopGptSovitsServiceButton.addEventListener("click", async () => {
  stopGptSovitsServiceButton.disabled = true;
  try {
    const status = await window.companion.stopGptSovitsService();
    if (status?.external) {
      setGptSovitsHelp("error", "当前服务由外部窗口启动，请关闭对应的 CMD 窗口。");
    } else {
      setGptSovitsHelp("", "本地语音服务已经停止。");
    }
    renderGptSovitsServiceStatus(status);
  } catch (error) {
    setGptSovitsHelp("error", `停止服务失败：${error.message || "未知错误"}`);
  } finally {
    stopGptSovitsServiceButton.disabled = false;
    await refreshGptSovitsServiceStatus();
  }
});

openGptSovitsLogButton.addEventListener("click", async () => {
  try {
    await window.companion.openGptSovitsServiceLog();
  } catch (error) {
    setGptSovitsHelp("error", `无法打开服务日志：${error.message || "尚未生成日志"}`);
  }
});

gptSovitsRuntimeDevice.addEventListener("change", () => {
  const installedDevice = runtimeOptionsState?.status?.installation?.device || "";
  const availableDevices = runtimeOptionsState?.hardware?.availableDevices || ["CPU"];
  reconfigureGptSovitsDeviceButton.disabled = !runtimeOptionsState?.status?.installed
    || !availableDevices.includes(gptSovitsRuntimeDevice.value)
    || gptSovitsRuntimeDevice.value === installedDevice;
});

reconfigureGptSovitsDeviceButton.addEventListener("click", async () => {
  const device = gptSovitsRuntimeDevice.value;
  const label = runtimeDeviceLabel(device);
  const confirmed = window.confirm(
    `将运行环境切换为“${label}”需要停止语音服务并重新配置 PyTorch。已有音色和基础模型会保留，是否继续？`,
  );
  if (!confirmed) return;
  reconfigureGptSovitsDeviceButton.disabled = true;
  try {
    await window.companion.reconfigureGptSovitsDevice(device);
    gptSovitsRuntimeSummary.textContent = `正在切换到：${label}`;
    gptSovitsRuntimeHelp.textContent = "已打开运行环境配置窗口；完成后服务可以重新后台启动。";
    setGptSovitsHelp("", "正在重新配置计算设备，请等待安装窗口完成。");
  } catch (error) {
    setGptSovitsHelp("error", `无法更改计算设备：${error.message || "未知错误"}`);
    await refreshGptSovitsRuntimeOptions();
  }
});

removeGptSovitsServiceButton.addEventListener("click", async () => {
  removeGptSovitsServiceButton.disabled = true;
  try {
    await window.companion.removeGptSovitsService();
    setGptSovitsHelp("", "已打开本地服务清理窗口；关闭正在运行的服务，并按窗口提示确认清理。");
  } catch (error) {
    setGptSovitsHelp("error", `无法打开清理工具：${error.message || "未知错误"}`);
  } finally {
    removeGptSovitsServiceButton.disabled = false;
  }
});

setInterval(refreshGptSovitsServiceStatus, 2_500);
setInterval(() => {
  if (reconfigureGptSovitsDeviceButton.disabled) refreshGptSovitsRuntimeOptions();
}, 15_000);

agentProviderList.addEventListener("click", async (event) => {
  const card = event.target.closest(".agent-provider-card[data-provider-id]");
  if (!card || !window.companion?.selectAgentProvider) return;
  const providerId = card.dataset.providerId;
  if (providerId === settingsState?.agentProviders?.activeProviderId) {
    const selected = settingsState.agentProviders.providers.find((item) => item.id === providerId);
    agentProviderStatus.dataset.state = "";
    agentProviderStatus.textContent = `${selected?.displayName || "当前智能体"} 已经连接。`;
    return;
  }
  for (const button of agentProviderList.querySelectorAll("button")) button.disabled = true;
  agentProviderStatus.dataset.state = "";
  agentProviderStatus.textContent = "正在切换智能体连接…";
  try {
    render(await window.companion.selectAgentProvider(providerId));
    setStatus("saved", "已保存");
  } catch (error) {
    agentProviderStatus.dataset.state = "error";
    agentProviderStatus.textContent = `连接失败：${error.message || "智能体暂时不可用"}`;
  } finally {
    for (const button of agentProviderList.querySelectorAll("button")) button.disabled = false;
  }
});

for (const item of navigationItems) {
  item.addEventListener("click", () => showPage(item.dataset.page));
}

notificationHistoryPathButton.addEventListener("click", async () => {
  if (notificationHistoryPathButton.disabled || !notificationHistoryLocationId) return;
  notificationHistoryPathButton.disabled = true;
  notificationHistoryLocationStatus.textContent = "";
  try {
    await window.companion.openStorageLocation(notificationHistoryLocationId);
    notificationHistoryLocationStatus.textContent = "已打开通知记录目录。";
  } catch (error) {
    notificationHistoryLocationStatus.textContent = `无法打开目录：${error.message || "未知错误"}`;
  } finally {
    notificationHistoryPathButton.disabled = !notificationHistoryLocationId
      || !notificationHistoryPathButton.title;
  }
});

testNotificationButton.addEventListener("click", async () => {
  if (testNotificationButton.disabled) return;
  testNotificationButton.disabled = true;
  testNotificationButton.textContent = "正在发送…";
  testNotificationResult.dataset.state = "";
  testNotificationResult.textContent = "正在按照当前设置准备测试提醒……";
  try {
    await saveQueue;
    const result = await window.companion.sendTestNotification();
    if (!result?.ok) {
      const reasons = {
        rule_disabled: "“任务完成”提醒规则当前处于关闭状态。",
        quiet_hours: "当前处于免打扰时段，测试提醒已按规则拦截。",
        no_channels: "系统通知和语音播报均未启用。",
      };
      throw new Error(reasons[result?.reason] || "测试提醒未能发送。");
    }
    const labels = result.channels.map((channel) => (
      channel === "windows" ? "Windows 通知" : "语音队列"
    ));
    testNotificationResult.dataset.state = "success";
    testNotificationResult.textContent = `已发送到：${labels.join("、")}。`;
  } catch (error) {
    testNotificationResult.dataset.state = "error";
    testNotificationResult.textContent = error.message || "测试提醒发送失败。";
  } finally {
    testNotificationButton.disabled = false;
    testNotificationButton.textContent = "发送测试提醒";
  }
});

testVoiceButton.addEventListener("click", async () => {
  if (testVoiceButton.disabled) return;
  testVoiceButton.disabled = true;
  testVoiceButton.textContent = "正在试听…";
  try {
    await saveQueue;
    const result = await window.companion.testSpeech({ text: voicePreviewText.value });
    if (!result?.ok) throw new Error(result?.error || "synthesis_failed");
    if (voiceEngine.value === "gpt-sovits") {
      setGptSovitsHelp("available", "试听完成，GPT-SoVITS 音频已通过默认设备播放。");
    } else {
      voiceHelp.textContent = "试听完成，声音通过 Windows 当前默认音频设备播放。";
    }
  } catch (error) {
    console.error("Unable to test speech", error);
    if (voiceEngine.value === "gpt-sovits") {
      setGptSovitsHelp("error", `试听失败：${error.message || "GPT-SoVITS 没有响应"}`);
    } else {
      voiceHelp.textContent = `试听失败：${error.message || "语音引擎没有响应"}`;
    }
  } finally {
    testVoiceButton.disabled = false;
    testVoiceButton.textContent = "试听语音";
  }
});

copyCommunityGroupButton?.addEventListener("click", async () => {
  if (copyCommunityGroupButton.disabled) return;
  const originalLabel = copyCommunityGroupButton.textContent;
  copyCommunityGroupButton.disabled = true;
  communityCopyStatus.dataset.state = "";
  communityCopyStatus.textContent = "正在复制群号…";
  try {
    if (!window.companion?.copyText) throw new Error("clipboard_unavailable");
    const result = await window.companion.copyText(COMMUNITY_GROUP_NUMBER);
    if (!result?.ok) throw new Error("clipboard_write_failed");
    copyCommunityGroupButton.textContent = "已复制";
    communityCopyStatus.dataset.state = "success";
    communityCopyStatus.textContent = `群号 ${COMMUNITY_GROUP_NUMBER} 已复制，可直接在 QQ 中搜索。`;
  } catch {
    communityCopyStatus.dataset.state = "error";
    communityCopyStatus.textContent = `复制失败，请手动输入群号 ${COMMUNITY_GROUP_NUMBER}。`;
  } finally {
    window.setTimeout(() => {
      copyCommunityGroupButton.disabled = false;
      copyCommunityGroupButton.textContent = originalLabel;
    }, 1_600);
  }
});

resetButton.addEventListener("click", async () => {
  if (!window.confirm("确定恢复全部默认设置吗？")) return;
  const revision = ++saveRevision;
  setStatus("saving", "正在恢复…");
  try {
    const state = await window.companion.resetSettings();
    if (revision !== saveRevision) return;
    voiceStyleDirty = false;
    saveVoiceStyleButton.disabled = true;
    render(state);
    await loadPetLibrary();
    await loadRemoteControlSettings();
    setStatus("saved", "已恢复");
  } catch (error) {
    console.error("Unable to reset settings", error);
    setStatus("error", "恢复失败");
  }
});

initialize();
