import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";
import { panelVerticalAlignment } from "../window-layout.mjs";
import { TASK_WINDOW_SIZE } from "./window-contracts.mjs";

export class TaskWindowFacade extends WindowFacade {
  #itemCount = 0;

  constructor({ createWindow, preload, getServiceUrl, getPreferences, getWorkArea,
    isQuitting, onBlur, onHide, onResize }) {
    super({
      createWindow,
      getUrl: () => `${getServiceUrl()}/?companion=1`,
      getOptions: () => ({
        width: TASK_WINDOW_SIZE.width,
        height: Math.min(TASK_WINDOW_SIZE.height, getWorkArea().height - 24),
        show: false, frame: false, hasShadow: false, transparent: true,
        backgroundColor: "#00000000", alwaysOnTop: getPreferences().appearance.alwaysOnTop,
        skipTaskbar: true, resizable: false, minWidth: 300,
        minHeight: TASK_WINDOW_SIZE.minHeight, maximizable: false, fullscreenable: false,
        webPreferences: isolatedWebPreferences(preload),
      }),
      configure: (window) => {
        window.setAlwaysOnTop(getPreferences().appearance.alwaysOnTop, "floating");
        window.on("blur", onBlur);
        window.on("close", (event) => {
          if (isQuitting()) return;
          event.preventDefault();
          onHide();
        });
      },
      onShown: () => this.send("companion:panel-shown"),
    });
    this.getWorkArea = getWorkArea;
    this.onResize = onResize;
  }

  verticalAlignment(badgeHeight) {
    return panelVerticalAlignment(this.#itemCount, this.getBounds()?.height, badgeHeight);
  }

  resize(value) {
    if (this.isDestroyed()) return;
    const area = this.getWorkArea();
    const height = Math.max(TASK_WINDOW_SIZE.minHeight,
      Math.min(TASK_WINDOW_SIZE.height, area.height - 24, Math.round(Number(value?.height) || 0)));
    const count = Math.round(Number(value?.itemCount));
    this.#itemCount = Number.isFinite(count) ? Math.max(0, Math.min(999, count)) : 0;
    const current = this.getBounds();
    if (current.height !== height) {
      this.setBounds({ ...current, width: Math.min(TASK_WINDOW_SIZE.width, area.width - 24), height });
    }
    this.onResize();
  }
}
