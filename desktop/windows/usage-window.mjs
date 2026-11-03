import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";
import { USAGE_WINDOW_SIZE } from "./window-contracts.mjs";

export class UsageWindowFacade extends WindowFacade {
  constructor({ createWindow, preload, getServiceUrl, getPreferences, getWorkArea,
    isQuitting, onBlur, onHide, onResize }) {
    super({
      createWindow,
      getUrl: () => `${getServiceUrl()}/usage-card.html`,
      getOptions: () => ({
        width: USAGE_WINDOW_SIZE.width, height: USAGE_WINDOW_SIZE.height,
        show: false, frame: false, hasShadow: false, transparent: true,
        backgroundColor: "#00000000", alwaysOnTop: getPreferences().appearance.alwaysOnTop,
        skipTaskbar: true, resizable: false,
        minWidth: USAGE_WINDOW_SIZE.width, maxWidth: USAGE_WINDOW_SIZE.width,
        minHeight: USAGE_WINDOW_SIZE.minHeight, maxHeight: USAGE_WINDOW_SIZE.maxHeight,
        maximizable: false, fullscreenable: false,
        webPreferences: isolatedWebPreferences(preload),
      }),
      configure: (window) => {
        window.setAlwaysOnTop(getPreferences().appearance.alwaysOnTop, "floating");
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.on("blur", onBlur);
        window.on("close", (event) => {
          if (isQuitting()) return;
          event.preventDefault();
          onHide();
        });
      },
      onShown: () => this.refresh(),
    });
    this.getWorkArea = getWorkArea;
    this.onResize = onResize;
  }

  refresh() { this.send("usage:card-shown"); }

  resize(value) {
    if (this.isDestroyed()) return;
    const requested = Math.round(Number(value?.height) || USAGE_WINDOW_SIZE.height);
    const height = Math.max(USAGE_WINDOW_SIZE.minHeight,
      Math.min(USAGE_WINDOW_SIZE.maxHeight, this.getWorkArea().height - 24, requested));
    const current = this.getBounds();
    if (Math.abs(current.height - height) < 2) return;
    this.setBounds({ ...current, width: USAGE_WINDOW_SIZE.width, height });
    this.onResize();
  }
}
