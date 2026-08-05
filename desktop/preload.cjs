const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  togglePanel: () => ipcRenderer.invoke("companion:toggle-panel"),
  hidePanel: () => ipcRenderer.invoke("companion:hide-panel"),
  onPanelShown: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("companion:panel-shown", listener);
    return () => ipcRenderer.removeListener("companion:panel-shown", listener);
  },
  showBadgeMenu: () => ipcRenderer.invoke("companion:show-badge-menu"),
  openSettings: () => ipcRenderer.invoke("companion:open-settings"),
  getDailyReport: () => ipcRenderer.invoke("daily-report:get"),
  updateDailyReport: () => ipcRenderer.invoke("daily-report:update"),
  copyText: (text) => ipcRenderer.invoke("daily-report:copy", text),
  startBadgeDrag: () => ipcRenderer.send("companion:start-badge-drag"),
  stopBadgeDrag: () => ipcRenderer.send("companion:stop-badge-drag"),
  petPointerDown: (value) => ipcRenderer.send("pet-window:pointer-down", value),
  petPointerMove: (value) => ipcRenderer.send("pet-window:pointer-move", value),
  petPointerUp: (value) => ipcRenderer.send("pet-window:pointer-up", value),
  petPointerCancel: (value) => ipcRenderer.send("pet-window:pointer-cancel", value),
  petAnimationEnd: (value) => ipcRenderer.send("pet-renderer:animation-end", value),
  onPetState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("pet:state", listener);
    return () => ipcRenderer.removeListener("pet:state", listener);
  },
  resizePanel: (size) => ipcRenderer.send("companion:resize-panel", size),
  updateSummary: (summary) => ipcRenderer.send("companion:update-summary", summary),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  resetSettings: () => ipcRenderer.invoke("settings:reset"),
  getAppUpdateStatus: () => ipcRenderer.invoke("app:update-status"),
  checkForAppUpdate: () => ipcRenderer.invoke("app:check-update"),
  downloadAppUpdate: () => ipcRenderer.invoke("app:download-update"),
  installAppUpdate: () => ipcRenderer.invoke("app:install-update"),
  onAppUpdateStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("app:update-status-changed", listener);
    return () => ipcRenderer.removeListener("app:update-status-changed", listener);
  },
  getStorageLocations: () => ipcRenderer.invoke("settings:storage:get"),
  openStorageLocation: (id) => ipcRenderer.invoke("settings:storage:open", id),
  sendTestNotification: () => ipcRenderer.invoke("notifications:test"),
  getWeixinStatus: () => ipcRenderer.invoke("weixin:status"),
  startWeixinConnection: () => ipcRenderer.invoke("weixin:connect"),
  submitWeixinVerificationCode: (code) => ipcRenderer.invoke("weixin:verify", code),
  disconnectWeixin: () => ipcRenderer.invoke("weixin:disconnect"),
  testWeixinNotification: () => ipcRenderer.invoke("weixin:test"),
  getRemoteControlSettings: () => ipcRenderer.invoke("remote-control:get"),
  updateRemoteControlSettings: (value) => (
    ipcRenderer.invoke("remote-control:update", value)
  ),
  onRemoteControlSettings: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("remote-control:changed", listener);
    return () => ipcRenderer.removeListener("remote-control:changed", listener);
  },
  onWeixinStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("weixin:status-changed", listener);
    return () => ipcRenderer.removeListener("weixin:status-changed", listener);
  },
  getSpeechVoices: () => ipcRenderer.invoke("speech:get-voices"),
  testSpeech: (request) => ipcRenderer.invoke("speech:test", request),
  selectSpeechFile: (kind) => ipcRenderer.invoke("speech:select-file", kind),
  testGptSovitsConnection: () => ipcRenderer.invoke("gpt-sovits:test-connection"),
  loadGptSovitsVoice: () => ipcRenderer.invoke("gpt-sovits:load-voice"),
  manageGptSovitsService: () => ipcRenderer.invoke("gpt-sovits:manage-service"),
  getGptSovitsServiceStatus: () => ipcRenderer.invoke("gpt-sovits:service-status"),
  stopGptSovitsService: () => ipcRenderer.invoke("gpt-sovits:stop-service"),
  openGptSovitsServiceLog: () => ipcRenderer.invoke("gpt-sovits:open-service-log"),
  getGptSovitsRuntimeOptions: () => ipcRenderer.invoke("gpt-sovits:runtime-options"),
  reconfigureGptSovitsDevice: (device) => ipcRenderer.invoke("gpt-sovits:reconfigure-device", device),
  removeGptSovitsService: () => ipcRenderer.invoke("gpt-sovits:remove-service"),
  getVoiceLibrary: () => ipcRenderer.invoke("voice-library:list"),
  importVoice: (value) => ipcRenderer.invoke("voice-library:import", value),
  updateVoice: (value) => ipcRenderer.invoke("voice-library:update", value),
  removeVoice: (id) => ipcRenderer.invoke("voice-library:remove", id),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getPetLibrary: () => ipcRenderer.invoke("pet-library:list"),
  selectPetZip: () => ipcRenderer.invoke("pet-library:select-zip"),
  importPetZip: (filePath) => ipcRenderer.invoke("pet-library:import-zip", filePath),
  selectPet: (id) => ipcRenderer.invoke("pet-library:select", id),
  removePet: (id) => ipcRenderer.invoke("pet-library:remove", id),
  openPetLibrary: () => ipcRenderer.invoke("pet-library:open"),
});

contextBridge.exposeInMainWorld("speechHost", {
  reportVoices: (value) => ipcRenderer.send("speech:voices", value),
  reportResult: (value) => ipcRenderer.send("speech:result", value),
  onSpeak: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("speech:speak", listener);
    return () => ipcRenderer.removeListener("speech:speak", listener);
  },
  onPlayAudio: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("speech:play-audio", listener);
    return () => ipcRenderer.removeListener("speech:play-audio", listener);
  },
});
